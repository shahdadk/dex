import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ModalResultArtifactSchema,
  type ModalAdapter,
  type ModalResultArtifact,
  type ModalSandbox,
} from "../modal/index.js";
import {
  ModalMonitorRequestSchema,
  type ModalMonitorRequest,
  type ParsedModalMonitorRequest,
} from "./schemas.js";

export const MODAL_MONITOR_INITIAL_DELAY_MS = 5_000;
export const MODAL_MONITOR_RETRY_DELAY_MS = 10_000;
export const MODAL_MONITOR_DEADLINE_MS = 25 * 60_000;
export const MODAL_SUCCESS_RESULT_RETENTION_MS = 5 * 60_000;

export interface ModalMonitorSchedule {
  request: ParsedModalMonitorRequest;
  delayMs: number;
  idempotencyKey: string;
}

export type ModalTerminalReason =
  | "result"
  | "nonzero_exit"
  | "invalid_result"
  | "deadline_exceeded";

export interface ModalTerminalEvent {
  taskId: string;
  sandboxId: string;
  completionKey: string;
  status: "succeeded" | "failed" | "cancelled";
  reason: ModalTerminalReason;
  exitCode: number | null;
  result?: ModalResultArtifact;
  sandboxRetentionExpiresAt?: string;
  error?: string;
}

/**
 * Must atomically execute an effect once per key. Cloud deployments should
 * back this with the durable task/outbox transaction; the default is suitable
 * for one process and unit tests.
 */
export interface ModalMonitorOnce {
  runOnce(key: string, effect: () => Promise<void>): Promise<boolean>;
}

/** Signals a live durable owner; callers must retry instead of acknowledging work. */
export class ModalMonitorLeaseBusyError extends Error {
  readonly key: string;
  readonly retryAfterMs: number;

  constructor(key: string, retryAfterMs: number) {
    super("A durable Modal monitor effect is still in flight");
    this.name = "ModalMonitorLeaseBusyError";
    this.key = key;
    this.retryAfterMs = retryAfterMs;
  }
}

export class InMemoryModalMonitorOnce implements ModalMonitorOnce {
  readonly #completed = new Set<string>();
  readonly #inFlight = new Map<string, Promise<void>>();

