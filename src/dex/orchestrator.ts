import { createHash } from "node:crypto";
import path from "node:path";
import {
  AgentTerminationUnverifiedError,
  awaitAgentHandleTermination,
} from "../agents/process.js";
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult } from "../agents/types.js";
import type { SessionAdoptionRequest } from "../agents/session-adoption.js";
import { discoverSessions, type DiscoveredSession } from "../agents/session-discovery.js";
import type { DexConfig } from "../config/config.js";
import type { DexPaths } from "../config/paths.js";
import type { EventLog } from "../state/events.js";
import {
  SemanticStageSchema,
  TestStatusSchema,
  WorkerSessionSchema,
  type AgentKind,
  type DexProject,
  type DexTask,
  type SemanticStage,
  type WorkerSession,
} from "../state/schemas.js";
import type { DexStateStore } from "../state/store.js";
import type { ReviewOutcomeRecord, TaskManager } from "../tasks/task-manager.js";
import { isCodexAuthLeaseBusyError } from "../setup/modal-auth.js";
import { workerId as makeWorkerId } from "../utils/ids.js";
import { redactString } from "../utils/redact.js";
import type { DexAction } from "./actions.js";
import { buildStatusMessage } from "./status.js";

export interface OrchestratorMessageContext {
  conversationId: string;
  messageId: string;
  cloudTaskId?: string;
  sourceMessageId?: string;
}

export interface MemoryObserver {
  observe(task: DexTask, worker: WorkerSession, event: AgentEvent): Promise<void>;
  summarize?(worker: WorkerSession, lastAssistantMessage?: string): Promise<void>;
  query?(task: DexTask | undefined, query: string): Promise<string[]>;
  snapshot?(taskId: string): unknown;
}

export interface TaskMover {
  moveToCloud(task: DexTask, preferredAgent?: AgentKind, signal?: AbortSignal): Promise<void>;
  recoverInterruptedHandoff?(task: DexTask): Promise<boolean>;
  stopCloudTask?(task: DexTask, expectedWorkerId?: string): Promise<boolean>;
}

export interface PowerController {
  keepAwake(untilTasksComplete: boolean): Promise<void>;
  requestSleep(when: "now" | "tasks_complete", conversationId: string): Promise<void>;
}

export interface DexOrchestratorOptions {
  store: DexStateStore;
  events: EventLog;
  tasks: TaskManager;
  paths: DexPaths;
  config: DexConfig;
  project: DexProject;
  agents: Record<AgentKind, AgentAdapter>;
  notify(conversationId: string, text: string): Promise<void>;
  /** Flushes already-durable transport events without creating duplicates. */
  flushTransport(): Promise<void>;
  publishTask?(task: DexTask, conversationId: string): Promise<void>;
  memory?: MemoryObserver;
  mover?: TaskMover;
  power?: PowerController;
  discoverSessions?(provider?: AgentKind): Promise<DiscoveredSession[]>;
  /** Delay before retrying a recoverable Modal journal in this daemon. */
  recoveryRetryMs?: number;
}

type WorkerPurpose = "work" | "review";

interface WorkerIntent {
  purpose?: WorkerPurpose;
  sourceAgent?: AgentKind;
  explicitResume?: boolean;
  lifecycleGeneration?: number;
}

interface ReviewBaseOutcome {
  status: "completed" | "failed" | "cancelled";
  stage: SemanticStage;
  latestSummary?: string;
  blockedReason?: string;
  testStatus?: DexTask["testStatus"];
}

interface ReviewRecord {
  reviewer: AgentKind;
  sourceAgent?: AgentKind;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  workerId: string;
  reviewedAt: string;
}

interface StartupControl {
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled(): void;
}

export class DexTerminalOutcomeQueuedError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DexTerminalOutcomeQueuedError";
    this.taskId = taskId;
  }
}

const REVIEW_MESSAGE_CHARS = 7_200;
const MAX_REVIEW_MESSAGE_CHUNKS = 8;
const MAX_REVIEW_SUMMARY_CHARS = 48_000;

export class DexOrchestrator {
  readonly #options: DexOrchestratorOptions;
  readonly #active = new Map<string, AgentHandle>();
  readonly #starting = new Set<string>();
  readonly #startupControls = new Map<string, StartupControl>();
  readonly #supervisions = new Map<string, Promise<void>>();
  readonly #stopping = new Set<string>();
  #drainTail: Promise<void> = Promise.resolve();
  #startGateTail: Promise<void> = Promise.resolve();
  #adoptionTail: Promise<void> = Promise.resolve();
  #recoveryTail: Promise<void> = Promise.resolve();
  #recoveryRetryTimer: NodeJS.Timeout | undefined;

  constructor(options: DexOrchestratorOptions) {
    this.#options = options;
  }

