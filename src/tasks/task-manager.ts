import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { DexPaths } from "../config/paths.js";
import type { EventLog } from "../state/events.js";
import {
  DexTaskSchema,
  SemanticStageSchema,
  TestStatusSchema,
  type AgentKind,
  type DexProject,
  type DexState,
  type DexTask,
  type SemanticStage,
  type TaskStatus,
} from "../state/schemas.js";
import type { DexStateStore } from "../state/store.js";
import { eventId as makeEventId, slugify, taskId as makeTaskId } from "../utils/ids.js";
import { redactString } from "../utils/redact.js";
import {
  createWorktree,
  inspectRepository,
  rollbackCreatedWorktree,
  type RepositoryInfo,
  type WorktreeResult,
} from "./worktree.js";

const ALLOWED: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["preparing", "checkpointing", "cancelled", "failed"]),
  preparing: new Set(["running", "checkpointing", "failed", "cancelled"]),
  running: new Set(["queued", "preparing", "waiting_user", "checkpointing", "completed", "failed", "cancelled"]),
  waiting_user: new Set(["queued", "preparing", "running", "checkpointing", "cancelled", "failed"]),
  checkpointing: new Set(["queued", "preparing", "handoff", "running", "failed", "cancelled"]),
  handoff: new Set(["preparing", "running", "failed", "cancelled"]),
  completed: new Set(["queued", "preparing", "checkpointing"]),
  failed: new Set(["queued", "preparing", "checkpointing", "cancelled"]),
  cancelled: new Set(["queued", "preparing", "checkpointing"]),
};
const MAX_OUTBOUND_MESSAGE_CHARS = 7_900;

