import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { Buffer } from "node:buffer";
import { ControlPlaneError, controlPlaneError } from "./errors.js";
import type { DexControlPlaneService } from "./service.js";

export const DEFAULT_CONTROL_PLANE_BODY_LIMIT = 64 * 1024;

export interface DexControlPlaneHandlerOptions {
  service: DexControlPlaneService;
  maxBodyBytes?: number;
  monitorTask?: {
    verify(headers: Headers, body: unknown): Promise<unknown>;
    run(body: unknown): Promise<unknown>;
  };
  onMonitorRegistered?: () => Promise<void>;
  readiness?: () => Promise<void>;
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorResponse(error: unknown): Response {
  const safe = controlPlaneError(error);
  const details = safe.details ?? {};
  const headers: Record<string, string> = {};
  if (typeof details.expectedSequence === "number") {
    headers["x-appfi-expected-sequence"] = String(details.expectedSequence);
  }
  return jsonResponse(safe.status, {
    code: safe.code,
    ...(Object.keys(details).length === 0 ? {} : details),
  }, headers);
}

async function boundedBody(request: Request, limit: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw new ControlPlaneError(413, "body_too_large", "Request body is too large");
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ControlPlaneError(413, "body_too_large", "Request body is too large");
    }
    chunks.push(Buffer.from(item.value));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function parseJson(body: string): unknown {
  if (!body) throw new ControlPlaneError(400, "invalid_json", "JSON body is required");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ControlPlaneError(400, "invalid_json", "Malformed JSON body");
  }
}

function requestsMonitorDispatch(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("events" in value)) return false;
  const events = (value as { events?: unknown }).events;
  return Array.isArray(events) && events.some((event) =>
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "modal.monitor.registered");
}

function validBodyLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 1024 * 1024) {
    throw new RangeError("Control-plane body limit must be between 1 KiB and 1 MiB");
  }
  return value;
}

export function createDexControlPlaneFetchHandler(
  options: DexControlPlaneHandlerOptions,
): (request: Request) => Promise<Response> {
  const limit = validBodyLimit(options.maxBodyBytes ?? DEFAULT_CONTROL_PLANE_BODY_LIMIT);
  const service = options.service;
  const readiness = options.readiness ?? (() => Promise.resolve());

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const isLiveness = url.pathname === "/livez";
      const isReadiness = url.pathname === "/readyz" || url.pathname === "/healthz";
      if (isLiveness || isReadiness) {
        if (request.method !== "GET") {
          return jsonResponse(405, { code: "method_not_allowed" }, { allow: "GET" });
        }
        if (isLiveness) return jsonResponse(200, { status: "ok" });
        try {
          await readiness();
          return jsonResponse(200, { status: "ok" });
        } catch {
          return jsonResponse(503, { status: "unavailable" });
        }
      }
      if (request.method !== "POST") {
        return jsonResponse(405, { code: "method_not_allowed" }, { allow: "POST" });
      }

      if (url.pathname === "/webhooks/sendblue") {
        service.verifySendblueRequest(request.headers);
        const body = await boundedBody(request, limit);
        const result = await service.processSendblueWebhook(parseJson(body), request.headers);
        await options.onMonitorRegistered?.();
        return jsonResponse(200, result);
      }
      if (url.pathname === "/v1/device/pair") {
        const body = await boundedBody(request, limit);
        const result = await service.pairDevice({
          body,
          headers: request.headers,
          json: parseJson(body),
        });
        return jsonResponse(200, result);
      }
      if (url.pathname === "/v1/device/sync") {
        const body = await boundedBody(request, limit);
        const json = parseJson(body);
        const dispatchMonitors = requestsMonitorDispatch(json);
        let result: Awaited<ReturnType<DexControlPlaneService["syncDevice"]>>;
        try {
          result = await service.syncDevice({
            body,
            headers: request.headers,
            json,
          });
        } catch (error) {
          // A prior sync may have committed before its Cloud Tasks API call
          // failed. Its signed retry is stale, but must still drain that outbox.
          if (
            dispatchMonitors &&
            error instanceof ControlPlaneError &&
            error.code === "stale_sequence"
          ) {
            await options.onMonitorRegistered?.();
          }
          throw error;
        }
        // Every accepted device sync can enqueue Sendblue messages. Drain the
        // transactional outbox even when no Modal monitor was registered.
        await options.onMonitorRegistered?.();
        return jsonResponse(200, result, {
          "x-appfi-next-sequence": String(result.nextSequence ?? ""),
        });
      }
      if (url.pathname === "/v1/modal/monitors") {
        service.verifyInternalRequest(request.headers);
        const body = await boundedBody(request, limit);
        const result = await service.registerModalMonitor(parseJson(body));
        await options.onMonitorRegistered?.();
        return jsonResponse(200, result);
      }
      if (url.pathname === "/v1/modal/results") {
        service.verifyInternalRequest(request.headers);
        const body = await boundedBody(request, limit);
        const result = await service.handleModalTerminal(parseJson(body));
        await options.onMonitorRegistered?.();
        return jsonResponse(200, result);
      }
      if (url.pathname === "/internal/modal/monitor" && options.monitorTask) {
        const body = parseJson(await boundedBody(request, limit));
        const verified = await options.monitorTask.verify(request.headers, body);
        const result = await options.monitorTask.run(verified);
        await options.onMonitorRegistered?.();
        return jsonResponse(200, result);
      }
      return jsonResponse(404, { code: "not_found" });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function webHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

async function readNodeBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > limit) {
    request.resume();
    throw new ControlPlaneError(413, "body_too_large", "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > limit) {
      request.resume();
      throw new ControlPlaneError(413, "body_too_large", "Request body is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function sendNodeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

export function createDexControlPlaneHttpHandler(
  options: DexControlPlaneHandlerOptions,
): RequestListener {
  const limit = validBodyLimit(options.maxBodyBytes ?? DEFAULT_CONTROL_PLANE_BODY_LIMIT);
  const fetchHandler = createDexControlPlaneFetchHandler({ ...options, maxBodyBytes: limit });
  return (request, response): void => {
    void (async () => {
      try {
        const method = request.method ?? "GET";
        const body = method === "GET" || method === "HEAD"
          ? (request.resume(), Buffer.alloc(0))
          : await readNodeBody(request, limit);
        const webRequest = new Request(`http://control-plane.local${request.url ?? "/"}`, {
          method,
          headers: webHeaders(request.headers),
          ...(method === "GET" || method === "HEAD" ? {} : { body: body.toString("utf8") }),
        });
        await sendNodeResponse(await fetchHandler(webRequest), response);
      } catch (error) {
        await sendNodeResponse(errorResponse(error), response);
      }
    })();
  };
}

export function createDexControlPlaneServer(
  options: DexControlPlaneHandlerOptions,
): Server {
  return createServer(createDexControlPlaneHttpHandler(options));
}

export const createControlPlaneHttpHandler = createDexControlPlaneHttpHandler;
export const createControlPlaneServer = createDexControlPlaneServer;