  async handle(actions: DexAction[], context: OrchestratorMessageContext): Promise<string> {
    const replies: string[] = [];
    const createActions = actions.filter((action): action is Extract<DexAction, { type: "CREATE_TASK" }> => action.type === "CREATE_TASK");
    const ingressIdentity = context.sourceMessageId ?? context.messageId;
    const accepted = await this.#options.tasks.acceptTasks(createActions.map((action, index) => ({
      ...(index === 0 && context.cloudTaskId ? { id: context.cloudTaskId } : {}),
      dedupeKey: `${ingressIdentity}:${index}`,
      description: action.description,
      project: this.#options.project,
      ...(action.preferredAgent ? { preferredAgent: action.preferredAgent } : {}),
      ...(action.executionPreference ? { executionPreference: action.executionPreference } : {}),
      metadata: {
        conversationId: context.conversationId,
        ...(index === 0 && context.cloudTaskId ? { cloudTaskId: context.cloudTaskId } : {}),
        ...(context.sourceMessageId ? { sourceMessageId: context.sourceMessageId } : {}),
      },
    })));
    if (accepted.length > 0) {
      await this.#options.notify(
        context.conversationId,
        accepted.length === 1 ? "on it" : `on it i'm handling all ${accepted.length}`,
      ).catch(() => undefined);
    }
    const created = await this.#options.tasks.prepareTasks(accepted.map(({ id }) => id));
    await Promise.all(created.map((task) => this.#options.publishTask?.(task, context.conversationId)));
    for (const action of actions) {
      switch (action.type) {
        case "CREATE_TASK": {
          break;
        }
        case "STATUS": {
          const state = await this.#options.store.read();
          const selected = action.taskQuery
            ? await this.#options.tasks.find(action.taskQuery)
            : Object.values(state.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          replies.push(buildStatusMessage(selected, Object.values(state.workers)));
          break;
        }
        case "LIST_SESSIONS": {
          const sessions = await (this.#options.discoverSessions ?? ((provider?: AgentKind) =>
            discoverSessions({ ...(provider ? { provider } : {}) })))(action.provider);
          const recent = sessions.slice(0, action.limit ?? 5);
          if (recent.length === 0) {
            await this.#options.store.updateState((state) => {
              delete state.pendingSessionSelections[context.conversationId];
            });
            replies.push(action.provider
              ? `i couldn't find any recent ${action.provider} sessions on this mac.`
              : "i couldn't find any recent claude or codex sessions on this mac.");
          } else {
            const createdAt = new Date();
            await this.#options.store.updateState((state) => {
              state.pendingSessionSelections[context.conversationId] = {
                conversationId: context.conversationId,
                sessions: recent.map((session) => ({
                  provider: session.provider,
                  sessionId: session.sessionId,
                  ...(session.cwd ? { cwd: session.cwd } : {}),
                  updatedAt: session.updatedAt,
                  ...(session.summary ? { summary: session.summary } : {}),
                  active: session.active,
                })),
                createdAt: createdAt.toISOString(),
                expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
              };
            });
            replies.push([
              `i found ${recent.length} recent ${recent.length === 1 ? "session" : "sessions"}:`,
              ...recent.map((session, index) => {
                const context = session.summary ?? session.cwd ?? "no summary available";
                return `${index + 1}. ${session.provider} · ${session.sessionId} — ${context}`;
              }),
              "",
              "say “continue the second one” or name a session id to adopt it.",
            ].join("\n"));
          }
          break;
        }
        case "ADOPT_LISTED_SESSION": {
          const state = await this.#options.store.read();
          const selection = state.pendingSessionSelections[context.conversationId];
          if (!selection || Date.parse(selection.expiresAt) <= Date.now()) {
            await this.#options.store.updateState((draft) => {
              delete draft.pendingSessionSelections[context.conversationId];
            });
            throw new Error("That session list expired. ask me to list your sessions again.");
          }
          const selected = selection.sessions[action.ordinal - 1];
          if (!selected) {
            throw new Error(`That list only has ${selection.sessions.length} ${selection.sessions.length === 1 ? "session" : "sessions"}.`);
          }
          const currentSessions = await (this.#options.discoverSessions ?? ((provider?: AgentKind) =>
            discoverSessions({ ...(provider ? { provider } : {}) })))(selected.provider);
          const current = currentSessions.find((session) =>
            session.provider === selected.provider && session.sessionId === selected.sessionId);
          if (!current) {
            await this.#options.store.updateState((draft) => {
              delete draft.pendingSessionSelections[context.conversationId];
            });
            throw new Error("That session is no longer available. ask me to list your sessions again.");
          }
          const adopted = await this.#adoptSession({
            type: "ADOPT_SESSION",
            provider: current.provider,
            sessionId: current.sessionId,
            ...(current.cwd ? { cwd: current.cwd } : {}),
            updatedAt: current.updatedAt,
            ...(current.summary ? { summary: current.summary } : {}),
            active: current.active,
          }, context);
          await this.#options.store.updateState((draft) => {
            delete draft.pendingSessionSelections[context.conversationId];
          });
          replies.push(`i adopted that ${selected.provider} session as ${adopted.title}. the task is durable now.`);
          break;
        }
        case "ADOPT_SESSION": {
          const adopted = await this.#adoptSession(action, context);
          replies.push(`i adopted that ${action.provider} session as ${adopted.title}. the task is durable now.`);
          break;
        }
        case "MEMORY_QUERY": {
          const affiliatedTask = await this.#affiliatedTask(context.conversationId);
          const matches = await this.#options.memory?.query?.(affiliatedTask, action.query);
          replies.push(matches?.length ? `yeah. ${matches.slice(0, 3).join(" ")}` : "i don't have a reliable memory for that yet.");
          break;
        }
        case "REVIEW_TASK": {
          const { task, sourceAgent } = await this.#resolveReviewTask(
            action.taskQuery,
            action.sourceAgent,
            context.conversationId,
          );
          if (sourceAgent === action.reviewer) {
            throw new Error(`Choose the other agent to review ${task.title}.`);
          }
          const lifecycleGeneration = await this.#bumpLifecycleGeneration(task.id);
          const started = await this.#startOrQueue(
            task,
            action.reviewer,
            context.conversationId,
            undefined,
            { purpose: "review", lifecycleGeneration, ...(sourceAgent ? { sourceAgent } : {}) },
            "review queued behind active work",
          );
          if (started) {
            replies.push(`${action.reviewer} is reviewing ${task.title}${sourceAgent ? ` after ${sourceAgent}` : ""}.`);
          } else {
            replies.push(`${action.reviewer}'s review of ${task.title} is queued behind the active work.`);
          }
          break;
        }
        case "REVIEW_RESULT": {
          const task = action.taskQuery
            ? await this.#resolveOne(action.taskQuery, context.conversationId)
            : await this.#latestReviewedTask(context.conversationId);
          const review = reviewRecord(task.metadata.latestReview);
          if (!review) throw new Error(`I don't have completed review findings for ${task.title} yet.`);
          const messages = reviewResultMessages(task.title, review);
          if (messages.length === 1) {
            replies.push(messages[0]!);
          } else {
            for (const message of messages) {
              await this.#options.notify(context.conversationId, message);
            }
          }
          break;
        }
        case "MOVE_TASK": {
          const targets = await this.#resolveControlTargets(action.taskQuery, context.conversationId);
          for (const task of targets) {
            if (action.destination === "cloud") {
              if (!this.#options.mover) throw new Error("Cloud movement is not configured");
              const state = await this.#options.store.read();
              const currentWorker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
              if (currentWorker?.target.kind === "modal" && ["starting", "running", "waiting"].includes(currentWorker.status)) {
                replies.push(`${task.title} is already running in the cloud with ${currentWorker.agent}.`);
                continue;
              }
              await this.#stopAndRestoreReview(
                task,
                "review interrupted by cloud handoff",
                true,
                context.conversationId,
              );
              const lifecycleGeneration = await this.#bumpLifecycleGeneration(task.id);
              const agent = action.preferredAgent ?? "codex";
              const started = await this.#moveToCloudOrQueue(
                await this.#latestTask(task.id),
                agent,
                "cloud handoff queued behind active work",
                true,
                lifecycleGeneration,
              );
              await this.drainQueue(context.conversationId);
              replies.push(started
                ? `${task.title} is being handed to ${agent} in the cloud.`
                : `${task.title} is queued to move to ${agent} in the cloud.`);
            } else {
              replies.push(`${task.title} is already durable; local return is not enabled in P0.`);
            }
          }
          break;
        }
        case "CHANGE_AGENT": {
          const task = await this.#resolveOne(action.taskQuery, context.conversationId);
          const current = await this.#latestTask(task.id);
          const currentReviewSource = current.metadata.reviewSourceAgent === "claude" || current.metadata.reviewSourceAgent === "codex"
            ? current.metadata.reviewSourceAgent
            : undefined;
          if (current.metadata.activeWorkerPurpose === "review" && currentReviewSource === action.agent) {
            throw new Error(`Choose the other agent to review ${task.title}.`);
          }
          const review = await this.#stopAndRestoreReview(
            task,
            "review interrupted while changing reviewer",
            true,
            context.conversationId,
          );
          const lifecycleGeneration = await this.#bumpLifecycleGeneration(task.id);
          const latest = await this.#latestTask(task.id);
          const purpose: WorkerPurpose = review.wasReview ? "review" : "work";
          const providerSessionId = purpose === "work"
            ? await this.#latestProviderSession(latest, action.agent, "work")
            : undefined;
          const started = await this.#startOrQueue(
            latest,
            action.agent,
            context.conversationId,
            providerSessionId,
            { purpose, lifecycleGeneration, ...(review.sourceAgent ? { sourceAgent: review.sourceAgent } : {}) },
            purpose === "review" ? "review queued after changing reviewer" : "queued after changing agent",
          );
          await this.drainQueue(context.conversationId);
          replies.push(started
            ? `${task.title} ${purpose === "review" ? "review" : "work"} is continuing with ${action.agent}.`
            : `${task.title} is queued to continue with ${action.agent}.`);
          break;
        }
        case "STOP_TASK": {
          const targets = await this.#resolveControlTargets(action.taskQuery, context.conversationId);
          for (const task of targets) {
            const review = await this.#stopAndRestoreReview(
              task,
              "review stopped at your request",
              false,
              context.conversationId,
            );
            await this.#bumpLifecycleGeneration(task.id);
            if (!review.wasReview) {
              await this.#options.tasks.transition(task.id, "cancelled", { stage: "failed", latestSummary: "stopped at your request" });
            }
            await this.drainQueue(context.conversationId);
            if (!review.wasReview) replies.push(`${task.title} is stopped. the task history is preserved.`);
          }
          break;
        }
        case "RESUME_TASK": {
          const task = await this.#resolveOne(action.taskQuery, context.conversationId);
          const lifecycleGeneration = await this.#claimLifecycleGenerationForResume(task.id);
          const latest = await this.#latestTask(task.id);
          const purpose = latest.metadata.activeWorkerPurpose === "review" ? "review" : "work";
          const reviewer = latest.metadata.reviewer === "claude" || latest.metadata.reviewer === "codex"
            ? latest.metadata.reviewer
            : undefined;
          const sourceAgent = latest.metadata.reviewSourceAgent === "claude" || latest.metadata.reviewSourceAgent === "codex"
            ? latest.metadata.reviewSourceAgent
            : undefined;
          const agent = purpose === "review" ? reviewer ?? "claude" : latest.preferredAgent ?? "codex";
          const providerSessionId = purpose === "review"
            ? undefined
            : await this.#latestProviderSession(latest, agent, "work");
          const started = purpose === "work" && latest.executionPreference === "cloud"
            ? await this.#moveToCloudOrQueue(latest, agent, "cloud continuation queued to resume", true, lifecycleGeneration)
            : await this.#startOrQueue(
                latest,
                agent,
                context.conversationId,
                providerSessionId,
                { purpose, explicitResume: true, lifecycleGeneration, ...(sourceAgent ? { sourceAgent } : {}) },
                purpose === "review" ? "review queued to resume" : "queued to resume",
              );
          await this.drainQueue(context.conversationId);
          replies.push(started ? `${task.title} is running again.` : `${task.title} is queued to resume.`);
          break;
        }
        case "KEEP_AWAKE": {
          if (!this.#options.power) throw new Error("Power control is not configured");
          await this.#options.power.keepAwake(action.until === "tasks_complete");
          replies.push("i'll keep this mac awake until the work finishes.");
          break;
        }
        case "SLEEP": {
          if (!this.#options.power) throw new Error("Power control is not configured");
          await this.#options.power.requestSleep(action.when, context.conversationId);
          replies.push(action.when === "now" ? "i'll sleep this mac once cloud ownership is confirmed." : "i'll restore normal power settings and sleep this mac when everything finishes.");
          break;
        }
      }
    }

    if (created.length > 0) {
      await this.drainQueue(context.conversationId);
    }

    return replies.filter(Boolean).join("\n\n");
  }

  async drainQueue(defaultConversationId?: string): Promise<void> {
    const run = this.#drainTail.then(() => this.#drainQueueOnce(defaultConversationId));
    this.#drainTail = run.catch(() => undefined);
    return run;
  }

  async recoverInterruptedTasks(): Promise<number> {
    const run = this.#recoveryTail.then(() => this.#recoverInterruptedTasksOnce());
    this.#recoveryTail = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } catch (error) {
      // A transient state-store or mover failure must not make this daemon the
      // last place a cleanup-pending auth lease is ever inspected.
      if (this.#options.mover?.recoverInterruptedHandoff) {
        this.#scheduleInterruptedHandoffRetry();
      }
      throw error;
    }
  }

  async #recoverInterruptedTasksOnce(): Promise<number> {
    let recovered = 0;
    let handoffRetryNeeded = false;
    const beforeRecovery = await this.#options.store.read();
    const interruptedHandoffs = Object.values(beforeRecovery.tasks).filter((task) =>
      needsModalHandoffRecovery(task),
    );
    for (const task of interruptedHandoffs) {
      const recover = this.#options.mover?.recoverInterruptedHandoff;
      if (!recover) continue;
      if (await recover.call(this.#options.mover, task).catch(() => false)) {
        recovered += 1;
      } else {
        handoffRetryNeeded = true;
      }
    }

    const state = await this.#options.store.read();
    const candidates = Object.values(state.tasks).filter((task) =>
      task.status === "failed" && task.metadata.interruptedByDaemonRestart === true,
    );
    for (const task of candidates) {
      const worker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
      const purpose = task.metadata.activeWorkerPurpose === "review" ? "review" : "work";
      const reviewer = task.metadata.reviewer === "claude" || task.metadata.reviewer === "codex"
        ? task.metadata.reviewer
        : undefined;
      const agent = purpose === "review" ? reviewer ?? worker?.agent ?? "claude" : worker?.agent ?? task.preferredAgent ?? "codex";
      const conversationId = typeof task.metadata.conversationId === "string"
        ? task.metadata.conversationId
        : "";
      const providerSessionId = worker?.providerSessionId
        ?? await this.#latestProviderSession(task, agent, purpose);
      const sourceAgent = task.metadata.reviewSourceAgent === "claude" || task.metadata.reviewSourceAgent === "codex"
        ? task.metadata.reviewSourceAgent
        : undefined;
      await this.#options.store.updateState((draft) => {
        const current = draft.tasks[task.id];
        if (current) current.metadata.workerRecoveryAttempts = 0;
      });
      await this.#options.tasks.markRecoveryPendingIfGeneration(
        task.id,
        lifecycleGeneration(task),
        {
          stage: "failed",
          latestSummary: "recovering local work after the daemon restart",
        },
        "daemon restart recovery is still pending",
      );
      if (!(await this.#hasWorkerCapacity())) {
        await this.#options.tasks.transition(task.id, "queued", {
          stage: "queued",
          latestSummary: "queued to resume after the daemon restart",
        });
        await this.#options.store.updateState((draft) => {
          const current = draft.tasks[task.id];
          if (!current) return;
          if (purpose === "review") {
            current.metadata.activeWorkerPurpose = "review";
            current.metadata.reviewer = agent;
            current.metadata.reviewSourceAgent = sourceAgent;
          } else {
            current.preferredAgent = agent;
            if (providerSessionId) current.metadata.adoptedProviderSessionId = providerSessionId;
            current.metadata.adoptedProvider = agent;
          }
        });
        continue;
      }
      const succeeded = await this.#recoverWorker(
        task.id,
        agent,
        purpose === "review" ? undefined : providerSessionId,
        conversationId,
        "the local daemon restarted",
        purpose,
        sourceAgent,
      );
      if (succeeded) {
        recovered += 1;
      } else if (conversationId) {
        const latest = await this.#latestTask(task.id);
        const workerId = latest.currentWorkerId ?? `restart-${task.id}`;
        if (purpose === "review") {
          await this.#restoreReviewBaseOutcome(task.id, {
            reviewer: agent,
            ...(sourceAgent ? { sourceAgent } : {}),
            status: "failed",
            summary: "review recovery failed after the local daemon restarted",
            workerId,
            reviewedAt: new Date().toISOString(),
          }, false, conversationId);
        } else {
          await this.#options.tasks.finalizeIfGenerationWithNotification(
            task.id,
            lifecycleGeneration(latest),
            {
              status: "failed",
              stage: "failed",
              summary: "local worker recovery failed after the daemon restarted",
              blockedReason: "daemon restart recovery exhausted",
              conversationId,
              text: `${task.title} failed after i exhausted local recovery. the task history is preserved.`,
              kind: "startup_failed",
              dedupeKey: `restart-recovery-failed:${workerId}`,
            },
          );
        }
        await this.#options.flushTransport().catch(() => undefined);
      }
    }
    await this.drainQueue();
    if (this.#options.mover?.recoverInterruptedHandoff) {
      const afterRecovery = await this.#options.store.read();
      handoffRetryNeeded ||= Object.values(afterRecovery.tasks).some(needsModalHandoffRecovery);
    }
    if (handoffRetryNeeded) this.#scheduleInterruptedHandoffRetry();
    return recovered;
  }

  #scheduleInterruptedHandoffRetry(): void {
    if (!this.#options.mover?.recoverInterruptedHandoff) return;
    if (this.#recoveryRetryTimer) return;
    const delayMs = Math.max(10, Math.floor(this.#options.recoveryRetryMs ?? 1_000));
    this.#recoveryRetryTimer = setTimeout(() => {
      this.#recoveryRetryTimer = undefined;
      void this.recoverInterruptedTasks().catch(() => {
        this.#scheduleInterruptedHandoffRetry();
      });
    }, delayMs);
    this.#recoveryRetryTimer.unref();
  }

  async #drainQueueOnce(defaultConversationId?: string): Promise<void> {
    for (;;) {
      const state = await this.#options.store.read();
      const cloudWorkers = Object.values(state.workers).filter((worker) =>
        worker.target.kind === "modal" && ["starting", "running", "waiting"].includes(worker.status),
      ).length;
      const capacity = this.#options.config.maxConcurrency - this.#active.size - this.#starting.size - cloudWorkers;
      if (capacity <= 0) return;
      const task = Object.values(state.tasks)
        .filter((candidate) => candidate.status === "queued" && taskPreparationReady(candidate))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!task) return;
      const conversationId = typeof task.metadata.conversationId === "string"
        ? task.metadata.conversationId
        : defaultConversationId;
      const purpose = task.metadata.activeWorkerPurpose === "review" ? "review" : "work";
      const sourceAgent = task.metadata.reviewSourceAgent === "claude" || task.metadata.reviewSourceAgent === "codex"
        ? task.metadata.reviewSourceAgent
        : undefined;
      try {
        if (task.executionPreference === "cloud" && purpose !== "review") {
          if (!this.#options.mover) throw new Error("Cloud movement is not configured");
          if (conversationId) {
            await this.#options.notify(
              conversationId,
              `i'm starting a fresh ${task.preferredAgent ?? "codex"} cloud session for ${task.title} right now`,
            ).catch(() => undefined);
          }
          await this.#moveToCloudWithReservation(task, task.preferredAgent ?? "codex");
        } else {
          const adoptedProviderSessionId = purpose === "work" && typeof task.metadata.adoptedProviderSessionId === "string"
            ? task.metadata.adoptedProviderSessionId
            : undefined;
          const reviewAgent = purpose === "review" && (task.metadata.reviewer === "claude" || task.metadata.reviewer === "codex")
            ? task.metadata.reviewer
            : undefined;
          await this.#startTaskResilient(
            task,
            reviewAgent ?? chooseAgent(task, this.#active.size),
            conversationId ?? "",
            adoptedProviderSessionId,
            {
              purpose,
              ...(sourceAgent ? { sourceAgent } : {}),
            },
          );
        }
      } catch (error) {
        if (error instanceof WorkerStartCancelledError) return;
        if (error instanceof WorkerCapacityError) return;
        if (isCodexAuthLeaseBusyError(error)) return;
        if (error instanceof DexTerminalOutcomeQueuedError) {
          await this.#options.flushTransport().catch(() => undefined);
          continue;
        }
        if (error instanceof AgentTerminationUnverifiedError) {
          if (conversationId) {
            await this.#options.notify(
              conversationId,
              `${task.title} needs attention. its worker could not be proven stopped, so i'm keeping the task fenced.`,
            ).catch(() => undefined);
          }
          return;
        }
        const message = redactString(error instanceof Error ? error.message : String(error));
        const latest = await this.#latestTask(task.id);
        if (latest.status !== "completed" && latest.status !== "cancelled" && latest.status !== "failed") {
          await this.#options.tasks.transition(task.id, "failed", {
            stage: "failed",
            blockedReason: message,
            latestSummary: `failed to start: ${message}`,
          }).catch(() => undefined);
        }
        if (conversationId) {
          await this.#options.notify(conversationId, `${task.title} couldn't start: ${message}`).catch(() => undefined);
        }
      }
    }
  }

  async #startTask(
    task: DexTask,
    agent: AgentKind,
    conversationId: string,
    resumeProviderSessionId?: string,
    intent: WorkerIntent = {},
  ): Promise<void> {
    const purpose = intent.purpose ?? "work";
    task = await this.#latestTask(task.id);
    if (!taskPreparationReady(task)) throw new Error(`${task.title} is still preparing its isolated worktree`);
    if (task.status === "completed" && purpose !== "review") throw new Error(`${task.title} is already complete`);
    const expectedGeneration = intent.lifecycleGeneration ?? lifecycleGeneration(task);
    const startup = createStartupControl();
    let reserved = false;
    let retainStartupFence = false;
    try {
    await this.#reserveWorkerSlot(task, startup, expectedGeneration);
    reserved = true;
    task = await this.#latestTask(task.id);
    if (lifecycleGeneration(task) !== expectedGeneration) throw new WorkerStartCancelledError(task.id);
    if (task.status === "cancelled" && purpose !== "review" && !intent.explicitResume) {
      throw new WorkerStartCancelledError(task.id);
    }
    if (task.status === "completed" && purpose !== "review") throw new Error(`${task.title} is already complete`);
    const stage: SemanticStage = purpose === "review"
      ? "reviewing"
      : agent === "claude" ? "investigating" : "implementing";
    if (this.#active.has(task.id)) throw new Error(`${task.title} already has an active worker`);
    if (!(await this.#options.agents[agent].available())) throw new Error(`${agent} is not available on this Mac`);
    if (startup.controller.signal.aborted) throw new WorkerStartCancelledError(task.id);
    if (purpose === "review") await this.#preserveReviewBaseOutcome(task.id);
    if (task.status !== "preparing") {
      const preparing = await this.#options.tasks.transitionIfGeneration(task.id, expectedGeneration, "preparing", { stage });
      if (!preparing) throw new WorkerStartCancelledError(task.id);
    }
    const id = makeWorkerId();
    const now = new Date().toISOString();
    let worker = WorkerSessionSchema.parse({
      id,
      taskId: task.id,
      agent,
      purpose,
      target: { kind: "local", machineId: this.#options.config.deviceId ?? "local-mac" },
      status: "starting",
      startedAt: now,
      eventsPath: this.#options.paths.events,
    });
    await this.#options.store.updateState((state) => {
      state.workers[id] = worker;
      const current = state.tasks[task.id];
      if (!current) throw new Error(`Task disappeared: ${task.id}`);
      if (lifecycleGeneration(current) !== expectedGeneration) throw new WorkerStartCancelledError(task.id);
      current.currentWorkerId = id;
      if (purpose === "work") current.preferredAgent = agent;
      current.workerHistory.push(id);
      current.metadata.activeWorkerPurpose = purpose;
      if (purpose === "review") {
        current.metadata.reviewSourceAgent = intent.sourceAgent;
        current.metadata.reviewer = agent;
      }
      current.updatedAt = now;
    });
    if (conversationId) {
      await this.#options.notify(
        conversationId,
        purpose === "review"
          ? `i'm starting a fresh ${agent} review for ${task.title} right now`
          : resumeProviderSessionId
            ? `i'm resuming the saved ${agent} session for ${task.title} right now`
            : `i'm starting a fresh ${agent} session for ${task.title} right now`,
      ).catch(() => undefined);
    }

    const inheritedMemories = await this.#options.memory
      ?.query?.(task, task.originalRequest)
      .catch(() => []);
    const adapter = this.#options.agents[agent];
    let handle: AgentHandle | undefined;
    try {
      const runOptions = {
        cwd: task.worktreePath,
        prompt: purpose === "review"
          ? reviewPrompt(task, inheritedMemories, intent.sourceAgent)
          : workerPrompt(task, inheritedMemories),
        timeoutMs: 25 * 60_000,
        startupTimeoutMs: 45_000,
        signal: startup.controller.signal,
        ...(agent === "claude" ? {
          permissionMode: purpose === "review" ? "plan" as const : "auto" as const,
          ...(purpose === "review" ? {
            extraArgs: [
              "--safe-mode",
              "--settings", '{"disableAllHooks":true}',
              "--setting-sources", "",
              "--strict-mcp-config",
              "--mcp-config", '{"mcpServers":{}}',
              "--disable-slash-commands",
              "--tools", "Read,Grep,Glob,Bash",
              "--disallowedTools", "Edit", "Write", "NotebookEdit", "mcp__*",
              "--no-session-persistence",
              "--no-chrome",
            ] as const,
          } : {}),
        } : purpose === "review" ? { sandboxMode: "read-only" as const } : {}),
      };
      if (startup.controller.signal.aborted) throw new WorkerStartCancelledError(task.id);
      const startedHandle = resumeProviderSessionId
        ? await adapter.resume(resumeProviderSessionId, runOptions)
        : await adapter.start(runOptions);
      handle = startedHandle;
      // A live provider process consumes capacity before durable activation is
      // complete. Keep it fenced here so a persistence failure cannot launch a
      // second worker against the same worktree.
      this.#active.set(task.id, startedHandle);
      if (startup.controller.signal.aborted) {
        throw new WorkerStartCancelledError(task.id);
      }
      worker = WorkerSessionSchema.parse({
        ...worker,
        status: "running",
        providerSessionId: startedHandle.providerSessionId,
        ...(startedHandle.pid ? { pid: startedHandle.pid } : {}),
        lastEventAt: new Date().toISOString(),
      });
      await this.#options.store.updateState((state) => {
        const currentTask = state.tasks[task.id];
        if (!currentTask || lifecycleGeneration(currentTask) !== expectedGeneration) {
          throw new WorkerStartCancelledError(task.id);
        }
        state.workers[id] = worker;
        delete currentTask.metadata.interruptedByDaemonRestart;
      });
      if (startup.controller.signal.aborted) throw new WorkerStartCancelledError(task.id);
      const running = await this.#options.tasks.transitionIfGeneration(task.id, expectedGeneration, "running", { stage });
      if (!running) throw new WorkerStartCancelledError(task.id);
      if (startup.controller.signal.aborted) throw new WorkerStartCancelledError(task.id);
      await this.#options.events.append({ type: "worker.started", taskId: task.id, workerId: id, payload: { agent, target: "local", purpose, providerSessionId: startedHandle.providerSessionId } });
      if (startup.controller.signal.aborted) throw new WorkerStartCancelledError(task.id);
      const supervision = this.#supervise(task, worker, startedHandle, conversationId, purpose, intent.sourceAgent);
      this.#supervisions.set(task.id, supervision);
      void supervision.then(
        () => {
          if (this.#supervisions.get(task.id) === supervision) this.#supervisions.delete(task.id);
        },
        () => {
          if (this.#supervisions.get(task.id) === supervision) this.#supervisions.delete(task.id);
        },
      );
    } catch (error) {
      if (!handle && error instanceof AgentTerminationUnverifiedError) {
        retainStartupFence = true;
        const message = redactString(error.message);
        await this.#options.store.updateState((state) => {
          const current = state.workers[id];
          if (!current) return;
          current.lastMessage = message;
          current.lastEventAt = new Date().toISOString();
        }).catch(() => undefined);
        await this.#options.notify(
          conversationId,
          `${task.title} needs attention. its starting ${agent} process could not be proven stopped, so i'm keeping the task fenced.`,
        ).catch(() => undefined);
        throw error;
      }
      if (handle) {
        try {
          await handle.stop();
          await awaitAgentHandleTermination(handle);
        } catch (terminationError) {
          if (!this.#active.has(task.id)) this.#active.set(task.id, handle);
          throw new AgentTerminationUnverifiedError(
            `${task.title} startup failed, but its ${agent} process could not be proven stopped; Dex is retaining task ownership and capacity`,
            { cause: new AggregateError([error, terminationError], "worker startup and termination both failed") },
          );
        }
        if (this.#active.get(task.id) === handle) this.#active.delete(task.id);
      }
      const cancelled = error instanceof WorkerStartCancelledError || startup.controller.signal.aborted;
      const cancellation = error instanceof WorkerStartCancelledError
        ? error
        : new WorkerStartCancelledError(task.id);
      const message = cancelled
        ? "worker startup cancelled by a newer task instruction"
        : redactString(error instanceof Error ? error.message : String(error));
      const endedAt = new Date().toISOString();
      await this.#options.store.updateState((state) => {
        const current = state.workers[id];
        if (!current) return;
        current.status = cancelled ? "stopped" : "failed";
        current.endedAt = endedAt;
        current.lastMessage = message;
        current.lastEventAt = endedAt;
      }).catch(() => undefined);
      if (!cancelled) {
        await this.#options.tasks.markRecoveryPendingIfGeneration(
          task.id,
          expectedGeneration,
          {
            stage: "failed",
            blockedReason: message,
            latestSummary: `failed to start: ${message}`,
          },
          `worker startup failed while recovery is being evaluated: ${message}`,
        ).catch(() => undefined);
        await this.#options.events.append({
          type: "worker.failed",
          taskId: task.id,
          workerId: id,
          payload: { phase: "startup", summary: message },
        }).catch(() => undefined);
      }
      throw cancelled ? cancellation : error;
    }
    } finally {
      startup.resolveSettled();
      if (!retainStartupFence) {
        if (this.#startupControls.get(task.id) === startup) this.#startupControls.delete(task.id);
        if (reserved) this.#starting.delete(task.id);
      }
    }
  }

  async #hasWorkerCapacity(): Promise<boolean> {
    const state = await this.#options.store.read();
    const cloudWorkers = Object.values(state.workers).filter((worker) =>
      worker.target.kind === "modal" && ["starting", "running", "waiting"].includes(worker.status),
    ).length;
    return this.#active.size + this.#starting.size + cloudWorkers < this.#options.config.maxConcurrency;
  }

  async #reserveWorkerSlot(
    task: DexTask,
    startup?: StartupControl,
    expectedGeneration = lifecycleGeneration(task),
  ): Promise<void> {
    const operation = this.#startGateTail.then(async () => {
      if (this.#active.has(task.id) || this.#starting.has(task.id)) {
        throw new Error(`${task.title} already has an active worker`);
      }
      const state = await this.#options.store.read();
      const currentTask = state.tasks[task.id];
      if (!currentTask) throw new Error(`Unknown Dex task: ${task.id}`);
      if (lifecycleGeneration(currentTask) !== expectedGeneration) {
        throw new WorkerStartCancelledError(task.id);
      }
      const currentWorker = Object.values(state.workers).find((worker) =>
        worker.taskId === task.id && ["starting", "running", "waiting"].includes(worker.status));
      if (currentWorker && ["starting", "running", "waiting"].includes(currentWorker.status)) {
        throw new Error(`${task.title} already has an active ${currentWorker.target.kind} worker`);
      }
      const cloudWorkers = Object.values(state.workers).filter((worker) =>
        worker.target.kind === "modal" && ["starting", "running", "waiting"].includes(worker.status),
      ).length;
      if (this.#active.size + this.#starting.size + cloudWorkers >= this.#options.config.maxConcurrency) {
        throw new WorkerCapacityError();
      }
      this.#starting.add(task.id);
      if (startup) this.#startupControls.set(task.id, startup);
    });
    this.#startGateTail = operation.catch(() => undefined);
    return operation;
  }

  async #moveToCloudWithReservation(
    task: DexTask,
    agent: AgentKind,
    allowCancelled = false,
    expectedGeneration = lifecycleGeneration(task),
  ): Promise<void> {
    if (!this.#options.mover) throw new Error("Cloud movement is not configured");
    const startup = createStartupControl();
    let reserved = false;
    try {
      await this.#reserveWorkerSlot(task, startup, expectedGeneration);
      reserved = true;
      const current = await this.#latestTask(task.id);
      if (lifecycleGeneration(current) !== expectedGeneration) {
        throw new WorkerStartCancelledError(task.id);
      }
      if (current.status === "cancelled" && !allowCancelled) {
        throw new WorkerStartCancelledError(task.id);
      }
      if (startup.controller.signal.aborted) throw new WorkerStartCancelledError(task.id);
      try {
        await this.#options.mover.moveToCloud(current, agent, startup.controller.signal);
      } catch (error) {
        // ModalTaskMover journals terminal cleanup before surfacing failures.
        // Start the same-process scanner immediately so lease cleanup does not
        // depend on a daemon restart.
        if (!isCodexAuthLeaseBusyError(error)) this.#scheduleInterruptedHandoffRetry();
        throw error;
      }
      if (startup.controller.signal.aborted) throw new WorkerStartCancelledError(task.id);
    } finally {
      startup.resolveSettled();
      if (this.#startupControls.get(task.id) === startup) this.#startupControls.delete(task.id);
      if (reserved) this.#starting.delete(task.id);
    }
  }

  async #moveToCloudOrQueue(
    task: DexTask,
    agent: AgentKind,
    queuedSummary: string,
    allowCancelled = false,
    expectedGeneration = lifecycleGeneration(task),
  ): Promise<boolean> {
    await this.#options.store.updateState((state) => {
      const current = state.tasks[task.id];
      if (!current) throw new Error(`Unknown Dex task: ${task.id}`);
      if (lifecycleGeneration(current) !== expectedGeneration) throw new WorkerStartCancelledError(task.id);
      current.executionPreference = "cloud";
      current.preferredAgent = agent;
      delete current.metadata.activeWorkerPurpose;
      delete current.metadata.reviewBaseOutcome;
      delete current.metadata.reviewer;
      delete current.metadata.reviewSourceAgent;
      current.updatedAt = new Date().toISOString();
    });
    try {
      await this.#moveToCloudWithReservation(
        await this.#latestTask(task.id),
        agent,
        allowCancelled,
        expectedGeneration,
      );
      return true;
    } catch (error) {
      if (!(error instanceof WorkerCapacityError) && !isCodexAuthLeaseBusyError(error)) throw error;
      await this.#queueWorker(
        task.id,
        agent,
        undefined,
        { purpose: "work", lifecycleGeneration: expectedGeneration },
        queuedSummary,
      );
      return false;
    }
  }

  async #startOrQueue(
    task: DexTask,
    agent: AgentKind,
    conversationId: string,
    providerSessionId: string | undefined,
    intent: WorkerIntent,
    queuedSummary: string,
  ): Promise<boolean> {
    const current = await this.#latestTask(task.id);
    const operationIntent: WorkerIntent = {
      ...intent,
      lifecycleGeneration: intent.lifecycleGeneration ?? lifecycleGeneration(current),
    };
    try {
      await this.#startTaskResilient(current, agent, conversationId, providerSessionId, operationIntent);
      return true;
    } catch (error) {
      if (!(error instanceof WorkerCapacityError)) throw error;
      await this.#queueWorker(task.id, agent, providerSessionId, operationIntent, queuedSummary);
      return false;
    }
  }

  async #queueWorker(
    taskId: string,
    agent: AgentKind,
    providerSessionId: string | undefined,
    intent: WorkerIntent,
    summary: string,
  ): Promise<void> {
    const purpose = intent.purpose ?? "work";
    const current = await this.#latestTask(taskId);
    const expectedGeneration = intent.lifecycleGeneration ?? lifecycleGeneration(current);
    if (purpose === "review") await this.#preserveReviewBaseOutcome(taskId);
    const queued = await this.#options.tasks.transitionIfGeneration(taskId, expectedGeneration, "queued", {
      stage: "queued",
      latestSummary: summary,
    });
    if (!queued) throw new WorkerStartCancelledError(taskId);
    await this.#options.store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) throw new Error(`Unknown Dex task: ${taskId}`);
      if (lifecycleGeneration(task) !== expectedGeneration || task.status !== "queued") return;
      task.metadata.activeWorkerPurpose = purpose;
      if (purpose === "review") {
        task.metadata.reviewer = agent;
        task.metadata.reviewSourceAgent = intent.sourceAgent;
      } else {
        task.preferredAgent = agent;
        task.metadata.adoptedProvider = agent;
        if (providerSessionId) task.metadata.adoptedProviderSessionId = providerSessionId;
        else delete task.metadata.adoptedProviderSessionId;
        delete task.metadata.reviewBaseOutcome;
        delete task.metadata.reviewer;
        delete task.metadata.reviewSourceAgent;
      }
      task.updatedAt = new Date().toISOString();
    });
  }

  async #startTaskResilient(
    task: DexTask,
    agent: AgentKind,
    conversationId: string,
    resumeProviderSessionId?: string,
    intent: WorkerIntent = {},
  ): Promise<void> {
    try {
      await this.#startTask(task, agent, conversationId, resumeProviderSessionId, intent);
    } catch (error) {
      if (error instanceof WorkerCapacityError || error instanceof WorkerStartCancelledError) throw error;
      const summary = redactString(error instanceof Error ? error.message : String(error));
      const latest = await this.#latestTask(task.id);
      if (intent.lifecycleGeneration !== undefined && lifecycleGeneration(latest) !== intent.lifecycleGeneration) {
        throw new WorkerStartCancelledError(task.id);
      }
      if (latest.status !== "failed") throw error;
      const recovered = await this.#recoverWorker(
        task.id,
        agent,
        resumeProviderSessionId,
        conversationId,
        `failed to start: ${summary}`,
        intent.purpose ?? "work",
        intent.sourceAgent,
      );
      if (!recovered) {
        const failed = await this.#latestTask(task.id);
        const workerId = failed.currentWorkerId ?? "worker-startup-failed";
        if (!conversationId) throw error;
        if (intent.purpose === "review") {
          await this.#restoreReviewBaseOutcome(task.id, {
            reviewer: agent,
            ...(intent.sourceAgent ? { sourceAgent: intent.sourceAgent } : {}),
            status: "failed",
            summary,
            workerId,
            reviewedAt: new Date().toISOString(),
          }, false, conversationId);
        } else {
          await this.#options.tasks.finalizeIfGenerationWithNotification(
            task.id,
            lifecycleGeneration(failed),
            {
              status: "failed",
              stage: "failed",
              summary: `failed to start: ${summary}`,
              blockedReason: summary,
              conversationId,
              text: `${task.title} couldn't start. ${summary}`,
              kind: "startup_failed",
              dedupeKey: `startup-failed:${workerId}`,
            },
          );
        }
        await this.#options.flushTransport().catch(() => undefined);
        throw new DexTerminalOutcomeQueuedError(
          task.id,
          `Final startup failure was durably queued for ${task.title}`,
          { cause: error },
        );
      }
    }
  }

  async #supervise(
    task: DexTask,
    worker: WorkerSession,
    handle: AgentHandle,
    conversationId: string,
    purpose: WorkerPurpose,
    sourceAgent?: AgentKind,
  ): Promise<void> {
    let shouldRecover = false;
    let failureSummary = "worker stopped unexpectedly";
    let terminationProven = false;
    try {
      for await (const event of handle.events) {
        await this.#recordAgentEvent(task, worker, event, purpose);
        await this.#options.memory?.observe(task, worker, event).catch(() => undefined);
      }
      const result = await handle.result;
      await awaitAgentHandleTermination(handle);
      terminationProven = true;
      const outcome = await this.#finishWorker(task, worker, result, conversationId, purpose, sourceAgent);
      shouldRecover = outcome.shouldRecover;
      failureSummary = outcome.summary;
    } catch (error) {
      if (!terminationProven) {
        try {
          await handle.stop();
          await awaitAgentHandleTermination(handle);
          terminationProven = true;
        } catch (terminationError) {
          const fenced = new AgentTerminationUnverifiedError(
            `${task.title}'s ${worker.agent} process could not be proven stopped after Dex lost supervision; ownership and capacity remain fenced`,
            { cause: new AggregateError([error, terminationError], "supervision and termination both failed") },
          );
          await this.#options.notify(
            conversationId,
            `${task.title} needs attention. i lost durable supervision, but i'm keeping its worker fenced so nothing else can run over it.`,
          ).catch(() => undefined);
          throw fenced;
        }
      }

      // Reaching this branch means the provider process is proven dead. The
      // exception is a Dex supervision/persistence failure, not a provider
      // failure, so it must not enter automatic worker recovery.
      const detail = redactString(error instanceof Error ? error.message : String(error));
      const message = `Dex supervision failed after safely stopping the worker: ${detail}`;
      const deliberatelyStopping = this.#stopping.has(task.id);
      let ownsTask = false;
      await this.#options.store.updateState((state) => {
        const current = state.workers[worker.id];
        if (current) {
          current.status = deliberatelyStopping ? "stopped" : "failed";
          current.endedAt = new Date().toISOString();
          current.lastMessage = message;
        }
        ownsTask = state.tasks[task.id]?.currentWorkerId === worker.id;
      });
      if (!deliberatelyStopping && ownsTask) {
        if (purpose === "review") {
          await this.#restoreReviewBaseOutcome(task.id, {
            reviewer: worker.agent,
            ...(sourceAgent ? { sourceAgent } : {}),
            status: "failed",
            summary: message,
            workerId: worker.id,
            reviewedAt: new Date().toISOString(),
          }, false, conversationId);
        } else {
          await this.#options.tasks.finalizeIfCurrentWorkerWithNotification(
            task.id,
            worker.id,
            {
              status: "failed",
              stage: "failed",
              summary: `failed: ${message}`,
              blockedReason: message,
              conversationId,
              text: `${task.title} failed. ${message}`,
              kind: "supervision_failed",
              dedupeKey: `supervision-failed:${worker.id}`,
            },
          );
        }
        await this.#options.flushTransport().catch(() => undefined);
        failureSummary = message;
      }
      await this.#options.events.append({
        type: "worker.failed",
        taskId: task.id,
        workerId: worker.id,
        payload: { phase: "supervision", summary: message },
      }).catch(() => undefined);
      shouldRecover = false;
    } finally {
      if (terminationProven && this.#active.get(task.id) === handle) this.#active.delete(task.id);
    }
    if (shouldRecover && !this.#stopping.has(task.id)) {
      const recovered = await this.#recoverWorker(
        task.id,
        worker.agent,
        purpose === "review" ? undefined : worker.providerSessionId,
        conversationId,
        failureSummary,
        purpose,
        sourceAgent,
      );
      if (!recovered) {
        if (purpose === "review") {
          await this.#restoreReviewBaseOutcome(task.id, {
            reviewer: worker.agent,
            ...(sourceAgent ? { sourceAgent } : {}),
            status: "failed",
            summary: failureSummary,
            workerId: worker.id,
            reviewedAt: new Date().toISOString(),
          }, false, conversationId);
        } else {
          await this.#options.tasks.finalizeIfCurrentWorkerWithNotification(
            task.id,
            worker.id,
            {
              status: "failed",
              stage: "failed",
              summary: failureSummary,
              blockedReason: failureSummary,
              conversationId,
              text: `${task.title} failed. ${failureSummary}`,
              kind: "work_failed",
              dedupeKey: `work-failed:${worker.id}`,
            },
          );
        }
        await this.#options.flushTransport().catch(() => undefined);
      }
    }
    if (!this.#stopping.has(task.id)) await this.drainQueue(conversationId);
  }

  async #recordAgentEvent(
    task: DexTask,
    worker: WorkerSession,
    event: AgentEvent,
    purpose: WorkerPurpose,
  ): Promise<void> {
    const stage = purpose === "review" ? "reviewing" : stageForEvent(event);
    const summary = event.type === "message" && event.role === "assistant" && !event.delta
      ? concise(event.text)
      : undefined;
    await this.#options.store.updateState((state) => {
      const currentWorker = state.workers[worker.id];
      if (currentWorker) {
        currentWorker.lastEventAt = event.timestamp;
        if (summary) currentWorker.lastMessage = summary;
      }
      const currentTask = state.tasks[task.id];
      if (currentTask?.currentWorkerId === worker.id) {
        if (stage) currentTask.stage = stage;
        if (summary) currentTask.latestSummary = summary;
        currentTask.updatedAt = event.timestamp;
      }
    });
    if (event.type === "tool") {
      await this.#options.events.append({ type: "worker.command", taskId: task.id, workerId: worker.id, payload: { name: event.name, status: event.status } });
    } else if (event.type === "message" && !event.delta) {
      await this.#options.events.append({ type: "worker.output", taskId: task.id, workerId: worker.id, payload: { summary: concise(event.text) } });
    }
  }

  async #finishWorker(
    task: DexTask,
    worker: WorkerSession,
    result: AgentResult,
    conversationId: string,
    purpose: WorkerPurpose,
    sourceAgent?: AgentKind,
  ): Promise<{ shouldRecover: boolean; summary: string }> {
    const succeeded = result.status === "completed" && result.exitCode === 0;
    const rawSummary = result.output || result.error || (succeeded ? "work completed" : "worker failed");
    const summary = purpose === "review" ? reviewOutput(rawSummary) : concise(rawSummary);
    await this.#options.memory?.summarize?.(worker, summary).catch(() => undefined);
    let ownsTask = false;
    await this.#options.store.updateState((state) => {
      const current = state.workers[worker.id];
      if (!current) return;
      current.status = succeeded ? "completed" : result.status === "cancelled" ? "stopped" : "failed";
      current.exitCode = result.exitCode ?? undefined;
      current.endedAt = result.finishedAt;
      current.lastMessage = summary;
      const currentTask = state.tasks[task.id];
      if (currentTask?.currentWorkerId !== worker.id) return;
      ownsTask = true;
      if (succeeded) delete currentTask.metadata.workerRecoveryAttempts;
      if (purpose !== "review" && (succeeded || result.status === "cancelled")) {
        delete currentTask.metadata.activeWorkerPurpose;
      }
    });
    await this.#options.events.append({
      type: succeeded ? "worker.completed" : "worker.failed",
      taskId: task.id,
      workerId: worker.id,
      payload: { status: result.status, exitCode: result.exitCode, summary },
    });
    if (!ownsTask) return { shouldRecover: false, summary };
    if (succeeded) {
      if (purpose === "review") {
        await this.#restoreReviewBaseOutcome(task.id, {
          reviewer: worker.agent,
          ...(sourceAgent ? { sourceAgent } : {}),
          status: "completed",
          summary,
          workerId: worker.id,
          reviewedAt: result.finishedAt,
        }, false, conversationId);
        await this.#options.flushTransport().catch(() => undefined);
      } else {
        const transitioned = await this.#options.tasks.completeIfCurrentWorkerWithNotification(
          task.id,
          worker.id,
          summary,
          conversationId,
          `${task.title} is done. ${summary}`,
        );
        if (transitioned) {
          // The task and message are already atomic. A failed flush leaves the
          // event in the outbox for the daemon loop and keeps sleep gated.
          await this.#options.flushTransport().catch(() => undefined);
        }
      }
    } else if (result.status !== "cancelled") {
      const transitioned = await this.#options.tasks.markRecoveryPendingIfCurrentWorker(
        task.id,
        worker.id,
        { stage: "failed", blockedReason: result.error ?? summary, latestSummary: summary },
        `worker failed while recovery is being evaluated: ${result.error ?? summary}`,
      );
      if (!transitioned) return { shouldRecover: false, summary };
    } else if (purpose === "review" && !this.#stopping.has(task.id)) {
      await this.#restoreReviewBaseOutcome(task.id, {
        reviewer: worker.agent,
        ...(sourceAgent ? { sourceAgent } : {}),
        status: "cancelled",
        summary,
        workerId: worker.id,
        reviewedAt: result.finishedAt,
      }, false, conversationId);
      await this.#options.flushTransport().catch(() => undefined);
    }
    return { shouldRecover: !succeeded && result.status !== "cancelled", summary };
  }

  async #stopActive(taskId: string): Promise<void> {
    const startup = this.#startupControls.get(taskId);
    const initialHandle = this.#active.get(taskId);
    const initialState = await this.#options.store.read();
    const initialTask = initialState.tasks[taskId];
    const initialWorker = initialTask?.currentWorkerId
      ? initialState.workers[initialTask.currentWorkerId]
      : undefined;
    const hasCloudWorker = initialWorker?.target.kind === "modal" &&
      ["starting", "running", "waiting"].includes(initialWorker.status);
    if (!startup && !initialHandle && !hasCloudWorker) return;
    this.#stopping.add(taskId);
    try {
      if (startup) {
        startup.controller.abort();
        await startup.settled;
        if (
          this.#startupControls.get(taskId) === startup &&
          this.#starting.has(taskId) &&
          !this.#active.has(taskId)
        ) {
          throw new AgentTerminationUnverifiedError(
            `${initialTask?.title ?? taskId} still has a fenced starting process whose termination is unverified`,
          );
        }
      }
      const handle = this.#active.get(taskId);
      if (handle) {
        await handle.stop();
        await awaitAgentHandleTermination(handle);
        await this.#supervisions.get(taskId);
      }
      const state = await this.#options.store.read();
      const task = state.tasks[taskId];
      const worker = task?.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
      if (task && worker?.target.kind === "modal" && ["starting", "running", "waiting"].includes(worker.status)) {
        if (!this.#options.mover?.stopCloudTask) {
          throw new Error(`Cloud cancellation is not configured for ${task.title}`);
        }
        let stopped: boolean;
        try {
          stopped = await this.#options.mover.stopCloudTask(task, worker.id);
        } catch (error) {
          this.#scheduleInterruptedHandoffRetry();
          throw error;
        }
        if (!stopped) {
          throw new Error(
            `${task.title} changed workers while Dex was stopping it. retry against the current task state.`,
          );
        }
      }
    } finally {
      this.#stopping.delete(taskId);
    }
  }

  async #recoverWorker(
    taskId: string,
    agent: AgentKind,
    providerSessionId: string | undefined,
    conversationId: string,
    failureSummary: string,
    purpose: WorkerPurpose = "work",
    sourceAgent?: AgentKind,
  ): Promise<boolean> {
    const task = await this.#latestTask(taskId);
    const expectedGeneration = lifecycleGeneration(task);
    const attempts = typeof task.metadata.workerRecoveryAttempts === "number"
      ? task.metadata.workerRecoveryAttempts
      : 0;
    if (task.status !== "failed" || attempts >= 1) return false;
    const intent: WorkerIntent = {
      purpose,
      lifecycleGeneration: expectedGeneration,
      ...(sourceAgent ? { sourceAgent } : {}),
    };
    const restoreAttemptCount = async (): Promise<void> => {
      await this.#options.store.updateState((state) => {
        const current = state.tasks[taskId];
        if (!current) return;
        if (lifecycleGeneration(current) !== expectedGeneration) return;
        if (attempts === 0) delete current.metadata.workerRecoveryAttempts;
        else current.metadata.workerRecoveryAttempts = attempts;
        current.updatedAt = new Date().toISOString();
      });
    };
    const queueAfterCapacityRace = async (): Promise<boolean> => {
      await restoreAttemptCount();
      await this.#queueWorker(
        taskId,
        agent,
        providerSessionId,
        intent,
        "queued to continue recovery",
      );
      return true;
    };
    await this.#options.store.updateState((state) => {
      const current = state.tasks[taskId];
      if (!current || current.status !== "failed" || lifecycleGeneration(current) !== expectedGeneration) return;
      current.metadata.workerRecoveryAttempts = attempts + 1;
      current.latestSummary = "worker stopped unexpectedly; preserving context for recovery";
      current.updatedAt = new Date().toISOString();
    });
    const claimed = await this.#latestTask(taskId);
    if (claimed.status !== "failed" || lifecycleGeneration(claimed) !== expectedGeneration) return false;
    try {
      await this.#startTask(await this.#latestTask(taskId), agent, conversationId, providerSessionId, intent);
    } catch (error) {
      if (error instanceof WorkerCapacityError) return queueAfterCapacityRace();
      if (error instanceof WorkerStartCancelledError) {
        await restoreAttemptCount();
        return false;
      }
      if (!providerSessionId) return false;
      try {
        await this.#startTask(await this.#latestTask(taskId), agent, conversationId, undefined, intent);
      } catch (fallbackError) {
        if (fallbackError instanceof WorkerCapacityError) return queueAfterCapacityRace();
        if (fallbackError instanceof WorkerStartCancelledError) await restoreAttemptCount();
        return false;
      }
    }
    await this.#options.notify(
      conversationId,
      `${task.title}'s worker stopped unexpectedly. i'm continuing the same task with the saved context.`,
    ).catch(() => undefined);
    await this.#options.events.append({
      type: "worker.output",
      taskId,
      payload: { summary: `automatic recovery after: ${failureSummary}` },
    });
    return true;
  }

  async #latestProviderSession(
    task: DexTask,
    agent: AgentKind,
    purpose: WorkerPurpose = "work",
  ): Promise<string | undefined> {
    const state = await this.#options.store.read();
    for (const workerId of [...task.workerHistory].reverse()) {
      const worker = state.workers[workerId];
      if (worker?.agent === agent && worker.purpose === purpose && worker.providerSessionId) {
        return worker.providerSessionId;
      }
    }
    return undefined;
  }

  async #stopAndRestoreReview(
    task: DexTask,
    summary: string,
    keepRetry = false,
    conversationId?: string,
  ): Promise<{ wasReview: boolean; reviewer?: AgentKind; sourceAgent?: AgentKind }> {
    const current = await this.#latestTask(task.id);
    const wasReview = current.metadata.activeWorkerPurpose === "review";
    const reviewer = current.metadata.reviewer === "claude" || current.metadata.reviewer === "codex"
      ? current.metadata.reviewer
      : undefined;
    const sourceAgent = current.metadata.reviewSourceAgent === "claude" || current.metadata.reviewSourceAgent === "codex"
      ? current.metadata.reviewSourceAgent
      : undefined;
    await this.#stopActive(task.id);
    if (!wasReview) return { wasReview: false };
    const state = await this.#options.store.read();
    const latest = state.tasks[task.id];
    const worker = current.currentWorkerId ? state.workers[current.currentWorkerId] : undefined;
    const resolvedReviewer = reviewer ?? worker?.agent ?? "claude";
    if (!latest || !reviewBaseOutcome(latest.metadata.reviewBaseOutcome)) {
      return {
        wasReview: true,
        reviewer: resolvedReviewer,
        ...(sourceAgent ? { sourceAgent } : {}),
      };
    }
    await this.#restoreReviewBaseOutcome(task.id, {
      reviewer: resolvedReviewer,
      ...(sourceAgent ? { sourceAgent } : {}),
      status: "cancelled",
      summary,
      workerId: worker?.id ?? "review-not-started",
      reviewedAt: new Date().toISOString(),
    }, keepRetry, conversationId);
    if (!keepRetry) await this.#options.flushTransport().catch(() => undefined);
    return {
      wasReview: true,
      reviewer: resolvedReviewer,
      ...(sourceAgent ? { sourceAgent } : {}),
    };
  }

  async #preserveReviewBaseOutcome(taskId: string): Promise<void> {
    await this.#options.store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) throw new Error(`Unknown Dex task: ${taskId}`);
      if (reviewBaseOutcome(task.metadata.reviewBaseOutcome)) return;
      if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
        throw new Error(`${task.title} must finish before another agent can review it.`);
      }
      task.metadata.reviewBaseOutcome = {
        status: task.status,
        stage: task.stage,
        ...(task.latestSummary ? { latestSummary: task.latestSummary } : {}),
        ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
        ...(task.testStatus ? { testStatus: task.testStatus } : {}),
      } satisfies ReviewBaseOutcome;
    });
  }

  async #restoreReviewBaseOutcome(
    taskId: string,
    review: ReviewOutcomeRecord,
    keepRetry = false,
    conversationId?: string,
  ): Promise<void> {
    const task = await this.#latestTask(taskId);
    const terminal = !keepRetry;
    if (terminal && !conversationId) {
      throw new Error(`Cannot finalize ${task.title} review without a conversation`);
    }
    const kind = review.status === "completed"
      ? "review_completed" as const
      : review.status === "failed" ? "review_failed" as const : "review_cancelled" as const;
    const text = review.status === "completed"
      ? `${task.title} review is done. ${reviewMessage(review.summary)}`
      : review.status === "failed"
        ? `${task.title} review failed. ${reviewMessage(review.summary)}`
        : `${task.title} review is stopped. the implementation outcome is preserved.`;
    await this.#options.tasks.restoreReviewBaseOutcome(taskId, review, {
      keepRetry,
      retainReviewIntent: !keepRetry && review.status === "failed",
      ...(terminal ? {
        conversationId: conversationId!,
        text,
        kind,
        dedupeKey: `review-${review.status}:${review.workerId}`,
      } : {}),
    });
  }

  async #adoptSession(
    action: SessionAdoptionRequest,
    context: OrchestratorMessageContext,
  ): Promise<DexTask> {
    const sessions = await (this.#options.discoverSessions ?? ((provider?: AgentKind) =>
      discoverSessions({ ...(provider ? { provider } : {}) })))(action.provider);
    const current = sessions.find((session) =>
      session.provider === action.provider && session.sessionId === action.sessionId);
    if (!current) {
      throw new Error(`That ${action.provider} session is no longer available. ask me to list sessions again.`);
    }
    if (current.active) {
      throw new Error(`That ${current.provider} session still appears active. stop it before asking Dex to adopt it.`);
    }
    if (current.cwd && !isWithinProject(this.#options.project.path, current.cwd)) {
      throw new Error(`That session belongs to ${current.cwd}, not the registered project ${this.#options.project.path}.`);
    }
    const adoption = this.#adoptionTail.then(async () => {
      const state = await this.#options.store.read();
      const existingTask = Object.values(state.tasks).find((task) =>
        (task.metadata.adoptedProvider === current.provider &&
          task.metadata.adoptedProviderSessionId === current.sessionId) ||
        task.workerHistory.some((id) => {
          const worker = state.workers[id];
          return worker?.agent === current.provider && worker.providerSessionId === current.sessionId;
        }));
      if (existingTask) {
        throw new Error(`That ${current.provider} session already belongs to ${existingTask.title}. resume that Dex task instead.`);
      }
      const adopted = await this.#options.tasks.createTask({
        description: current.summary ?? `continue ${current.provider} session ${current.sessionId}`,
        project: this.#options.project,
        preferredAgent: current.provider,
      });
      await this.#options.store.updateState((draft) => {
        const task = draft.tasks[adopted.id];
        if (!task) throw new Error(`Adopted task disappeared: ${adopted.id}`);
        task.metadata.conversationId = context.conversationId;
        task.metadata.adoptedProviderSessionId = current.sessionId;
        task.metadata.adoptedProvider = current.provider;
        if (current.cwd) task.metadata.discoveredSessionCwd = current.cwd;
        task.metadata.discoveredSessionUpdatedAt = current.updatedAt;
        task.updatedAt = new Date().toISOString();
      });
      return adopted;
    });
    this.#adoptionTail = adoption.then(() => undefined, () => undefined);
    const adopted = await adoption;
    await this.#options.publishTask?.(adopted, context.conversationId);
    await this.#options.notify(context.conversationId, "on it").catch(() => undefined);
    await this.drainQueue(context.conversationId);
    return adopted;
  }

  async #latestTask(taskId: string): Promise<DexTask> {
    const state = await this.#options.store.read();
    const task = state.tasks[taskId];
    if (!task) throw new Error(`Unknown Dex task: ${taskId}`);
    return task;
  }

  async #bumpLifecycleGeneration(taskId: string): Promise<number> {
    let generation = 0;
    await this.#options.store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) throw new Error(`Unknown Dex task: ${taskId}`);
      generation = lifecycleGeneration(task) + 1;
      task.metadata.lifecycleGeneration = generation;
      task.updatedAt = new Date().toISOString();
    });
    return generation;
  }

  /** Claims an explicit resume relative to worker-slot reservation. If a
   * recovery/start already owns the task, reject without invalidating that
   * startup's generation. */
  async #claimLifecycleGenerationForResume(taskId: string): Promise<number> {
    let generation = 0;
    const operation = this.#startGateTail.then(async () => {
      await this.#options.store.updateState((state) => {
        const task = state.tasks[taskId];
        if (!task) throw new Error(`Unknown Dex task: ${taskId}`);
        const worker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
        const hasDurableWorker = worker && ["starting", "running", "waiting"].includes(worker.status);
        if (this.#active.has(taskId) || this.#starting.has(taskId) || hasDurableWorker) {
          throw new Error(`${task.title} already has an active worker`);
        }
        generation = lifecycleGeneration(task) + 1;
        task.metadata.lifecycleGeneration = generation;
        task.updatedAt = new Date().toISOString();
      });
    });
    this.#startGateTail = operation.catch(() => undefined);
    await operation;
    return generation;
  }

  async #resolveReviewTask(
    query: string | undefined,
    requestedSourceAgent: AgentKind | undefined,
    conversationId: string,
  ): Promise<{ task: DexTask; sourceAgent?: AgentKind }> {
    const state = await this.#options.store.read();
    const hasSourceWorker = (task: DexTask, agent: AgentKind) => task.workerHistory.some((workerId) => {
      const worker = state.workers[workerId];
      return worker?.agent === agent && worker.purpose === "work";
    });
    let task: DexTask | undefined;
    if (query) {
      task = await this.#resolveOne(query, conversationId);
    } else {
      task = Object.values(state.tasks)
        .filter((candidate) => ["completed", "failed", "cancelled"].includes(candidate.status))
        .filter((candidate) => candidate.metadata.conversationId === conversationId)
        .filter((candidate) => !requestedSourceAgent || hasSourceWorker(candidate, requestedSourceAgent))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    }
    if (!task) {
      throw new Error(requestedSourceAgent
        ? `I couldn't find completed ${requestedSourceAgent} work to review.`
        : "I couldn't find completed work to review.");
    }
    if (["completed", "failed", "cancelled"].includes(task.status) && this.#active.has(task.id)) {
      await this.#supervisions.get(task.id);
      task = await this.#latestTask(task.id);
    }
    if (!["completed", "failed", "cancelled"].includes(task.status) || this.#active.has(task.id)) {
      throw new Error(`${task.title} is still running. ask me to review it when the current worker finishes.`);
    }
    if (requestedSourceAgent && !hasSourceWorker(task, requestedSourceAgent)) {
      throw new Error(`I couldn't find ${requestedSourceAgent} work on ${task.title}.`);
    }
    const sourceAgent = requestedSourceAgent ?? [...task.workerHistory]
      .reverse()
      .map((workerId) => state.workers[workerId])
      .filter((worker) => worker?.purpose === "work")
      .map((worker) => worker?.agent)
      .find((agent): agent is AgentKind => agent === "claude" || agent === "codex");
    return { task, ...(sourceAgent ? { sourceAgent } : {}) };
  }

  async #affiliatedTask(conversationId: string): Promise<DexTask | undefined> {
    const sameConversation = (await this.#options.tasks.list())
      .filter((task) => task.metadata.conversationId === conversationId);
    const active = sameConversation.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
    if (active.length === 1) return active[0];
    if (active.length > 1) return undefined;
    return sameConversation[0];
  }

  async #latestReviewedTask(conversationId: string): Promise<DexTask> {
    const task = (await this.#options.tasks.list())
      .filter((candidate) => candidate.metadata.conversationId === conversationId)
      .filter((candidate) => reviewRecord(candidate.metadata.latestReview))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!task) throw new Error("I don't have completed review findings in this conversation yet.");
    return task;
  }

  async #resolveOne(query: string, conversationId?: string): Promise<DexTask> {
    const implicit = /^(?:it|that|this|that one|this one|current|current task)$/i.test(query.trim());
    if (implicit) {
      if (!conversationId) throw new Error("Tell me which task you mean.");
      const sameConversation = (await this.#options.tasks.list())
        .filter((task) => task.metadata.conversationId === conversationId);
      const active = sameConversation.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
      if (active.length === 1) return active[0]!;
      if (active.length > 1) {
        throw new Error(`I found multiple active tasks here: ${active.slice(0, 3).map((task) => task.title).join(", ")}.`);
      }
      if (sameConversation.length === 1) return sameConversation[0]!;
      if (sameConversation.length > 1) {
        throw new Error(`I found multiple recent tasks here: ${sameConversation.slice(0, 3).map((task) => task.title).join(", ")}.`);
      }
      throw new Error("I couldn't find a task in this conversation. name the task you mean.");
    }
    const matches = await this.#options.tasks.find(query);
    if (matches.length === 0) throw new Error(`I couldn't find a task matching “${query}”.`);
    if (matches.length > 1 && conversationId) {
      const sameConversation = matches.filter((task) => task.metadata.conversationId === conversationId);
      if (sameConversation.length === 1) return sameConversation[0]!;
      if (sameConversation.length > 1) {
        throw new Error(`I found multiple tasks matching “${query}” here: ${sameConversation.slice(0, 3).map((task) => task.title).join(", ")}.`);
      }
    }
    if (matches.length > 1) throw new Error(`I found multiple tasks matching “${query}”: ${matches.slice(0, 3).map((task) => task.title).join(", ")}.`);
    return matches[0]!;
  }

  async #resolveControlTargets(query: string, conversationId: string): Promise<DexTask[]> {
    const all = /^(?:everything|all|all tasks|everything unfinished|all unfinished tasks|unfinished tasks)$/i
      .test(query.trim());
    if (!all) return [await this.#resolveOne(query, conversationId)];
    const targets = (await this.#options.tasks.list())
      .filter((task) => task.metadata.conversationId === conversationId)
      .filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
    if (targets.length === 0) throw new Error("I couldn't find unfinished work in this conversation.");
    return targets;
  }
}

