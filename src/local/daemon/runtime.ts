import { hostname } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ClaudeAgentAdapter, CodexAgentAdapter } from "../../agents/index.js";
import { stopAllDexLocalAgentProcesses } from "../../agents/process.js";
import { ModalTaskMover, type ModalMonitorRegistration } from "../../cloud/modal-task-mover.js";
import {
  ModalResultWithAuthPersistenceSchema,
} from "../../cloud/control-plane/models.js";
import type { DexVerifiedCommand } from "../../cloud/messaging/index.js";
import { DexCloudProtocolError } from "../../cloud/messaging/index.js";
import type { DexConfig } from "../../config/config.js";
import type { DexPaths } from "../../config/paths.js";
import { DexOrchestrator, DexTerminalOutcomeQueuedError } from "../../dex/orchestrator.js";
import { MessageRouter } from "../../dex/router.js";
import { MemoryContinuity } from "../../memory/index.js";
import { EventLog } from "../../state/events.js";
import type { DexProject, DexState } from "../../state/schemas.js";
import { DexStateStore } from "../../state/store.js";
import { LocalTerminalEffectJournalSchema, TaskManager } from "../../tasks/task-manager.js";
import { eventId } from "../../utils/ids.js";
import { redactString } from "../../utils/redact.js";
import { BatteryMonitor } from "../battery-monitor.js";
import {
  CloudResultCompletionSchema,
  CloudResultImportError,
  CloudResultImporter,
  type CloudResultImportResult,
} from "../cloud-result/index.js";
import { MacMachineController } from "../machine/mac-machine.js";
import { DexPairingService, MacOSDexKeychain } from "../pairing/index.js";
import { simulatedBatteryReading } from "../power/battery.js";
import { DexCloudBridge } from "./cloud-bridge.js";
import { DexPowerController } from "./power-controller.js";
import {
  releaseCodexAuthLease,
  type CodexAuthLeaseReleaseEvidence,
} from "../../setup/modal-auth.js";

const ACTIVE_TASK_STATUSES = new Set(["queued", "preparing", "running", "waiting_user", "checkpointing", "handoff"]);
const PLAIN_YES_NO = /^(yes|no)[.!?]?$/i;

const MessagePayloadSchema = z.object({
  text: z.string().min(1).max(20_000),
  conversationId: z.string().min(1).max(512),
  messageId: z.string().min(1).max(512).optional(),
  taskId: z.string().min(1).max(512).optional(),
  cloudTaskId: z.string().min(1).max(512).optional(),
}).passthrough();

const BatteryPayloadSchema = z.object({
  percent: z.number().int().min(0).max(100),
}).passthrough();

const CloudCompletionPayloadSchema = CloudResultCompletionSchema.extend({
  workerId: z.string().min(1).optional(),
  summary: z.string().min(1).max(10_000),
  exitCode: z.number().int().nullable().optional(),
  result: ModalResultWithAuthPersistenceSchema.optional(),
  sandboxTerminal: z.object({
    kind: z.enum(["poll", "terminate_wait"]),
    volumePersisted: z.literal(true),
  }).strict().optional(),
  tests: z.object({
    command: z.string().optional(),
    passed: z.number().int().min(0).optional(),
    failed: z.number().int().min(0).optional(),
    summary: z.string().optional(),
  }).optional(),
}).superRefine((completion, context) => {
  const evidence = completion.result?.authVolumePersisted;
  if (!evidence) return;
  if (
    evidence.taskId !== completion.taskId
    || evidence.handoffSha256 !== (completion.handoffSha256 ?? completion.result?.handoffSha256)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["result", "authVolumePersisted"],
      message: "Auth persistence evidence is not bound to this cloud completion",
    });
  }
});

type CloudCompletionPayload = z.infer<typeof CloudCompletionPayloadSchema>;

const PendingCloudResultImportSchema = z.object({
  version: z.literal(1),
  commandId: z.string().min(1).max(512),
  completion: CloudCompletionPayloadSchema,
  conversationId: z.string().min(1).max(512).optional(),
  attempts: z.number().int().min(1).max(1_000),
  firstFailedAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime(),
  lastFailure: z.object({
    code: z.string().min(1).max(128),
    failedAt: z.string().datetime(),
  }).strict(),
}).strict();

type PendingCloudResultImport = z.infer<typeof PendingCloudResultImportSchema>;

const CodexAuthLeaseReleaseEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("terminal-poll"),
    sandboxId: z.string().min(1),
    exitCode: z.number().int(),
    operationToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal("terminate-wait"),
    sandboxId: z.string().min(1),
    volumePersisted: z.literal(true),
    operationToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal("sandbox-not-created"),
    operationToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal("auth-volume-sync"),
    sandboxId: z.string().min(1),
    handoffSha256: z.string().regex(/^[a-f0-9]{64}$/),
    authSha256: z.string().regex(/^[a-f0-9]{64}$/),
    persistedAt: z.string().datetime(),
    operationToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);

