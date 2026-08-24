import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ClaudeAgentAdapter, CodexAgentAdapter } from "../../agents/index.js";
import { ModalTaskMover, type ModalMonitorRegistration } from "../../cloud/modal-task-mover.js";
import type { DexVerifiedCommand } from "../../cloud/messaging/index.js";
import type { DexConfig } from "../../config/config.js";
import type { DexPaths } from "../../config/paths.js";
import { DexOrchestrator } from "../../dex/orchestrator.js";
import { MessageRouter } from "../../dex/router.js";
import { MemoryContinuity } from "../../memory/index.js";
import { EventLog } from "../../state/events.js";
import type { DexProject } from "../../state/schemas.js";
import { DexStateStore } from "../../state/store.js";
import { TaskManager } from "../../tasks/task-manager.js";
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
import { releaseCodexAuthLease } from "../../setup/modal-auth.js";

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
  tests: z.object({
    command: z.string().optional(),
    passed: z.number().int().min(0).optional(),
    failed: z.number().int().min(0).optional(),
    summary: z.string().optional(),
  }).optional(),
});

interface RuntimeCloudResultImporter {
  import(input: {
    task: Parameters<CloudResultImporter["import"]>[0]["task"];
    completion: unknown;
  }): Promise<CloudResultImportResult>;
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
  readonly #resultImporter: RuntimeCloudResultImporter;
  readonly #codexAuthLeasePath: string;
  #stopped = false;

  constructor(options: {
    bridge: DexCloudBridge;
    router: MessageRouter;
    orchestrator: DexOrchestrator;
    store: DexStateStore;
    events: EventLog;
    battery: BatteryMonitor;
    power: DexPowerController;
    resultImporter?: RuntimeCloudResultImporter;
    codexAuthLeasePath: string;
  }) {
    this.#bridge = options.bridge;
    this.#router = options.router;
    this.#orchestrator = options.orchestrator;
    this.#store = options.store;
    this.#events = options.events;
    this.#battery = options.battery;
    this.#power = options.power;
    this.#resultImporter = options.resultImporter ?? new CloudResultImporter();
    this.#codexAuthLeasePath = options.codexAuthLeasePath;
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
          const commands = await this.#bridge.syncOnce(25_000);
          for (const command of commands) await this.handleCommand(command);
          await this.#power.maybeSleepWhenReady();
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
    await this.#power.releaseForShutdown();
  }