function chooseAgent(task: DexTask, index: number): AgentKind {
  if (task.preferredAgent) return task.preferredAgent;
  if (/\b(?:investigate|review|understand|diagnose)\b/i.test(task.originalRequest)) return "claude";
  return index === 1 ? "claude" : "codex";
}

function taskPreparationReady(task: DexTask): boolean {
  // Tasks written by older Dex versions predate the explicit preparation
  // fence and already point at completed worktrees.
  return task.metadata.preparationStatus === undefined || task.metadata.preparationStatus === "ready";
}

function isWithinProject(projectPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(projectPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function reviewBaseOutcome(value: unknown): ReviewBaseOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "completed" && candidate.status !== "failed" && candidate.status !== "cancelled") {
    return undefined;
  }
  const stage = SemanticStageSchema.safeParse(candidate.stage);
  if (!stage.success) return undefined;
  const testStatus = candidate.testStatus === undefined
    ? undefined
    : TestStatusSchema.safeParse(candidate.testStatus);
  if (testStatus && !testStatus.success) return undefined;
  return {
    status: candidate.status,
    stage: stage.data,
    ...(typeof candidate.latestSummary === "string" ? { latestSummary: candidate.latestSummary } : {}),
    ...(typeof candidate.blockedReason === "string" ? { blockedReason: candidate.blockedReason } : {}),
    ...(testStatus?.success ? { testStatus: testStatus.data } : {}),
  };
}