  async runOnce(key: string, effect: () => Promise<void>): Promise<boolean> {
    if (this.#completed.has(key)) return false;

    const existing = this.#inFlight.get(key);
    if (existing) {
      await existing;
      return false;
    }

    const execution = effect();
    this.#inFlight.set(key, execution);
    try {
      await execution;
      this.#completed.add(key);
      return true;
    } finally {
      this.#inFlight.delete(key);
    }
  }
}

export interface ModalMonitorDependencies {
  modal: Pick<ModalAdapter, "fromId">;
  schedule(schedule: ModalMonitorSchedule): Promise<void>;
  onTerminal(event: ModalTerminalEvent): Promise<void>;
  once?: ModalMonitorOnce;
  now?: () => number;
  readResult?: (
    sandbox: ModalSandbox,
    remotePath: string,
  ) => Promise<unknown>;
}

export type ModalMonitorOutcome =
  | {
      kind: "rescheduled";
      delayMs: number;
      nextAttempt: number;
      idempotencyKey: string;
      scheduled: boolean;
    }
  | {
      kind: "terminal";
      event: ModalTerminalEvent;
      callbackInvoked: boolean;
    };

async function readResultFromSandbox(
  sandbox: ModalSandbox,
  remotePath: string,
): Promise<unknown> {
  const directory = await mkdtemp(path.join(tmpdir(), "dex-modal-result-"));
  const localPath = path.join(directory, "result.json");
  try {
    await sandbox.copyToLocal(remotePath, localPath);
    return JSON.parse(await readFile(localPath, "utf8")) as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function modalMonitorAttemptScope(taskId: string, handoffSha256: string): string {
  return `${taskId}:${handoffSha256.slice(0, 16)}`;
}

export function modalMonitorTerminalKey(taskId: string, handoffSha256: string): string {
  return `modal-monitor:${modalMonitorAttemptScope(taskId, handoffSha256)}:terminal`;
}

export function modalMonitorRetryKey(taskId: string, handoffSha256: string, attempt: number): string {
  return `modal-monitor:${modalMonitorAttemptScope(taskId, handoffSha256)}:attempt:${attempt}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultNotReady(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || /not found|no such file|does not exist/i.test(errorMessage(error));
}

async function readValidatedResult(
  dependencies: ModalMonitorDependencies,
  sandbox: ModalSandbox,
  request: ParsedModalMonitorRequest,
): Promise<ModalResultArtifact> {
  const raw = await (dependencies.readResult ?? readResultFromSandbox)(
    sandbox,
    request.resultPath,
  );
  const artifact = ModalResultArtifactSchema.parse(raw);
  if (artifact.taskId !== request.taskId) {
    throw new Error("Result taskId does not match monitor taskId");
  }
  if (artifact.handoffSha256 !== request.handoffSha256) {
    throw new Error("Result handoffSha256 does not match the verified handoff");
  }
  if (artifact.status === "succeeded" && !artifact.validation.passed) {
    throw new Error("A succeeded result must report passing validation");
  }
  return artifact;
}

export class ModalMonitor {
  readonly #dependencies: ModalMonitorDependencies;
  readonly #once: ModalMonitorOnce;

  constructor(dependencies: ModalMonitorDependencies) {
    this.#dependencies = dependencies;
    this.#once = dependencies.once ?? new InMemoryModalMonitorOnce();
  }

  async run(input: ModalMonitorRequest): Promise<ModalMonitorOutcome> {
    const request = ModalMonitorRequestSchema.parse(input);
    const now = this.#dependencies.now?.() ?? Date.now();
    const deadline = Date.parse(request.startedAt) + MODAL_MONITOR_DEADLINE_MS;
    let sandbox: ModalSandbox | undefined;
    let exitCode: number | null = null;
    let observationError: unknown;

    try {
      sandbox = await this.#dependencies.modal.fromId(request.sandboxId);
      exitCode = await sandbox.poll();
    } catch (error) {
      observationError = error;
    }

    // The worker intentionally keeps a detached Sandbox alive for a bounded
    // period after atomically writing result.json. Consume that result while
    // the filesystem is still reachable, then terminate the hold process.
    if (exitCode === null && sandbox && now < deadline) {
      let artifact: ModalResultArtifact | undefined;
      try {
        artifact = await readValidatedResult(this.#dependencies, sandbox, request);
      } catch (error) {
        if (!resultNotReady(error)) {
          const outcome = await this.#deliverTerminal({
            taskId: request.taskId,
            sandboxId: request.sandboxId,
            completionKey: modalMonitorTerminalKey(request.taskId, request.handoffSha256),
            status: "failed",
            reason: "invalid_result",
            exitCode: null,
            error: errorMessage(error),
          });
          await sandbox.terminate().catch(() => undefined);
          return outcome;
        }
      }
      if (artifact) {
        const sandboxRetentionExpiresAt = artifact.status === "succeeded"
          ? new Date(now + MODAL_SUCCESS_RESULT_RETENTION_MS).toISOString()
          : undefined;
        const outcome = await this.#deliverTerminal({
          taskId: request.taskId,
          sandboxId: request.sandboxId,
          completionKey: modalMonitorTerminalKey(request.taskId, request.handoffSha256),
          status: artifact.status,
          reason: "result",
          exitCode: artifact.status === "succeeded" ? 0 : 1,
          result: artifact,
          ...(sandboxRetentionExpiresAt === undefined
            ? {}
            : { sandboxRetentionExpiresAt }),
        });
        if (artifact.status === "succeeded") {
          await sandbox.detach();
        } else {
          await sandbox.terminate().catch(() => undefined);
        }
        return outcome;
      }
    }

    if (exitCode === null && now < deadline) {
      if (sandbox) await sandbox.detach();
      const nextAttempt = request.attempt + 1;
      const normalDelay =
        request.attempt === 0
          ? MODAL_MONITOR_INITIAL_DELAY_MS
          : MODAL_MONITOR_RETRY_DELAY_MS;
      const delayMs = Math.min(normalDelay, deadline - now);
      const idempotencyKey = modalMonitorRetryKey(request.taskId, request.handoffSha256, nextAttempt);
      const nextRequest: ParsedModalMonitorRequest = {
        ...request,
        attempt: nextAttempt,
      };
      const scheduled = await this.#once.runOnce(idempotencyKey, () =>
        this.#dependencies.schedule({
          request: nextRequest,
          delayMs,
          idempotencyKey,
        }),
      );
      return {
        kind: "rescheduled",
        delayMs,
        nextAttempt,
        idempotencyKey,
        scheduled,
      };
    }

    if (exitCode === null) {
      if (sandbox) {
        await sandbox.terminate().catch(() => undefined);
      }
      return this.#deliverTerminal({
        taskId: request.taskId,
        sandboxId: request.sandboxId,
        completionKey: modalMonitorTerminalKey(request.taskId, request.handoffSha256),
        status: "failed",
        reason: "deadline_exceeded",
        exitCode: null,
        ...(observationError === undefined
          ? {}
          : { error: errorMessage(observationError) }),
      });
    }

    let artifact: ModalResultArtifact | undefined;
    let artifactError: unknown;
    try {
      if (!sandbox) throw observationError ?? new Error("Sandbox unavailable");
      artifact = await readValidatedResult(this.#dependencies, sandbox, request);
    } catch (error) {
      artifactError = error;
      artifact = undefined;
    } finally {
      if (sandbox) await sandbox.detach();
    }

    if (!artifact) {
      return this.#deliverTerminal({
        taskId: request.taskId,
        sandboxId: request.sandboxId,
        completionKey: modalMonitorTerminalKey(request.taskId, request.handoffSha256),
        status: "failed",
        reason: "invalid_result",
        exitCode,
        error: errorMessage(artifactError),
      });
    }

    if (exitCode !== 0 && artifact.status === "succeeded") {
      return this.#deliverTerminal({
        taskId: request.taskId,
        sandboxId: request.sandboxId,
        completionKey: modalMonitorTerminalKey(request.taskId, request.handoffSha256),
        status: "failed",
        reason: "nonzero_exit",
        exitCode,
        result: artifact,
        error: `Sandbox exited with code ${exitCode}`,
      });
    }

    return this.#deliverTerminal({
      taskId: request.taskId,
      sandboxId: request.sandboxId,
      completionKey: modalMonitorTerminalKey(request.taskId, request.handoffSha256),
      status: artifact.status,
      reason: "result",
      exitCode,
      result: artifact,
    });
  }

  async #deliverTerminal(
    event: ModalTerminalEvent,
  ): Promise<ModalMonitorOutcome> {
    const callbackInvoked = await this.#once.runOnce(event.completionKey, () =>
      this.#dependencies.onTerminal(event),
    );
    return { kind: "terminal", event, callbackInvoked };
  }
}

export function createModalMonitor(
  dependencies: ModalMonitorDependencies,
): ModalMonitor {
  return new ModalMonitor(dependencies);
}

export async function runModalMonitor(
  request: ModalMonitorRequest,
  dependencies: ModalMonitorDependencies,
): Promise<ModalMonitorOutcome> {
  return new ModalMonitor(dependencies).run(request);
}