  async handleCommand(command: DexVerifiedCommand): Promise<void> {
    const type = command.command.type;
    const payload = command.command.payload;
    try {
      if (type === "message.received") {
        const message = MessagePayloadSchema.parse(payload);
        const messageId = message.messageId ?? command.id;
        const cloudTaskId = message.cloudTaskId ?? message.taskId;
        if (!(await this.#claimMessage(messageId, command.id))) {
          await this.#bridge.receipt(command.id, "duplicate");
          await this.#bridge.syncOnce(0);
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
        if (reply) await this.#bridge.notify(message.conversationId, reply);
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
        try {
          let resultImport: Record<string, unknown> | undefined;
          if (completion.status === "succeeded" && completion.result?.status === "succeeded") {
            const stateBeforeImport = await this.#store.read();
            const taskBeforeImport = stateBeforeImport.tasks[completion.taskId];
            if (!taskBeforeImport) throw new Error(`Unknown completed cloud task: ${completion.taskId}`);
            try {
              const imported = await this.#resultImporter.import({
                task: taskBeforeImport,
                completion,
              });
              resultImport = {
                status: "completed",
                ...imported,
                importedAt: new Date().toISOString(),
              };
            } catch (error) {
              const code = error instanceof CloudResultImportError ? error.code : "retrieval_failed";
              const recoverable = error instanceof CloudResultImportError ? error.recoverable : true;
              resultImport = {
                status: "failed",
                code,
                recoverable,
                failedAt: new Date().toISOString(),
              };
              const conversationId = command.authority.conversationId
                ?? (typeof taskBeforeImport.metadata.conversationId === "string"
                  ? taskBeforeImport.metadata.conversationId
                  : undefined);
              if (conversationId) {
                await this.#bridge.notify(
                  conversationId,
                  `${taskBeforeImport.title} finished in the cloud, but i couldn't safely sync the result bundle back to this mac yet. the cloud sandbox is preserved.`,
                ).catch(() => undefined);
              }
            }
          }
          await this.#store.updateState((state) => {
            const task = state.tasks[completion.taskId];
            if (!task) throw new Error(`Unknown completed cloud task: ${completion.taskId}`);
            task.status = completion.status === "succeeded"
              ? "completed"
              : completion.status === "cancelled" ? "cancelled" : "failed";
            task.stage = completion.status === "succeeded" ? "done" : "failed";
            task.latestSummary = completion.summary;
            task.updatedAt = new Date().toISOString();
            if (resultImport) task.metadata.resultImport = resultImport;
            if (completion.tests) task.testStatus = completion.tests;
            const workerId = completion.workerId ?? task.currentWorkerId;
            const worker = workerId ? state.workers[workerId] : undefined;
            if (worker) {
              worker.status = completion.status === "succeeded"
                ? "completed"
                : completion.status === "cancelled" ? "stopped" : "failed";
              worker.lastMessage = completion.summary;
              worker.endedAt = new Date().toISOString();
              if (completion.exitCode !== undefined && completion.exitCode !== null) worker.exitCode = completion.exitCode;
            }
          });
          await this.#events.append({
            type: completion.status === "succeeded" ? "task.completed" : "task.failed",
            taskId: completion.taskId,
            payload: {
              status: completion.status,
              summary: completion.summary,
              source: "modal-monitor",
              ...(resultImport ? { resultImport } : {}),
            },
          });
          await this.#orchestrator.drainQueue();
          await this.#power.maybeSleepWhenReady();
        } finally {
          // A validated terminal callback means this worker can no longer
          // refresh the shared account cache, even if local bookkeeping fails.
          await releaseCodexAuthLease(this.#codexAuthLeasePath, completion.taskId);
        }
      } else {
        throw new Error(`Unsupported Dex command: ${type}`);
      }
      await this.#bridge.receipt(command.id, "processed");
    } catch (error) {
      const reason = redactString(error instanceof Error ? error.message : String(error));
      await this.#bridge.receipt(command.id, "rejected", reason);
      const conversationId = command.authority.conversationId;
      if (conversationId) {
        await this.#bridge.notify(conversationId, `i couldn't complete that request: ${reason}`);
      }
    }
    await this.#bridge.syncOnce(0);
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

    const replies: string[] = [];
    for (const taskId of prompt.taskIds) {
      const current = await this.#store.read();
      const task = current.tasks[taskId];
      if (!task || !ACTIVE_TASK_STATUSES.has(task.status)) continue;
      const worker = task.currentWorkerId ? current.workers[task.currentWorkerId] : undefined;
      if (worker?.target.kind !== "local") continue;
      const ambiguousId = Object.values(current.tasks).some((candidate) =>
        candidate.id !== taskId && (
          candidate.id.toLowerCase().includes(taskId.toLowerCase()) ||
          candidate.title.toLowerCase().includes(taskId.toLowerCase())
        ),
      );
      if (ambiguousId) throw new Error(`Captured task ID is not uniquely resolvable: ${taskId}`);
      replies.push(await this.#orchestrator.handle([{
        type: "MOVE_TASK",
        taskQuery: taskId,
        destination: "cloud",
        preferredAgent: "codex",
      }], context));
    }
    await removePrompt();
    return replies.filter(Boolean).join("\n\n") || "the captured tasks are no longer running locally, so there was nothing to move.";
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
    await bridge.notify(defaultConversation, text);
  };
  const power = new DexPowerController({
    store,
    events,
    machine,
    notify: (conversationId, text) => bridge.notify(conversationId, text),
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
      }, { flush: true });
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
    notify: (conversationId, text) => bridge.notify(conversationId, text),
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
    resultImporter: new CloudResultImporter(),
    codexAuthLeasePath: path.join(options.paths.handoffs, ".codex-account-auth.lease"),
  });
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