const CloudCompletionEffectJournalSchema = z.object({
  version: z.literal(1),
  commandId: z.string().min(1).max(512),
  completion: CloudCompletionPayloadSchema,
  finalStatus: z.enum(["succeeded", "failed", "cancelled"]),
  summary: z.string().min(1).max(20_000),
  resultImport: z.record(z.string(), z.unknown()).optional(),
  operationToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  leaseReleaseEvidence: CodexAuthLeaseReleaseEvidenceSchema.optional(),
  eventId: z.string().min(1),
  effects: z.object({
    sandboxTerminated: z.boolean(),
    eventAppended: z.boolean(),
    leaseReleased: z.boolean(),
    queueDrained: z.boolean(),
    receiptQueued: z.boolean(),
    receiptAccepted: z.boolean(),
    powerChecked: z.boolean(),
  }).strict(),
  phase: z.enum(["pending", "complete"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

type CloudCompletionEffectJournal = z.infer<typeof CloudCompletionEffectJournalSchema>;
type CloudCompletionEffectName = keyof CloudCompletionEffectJournal["effects"];

function cloudCompletionEffectsAreReadyForPower(state: DexState): boolean {
  for (const task of Object.values(state.tasks)) {
    const raw = task.metadata.cloudCompletionEffects;
    if (raw === undefined) continue;
    const parsed = CloudCompletionEffectJournalSchema.safeParse(raw);
    if (!parsed.success) return false;
    const effects = parsed.data.effects;
    if (
      !effects.sandboxTerminated ||
      !effects.eventAppended ||
      !effects.leaseReleased ||
      !effects.queueDrained ||
      !effects.receiptQueued ||
      !effects.receiptAccepted
    ) {
      return false;
    }
  }
  return true;
}

export function localTerminalEffectsAreReadyForPower(state: DexState): boolean {
  for (const task of Object.values(state.tasks)) {
    const raw = task.metadata.localTerminalEffects;
    if (raw === undefined) continue;
    const parsed = LocalTerminalEffectJournalSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.phase !== "complete" ||
      task.metadata.terminalNotificationEventId !== parsed.data.eventId
    ) return false;
  }
  return true;
}

export function terminalEffectsAreReadyForPower(state: DexState): boolean {
  return cloudCompletionEffectsAreReadyForPower(state) && localTerminalEffectsAreReadyForPower(state);
}

async function confirmAcceptedLocalTerminalNotifications(store: DexStateStore): Promise<number> {
  const snapshot = await store.read();
  const pendingSnapshot = new Set(snapshot.pendingTransportEvents.map(({ id }) => id));
  const hasCandidate = Object.values(snapshot.tasks).some((task) => {
    const parsed = LocalTerminalEffectJournalSchema.safeParse(task.metadata.localTerminalEffects);
    return parsed.success &&
      parsed.data.phase === "notification_pending" &&
      task.metadata.terminalNotificationEventId === parsed.data.eventId &&
      !pendingSnapshot.has(parsed.data.eventId);
  });
  if (!hasCandidate) return 0;
  let confirmed = 0;
  await store.updateState((state) => {
    const pendingEventIds = new Set(state.pendingTransportEvents.map(({ id }) => id));
    const timestamp = new Date().toISOString();
    for (const task of Object.values(state.tasks)) {
      const parsed = LocalTerminalEffectJournalSchema.safeParse(task.metadata.localTerminalEffects);
      if (
        !parsed.success ||
        parsed.data.phase !== "notification_pending" ||
        task.metadata.terminalNotificationEventId !== parsed.data.eventId ||
        pendingEventIds.has(parsed.data.eventId)
      ) {
        continue;
      }
      task.metadata.localTerminalEffects = {
        ...parsed.data,
        phase: "complete",
        acceptedAt: timestamp,
        updatedAt: timestamp,
      };
      task.updatedAt = timestamp;
      confirmed += 1;
    }
  });
  return confirmed;
}

class StaleCloudCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleCloudCompletionError";
  }
}

function assertOwnedCloudCompletion(
  state: DexState,
  completion: CloudCompletionPayload,
): {
  task: DexState["tasks"][string];
  workerId: string;
  sandboxId: string;
  operationToken?: string;
} {
  const task = state.tasks[completion.taskId];
  if (!task) throw new StaleCloudCompletionError(`Unknown completed cloud task: ${completion.taskId}`);
  if (!completion.workerId || task.currentWorkerId !== completion.workerId) {
    throw new StaleCloudCompletionError(`Stale cloud completion does not own task ${completion.taskId}`);
  }
  const worker = state.workers[completion.workerId];
  if (!worker || worker.taskId !== task.id || worker.target.kind !== "modal") {
    throw new StaleCloudCompletionError(`Cloud completion worker ownership is invalid for ${completion.taskId}`);
  }
  if (!["starting", "running", "waiting"].includes(worker.status) ||
      !["checkpointing", "handoff", "running"].includes(task.status)) {
    throw new StaleCloudCompletionError(`Stale cloud completion targets a terminal Dex task ${completion.taskId}`);
  }
  const sandboxId = completion.sandboxId ?? completion.sandbox?.id;
  if (!sandboxId || worker.target.sandboxId !== sandboxId) {
    throw new StaleCloudCompletionError(`Cloud completion sandbox ownership is invalid for ${completion.taskId}`);
  }
  const journal = task.metadata.modalHandoffJournal;
  const journalRecord = journal && typeof journal === "object" && !Array.isArray(journal)
    ? journal as Record<string, unknown>
    : undefined;
  const expectedHandoff = typeof task.metadata.handoffHash === "string"
    ? task.metadata.handoffHash
    : typeof journalRecord?.handoffSha256 === "string" ? journalRecord.handoffSha256 : undefined;
  const completionHandoff = completion.handoffSha256 ?? completion.result?.handoffSha256;
  if (!expectedHandoff || !completionHandoff || expectedHandoff !== completionHandoff) {
    throw new StaleCloudCompletionError(`Cloud completion handoff ownership is invalid for ${completion.taskId}`);
  }
  const operationToken = typeof journalRecord?.operationToken === "string"
    ? journalRecord.operationToken
    : undefined;
  return { task, workerId: completion.workerId, sandboxId, ...(operationToken ? { operationToken } : {}) };
}

interface RuntimeCloudResultImporter {
  import(input: {
    task: Parameters<CloudResultImporter["import"]>[0]["task"];
    completion: unknown;
    beforeApply?: () => Promise<void>;
  }): Promise<CloudResultImportResult>;
  terminateRetainedSandbox?(sandboxId: string): Promise<boolean>;
}

export interface DexDaemonRuntimeOptions {
  paths: DexPaths;
  config: DexConfig;
  store?: DexStateStore;
  events?: EventLog;
  signal?: AbortSignal;
}

export class DexDaemonRuntime {
  readonly #bridge: DexCloudBridge;
  readonly #router: MessageRouter;
  readonly #orchestrator: DexOrchestrator;
  readonly #store: DexStateStore;
  readonly #events: EventLog;
  readonly #battery: BatteryMonitor;
  readonly #power: DexPowerController;
  readonly #tasks: TaskManager | undefined;
  readonly #resultImporter: RuntimeCloudResultImporter;
  readonly #codexAuthLeasePath: string;
  readonly #releaseCodexAuthLease: typeof releaseCodexAuthLease;
  #resultImportTail: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(options: {
    bridge: DexCloudBridge;
    router: MessageRouter;
    orchestrator: DexOrchestrator;
    store: DexStateStore;
    events: EventLog;
    battery: BatteryMonitor;
    power: DexPowerController;
    tasks?: TaskManager;
    resultImporter?: RuntimeCloudResultImporter;
    codexAuthLeasePath: string;
    releaseCodexAuthLease?: typeof releaseCodexAuthLease;
  }) {
    this.#bridge = options.bridge;
    this.#router = options.router;
    this.#orchestrator = options.orchestrator;
    this.#store = options.store;
    this.#events = options.events;
    this.#battery = options.battery;
    this.#power = options.power;
    this.#tasks = options.tasks;
    this.#resultImporter = options.resultImporter ?? new CloudResultImporter();
    this.#codexAuthLeasePath = options.codexAuthLeasePath;
    this.#releaseCodexAuthLease = options.releaseCodexAuthLease ?? releaseCodexAuthLease;
  }

  async run(signal?: AbortSignal): Promise<void> {
    await this.#power.reconcileStartup();
    this.#battery.start();
    const stop = () => { this.#stopped = true; };
    signal?.addEventListener("abort", stop, { once: true });
    let backoffMs = 1_000;
    try {
      while (!this.#stopped && !signal?.aborted) {
        try {
          await this.retryPendingCloudResultImports().catch(() => undefined);
          // Finish non-power effects before polling. The subsequent sync
          // durably flushes any pending command receipts/outbox messages
          // before a replayed sleep check is allowed to suspend this Mac.
          await this.retryPendingCloudCompletionEffects({ includePower: false })
            .catch(() => undefined);
          await this.#ensurePendingCloudCompletionReceipts().catch(() => undefined);
          const commands = await this.#bridge.syncOnce(25_000);
          await this.#confirmAcceptedLocalTerminalNotifications();
          for (const command of commands) await this.handleCommand(command);
          await this.#confirmAcceptedCloudCompletionReceipts();
          await this.retryPendingCloudCompletionEffects({ includePower: true })
            .catch(() => undefined);
          await this.#maybeSleepWhenCompletionReceiptsAccepted();
          // The cloud endpoint may return before the requested long-poll
          // window when no command is queued. Avoid a hot network loop.
          if (commands.length === 0) await delay(1_000, signal);
          backoffMs = 1_000;
        } catch (error) {
          if (signal?.aborted || this.#stopped) break;
          await delay(backoffMs, signal);
          backoffMs = Math.min(30_000, backoffMs * 2);
          if (error instanceof Error && /verification|authority|signature/i.test(error.message)) {
            // Fail closed, but keep polling so a corrected signed command can
            // be delivered without reinstalling the daemon.
          }
        }
      }
    } finally {
      this.#battery.stop();
      signal?.removeEventListener("abort", stop);
    }
  }

  stop(): void {
    this.#stopped = true;
  }

  async shutdown(): Promise<void> {
    this.stop();
    this.#battery.stop();
    const failures: unknown[] = [];
    await stopAllDexLocalAgentProcesses().catch((error) => failures.push(error));
    await this.#power.releaseForShutdown().catch((error) => failures.push(error));
    if (failures.length > 0) {
      throw new AggregateError(failures, "Dex daemon shutdown failed");
    }
  }

  async handleCommand(command: DexVerifiedCommand): Promise<void> {
    const type = command.command.type;
    const payload = command.command.payload;
    let cloudCompletionTaskId: string | undefined;
    let processed = false;
    try {
      if (type === "message.received") {
        const message = MessagePayloadSchema.parse(payload);
        const messageId = message.messageId ?? command.id;
        const cloudTaskId = message.cloudTaskId ?? message.taskId;
        if (!(await this.#claimMessage(messageId, command.id))) {
          await this.#bridge.receipt(command.id, "duplicate");
          await this.#bridge.syncOnce(0);
          await this.#confirmAcceptedLocalTerminalNotifications();
          return;
        }
        await this.#events.append({
          type: "message.received",
          payload: {
            conversationId: message.conversationId,
            messageId,
            text: message.text,
            ...(cloudTaskId ? { cloudTaskId } : {}),
          },
        });
        const context = {
          conversationId: message.conversationId,
          messageId,
          sourceMessageId: messageId,
          ...(cloudTaskId ? { cloudTaskId } : {}),
        };
        const followUp = await this.#handleConversationFollowUp(message.text, context);
        let reply: string;
        if (followUp !== undefined) {
          reply = followUp;
        } else {
          const route = await this.#router.route(message.text);
          // Integration note: an immediate CREATE_TASK acknowledgement belongs
          // inside the orchestrator, after durable task creation but before
          // worker startup. A runtime-level pre-ack could claim work that was
          // never persisted and would duplicate the orchestrator's final reply.
          reply = await this.#orchestrator.handle(route.actions, context);
        }
        if (reply) await this.#bridge.notify(message.conversationId, reply, false);
      } else if (type === "demo.battery") {
        const { percent } = BatteryPayloadSchema.parse(payload);
        await this.#battery.handleBatteryReading(simulatedBatteryReading({
          batteryPercent: percent,
          charging: false,
          powerSource: "battery",
          remainingMinutes: null,
        }));
      } else if (type === "power.restore") {
        await this.#power.restore();
      } else if (type === "task.cloud.completed") {
        const completion = CloudCompletionPayloadSchema.parse(payload);
        cloudCompletionTaskId = completion.taskId;
        await this.#serializeResultImport(() => this.#handleCloudCompletion(
          completion,
          command.authority.conversationId,
          command.id,
        ));
      } else {
        throw new Error(`Unsupported Dex command: ${type}`);
      }
      await this.#bridge.receipt(command.id, "processed");
      processed = true;
      if (cloudCompletionTaskId) {
        const journal = await this.#readCloudCompletionEffectJournal(cloudCompletionTaskId);
        if (journal?.commandId === command.id) {
          await this.#markCloudCompletionEffect(
            cloudCompletionTaskId,
            journal.eventId,
            "receiptQueued",
          ).catch(() => undefined);
        }
      }
    } catch (error) {
      if (error instanceof DexTerminalOutcomeQueuedError) {
        await this.#bridge.receipt(command.id, "processed");
        processed = true;
      } else {
        const reason = redactString(error instanceof Error ? error.message : String(error));
        await this.#bridge.receipt(command.id, "rejected", reason);
        const conversationId = command.authority.conversationId;
        if (conversationId && !(error instanceof StaleCloudCompletionError)) {
          await this.#bridge.notify(conversationId, `i couldn't complete that request: ${reason}`, false);
        }
      }
    }
    await this.#bridge.syncOnce(0);
    await this.#confirmAcceptedLocalTerminalNotifications();
    if (processed && cloudCompletionTaskId) {
      await this.#confirmAcceptedCloudCompletionReceipts(cloudCompletionTaskId)
        .catch(() => undefined);
      // A sleep request is the last replayable effect and is only evaluated
      // after the processed receipt and completion outbox have reached Dex
      // Cloud. This prevents suspending the local relay in the crash window.
      await this.#serializeResultImport(async () => {
        await this.#resumeCloudCompletionEffects(cloudCompletionTaskId, { includePower: true })
          .catch(() => undefined);
      });
      await this.#bridge.syncOnce(0);
      await this.#confirmAcceptedLocalTerminalNotifications();
    }
  }

  /**
   * Retries cloud-result imports that were durably accepted from Dex Cloud but
   * could not yet be synchronized into the local task worktree. The terminal
   * command can be acknowledged once this retry owner is persisted.
   */
  retryPendingCloudResultImports(options: { force?: boolean } = {}): Promise<number> {
    return this.#serializeResultImport(async () => {
      const snapshot = await this.#store.read();
      const now = Date.now();
      const candidates = Object.values(snapshot.tasks).flatMap((task) => {
        const parsed = PendingCloudResultImportSchema.safeParse(
          task.metadata.pendingCloudResultImport,
        );
        if (!parsed.success) return [];
        if (!options.force && Date.parse(parsed.data.nextAttemptAt) > now) return [];
        return [{ taskId: task.id, pending: parsed.data }];
      });
      let attempted = 0;
      for (const candidate of candidates) {
        attempted += 1;
        try {
          await this.#handleCloudCompletion(
            candidate.pending.completion,
            candidate.pending.conversationId,
            candidate.pending.commandId,
            candidate.pending,
          );
        } catch (error) {
          if (!(error instanceof StaleCloudCompletionError)) throw error;
          await this.#store.updateState((state) => {
            const task = state.tasks[candidate.taskId];
            if (!task) return;
            const current = PendingCloudResultImportSchema.safeParse(
              task.metadata.pendingCloudResultImport,
            );
            if (!current.success) return;
            if (
              current.data.completion.workerId === candidate.pending.completion.workerId
              && current.data.completion.sandboxId === candidate.pending.completion.sandboxId
              && current.data.completion.handoffSha256 === candidate.pending.completion.handoffSha256
            ) {
              delete task.metadata.pendingCloudResultImport;
              task.metadata.resultImport = {
                status: "abandoned",
                code: "stale_ownership",
                abandonedAt: new Date().toISOString(),
              };
            }
          });
        }
      }
      return attempted;
    });
  }

  retryPendingCloudCompletionEffects(
    options: { includePower?: boolean } = {},
  ): Promise<number> {
    return this.#serializeResultImport(async () => {
      const snapshot = await this.#store.read();
      const candidates: string[] = [];
      const failures: unknown[] = [];
      for (const task of Object.values(snapshot.tasks)) {
        const raw = task.metadata.cloudCompletionEffects;
        if (raw === undefined) continue;
        const parsed = CloudCompletionEffectJournalSchema.safeParse(
          raw,
        );
        if (!parsed.success) {
          failures.push(new Error(`Task ${task.id} has an invalid cloud-completion effect journal`));
        } else if (parsed.data.phase === "pending") {
          candidates.push(task.id);
        }
      }
      let attempted = 0;
      for (const taskId of candidates) {
        attempted += 1;
        await this.#resumeCloudCompletionEffects(taskId, {
          includePower: options.includePower === true,
        }).catch((error) => failures.push(error));
      }
      if (failures.length > 0) {
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(
          failures,
          `Could not finish ${failures.length} durable cloud-completion effect journal${failures.length === 1 ? "" : "s"}`,
        );
      }
      return attempted;
    });
  }

  async #ensurePendingCloudCompletionReceipts(taskId?: string): Promise<number> {
    const snapshot = await this.#store.read();
    const journals = Object.values(snapshot.tasks).flatMap((task) => {
      if (taskId && task.id !== taskId) return [];
      const parsed = CloudCompletionEffectJournalSchema.safeParse(
        task.metadata.cloudCompletionEffects,
      );
      if (!parsed.success || parsed.data.phase === "complete" || parsed.data.effects.receiptQueued) {
        return [];
      }
      return [{ taskId: task.id, journal: parsed.data }];
    });
    let queued = 0;
    for (const { taskId: journalTaskId, journal } of journals) {
      await this.#bridge.receipt(journal.commandId, "processed");
      await this.#markCloudCompletionEffect(
        journalTaskId,
        journal.eventId,
        "receiptQueued",
      );
      queued += 1;
    }
    return queued;
  }

  async #confirmAcceptedCloudCompletionReceipts(taskId?: string): Promise<number> {
    const snapshot = await this.#store.read();
    const pendingReceiptIds = new Set(
      snapshot.pendingTransportReceipts.map(({ commandId }) => commandId),
    );
    const accepted = Object.values(snapshot.tasks).flatMap((task) => {
      if (taskId && task.id !== taskId) return [];
      const parsed = CloudCompletionEffectJournalSchema.safeParse(
        task.metadata.cloudCompletionEffects,
      );
      if (
        !parsed.success ||
        parsed.data.phase === "complete" ||
        !parsed.data.effects.receiptQueued ||
        parsed.data.effects.receiptAccepted ||
        pendingReceiptIds.has(parsed.data.commandId)
      ) {
        return [];
      }
      return [{ taskId: task.id, journal: parsed.data }];
    });
    for (const { taskId: journalTaskId, journal } of accepted) {
      await this.#markCloudCompletionEffect(
        journalTaskId,
        journal.eventId,
        "receiptAccepted",
      );
    }
    return accepted.length;
  }

  /**
   * The ordinary power loop still needs to handle local-only completions, but
   * a cloud completion must never make the machine disappear before every
   * replayable effect is complete. Invalid and pending journals fail closed:
   * recovery can repair/report them while the Mac remains reachable.
   */
  async #maybeSleepWhenCompletionReceiptsAccepted(): Promise<void> {
    const snapshot = await this.#store.read();
    for (const task of Object.values(snapshot.tasks)) {
      const raw = task.metadata.cloudCompletionEffects;
      if (raw === undefined) continue;
      const parsed = CloudCompletionEffectJournalSchema.safeParse(raw);
      if (!parsed.success || parsed.data.phase !== "complete") return;
    }
    await this.#power.maybeSleepWhenReady();
  }

  async #handleCloudCompletion(
    completion: CloudCompletionPayload,
    conversationId?: string,
    commandId?: string,
    pending?: PendingCloudResultImport,
  ): Promise<void> {
    const effectiveCommandId = commandId ?? pending?.commandId;
    if (!effectiveCommandId) {
      throw new Error("Cloud completion is missing its durable command identity");
    }
    const snapshot = await this.#store.read();
    const existingTask = snapshot.tasks[completion.taskId];
    const existingJournal = existingTask
      ? CloudCompletionEffectJournalSchema.safeParse(
        existingTask.metadata.cloudCompletionEffects,
      )
      : undefined;
    if (
      existingTask &&
      !ACTIVE_TASK_STATUSES.has(existingTask.status) &&
      existingJournal?.success === true &&
      isDeepStrictEqual(existingJournal.data.completion, completion)
    ) {
      await this.#resumeCloudCompletionEffects(existingTask.id, { includePower: false })
        .catch(() => undefined);
      return;
    }
    const ownership = assertOwnedCloudCompletion(snapshot, completion);
    let leaseReleaseEvidence = this.#terminalLeaseEvidence(completion, ownership);
    {
      if (completion.status === "succeeded" && completion.result?.status === "succeeded") {
        const taskBeforeImport = ownership.task;
        try {
          const imported = await this.#resultImporter.import({
            task: taskBeforeImport,
            completion,
            beforeApply: async () => {
              assertOwnedCloudCompletion(await this.#store.read(), completion);
            },
          });
          const resultImport = {
            status: "completed",
            ...imported,
            importedAt: new Date().toISOString(),
          };
          if (imported.sandboxTerminated && ownership.operationToken) {
            leaseReleaseEvidence = {
              kind: "terminate-wait",
              sandboxId: ownership.sandboxId,
              volumePersisted: true,
              operationToken: ownership.operationToken,
            };
          }
          await this.#finalizeCloudCompletion(
            completion,
            effectiveCommandId,
            "succeeded",
            completion.summary,
            resultImport,
            leaseReleaseEvidence,
            !imported.sandboxTerminated && !completion.sandboxTerminal && !leaseReleaseEvidence,
          );
          return;
        } catch (error) {
          if (error instanceof StaleCloudCompletionError) throw error;
          const code = error instanceof CloudResultImportError ? error.code : "retrieval_failed";
          const recoverable = error instanceof CloudResultImportError ? error.recoverable : true;
          const failedAt = new Date().toISOString();
          const resultImport = {
            status: "failed",
            code,
            recoverable,
            failedAt,
          };
          if (recoverable) {
            await this.#persistPendingCloudResultImport({
              commandId: effectiveCommandId,
              completion,
              ...(conversationId ? { conversationId } : {}),
              ...(pending ? { previous: pending } : {}),
              code,
              resultImport,
            });
            return;
          }
          await this.#finalizeCloudCompletion(
            completion,
            effectiveCommandId,
            "failed",
            `${completion.summary} Dex could not safely import the cloud result.`,
            resultImport,
            leaseReleaseEvidence,
            !completion.sandboxTerminal && !leaseReleaseEvidence,
          );
          return;
        }
      }

      await this.#finalizeCloudCompletion(
        completion,
        effectiveCommandId,
        completion.status,
        completion.summary,
        undefined,
        leaseReleaseEvidence,
        !completion.sandboxTerminal && !leaseReleaseEvidence,
      );
    }
  }

  #terminalLeaseEvidence(
    completion: CloudCompletionPayload,
    ownership: ReturnType<typeof assertOwnedCloudCompletion>,
  ): CodexAuthLeaseReleaseEvidence | undefined {
    if (!ownership.operationToken) return undefined;
    const persisted = completion.result?.authVolumePersisted;
    if (persisted) {
      return {
        kind: "auth-volume-sync",
        sandboxId: ownership.sandboxId,
        handoffSha256: persisted.handoffSha256,
        authSha256: persisted.authSha256,
        persistedAt: persisted.persistedAt,
        operationToken: ownership.operationToken,
      };
    }
    if (!completion.sandboxTerminal) return undefined;
    if (completion.sandboxTerminal.kind === "poll") {
      if (completion.exitCode === undefined || completion.exitCode === null) {
        throw new Error("Cloud terminal-poll evidence is missing its exit code");
      }
      return {
        kind: "terminal-poll",
        sandboxId: ownership.sandboxId,
        exitCode: completion.exitCode,
        operationToken: ownership.operationToken,
      };
    }
    return {
      kind: "terminate-wait",
      sandboxId: ownership.sandboxId,
      volumePersisted: true,
      operationToken: ownership.operationToken,
    };
  }

  async #persistPendingCloudResultImport(input: {
    commandId: string;
    completion: CloudCompletionPayload;
    conversationId?: string;
    previous?: PendingCloudResultImport;
    code: string;
    resultImport: Record<string, unknown>;
  }): Promise<void> {
    const now = new Date();
    const attempts = (input.previous?.attempts ?? 0) + 1;
    const failedAt = now.toISOString();
    const delayMs = Math.min(5 * 60_000, 10_000 * 2 ** Math.min(5, attempts - 1));
    const taskSnapshot = assertOwnedCloudCompletion(
      await this.#store.read(),
      input.completion,
    ).task;
    const effectiveConversationId = input.conversationId
      ?? (typeof taskSnapshot.metadata.conversationId === "string"
        ? taskSnapshot.metadata.conversationId
        : undefined);
    const pending = PendingCloudResultImportSchema.parse({
      version: 1,
      commandId: input.commandId,
      completion: input.completion,
      ...(effectiveConversationId ? { conversationId: effectiveConversationId } : {}),
      attempts,
      firstFailedAt: input.previous?.firstFailedAt ?? failedAt,
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
      lastFailure: { code: input.code, failedAt },
    });
    await this.#store.updateState((state) => {
      const { task, workerId } = assertOwnedCloudCompletion(state, input.completion);
      task.status = "running";
      task.stage = "waiting";
      task.latestSummary = `${input.completion.summary} syncing the validated cloud result back to this mac`;
      task.nextStep = "retrying cloud result synchronization";
      delete task.blockedReason;
      task.updatedAt = failedAt;
      task.metadata.pendingCloudResultImport = pending;
      task.metadata.resultImport = {
        ...input.resultImport,
        status: "pending",
        code: input.code,
        recoverable: true,
        attempts,
        nextAttemptAt: pending.nextAttemptAt,
      };
      if (input.completion.tests) task.testStatus = input.completion.tests;
      const worker = state.workers[workerId];
      if (worker) {
        worker.status = "waiting";
        worker.lastMessage = task.latestSummary;
        delete worker.endedAt;
      }
    });
    if (!input.previous && effectiveConversationId) {
      await this.#bridge.notify(
        effectiveConversationId,
        `${taskSnapshot.title} finished in the cloud. i'm safely syncing the result back to this mac now.`,
      ).catch(() => undefined);
    }
  }

  async #finalizeCloudCompletion(
    completion: CloudCompletionPayload,
    commandId: string,
    status: "succeeded" | "failed" | "cancelled",
    summary: string,
    resultImport?: Record<string, unknown>,
    leaseReleaseEvidence?: CodexAuthLeaseReleaseEvidence,
    sandboxTerminationRequired = false,
  ): Promise<void> {
    const ownership = assertOwnedCloudCompletion(await this.#store.read(), completion);
    if (sandboxTerminationRequired && !this.#resultImporter.terminateRetainedSandbox) {
      throw new Error("Cloud completion cannot durably terminate its retained sandbox");
    }
    if (ownership.operationToken && !leaseReleaseEvidence && !sandboxTerminationRequired) {
      throw new Error("Cloud completion is missing terminal sandbox evidence for its Codex auth lease");
    }
    const now = new Date().toISOString();
    const completionEventId = eventId();
    const journal = CloudCompletionEffectJournalSchema.parse({
      version: 1,
      commandId,
      completion,
      finalStatus: status,
      summary,
      ...(resultImport ? { resultImport } : {}),
      ...(ownership.operationToken ? { operationToken: ownership.operationToken } : {}),
      ...(leaseReleaseEvidence ? { leaseReleaseEvidence } : {}),
      eventId: completionEventId,
      effects: {
        sandboxTerminated: !sandboxTerminationRequired,
        eventAppended: false,
        leaseReleased: ownership.operationToken === undefined,
        queueDrained: false,
        receiptQueued: false,
        receiptAccepted: false,
        powerChecked: false,
      },
      phase: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await this.#store.updateState((state) => {
      const { task, workerId } = assertOwnedCloudCompletion(state, completion);
      task.status = status === "succeeded"
        ? "completed"
        : status === "cancelled" ? "cancelled" : "failed";
      task.stage = status === "succeeded" ? "done" : "failed";
      task.latestSummary = summary;
      task.updatedAt = now;
      delete task.metadata.pendingCloudResultImport;
      if (resultImport) task.metadata.resultImport = resultImport;
      task.metadata.cloudCompletionEffects = journal;
      if (status === "succeeded") {
        delete task.blockedReason;
        delete task.nextStep;
      }
      if (completion.tests) task.testStatus = completion.tests;
      const worker = state.workers[workerId];
      if (worker) {
        worker.status = status === "succeeded"
          ? "completed"
          : status === "cancelled" ? "stopped" : "failed";
        worker.lastMessage = summary;
        worker.endedAt = now;
        if (completion.exitCode !== undefined && completion.exitCode !== null) {
          worker.exitCode = completion.exitCode;
        }
      }
    });
    // Terminal state and the replay owner are committed atomically. A
    // post-commit failure therefore leaves enough evidence for startup or a
    // duplicate cloud callback to finish every effect safely.
    await this.#resumeCloudCompletionEffects(completion.taskId, { includePower: false })
      .catch(() => undefined);
  }

  async #resumeCloudCompletionEffects(
    taskId: string,
    options: { includePower: boolean },
  ): Promise<void> {
    let journal = await this.#readCloudCompletionEffectJournal(taskId);
    if (!journal || journal.phase === "complete") return;

    if (!journal.effects.sandboxTerminated) {
      const sandboxId = journal.completion.sandboxId ?? journal.completion.sandbox?.id;
      if (!sandboxId || !this.#resultImporter.terminateRetainedSandbox) {
        throw new Error(`Cloud completion ${taskId} cannot terminate its retained sandbox`);
      }
      const terminated = await this.#resultImporter.terminateRetainedSandbox(sandboxId);
      if (!terminated) {
        throw new Error(`Cloud completion ${taskId} is waiting for retained sandbox termination`);
      }
      await this.#markCloudCompletionSandboxTerminated(taskId, journal.eventId, sandboxId);
      journal = await this.#readCloudCompletionEffectJournal(taskId);
      if (!journal) return;
    }

    if (!journal.effects.eventAppended) {
      await this.#events.append({
        id: journal.eventId,
        type: journal.finalStatus === "succeeded" ? "task.completed" : "task.failed",
        taskId,
        payload: {
          status: journal.finalStatus,
          summary: journal.summary,
          source: "modal-monitor",
          ...(journal.resultImport ? { resultImport: journal.resultImport } : {}),
        },
      });
      await this.#markCloudCompletionEffect(taskId, journal.eventId, "eventAppended");
      journal = await this.#readCloudCompletionEffectJournal(taskId);
      if (!journal) return;
    }

    if (!journal.effects.leaseReleased) {
      if (!journal.leaseReleaseEvidence) {
        throw new Error(`Cloud completion ${taskId} is missing durable lease-release evidence`);
      }
      await this.#releaseCodexAuthLease(
        this.#codexAuthLeasePath,
        taskId,
        journal.leaseReleaseEvidence,
      );
      await this.#markCloudCompletionEffect(taskId, journal.eventId, "leaseReleased");
      journal = await this.#readCloudCompletionEffectJournal(taskId);
      if (!journal) return;
    }

    if (!journal.effects.queueDrained) {
      await this.#orchestrator.drainQueue();
      await this.#markCloudCompletionEffect(taskId, journal.eventId, "queueDrained");
      journal = await this.#readCloudCompletionEffectJournal(taskId);
      if (!journal) return;
    }

    if (
      options.includePower &&
      journal.effects.receiptAccepted &&
      !journal.effects.powerChecked
    ) {
      await this.#power.maybeSleepWhenReady();
      await this.#markCloudCompletionEffect(taskId, journal.eventId, "powerChecked");
    }
  }

  async #readCloudCompletionEffectJournal(
    taskId: string,
  ): Promise<CloudCompletionEffectJournal | undefined> {
    const task = (await this.#store.read()).tasks[taskId];
    if (!task) return undefined;
    const parsed = CloudCompletionEffectJournalSchema.safeParse(
      task.metadata.cloudCompletionEffects,
    );
    return parsed.success ? parsed.data : undefined;
  }

  async #markCloudCompletionEffect(
    taskId: string,
    expectedEventId: string,
    effect: CloudCompletionEffectName,
  ): Promise<void> {
    await this.#store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) throw new StaleCloudCompletionError(`Cloud completion task disappeared: ${taskId}`);
      const parsed = CloudCompletionEffectJournalSchema.safeParse(
        task.metadata.cloudCompletionEffects,
      );
      if (!parsed.success || parsed.data.eventId !== expectedEventId) {
        throw new StaleCloudCompletionError(`Cloud completion replay ownership changed for ${taskId}`);
      }
      const next = parsed.data;
      next.effects[effect] = true;
      next.updatedAt = new Date().toISOString();
      next.phase = Object.values(next.effects).every(Boolean) ? "complete" : "pending";
      task.metadata.cloudCompletionEffects = next;
    });
  }

  async #markCloudCompletionSandboxTerminated(
    taskId: string,
    expectedEventId: string,
    sandboxId: string,
  ): Promise<void> {
    await this.#store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) throw new StaleCloudCompletionError(`Cloud completion task disappeared: ${taskId}`);
      const parsed = CloudCompletionEffectJournalSchema.safeParse(
        task.metadata.cloudCompletionEffects,
      );
      if (!parsed.success || parsed.data.eventId !== expectedEventId) {
        throw new StaleCloudCompletionError(`Cloud completion replay ownership changed for ${taskId}`);
      }
      const next = parsed.data;
      next.effects.sandboxTerminated = true;
      if (next.operationToken) {
        next.leaseReleaseEvidence = {
          kind: "terminate-wait",
          sandboxId,
          volumePersisted: true,
          operationToken: next.operationToken,
        };
      }
      next.updatedAt = new Date().toISOString();
      next.phase = Object.values(next.effects).every(Boolean) ? "complete" : "pending";
      task.metadata.cloudCompletionEffects = next;
    });
  }

  #serializeResultImport<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#resultImportTail.then(operation, operation);
    this.#resultImportTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async injectDemoBattery(percent: number): Promise<void> {
    await this.#battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: percent,
      charging: false,
      powerSource: "battery",
      remainingMinutes: null,
    }));
  }

  restorePower(): Promise<void> {
    return this.#power.restore();
  }

  recoverInterruptedTasks(): Promise<number> {
    return this.#orchestrator.recoverInterruptedTasks();
  }

  async #handleConversationFollowUp(
    text: string,
    context: { conversationId: string; messageId: string },
  ): Promise<string | undefined> {
    const answer = PLAIN_YES_NO.exec(text.trim())?.[1]?.toLowerCase();
    if (answer !== "yes" && answer !== "no") return undefined;
    const state = await this.#store.read();
    const prompt = state.pendingConversationPrompts
      .filter((candidate) => candidate.conversationId === context.conversationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!prompt) return undefined;
    const removePrompt = async (): Promise<void> => {
      await this.#store.updateState((draft) => {
        draft.pendingConversationPrompts = draft.pendingConversationPrompts.filter(
          (candidate) => candidate.id !== prompt.id,
        );
      });
    };
    if (Date.parse(prompt.expiresAt) <= Date.now()) {
      await removePrompt();
      return "that battery prompt expired, so i left the captured tasks running locally.";
    }
    if (answer === "no") {
      await removePrompt();
      return "okay. i left the captured tasks running locally.";
    }
    if (!prompt.taskSnapshots) {
      await removePrompt();
      return "that battery prompt predates worker fencing, so i left the captured tasks running locally.";
    }

    const replies: string[] = [];
    const completedLocally: string[] = [];
    const changedBeforeClaim: string[] = [];
    for (const captured of prompt.taskSnapshots) {
      const current = await this.#store.read();
      const task = current.tasks[captured.taskId];
      if (!task) continue;
      const worker = task.currentWorkerId ? current.workers[task.currentWorkerId] : undefined;
      if (worker?.target.kind !== "local") continue;
      if (task.status === "completed") {
        completedLocally.push(task.title);
        continue;
      }
      if (!ACTIVE_TASK_STATUSES.has(task.status)) continue;
      const result = await this.#orchestrator.moveCapturedLocalTaskToCloud(captured, context);
      if (result.status === "started") {
        replies.push(`${result.title} is being handed to codex in the cloud.`);
      } else if (result.status === "queued") {
        replies.push(`${result.title} is queued to move to codex in the cloud.`);
      } else if (result.status === "local_completed") {
        completedLocally.push(result.title);
      } else {
        changedBeforeClaim.push(result.title);
      }
    }
    await removePrompt();
    const completedReply = completedLocally.length === 0
      ? ""
      : completedLocally.length === 1
        ? `${completedLocally[0]} already finished locally, so i didn't move or rerun it.`
        : `${completedLocally.join(", ")} already finished locally, so i didn't move or rerun them.`;
    const changedReply = changedBeforeClaim.length === 0
      ? ""
      : changedBeforeClaim.length === 1
        ? `${changedBeforeClaim[0]} changed workers before i could claim it, so i left the current work alone.`
        : `${changedBeforeClaim.join(", ")} changed workers before i could claim them, so i left the current work alone.`;
    return [...replies.filter(Boolean), completedReply, changedReply].filter(Boolean).join("\n\n")
      || "the captured tasks are no longer running locally, so there was nothing to move.";
  }

  async #claimMessage(messageId: string, commandId: string): Promise<boolean> {
    let claimed = false;
    await this.#store.updateState((state) => {
      if (state.processedMessageIds.includes(messageId) || state.processedMessageIds.includes(commandId)) return;
      state.processedMessageIds.push(messageId);
      if (commandId !== messageId) state.processedMessageIds.push(commandId);
      state.processedMessageIds = state.processedMessageIds.slice(-5_000);
      claimed = true;
    });
    return claimed;
  }

  #confirmAcceptedLocalTerminalNotifications(): Promise<number> {
    return this.#tasks
      ? this.#tasks.confirmAcceptedLocalTerminalNotifications()
      : confirmAcceptedLocalTerminalNotifications(this.#store);
  }
}

