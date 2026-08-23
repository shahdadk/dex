import type { ZodType } from "zod";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { DexDeviceKeyPair, DexPinnedServerKey } from "./crypto.js";
import {
  DexPairingPayloadSchema,
  DexPairingResponseSchema,
  DexSyncPayloadSchema,
  DexSyncResponseSchema,
  type DexPairingPayload,
  type DexPairingResponse,
  type DexSyncPayload,
  type DexSyncResponse,
} from "./schemas.js";
import {
  DexRequestSequencer,
  signDexRequest,
  type DexRequestMetadata,
  type DexRequestSequencerOptions,
  type DexRequestSignatureInput,
} from "./request-signing.js";
import {
  DexCommandVerifier,
  type DexVerifiedCommand,
} from "./verification.js";

export type DexFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DexPollingTransportHealth {
  kind: "polling";
  survivesHostSleep: true;
  status: "idle" | "healthy" | "degraded";
  consecutiveFailures: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: "network" | "http" | "protocol" | "verification";
}

export interface DexCloudMessagingClientOptions extends DexRequestSequencerOptions {
  baseUrl: string;
  keyPair: DexDeviceKeyPair;
  deviceId?: string;
  ownerId?: string;
  pinnedServerKeys?: readonly DexPinnedServerKey[];
  fetch?: DexFetch;
  sequencer?: DexRequestSequencer;
}

export interface DexSyncResult {
  version: 1;
  cursor: string;
  acceptedEventIds: string[];
  acceptedReceiptIds: string[];
  retryAfterMs?: number;
  nextSequence?: number;
  commands: DexVerifiedCommand[];
  transport: DexPollingTransportHealth;
}

export class DexCloudProtocolError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; code: string; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DexCloudProtocolError";
    if (options.status !== undefined) this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

type DevicePath = "/v1/device/pair" | "/v1/device/sync";

interface ParsedResponse {
  response: Response;
  json: unknown;
}

// These compatibility names deliberately stay private. Dex callers only see
// the branded request, response, and health interfaces above.
const WIRE = {
  client: "x-appfi-client",
  protocol: "x-appfi-protocol-version",
  deviceId: "x-appfi-device-id",
  keyId: "x-appfi-key-id",
  algorithm: "x-appfi-signature-algorithm",
  sequence: "x-appfi-sequence",
  nonce: "x-appfi-nonce",
  timestamp: "x-appfi-timestamp",
  contentSha256: "x-appfi-content-sha256",
  bodySha256: "x-appfi-body-sha256",
  signature: "x-appfi-signature",
  expectedSequence: "x-appfi-expected-sequence",
  nextSequence: "x-appfi-next-sequence",
} as const;

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_.-]{1,100}$/.test(normalized) ? normalized : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseCode(json: unknown): string | undefined {
  const body = record(json);
  const error = record(body?.error);
  return safeErrorCode(body?.code) ?? safeErrorCode(error?.code);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function replaySequence(parsed: ParsedResponse): number | undefined {
  const fromHeader =
    parsed.response.headers.get(WIRE.expectedSequence) ??
    parsed.response.headers.get(WIRE.nextSequence);
  const body = record(parsed.json);
  const error = record(body?.error);
  return positiveInteger(fromHeader) ??
    positiveInteger(body?.expectedSequence) ??
    positiveInteger(body?.nextSequence) ??
    positiveInteger(error?.expectedSequence) ??
    positiveInteger(error?.nextSequence);
}

function isReplayResponse(parsed: ParsedResponse): boolean {
  if (parsed.response.ok) return false;
  const code = responseCode(parsed.json) ?? "";
  return replaySequence(parsed) !== undefined ||
    ((parsed.response.status === 401 || parsed.response.status === 409) &&
      /(?:replay|sequence|nonce|stale_(?:request|timestamp))/.test(code));
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DexCloudProtocolError("Dex cloud returned malformed JSON", {
      code: "invalid_json",
      cause: error,
    });
  }
}