function reviewRecord(value: unknown): ReviewRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.reviewer !== "claude" && candidate.reviewer !== "codex") return undefined;
  if (candidate.status !== "completed" && candidate.status !== "failed" && candidate.status !== "cancelled") {
    return undefined;
  }
  if (
    typeof candidate.summary !== "string" ||
    typeof candidate.workerId !== "string" ||
    typeof candidate.reviewedAt !== "string"
  ) {
    return undefined;
  }
  const sourceAgent = candidate.sourceAgent === "claude" || candidate.sourceAgent === "codex"
    ? candidate.sourceAgent
    : undefined;
  return {
    reviewer: candidate.reviewer,
    ...(sourceAgent ? { sourceAgent } : {}),
    status: candidate.status,
    summary: candidate.summary,
    workerId: candidate.workerId,
    reviewedAt: candidate.reviewedAt,
  };
}

function workerPrompt(task: DexTask, inheritedMemories: string[] = []): string {
  const memory = inheritedMemories.length > 0
    ? `\n\nRELEVANT PRIOR KNOWLEDGE:\n${inheritedMemories.slice(0, 15).map((item) => `- ${item}`).join("\n")}\n\nTreat recorded failed approaches as constraints. Do not repeat them without new evidence.`
    : "";
  return `You are a coding worker operating under Dex.\n\nTASK:\n${task.title}\n\nUSER'S ORIGINAL REQUEST:\n${task.originalRequest}\n\nREPOSITORY:\n${task.repositoryPath}\n\nBRANCH:\n${task.dexBranch}${memory}\n\nREQUIREMENTS:\n1. Complete the task rather than only explaining it.\n2. Inspect the existing implementation before modifying it.\n3. Preserve existing conventions.\n4. Run relevant tests.\n5. Do not push, deploy, merge, or perform destructive remote actions.\n6. Summarize changes, validation, failed approaches, and remaining issues.`;
}