export async function createDaemonRuntime(options: DexDaemonRuntimeOptions): Promise<DexDaemonRuntime> {
  const store = options.store ?? new DexStateStore(options.paths.state);
  const events = options.events ?? new EventLog(options.paths.events);
  const state = await store.read();
  const project = resolveProject(options.config, state.projects);
  if (!options.config.cloudUrl) throw new Error("Dex Cloud is not configured; run dex setup");
  if (options.config.serverKeys.length === 0) throw new Error("Dex Cloud has no pinned command-signing key");
  const keychain = new MacOSDexKeychain();
  const pairing = new DexPairingService({
    baseUrl: options.config.cloudUrl,
    keychain,
    pinnedServerKeys: options.config.serverKeys,
  });
  const identity = await pairing.loadIdentity();
  if (!identity) throw new Error("This Mac is not paired with Dex Cloud; run dex setup");
  if (options.config.deviceId && options.config.deviceId !== identity.deviceId) {
    throw new Error("Dex config and Keychain refer to different device identities");
  }
  const client = await pairing.createClient();
  const bridge = new DexCloudBridge(client, store, events);
  const memory = new MemoryContinuity({ store });
  const tasks = new TaskManager(store, events, options.paths);
  const machine = new MacMachineController();
  const defaultConversation = options.config.pairedConversationId ?? identity.pairedConversationId;
  const notifyDefault = async (text: string): Promise<void> => {
    if (!defaultConversation) throw new Error("Dex has no paired conversation for proactive notification");
    // Command handling performs one explicit transport flush after durable
    // orchestration. Do not make local work wait for Sendblue delivery here.
    await bridge.notify(defaultConversation, text, false);
  };
  const power = new DexPowerController({
    store,
    events,
    machine,
    notify: (conversationId, text, stableEventId) =>
      bridge.notify(conversationId, text, true, stableEventId),
    transportBarrier: (effect) => bridge.withDrainedTransport(effect),
    durabilityGate: terminalEffectsAreReadyForPower,
  });
  const battery = new BatteryMonitor({
    store,
    events,
    machine,
    deviceId: identity.deviceId,
    ...(defaultConversation ? { conversationId: defaultConversation } : {}),
    notify: notifyDefault,
  });
  const mover = new ModalTaskMover({
    store,
    events,
    tasks,
    handoffsRoot: options.paths.handoffs,
    codexAuthLeasePath: path.join(options.paths.handoffs, ".codex-account-auth.lease"),
    taskKnowledge: (taskId) => memory.getTaskKnowledge(taskId),
    scheduleMonitor: async (registration: ModalMonitorRegistration) => {
      await bridge.publish({
        type: "modal.monitor.registered",
        taskId: registration.taskId,
        workerId: registration.workerId,
        payload: { ...registration },
      }, { flush: false });
      await flushMonitorRegistration(() => bridge.syncOnce(0));
      await store.updateState((draft) => {
        const task = draft.tasks[registration.taskId];
        if (!task) throw new Error(`Task disappeared while registering cloud monitoring: ${registration.taskId}`);
        task.metadata.cloudMonitorAcknowledged = true;
        task.metadata.sandboxId = registration.sandboxId;
        task.updatedAt = new Date().toISOString();
      });
    },
  });
  const orchestrator = new DexOrchestrator({
    store,
    events,
    tasks,
    paths: options.paths,
    config: { ...options.config, deviceId: identity.deviceId },
    project,
    agents: { codex: new CodexAgentAdapter(), claude: new ClaudeAgentAdapter() },
    notify: (conversationId, text) => bridge.notify(conversationId, text, false),
    flushTransport: async () => { await bridge.syncOnce(0); },
    publishTask: async (task, conversationId) => {
      await bridge.publish({
        type: "task.created",
        taskId: task.id,
        payload: {
          title: task.title,
          originalRequest: task.originalRequest,
          conversationId,
          projectId: task.projectId,
          ...(typeof task.metadata.cloudTaskId === "string"
            ? { cloudTaskId: task.metadata.cloudTaskId }
            : {}),
          ...(typeof task.metadata.sourceMessageId === "string"
            ? { sourceMessageId: task.metadata.sourceMessageId }
            : {}),
        },
      });
    },
    memory,
    mover,
    power,
  });
  await store.updateState((draft) => {
    const previous = draft.machine;
    draft.machine = {
      ...previous,
      id: identity.deviceId,
      hostname: options.config.deviceName ?? hostname(),
      sleepPreventionActive: previous?.sleepPreventionActive ?? false,
      aggressiveLidModeActive: false,
      batteryAlertThresholds: previous?.batteryAlertThresholds ?? [],
      updatedAt: new Date().toISOString(),
    };
  });
  return new DexDaemonRuntime({
    bridge,
    router: new MessageRouter(),
    orchestrator,
    store,
    events,
    battery,
    power,
    tasks,
    resultImporter: new CloudResultImporter(),
    codexAuthLeasePath: path.join(options.paths.handoffs, ".codex-account-auth.lease"),
  });
}

export async function flushMonitorRegistration(
  sync: () => Promise<unknown>,
  options: {
    timeoutMs?: number;
    retryDelayMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 ||
      !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("Monitor registration retry bounds must be non-negative integers");
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      await sync();
      return;
    } catch (error) {
      if (!(error instanceof DexCloudProtocolError) || !error.retryable || now() >= deadline) {
        throw error;
      }
      await wait(retryDelayMs);
    }
  }
}

function resolveProject(config: DexConfig, projects: Record<string, DexProject>): DexProject {
  const byId = config.defaultProjectId ? projects[config.defaultProjectId] : undefined;
  if (byId) return byId;
  const byPath = config.defaultRepository
    ? Object.values(projects).find((project) => project.path === config.defaultRepository)
    : undefined;
  if (byPath) return byPath;
  throw new Error("Dex has no default project; run dex setup from a Git repository");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