export class DexCloudMessagingClient {
  readonly #baseUrl: URL;
  readonly #keyPair: DexDeviceKeyPair;
  readonly #deviceId: string | undefined;
  readonly #fetch: DexFetch;
  readonly #sequencer: DexRequestSequencer;
  readonly #verifier: DexCommandVerifier;
  #health: DexPollingTransportHealth = {
    kind: "polling",
    survivesHostSleep: true,
    status: "idle",
    consecutiveFailures: 0,
  };

  constructor(options: DexCloudMessagingClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1") {
      throw new TypeError("Dex cloud URL must use HTTPS");
    }
    this.#baseUrl = baseUrl;
    this.#keyPair = options.keyPair;
    this.#deviceId = options.deviceId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch) throw new TypeError("A fetch implementation is required");
    this.#sequencer = options.sequencer ?? new DexRequestSequencer(options);
    this.#verifier = new DexCommandVerifier({
      pinnedServerKeys: options.pinnedServerKeys ?? [],
      ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  get transportHealth(): DexPollingTransportHealth {
    return { ...this.#health };
  }

  health(): DexPollingTransportHealth {
    return this.transportHealth;
  }

  pair(payload: DexPairingPayload): Promise<DexPairingResponse> {
    return this.#post(
      "/v1/device/pair",
      DexPairingPayloadSchema.parse(payload),
      DexPairingResponseSchema,
    );
  }

  async sync(payload: DexSyncPayload): Promise<DexSyncResult> {
    const response = await this.#post(
      "/v1/device/sync",
      DexSyncPayloadSchema.parse(payload),
      DexSyncResponseSchema,
    );
    try {
      const commands = this.#verifier.verifyAll(response.commands);
      this.#markSuccess();
      return {
        version: 1,
        cursor: response.cursor,
        acceptedEventIds: response.acceptedEventIds,
        acceptedReceiptIds: response.acceptedReceiptIds,
        ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
        ...(response.nextSequence === undefined ? {} : { nextSequence: response.nextSequence }),
        commands,
        transport: this.transportHealth,
      };
    } catch (error) {
      this.#markFailure("verification");
      if (error instanceof DexCloudProtocolError) throw error;
      throw new DexCloudProtocolError("Dex cloud command verification failed", {
        code: "command_verification_failed",
        cause: error,
      });
    }
  }

  poll(payload: DexSyncPayload): Promise<DexSyncResult> {
    return this.sync(payload);
  }

  async #post<T>(path: DevicePath, payload: unknown, schema: ZodType<T>): Promise<T> {
    const body = canonicalJson(payload);
    const contentSha256 = sha256Hex(body);
    let recoveredReplay = false;

    for (;;) {
      const metadata = this.#sequencer.next();
      this.#markAttempt(metadata.timestamp);
      let parsed: ParsedResponse;
      try {
        parsed = await this.#send(path, body, contentSha256, metadata);
      } catch (error) {
        this.#markFailure(error instanceof DexCloudProtocolError ? "protocol" : "network");
        if (error instanceof DexCloudProtocolError) throw error;
        throw new DexCloudProtocolError("Dex cloud request failed", {
          code: "network_error",
          retryable: true,
          cause: error,
        });
      }

      if (isReplayResponse(parsed) && !recoveredReplay) {
        const nextSequence = replaySequence(parsed);
        if (nextSequence !== undefined) this.#sequencer.setNextSequenceFloor(nextSequence);
        recoveredReplay = true;
        continue;
      }

      if (!parsed.response.ok) {
        this.#markFailure("http");
        const code = responseCode(parsed.json) ?? `http_${parsed.response.status}`;
        throw new DexCloudProtocolError("Dex cloud rejected the request", {
          status: parsed.response.status,
          code,
          retryable: parsed.response.status === 429 || parsed.response.status >= 500,
        });
      }

      try {
        const result = schema.parse(parsed.json);
        const nextSequence = positiveInteger(record(parsed.json)?.nextSequence);
        if (nextSequence !== undefined) this.#sequencer.setNextSequenceFloor(nextSequence);
        this.#markSuccess();
        return result;
      } catch (error) {
        this.#markFailure("protocol");
        throw new DexCloudProtocolError("Dex cloud response schema validation failed", {
          status: parsed.response.status,
          code: "invalid_response",
          cause: error,
        });
      }
    }
  }

  async #send(
    path: DevicePath,
    body: string,
    contentSha256: string,
    metadata: DexRequestMetadata,
  ): Promise<ParsedResponse> {
    const signatureInput: DexRequestSignatureInput = {
      method: "POST",
      path,
      keyId: this.#keyPair.keyId,
      ...(this.#deviceId === undefined ? {} : { deviceId: this.#deviceId }),
      contentSha256,
      ...metadata,
    };
    const headers: Record<string, string> = {
      "accept": "application/json",
      "content-type": "application/json",
      [WIRE.client]: "dex",
      [WIRE.protocol]: "1",
      [WIRE.keyId]: this.#keyPair.keyId,
      [WIRE.algorithm]: "ed25519",
      [WIRE.sequence]: String(metadata.sequence),
      [WIRE.nonce]: metadata.nonce,
      [WIRE.timestamp]: String(metadata.timestamp),
      [WIRE.contentSha256]: contentSha256,
      [WIRE.bodySha256]: contentSha256,
      [WIRE.signature]: signDexRequest(signatureInput, this.#keyPair.privateKey),
      ...(this.#deviceId === undefined ? {} : { [WIRE.deviceId]: this.#deviceId }),
    };
    const url = new URL(path, this.#baseUrl.origin);
    const response = await this.#fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
    });
    return { response, json: parseJson(await response.text()) };
  }

  #markAttempt(timestamp: number): void {
    this.#health = {
      ...this.#health,
      lastAttemptAt: new Date(timestamp).toISOString(),
    };
  }

  #markSuccess(): void {
    this.#health = {
      ...this.#health,
      status: "healthy",
      consecutiveFailures: 0,
      lastSuccessAt: new Date().toISOString(),
    };
    delete this.#health.lastError;
  }

  #markFailure(error: NonNullable<DexPollingTransportHealth["lastError"]>): void {
    this.#health = {
      ...this.#health,
      status: "degraded",
      consecutiveFailures: this.#health.consecutiveFailures + 1,
      lastError: error,
    };
  }
}

export const DexDeviceClient = DexCloudMessagingClient;