function reviewPrompt(
  task: DexTask,
  inheritedMemories: string[] = [],
  sourceAgent?: AgentKind,
): string {
  const memory = inheritedMemories.length > 0
    ? `\n\nRELEVANT TASK MEMORY:\n${inheritedMemories.slice(0, 15).map((item) => `- ${item}`).join("\n")}`
    : "";
  return `You are a REVIEW-ONLY worker operating under Dex.\n\nTASK BEING REVIEWED:\n${task.title}\n\nUSER'S ORIGINAL REQUEST:\n${task.originalRequest}\n\nSOURCE WORKER:\n${sourceAgent ?? "previous coding worker"}\n\nWORKTREE:\n${task.worktreePath}\n\nBASE BRANCH:\n${task.baseBranch}\n\nDEX BRANCH:\n${task.dexBranch}${memory}\n\nREVIEW CONTRACT:\n1. Do not edit, write, patch, format, commit, push, merge, deploy, or mutate any file or remote resource.\n2. Inspect the current worktree, committed diff against the base branch, and any uncommitted diff.\n3. Check correctness, regressions, security, tests, and whether the original request was actually satisfied.\n4. Treat remembered failed approaches as constraints and flag any recurrence.\n5. Return findings ordered by severity with file and line references.\n6. If there are no material findings, say so explicitly and note any remaining validation gaps.`;
}

