import { createHash } from "node:crypto";
import { CloudTasksClient } from "@google-cloud/tasks";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { ControlPlaneError, type MonitorJobRecord } from "../control-plane/index.js";
import {
  ModalMonitor,
  ModalMonitorRequestSchema,
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

const CloudTasksMonitorBodySchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(512),
  request: ModalMonitorRequestSchema,
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

export class CloudTasksMonitorDispatcher {
  readonly #config: CloudTasksMonitorConfig;
  readonly #client: CloudTasksClientLike;

  constructor(config: CloudTasksMonitorConfig, client: CloudTasksClientLike = new CloudTasksClient()) {
    this.#config = config;
    this.#client = client;
  }

  dispatch(job: MonitorJobRecord): Promise<void> {
    return this.schedule({
      idempotencyKey: job.idempotencyKey,
      request: ModalMonitorRequestSchema.parse(job.request),
      delayMs: Math.max(0, Date.parse(job.availableAt) - Date.now()),
    });
  }

  async schedule(schedule: ModalMonitorSchedule): Promise<void> {
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
            scheduleTime: { seconds: Math.floor((Date.now() + schedule.delayMs) / 1_000) },
          }),
        },
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 6 && code !== "ALREADY_EXISTS") throw error;
    }
  }
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
    const result = CloudTasksMonitorBodySchema.safeParse(body);
    if (!result.success) throw new ControlPlaneError(400, "invalid_cloud_task", "Invalid Cloud Tasks monitor body");
    const parsed = result.data;
    const expectedTask = cloudTaskId(parsed.idempotencyKey);
    if (
      headers.get("x-cloudtasks-queuename") !== this.#config.queue ||
      headers.get("x-cloudtasks-taskname") !== expectedTask
    ) {
      throw new ControlPlaneError(401, "invalid_cloud_task", "Cloud Tasks request headers do not match the configured queue and task");
    }
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
    return parsed;
  }
}

export class CloudTasksModalMonitor {
  readonly #monitor: ModalMonitor;

  constructor(options: {
    modal: Pick<ModalAdapter, "fromId">;
    once: ModalMonitorOnce;
    dispatcher: CloudTasksMonitorDispatcher;
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
