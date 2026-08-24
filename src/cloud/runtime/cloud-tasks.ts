import { createHash } from "node:crypto";
import { CloudTasksClient } from "@google-cloud/tasks";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { ControlPlaneError, type MonitorJobRecord } from "../control-plane/index.js";
import {
  ModalMonitor,
  ModalMonitorRequestSchema,
  modalMonitorRetryKey,
  type ModalMonitorOutcome,
  type ModalMonitorSchedule,
  type ModalMonitorOnce,
  type ParsedModalMonitorRequest,
} from "../modal-monitor/index.js";
import type { ModalAdapter } from "../modal/index.js";

export const CLOUD_TASKS_MONITOR_PATH = "/internal/modal/monitor";

export interface CloudTasksMonitorConfig {
  project: string;
  location: string;
  queue: string;
  serviceUrl: string;
  audience: string;
  serviceAccountEmail: string;
}

const BoundedIdentifierSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));

const StrictModalMonitorRequestSchema = ModalMonitorRequestSchema.extend({
  taskId: BoundedIdentifierSchema,
  sandboxId: BoundedIdentifierSchema,
  attempt: z.number().int().min(0).max(10_000).default(0),
  resultPath: z.string().startsWith("/").max(1_024).default("/dex/result.json"),
}).strict();

const CloudTasksMonitorBodySchema = z.object({
  idempotencyKey: z.string()
    .min(1)
    .max(1_024)
    .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)),
  request: StrictModalMonitorRequestSchema,
}).strict();

export type CloudTasksMonitorBody = z.output<typeof CloudTasksMonitorBodySchema>;

export interface CloudTasksClientLike {
  queuePath(project: string, location: string, queue: string): string;
  taskPath(project: string, location: string, queue: string, task: string): string;
  createTask(request: unknown): Promise<unknown>;
}