function stageForEvent(event: AgentEvent): SemanticStage | undefined {
  if (event.type !== "tool") return undefined;
  if (/test|vitest|jest|pytest|cargo test/i.test(event.name)) return "testing";
  if (/read|search|find|grep|list/i.test(event.name)) return "investigating";
  if (/edit|write|patch|file_change/i.test(event.name)) return "implementing";
  return undefined;
}

function concise(value: string): string {
  const text = redactString(value).replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

function reviewOutput(value: string): string {
  const redacted = redactString(value).trim();
  if (redacted.length <= MAX_REVIEW_SUMMARY_CHARS) return redacted;
  const digest = createHash("sha256").update(redacted).digest("hex").slice(0, 16);
  const suffix = `\n\n[Dex retained the first ${MAX_REVIEW_SUMMARY_CHARS.toLocaleString()} characters; original ${redacted.length.toLocaleString()} characters; sha256 ${digest}]`;
  return `${redacted.slice(0, MAX_REVIEW_SUMMARY_CHARS - suffix.length).trimEnd()}${suffix}`;
}

function reviewMessage(value: string): string {
  return value.length > 1_200 ? `${value.slice(0, 1_197)}…` : value;
}

function reviewResultMessages(title: string, review: ReviewRecord): string[] {
  const chunks = splitMessageText(review.summary, REVIEW_MESSAGE_CHARS).slice(0, MAX_REVIEW_MESSAGE_CHUNKS);
  if (chunks.length === 1) return [`${review.reviewer} review of ${title}:\n${chunks[0]}`];
  return chunks.map((chunk, index) => index === 0
    ? `${review.reviewer} review of ${title} (${index + 1}/${chunks.length}):\n${chunk}`
    : `${title} review continued (${index + 1}/${chunks.length}):\n${chunk}`);
}

function splitMessageText(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars + 1);
    const newline = candidate.lastIndexOf("\n");
    const whitespace = candidate.lastIndexOf(" ");
    const boundary = Math.max(newline, whitespace);
    const cut = boundary >= Math.floor(maxChars * 0.6) ? boundary : maxChars;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function createStartupControl(): StartupControl {
  const controller = new AbortController();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return { controller, settled, resolveSettled };
}

function lifecycleGeneration(task: DexTask): number {
  const value = task.metadata.lifecycleGeneration;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function needsModalHandoffRecovery(task: DexTask): boolean {
  if (task.status === "checkpointing" || task.status === "handoff") return true;
  const value = task.metadata.modalHandoffJournal;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  if (journal.cleanupPending === true) return true;
  return typeof journal.phase === "string" &&
    !["completed", "stopped", "failed"].includes(journal.phase);
}

class WorkerCapacityError extends Error {
  constructor() {
    super("Dex worker capacity is currently full");
    this.name = "WorkerCapacityError";
  }
}

class WorkerStartCancelledError extends Error {
  constructor(taskId: string) {
    super(`Worker startup cancelled for ${taskId}`);
    this.name = "WorkerStartCancelledError";
  }
}