export const LocalTerminalEffectJournalSchema = z.discriminatedUnion("phase", [
  z.object({
    version: z.literal(1),
    phase: z.literal("recovery_pending"),
    reason: z.string().min(1).max(20_000),
    updatedAt: z.string().datetime(),
  }).strict(),
  z.object({
    version: z.literal(1),
    phase: z.literal("notification_pending"),
    kind: z.enum([
      "work_completed", "work_failed", "startup_failed", "supervision_failed",
      "review_completed", "review_failed", "review_cancelled",
    ]),
    dedupeKey: z.string().min(1).max(512),
    eventId: z.string().min(1).max(512),
    queuedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
  z.object({
    version: z.literal(1),
    phase: z.literal("complete"),
    kind: z.enum([
      "work_completed", "work_failed", "startup_failed", "supervision_failed",
      "review_completed", "review_failed", "review_cancelled",
    ]),
    dedupeKey: z.string().min(1).max(512),
    eventId: z.string().min(1).max(512),
    queuedAt: z.string().datetime(),
    acceptedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
]);

export type LocalTerminalEffectJournal = z.infer<typeof LocalTerminalEffectJournalSchema>;
export type LocalTerminalEffectKind = Extract<
  LocalTerminalEffectJournal,
  { phase: "notification_pending" }
>["kind"];

const ReviewBaseOutcomeSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  stage: SemanticStageSchema,
  latestSummary: z.string().optional(),
  blockedReason: z.string().optional(),
  testStatus: TestStatusSchema.optional(),
}).strict();

export interface ReviewOutcomeRecord {
  reviewer: AgentKind;
  sourceAgent?: AgentKind;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  workerId: string;
  reviewedAt: string;
}

export interface TerminalNotificationInput {
  status: "completed" | "failed" | "cancelled";
  stage: SemanticStage;
  summary: string;
  blockedReason?: string;
  conversationId: string;
  text: string;
  kind: LocalTerminalEffectKind;
  dedupeKey: string;
}

export interface CreateTaskInput {
  id?: string;
  /** Stable ingress identity used to make acceptance retry-safe. */
  dedupeKey?: string;
  description: string;
  project: DexProject;
  preferredAgent?: AgentKind;
  executionPreference?: "local" | "cloud";
  createWorktree?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskPreparationOperations {
  inspectRepository(repositoryPath: string): Promise<RepositoryInfo>;
  createWorktree(repository: RepositoryInfo, worktreesRoot: string, taskId: string): Promise<WorktreeResult>;
  rollbackCreatedWorktree(repositoryRoot: string, worktree: WorktreeResult): Promise<void>;
}

export type LocalWorkerHandoffClaim =
  | {
      status: "claimed";
      task: DexTask;
      sourceWorkerId: string;
      sourceGeneration: number;
      claimedGeneration: number;
    }
  | {
      status: "local_completed" | "stale";
      task: DexTask;
    };

export class TaskManager {
  readonly #store: DexStateStore;
  readonly #events: EventLog;
  readonly #paths: DexPaths;
  readonly #preparation: TaskPreparationOperations;
  #preparationTail: Promise<void> = Promise.resolve();

  constructor(
    store: DexStateStore,
    events: EventLog,
    paths: DexPaths,
    preparation: Partial<TaskPreparationOperations> = {},
  ) {
    this.#store = store;
    this.#events = events;
    this.#paths = paths;
    this.#preparation = {
      inspectRepository: preparation.inspectRepository ?? inspectRepository,
      createWorktree: preparation.createWorktree ?? createWorktree,
      rollbackCreatedWorktree: preparation.rollbackCreatedWorktree ?? rollbackCreatedWorktree,
    };
  }

  async createTask(input: CreateTaskInput): Promise<DexTask> {
    return (await this.createTasks([input]))[0]!;
  }

  async createTasks(inputs: readonly CreateTaskInput[]): Promise<DexTask[]> {
    const accepted = await this.acceptTasks(inputs);
    return this.prepareTasks(accepted.map(({ id }) => id));
  }

  /**
   * Persists lightweight task identities atomically without touching Git.
   * Workers are fenced by `preparationStatus=pending` until `prepareTasks`
   * commits every requested worktree in one state revision.
   */
  async acceptTasks(inputs: readonly CreateTaskInput[]): Promise<DexTask[]> {
    if (inputs.length === 0) return [];
    const candidates = inputs.map((input) => {
      const title = taskTitle(input.description);
      const id = input.id === undefined
        ? input.dedupeKey ? stableTaskId(title, input.dedupeKey) : makeTaskId(title)
        : validatedTaskId(input.id);
      const now = new Date().toISOString();
      const needsWorktree = input.createWorktree !== false;
      return DexTaskSchema.parse({
        id,
        kind: "dex",
        projectId: input.project.id,
        title,
        originalRequest: input.description,
        repositoryPath: path.resolve(input.project.path),
        repositoryRemote: input.project.remote,
        baseBranch: input.project.defaultBranch,
        dexBranch: `dex/${id}`,
        worktreePath: path.join(this.#paths.worktrees, id),
        status: "queued",
        stage: "queued",
        createdAt: now,
        updatedAt: now,
        preferredAgent: input.preferredAgent,
        executionPreference: input.executionPreference,
        workerHistory: [],
        memoryQueries: [],
        metadata: {
          ...input.metadata,
          preparationStatus: needsWorktree ? "pending" : "ready",
          preparationAttempts: 0,
          createWorktree: needsWorktree,
        },
      });
    });
    const accepted: DexTask[] = [];
    const inserted = new Set<string>();
    await this.#store.updateState((state) => {
      for (const candidate of candidates) {
        const existing = state.tasks[candidate.id];
        if (existing) {
          assertSameAcceptedTask(existing, candidate);
          accepted.push(existing);
          continue;
        }
        state.tasks[candidate.id] = candidate;
        accepted.push(candidate);
        inserted.add(candidate.id);
      }
    });
    await Promise.all(accepted.filter(({ id }) => inserted.has(id)).map((task) => this.#events.append({
      id: `task-created:${task.id}`,
      type: "task.created",
      taskId: task.id,
      payload: { title: task.title, projectId: task.projectId },
    })));
    return accepted;
  }

  /**
   * Prepares all pending tasks as a unit. A failure rolls back only worktrees
   * and branches created by this attempt, leaving the accepted task identities
   * durable and safe to retry.
   */
  prepareTasks(taskIds: readonly string[]): Promise<DexTask[]> {
    const operation = this.#preparationTail.then(() => this.#prepareTasksOnce(taskIds));
    this.#preparationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #prepareTasksOnce(taskIds: readonly string[]): Promise<DexTask[]> {
    if (taskIds.length === 0) return [];
    const uniqueIds = [...new Set(taskIds)];
    if (uniqueIds.length !== taskIds.length) throw new Error("Cannot prepare the same Dex task twice in one batch");
    const before = await this.#store.read();
    const requested = uniqueIds.map((id) => {
      const task = before.tasks[id];
      if (!task) throw new Error(`Unknown Dex task: ${id}`);
      return task;
    });
    const pending = requested.filter((task) => task.metadata.preparationStatus !== "ready");
    if (pending.length === 0) return requested;

    const prepared: Array<{ task: DexTask; repository: RepositoryInfo; worktree: WorktreeResult }> = [];
    let primaryError: unknown;
    try {
      for (const task of pending) {
        if (task.status !== "queued" || task.currentWorkerId) {
          throw new Error(`Cannot prepare ${task.id} after worker execution has started`);
        }
        const repository = await this.#preparation.inspectRepository(task.repositoryPath);
        const worktree = await this.#preparation.createWorktree(repository, this.#paths.worktrees, task.id);
        prepared.push({ task, repository, worktree });
      }
      await this.#store.updateState((state) => {
        for (const item of prepared) {
          const current = state.tasks[item.task.id];
          if (!current) throw new Error(`Accepted task disappeared during preparation: ${item.task.id}`);
          if (current.metadata.preparationStatus === "ready") continue;
          assertSameAcceptedTask(current, item.task);
          if (current.status !== "queued" || current.currentWorkerId) {
            throw new Error(`Task ownership changed during preparation: ${current.id}`);
          }
          current.repositoryPath = item.repository.root;
          if (item.repository.remote) current.repositoryRemote = item.repository.remote;
          else delete current.repositoryRemote;
          current.baseBranch = item.repository.branch;
          current.dexBranch = item.worktree.branch;
          current.worktreePath = item.worktree.path;
          current.metadata.preparationStatus = "ready";
          current.metadata.preparationAttempts = preparationAttempts(current) + 1;
          current.updatedAt = new Date().toISOString();
        }
      });
      const committed = await this.#store.read();
      return uniqueIds.map((id) => {
        const task = committed.tasks[id];
        if (!task || task.metadata.preparationStatus !== "ready") {
          throw new Error(`Worktree preparation was not durably committed for ${id}`);
        }
        return task;
      });
    } catch (error) {
      primaryError = error;
      // AtomicJsonStore can throw after rename if directory fsync fails. If the
      // ready state is already durable, retaining the matching worktrees is the
      // only consistent recovery.
      const committed = await this.#store.read().then(
        (state) => prepared.length > 0 && prepared.every(({ task, worktree }) => {
          const current = state.tasks[task.id];
          return current?.metadata.preparationStatus === "ready" &&
            current.worktreePath === worktree.path && current.dexBranch === worktree.branch;
        }),
        () => false,
      );
      if (committed) {
        const state = await this.#store.read();
        return uniqueIds.map((id) => state.tasks[id]!);
      }
    }

    const cleanupErrors: unknown[] = [];
    for (const item of prepared.reverse()) {
      if (!item.worktree.createdWorktree && !item.worktree.createdBranch) continue;
      await this.#preparation.rollbackCreatedWorktree(item.repository.root, item.worktree).catch((error: unknown) => {
        cleanupErrors.push(error);
      });
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], "Task preparation failed and cleanup was incomplete");
    }
    throw primaryError;
  }

  async transition(
    taskId: string,
    status: TaskStatus,
    patch: Partial<Pick<DexTask, "latestSummary" | "nextStep" | "blockedReason" | "testStatus">> & {
      stage?: SemanticStage;
    } = {},
  ): Promise<DexTask> {
    let updated: DexTask | undefined;
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      if (current.status !== status && !ALLOWED[current.status].has(status)) {
        throw new Error(`Invalid Dex task transition ${current.status} -> ${status}`);
      }
      updated = DexTaskSchema.parse({
        ...current,
        ...patch,
        status,
        metadata: metadataForTransition(current, status),
        updatedAt: new Date().toISOString(),
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) throw new Error(`Task ${taskId} was not updated`);
    const eventType = status === "completed" ? "task.completed" : status === "failed" ? "task.failed" : status === "waiting_user" ? "task.blocked" : "task.started";
    await this.#events.append({ type: eventType, taskId, payload: { status, stage: updated.stage, summary: updated.latestSummary } });
    return updated;
  }

  async setContinuationInstruction(taskId: string, instruction: string): Promise<DexTask> {
    const nextStep = redactString(instruction).trim();
    if (!nextStep) throw new TypeError("A continuation instruction is required");
    let updated: DexTask | undefined;
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      updated = DexTaskSchema.parse({
        ...current,
        nextStep,
        updatedAt: new Date().toISOString(),
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) throw new Error(`Task ${taskId} was not updated`);
    return updated;
  }

  /**
   * Applies a worker outcome only while that worker still owns the durable task.
   * A late process result must never overwrite a replacement worker or an
   * explicit user instruction that changed task ownership.
   */
  async transitionIfCurrentWorker(
    taskId: string,
    expectedWorkerId: string,
    status: TaskStatus,
    patch: Partial<Pick<DexTask, "latestSummary" | "nextStep" | "blockedReason" | "testStatus">> & {
      stage?: SemanticStage;
    } = {},
  ): Promise<DexTask | undefined> {
    let updated: DexTask | undefined;
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      if (current.currentWorkerId !== expectedWorkerId) return;
      if (current.status !== status && !ALLOWED[current.status].has(status)) {
        throw new Error(`Invalid Dex task transition ${current.status} -> ${status}`);
      }
      updated = DexTaskSchema.parse({
        ...current,
        ...patch,
        status,
        metadata: metadataForTransition(current, status),
        updatedAt: new Date().toISOString(),
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) return undefined;
    const eventType = status === "completed" ? "task.completed" : status === "failed" ? "task.failed" : status === "waiting_user" ? "task.blocked" : "task.started";
    await this.#events.append({ type: eventType, taskId, payload: { status, stage: updated.stage, summary: updated.latestSummary } });
    return updated;
  }

  /**
   * Atomically chooses the winner between a local worker's terminal result and
   * a battery-response cloud handoff. The compare-and-swap is intentionally
   * bound to both worker identity and lifecycle generation: a stale prompt can
   * never claim a replacement worker, and a worker result from the generation
   * before this claim can never finish the task afterward.
   */
  async claimLocalWorkerForCloudHandoff(
    taskId: string,
    expectedWorkerId: string,
    expectedGeneration: number,
  ): Promise<LocalWorkerHandoffClaim> {
    let outcome: LocalWorkerHandoffClaim | undefined;
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      const worker = state.workers[current.currentWorkerId ?? ""];
      const generation = taskLifecycleGeneration(current);

      if (current.status === "completed" || (
        current.currentWorkerId === expectedWorkerId && worker?.status === "completed"
      )) {
        outcome = { status: "local_completed", task: current };
        return;
      }
      if (
        current.currentWorkerId !== expectedWorkerId ||
        generation !== expectedGeneration ||
        worker?.target.kind !== "local" ||
        worker.purpose !== "work" ||
        !["starting", "running", "waiting"].includes(worker.status) ||
        !["queued", "preparing", "running", "waiting_user"].includes(current.status)
      ) {
        outcome = { status: "stale", task: current };
        return;
      }
      if (expectedGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`Lifecycle generation exhausted for ${current.title}`);
      }

      const claimedGeneration = expectedGeneration + 1;
      const timestamp = new Date().toISOString();
      const claimed = DexTaskSchema.parse({
        ...current,
        status: "checkpointing",
        stage: "checkpointing",
        latestSummary: "checkpointing local work for cloud handoff",
        metadata: {
          ...metadataForTransition(current, "checkpointing"),
          lifecycleGeneration: claimedGeneration,
        },
        updatedAt: timestamp,
      });
      state.tasks[taskId] = claimed;
      outcome = {
        status: "claimed",
        task: claimed,
        sourceWorkerId: expectedWorkerId,
        sourceGeneration: expectedGeneration,
        claimedGeneration,
      };
    });
    if (!outcome) throw new Error(`Task ${taskId} handoff claim did not resolve`);
    if (outcome.status === "claimed") {
      await this.#events.append({
        type: "handoff.started",
        taskId,
        workerId: outcome.sourceWorkerId,
        payload: {
          reason: "battery_response",
          sourceGeneration: outcome.sourceGeneration,
          claimedGeneration: outcome.claimedGeneration,
        },
      }).catch(() => undefined);
    }
    return outcome;
  }

  /**
   * Commits a successful local-worker outcome and its user notification to
   * the same atomic state revision. Power policy can therefore never observe
   * a terminal task without also observing the durable transport event that
   * must be accepted before sleep.
   */
  async completeIfCurrentWorkerWithNotification(
    taskId: string,
    expectedWorkerId: string,
    summary: string,
    conversationId: string,
    text: string,
  ): Promise<DexTask | undefined> {
    return this.finalizeIfCurrentWorkerWithNotification(taskId, expectedWorkerId, {
      status: "completed",
      stage: "done",
      summary,
      conversationId,
      text,
      kind: "work_completed",
      dedupeKey: `work-completed:${expectedWorkerId}`,
    });
  }

  async completeIfCurrentWorkerAndGenerationWithNotification(
    taskId: string,
    expectedWorkerId: string,
    expectedGeneration: number,
    summary: string,
    conversationId: string,
    text: string,
  ): Promise<DexTask | undefined> {
    return this.finalizeIfCurrentWorkerAndGenerationWithNotification(
      taskId,
      expectedWorkerId,
      expectedGeneration,
      {
        status: "completed",
        stage: "done",
        summary,
        conversationId,
        text,
        kind: "work_completed",
        dedupeKey: `work-completed:${expectedWorkerId}`,
      },
    );
  }

  async markRecoveryPendingIfCurrentWorker(
    taskId: string,
    expectedWorkerId: string,
    patch: Partial<Pick<DexTask, "latestSummary" | "nextStep" | "blockedReason" | "testStatus">> & {
      stage?: SemanticStage;
    },
    reason: string,
  ): Promise<DexTask | undefined> {
    return this.#markRecoveryPending(taskId, (task) => task.currentWorkerId === expectedWorkerId, patch, reason);
  }

  async markRecoveryPendingIfCurrentWorkerAndGeneration(
    taskId: string,
    expectedWorkerId: string,
    expectedGeneration: number,
    patch: Partial<Pick<DexTask, "latestSummary" | "nextStep" | "blockedReason" | "testStatus">> & {
      stage?: SemanticStage;
    },
    reason: string,
  ): Promise<DexTask | undefined> {
    return this.#markRecoveryPending(
      taskId,
      (task) => ownsWorkerGeneration(task, expectedWorkerId, expectedGeneration),
      patch,
      reason,
    );
  }

  async markRecoveryPendingIfGeneration(
    taskId: string,
    expectedGeneration: number,
    patch: Partial<Pick<DexTask, "latestSummary" | "nextStep" | "blockedReason" | "testStatus">> & {
      stage?: SemanticStage;
    },
    reason: string,
  ): Promise<DexTask | undefined> {
    return this.#markRecoveryPending(
      taskId,
      (task) => (typeof task.metadata.lifecycleGeneration === "number" ? task.metadata.lifecycleGeneration : 0) === expectedGeneration,
      patch,
      reason,
    );
  }

  async finalizeIfCurrentWorkerWithNotification(
    taskId: string,
    expectedWorkerId: string,
    input: TerminalNotificationInput,
  ): Promise<DexTask | undefined> {
    return this.#finalizeWithNotification(taskId, (task) => task.currentWorkerId === expectedWorkerId, input);
  }

  async finalizeIfCurrentWorkerAndGenerationWithNotification(
    taskId: string,
    expectedWorkerId: string,
    expectedGeneration: number,
    input: TerminalNotificationInput,
  ): Promise<DexTask | undefined> {
    return this.#finalizeWithNotification(
      taskId,
      (task) => ownsWorkerGeneration(task, expectedWorkerId, expectedGeneration),
      input,
    );
  }

  async finalizeIfGenerationWithNotification(
    taskId: string,
    expectedGeneration: number,
    input: TerminalNotificationInput,
  ): Promise<DexTask | undefined> {
    return this.#finalizeWithNotification(
      taskId,
      (task) => (typeof task.metadata.lifecycleGeneration === "number" ? task.metadata.lifecycleGeneration : 0) === expectedGeneration,
      input,
    );
  }

  async restoreReviewBaseOutcome(
    taskId: string,
    review: ReviewOutcomeRecord,
    options: {
      keepRetry: boolean;
      retainReviewIntent?: boolean;
      conversationId?: string;
      text?: string;
      kind?: Extract<LocalTerminalEffectKind, "review_completed" | "review_failed" | "review_cancelled">;
      dedupeKey?: string;
    },
  ): Promise<DexTask> {
    let updated: DexTask | undefined;
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      const base = ReviewBaseOutcomeSchema.safeParse(current.metadata.reviewBaseOutcome);
      if (!base.success) throw new Error(`Missing review base outcome for ${current.title}`);
      const timestamp = new Date().toISOString();
      const metadata: Record<string, unknown> = { ...current.metadata, latestReview: review };
      delete metadata.workerRecoveryAttempts;
      if (options.keepRetry) {
        metadata.activeWorkerPurpose = "review";
        metadata.reviewer = review.reviewer;
        metadata.reviewSourceAgent = review.sourceAgent;
        metadata.localTerminalEffects = recoveryPendingJournal(review.summary, timestamp);
      } else {
        delete metadata.activeWorkerPurpose;
        delete metadata.reviewBaseOutcome;
        delete metadata.reviewer;
        delete metadata.reviewSourceAgent;
        if (options.retainReviewIntent) {
          metadata.activeWorkerPurpose = "review";
          metadata.reviewer = review.reviewer;
          metadata.reviewSourceAgent = review.sourceAgent;
        }
        if (!options.conversationId || !options.text || !options.kind || !options.dedupeKey) {
          throw new Error(`Review terminal notification is incomplete for ${current.title}`);
        }
        queueTerminalNotification(state, current, metadata, {
          status: base.data.status,
          stage: base.data.stage,
          summary: base.data.latestSummary ?? review.summary,
          conversationId: options.conversationId,
          text: options.text,
          kind: options.kind,
          dedupeKey: options.dedupeKey,
        }, timestamp);
      }
      updated = DexTaskSchema.parse({
        ...current,
        status: base.data.status,
        stage: base.data.stage,
        latestSummary: base.data.latestSummary,
        blockedReason: base.data.blockedReason,
        testStatus: base.data.testStatus,
        metadata,
        updatedAt: timestamp,
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) throw new Error(`Task ${taskId} review outcome was not restored`);
    await this.#events.append({
      type: review.status === "completed" ? "task.completed" : "task.failed",
      taskId,
      payload: { review: true, status: review.status, summary: review.summary },
    }).catch(() => undefined);
    return updated;
  }

  async confirmAcceptedLocalTerminalNotifications(): Promise<number> {
    const snapshot = await this.#store.read();
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
    await this.#store.updateState((state) => {
      const pending = new Set(state.pendingTransportEvents.map(({ id }) => id));
      const timestamp = new Date().toISOString();
      for (const task of Object.values(state.tasks)) {
        const parsed = LocalTerminalEffectJournalSchema.safeParse(task.metadata.localTerminalEffects);
        if (
          !parsed.success ||
          parsed.data.phase !== "notification_pending" ||
          task.metadata.terminalNotificationEventId !== parsed.data.eventId ||
          pending.has(parsed.data.eventId)
        ) continue;
        task.metadata.localTerminalEffects = {
          ...parsed.data,
          phase: "complete",
          acceptedAt: timestamp,
          updatedAt: timestamp,
        } satisfies LocalTerminalEffectJournal;
        task.updatedAt = timestamp;
        confirmed += 1;
      }
    });
    return confirmed;
  }

  /** Applies a transition only while the caller still owns the task lifecycle. */
  async transitionIfGeneration(
    taskId: string,
    expectedGeneration: number,
    status: TaskStatus,
    patch: Partial<Pick<DexTask, "latestSummary" | "nextStep" | "blockedReason" | "testStatus">> & {
      stage?: SemanticStage;
    } = {},
  ): Promise<DexTask | undefined> {
    let updated: DexTask | undefined;
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      const generation = typeof current.metadata.lifecycleGeneration === "number"
        ? current.metadata.lifecycleGeneration
        : 0;
      if (generation !== expectedGeneration) return;
      if (current.status !== status && !ALLOWED[current.status].has(status)) {
        throw new Error(`Invalid Dex task transition ${current.status} -> ${status}`);
      }
      updated = DexTaskSchema.parse({
        ...current,
        ...patch,
        status,
        metadata: metadataForTransition(current, status),
        updatedAt: new Date().toISOString(),
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) return undefined;
    const eventType = status === "completed" ? "task.completed" : status === "failed" ? "task.failed" : status === "waiting_user" ? "task.blocked" : "task.started";
    await this.#events.append({ type: eventType, taskId, payload: { status, stage: updated.stage, summary: updated.latestSummary } });
    return updated;
  }

  async #markRecoveryPending(
    taskId: string,
    owns: (task: DexTask) => boolean,
    patch: Partial<Pick<DexTask, "latestSummary" | "nextStep" | "blockedReason" | "testStatus">> & {
      stage?: SemanticStage;
    },
    reason: string,
  ): Promise<DexTask | undefined> {
    let updated: DexTask | undefined;
    const timestamp = new Date().toISOString();
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      if (!owns(current)) return;
      if (current.status !== "failed" && !ALLOWED[current.status].has("failed")) {
        throw new Error(`Invalid Dex task transition ${current.status} -> failed`);
      }
      updated = DexTaskSchema.parse({
        ...current,
        ...patch,
        status: "failed",
        metadata: {
          ...current.metadata,
          localTerminalEffects: recoveryPendingJournal(reason, timestamp),
        },
        updatedAt: timestamp,
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) return undefined;
    await this.#events.append({
      type: "task.failed",
      taskId,
      payload: { status: "failed", recoveryPending: true, summary: updated.latestSummary },
    }).catch(() => undefined);
    return updated;
  }

  async #finalizeWithNotification(
    taskId: string,
    owns: (task: DexTask) => boolean,
    input: TerminalNotificationInput,
  ): Promise<DexTask | undefined> {
    let updated: DexTask | undefined;
    const timestamp = new Date().toISOString();
    await this.#store.updateState((state) => {
      const current = requireTask(state, taskId);
      if (!owns(current)) return;
      if (current.status !== input.status && !ALLOWED[current.status].has(input.status)) {
        throw new Error(`Invalid Dex task transition ${current.status} -> ${input.status}`);
      }
      const metadata = { ...current.metadata };
      queueTerminalNotification(state, current, metadata, input, timestamp);
      updated = DexTaskSchema.parse({
        ...current,
        status: input.status,
        stage: input.stage,
        latestSummary: input.summary,
        ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
        metadata,
        updatedAt: timestamp,
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) return undefined;
    await this.#events.append({
      type: input.status === "completed" ? "task.completed" : "task.failed",
      taskId,
      payload: { status: input.status, stage: input.stage, summary: input.summary },
    }).catch(() => undefined);
    return updated;
  }

  async find(query: string): Promise<DexTask[]> {
    const state = await this.#store.read();
    const normalized = query.toLowerCase().trim();
    return Object.values(state.tasks)
      .filter((task) => task.id.toLowerCase().includes(normalized) || task.title.toLowerCase().includes(normalized))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async list(): Promise<DexTask[]> {
    const state = await this.#store.read();
    return Object.values(state.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function requireTask(state: DexState, taskId: string): DexTask {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Unknown Dex task: ${taskId}`);
  return task;
}

function taskLifecycleGeneration(task: DexTask): number {
  const value = task.metadata.lifecycleGeneration;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function ownsWorkerGeneration(task: DexTask, workerId: string, generation: number): boolean {
  return task.currentWorkerId === workerId && taskLifecycleGeneration(task) === generation;
}

function metadataForTransition(task: DexTask, status: TaskStatus): Record<string, unknown> {
  const metadata = { ...task.metadata };
  if (!["completed", "failed", "cancelled"].includes(status)) {
    delete metadata.localTerminalEffects;
  }
  return metadata;
}

function recoveryPendingJournal(reason: string, timestamp: string): LocalTerminalEffectJournal {
  return {
    version: 1,
    phase: "recovery_pending",
    reason: redactString(reason).slice(0, 20_000) || "local worker recovery pending",
    updatedAt: timestamp,
  };
}

function queueTerminalNotification(
  state: DexState,
  task: DexTask,
  metadata: Record<string, unknown>,
  input: TerminalNotificationInput,
  timestamp: string,
): void {
  const existing = LocalTerminalEffectJournalSchema.safeParse(metadata.localTerminalEffects);
  if (
    existing.success &&
    existing.data.phase !== "recovery_pending" &&
    existing.data.dedupeKey === input.dedupeKey
  ) {
    metadata.terminalNotificationEventId = existing.data.eventId;
    return;
  }
  const notification = {
    id: makeEventId(),
    timestamp,
    type: "message.sent" as const,
    taskId: task.id,
    payload: {
      conversationId: input.conversationId,
      text: redactString(input.text).slice(0, MAX_OUTBOUND_MESSAGE_CHARS),
    },
  };
  metadata.terminalNotificationEventId = notification.id;
  metadata.localTerminalEffects = {
    version: 1,
    phase: "notification_pending",
    kind: input.kind,
    dedupeKey: input.dedupeKey,
    eventId: notification.id,
    queuedAt: timestamp,
    updatedAt: timestamp,
  } satisfies LocalTerminalEffectJournal;
  if (!state.pendingTransportEvents.some(({ id }) => id === notification.id)) {
    state.pendingTransportEvents.push(notification);
  }
}

function taskTitle(description: string): string {
  return description
    .replace(/^(?:please\s+)?(?:fix|finish|investigate|add|implement|build|review)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim()
    .slice(0, 72) || "engineering task";
}

function stableTaskId(title: string, dedupeKey: string): string {
  const digest = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 10);
  return validatedTaskId(`${slugify(title)}-${digest}`);
}

function assertSameAcceptedTask(existing: DexTask, candidate: DexTask): void {
  if (existing.originalRequest !== candidate.originalRequest ||
    existing.projectId !== candidate.projectId) {
    throw new Error(`Dex task identity conflicts with an existing task: ${candidate.id}`);
  }
}

function preparationAttempts(task: DexTask): number {
  const value = task.metadata.preparationAttempts;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validatedTaskId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new TypeError("Dex task ID must contain only letters, numbers, dots, underscores, and dashes");
  }
  return id;
}