export function cloudTaskId(idempotencyKey: string): string {
  return `modal-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export function modalMonitorIdempotencyKey(
  request: Pick<ParsedModalMonitorRequest, "taskId" | "handoffSha256" | "attempt">,
): string {
  return request.attempt === 0
    ? `modal-monitor:${request.taskId}:${request.handoffSha256.slice(0, 16)}:initial`
    : modalMonitorRetryKey(request.taskId, request.handoffSha256, request.attempt);
}

function legacyModalMonitorIdempotencyKey(
  request: Pick<ParsedModalMonitorRequest, "taskId" | "attempt">,
): string {
  return request.attempt === 0
    ? `modal-monitor:${request.taskId}:initial`
    : `modal-monitor:${request.taskId}:attempt:${request.attempt}`;
}

export function matchesModalMonitorIdempotencyKey(
  idempotencyKey: string,
  request: Pick<ParsedModalMonitorRequest, "taskId" | "handoffSha256" | "attempt">,
): boolean {
  return idempotencyKey === modalMonitorIdempotencyKey(request) ||
    idempotencyKey === legacyModalMonitorIdempotencyKey(request);
}

export class CloudTasksMonitorDispatcher {
  readonly #config: CloudTasksMonitorConfig;
  readonly #client: CloudTasksClientLike;
  readonly #now: () => number;

  constructor(
    config: CloudTasksMonitorConfig,
    client: CloudTasksClientLike = new CloudTasksClient(),
    now: () => number = Date.now,
  ) {
    this.#config = config;
    this.#client = client;
    this.#now = now;
  }

  dispatch(job: MonitorJobRecord): Promise<void> {
    return this.schedule({
      idempotencyKey: job.idempotencyKey,
      request: ModalMonitorRequestSchema.parse(job.request),
      delayMs: Math.max(0, Date.parse(job.availableAt) - this.#now()),
    });
  }

  async schedule(schedule: ModalMonitorSchedule): Promise<void> {
    if (!Number.isSafeInteger(schedule.delayMs) || schedule.delayMs < 0) {
      throw new RangeError("Cloud Tasks monitor delay must be a non-negative integer");
    }
    if (!matchesModalMonitorIdempotencyKey(schedule.idempotencyKey, schedule.request)) {
      throw new TypeError("Cloud Tasks monitor idempotency key does not match its request");
    }
    const parent = this.#client.queuePath(
      this.#config.project,
      this.#config.location,
      this.#config.queue,
    );
    const taskId = cloudTaskId(schedule.idempotencyKey);
    const body: CloudTasksMonitorBody = {
      idempotencyKey: schedule.idempotencyKey,
      request: schedule.request,
    };
    try {
      await this.#client.createTask({
        parent,
        task: {
          name: this.#client.taskPath(
            this.#config.project,
            this.#config.location,
            this.#config.queue,
            taskId,
          ),
          httpRequest: {
            httpMethod: "POST",
            url: new URL(CLOUD_TASKS_MONITOR_PATH, this.#config.serviceUrl).toString(),
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify(body)).toString("base64"),
            oidcToken: {
              serviceAccountEmail: this.#config.serviceAccountEmail,
              audience: this.#config.audience,
            },
          },
          ...(schedule.delayMs === 0 ? {} : {
            scheduleTime: timestamp(this.#now() + schedule.delayMs),
          }),
        },
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 6 && code !== "ALREADY_EXISTS") throw error;
    }
  }
}

function timestamp(milliseconds: number): { seconds: number; nanos: number } {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("Cloud Tasks monitor schedule time is invalid");
  }
  return {
    seconds: Math.floor(milliseconds / 1_000),
    nanos: (milliseconds % 1_000) * 1_000_000,
  };
}

export interface CloudTasksTokenVerifier {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{
    getPayload?(): { email?: string; email_verified?: boolean } | undefined;
  }>;
}

export class CloudTasksRequestAuthenticator {
  readonly #config: CloudTasksMonitorConfig;
  readonly #verifier: CloudTasksTokenVerifier;

  constructor(config: CloudTasksMonitorConfig, verifier: CloudTasksTokenVerifier = new OAuth2Client()) {
    this.#config = config;
    this.#verifier = verifier;
  }

  async verify(headers: Headers, body: unknown): Promise<CloudTasksMonitorBody> {
    const authorization = headers.get("authorization");
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match) throw new ControlPlaneError(401, "invalid_cloud_task", "Cloud Tasks OIDC bearer token is required");
    try {
      const ticket = await this.#verifier.verifyIdToken({
        idToken: match[1]!,
        audience: this.#config.audience,
      });
      const payload = ticket.getPayload?.();
      if (payload?.email !== this.#config.serviceAccountEmail || payload.email_verified !== true) {
        throw new Error("Unexpected OIDC identity");
      }
    } catch {
      throw new ControlPlaneError(401, "invalid_cloud_task", "Cloud Tasks OIDC token is invalid");
    }

    const mediaType = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new ControlPlaneError(415, "invalid_cloud_task", "Cloud Tasks monitor body must be JSON");
    }
    const result = CloudTasksMonitorBodySchema.safeParse(body);
    if (!result.success) throw new ControlPlaneError(400, "invalid_cloud_task", "Invalid Cloud Tasks monitor body");
    const parsed = result.data;
    if (!matchesModalMonitorIdempotencyKey(parsed.idempotencyKey, parsed.request)) {
      throw new ControlPlaneError(400, "invalid_cloud_task", "Cloud Tasks monitor identity does not match its request");
    }
    const expectedTask = cloudTaskId(parsed.idempotencyKey);
    if (
      headers.get("x-cloudtasks-queuename") !== this.#config.queue ||
      headers.get("x-cloudtasks-taskname") !== expectedTask
    ) {
      throw new ControlPlaneError(401, "invalid_cloud_task", "Cloud Tasks request headers do not match the configured queue and task");
    }
    return parsed;
  }
}

export class CloudTasksModalMonitor {
  readonly #monitor: ModalMonitor;

  constructor(options: {
    modal: Pick<ModalAdapter, "fromId">;
    once: ModalMonitorOnce;
    dispatcher: Pick<CloudTasksMonitorDispatcher, "schedule">;
    onTerminal(input: unknown): Promise<void>;
    now?: () => number;
  }) {
    this.#monitor = new ModalMonitor({
      modal: options.modal,
      once: options.once,
      schedule: (schedule) => options.dispatcher.schedule(schedule),
      onTerminal: options.onTerminal,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  run(request: ParsedModalMonitorRequest): Promise<ModalMonitorOutcome> {
    return this.#monitor.run(request);
  }
}
