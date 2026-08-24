import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult } from "../agents/types.js";
import { discoverSessions, type DiscoveredSession } from "../agents/session-discovery.js";
import type { DexConfig } from "../config/config.js";
import type { DexPaths } from "../config/paths.js";
import type { EventLog } from "../state/events.js";
import {
  WorkerSessionSchema,
  type AgentKind,
  type DexProject,
  type DexTask,
  type SemanticStage,
  type WorkerSession,
} from "../state/schemas.js";
import type { DexStateStore } from "../state/store.js";
import type { TaskManager } from "../tasks/task-manager.js";
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
  moveToCloud(task: DexTask, preferredAgent?: AgentKind): Promise<void>;
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
  publishTask?(task: DexTask, conversationId: string): Promise<void>;
  memory?: MemoryObserver;
  mover?: TaskMover;
  power?: PowerController;
  discoverSessions?(provider?: AgentKind): Promise<DiscoveredSession[]>;
}

export class DexOrchestrator {
  readonly #options: DexOrchestratorOptions;
  readonly #active = new Map<string, AgentHandle>();
  readonly #supervisions = new Map<string, Promise<void>>();
  readonly #stopping = new Set<string>();
  #drainTail: Promise<void> = Promise.resolve();

  constructor(options: DexOrchestratorOptions) {
    this.#options = options;
  }

  async handle(actions: DexAction[], context: OrchestratorMessageContext): Promise<string> {
    const replies: string[] = [];
    const createActions = actions.filter((action): action is Extract<DexAction, { type: "CREATE_TASK" }> => action.type === "CREATE_TASK");
    const created = await this.#options.tasks.createTasks(createActions.map((action, index) => ({
      ...(index === 0 && context.cloudTaskId ? { id: context.cloudTaskId } : {}),
      description: action.description,
      project: this.#options.project,
      ...(action.preferredAgent ? { preferredAgent: action.preferredAgent } : {}),
      ...(action.executionPreference ? { executionPreference: action.executionPreference } : {}),
    })));
    if (created.length > 0) {
      await this.#options.store.updateState((state) => {
        for (const [index, task] of created.entries()) {
          const current = state.tasks[task.id];
          if (current) {
            current.metadata.conversationId = context.conversationId;
            if (index === 0 && context.cloudTaskId) current.metadata.cloudTaskId = context.cloudTaskId;
            if (context.sourceMessageId) current.metadata.sourceMessageId = context.sourceMessageId;
          }
        }
      });
    }
    await Promise.all(created.map((task) => this.#options.publishTask?.(task, context.conversationId)));
    if (created.length > 0) {
      await this.#options.notify(
        context.conversationId,
        created.length === 1 ? "on it" : `on it i'm handling all ${created.length}`,
      ).catch(() => undefined);
    }
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
            replies.push(action.provider
              ? `i couldn't find any recent ${action.provider} sessions on this mac.`
              : "i couldn't find any recent claude or codex sessions on this mac.");
          } else {
            replies.push([
              `i found ${recent.length} recent ${recent.length === 1 ? "session" : "sessions"}:`,
              ...recent.map((session) => {
                const context = session.summary ?? session.cwd ?? "no summary available";
                return `${session.provider} · ${session.sessionId} — ${context}`;
              }),
            ].join("\n"));
          }
          break;
        }
        case "ADOPT_SESSION": {
          const adopted = await this.#options.tasks.createTask({
            description: action.summary ?? `continue ${action.provider} session ${action.sessionId}`,
            project: this.#options.project,
            preferredAgent: action.provider,
          });
          await this.#options.store.updateState((state) => {
            const task = state.tasks[adopted.id];
            if (!task) throw new Error(`Adopted task disappeared: ${adopted.id}`);
            task.metadata.conversationId = context.conversationId;
            task.metadata.adoptedProviderSessionId = action.sessionId;
            task.metadata.adoptedProvider = action.provider;
            if (action.cwd) task.metadata.discoveredSessionCwd = action.cwd;
            if (action.updatedAt) task.metadata.discoveredSessionUpdatedAt = action.updatedAt;
            task.updatedAt = new Date().toISOString();
          });
          await this.#options.publishTask?.(adopted, context.conversationId);
          await this.#options.notify(context.conversationId, "on it").catch(() => undefined);
          await this.drainQueue(context.conversationId);
          replies.push(`i adopted that ${action.provider} session as ${adopted.title}. the task is durable now.`);
          break;
        }
        case "MEMORY_QUERY": {
          const matches = await this.#options.memory?.query?.(undefined, action.query);
          replies.push(matches?.length ? `yeah. ${matches.slice(0, 3).join(" ")}` : "i don't have a reliable memory for that yet.");
          break;
        }
        case "MOVE_TASK": {
          const task = await this.#resolveOne(action.taskQuery);
          if (action.destination === "cloud") {
            if (!this.#options.mover) throw new Error("Cloud movement is not configured");
            await this.#stopActive(task.id);
            await this.#options.mover.moveToCloud(await this.#latestTask(task.id), action.preferredAgent);
            await this.drainQueue(context.conversationId);
            replies.push(`${task.title} is being handed to ${action.preferredAgent ?? "codex"} in the cloud.`);
          } else {
            replies.push(`${task.title} is already durable; local return is not enabled in P0.`);
          }
          break;
        }
        case "CHANGE_AGENT": {
          const task = await this.#resolveOne(action.taskQuery);
          await this.#stopActive(task.id);
          await this.#startTask(await this.#latestTask(task.id), action.agent, context.conversationId);
          await this.drainQueue(context.conversationId);
          replies.push(`${task.title} is continuing with ${action.agent}.`);
          break;
        }
        case "STOP_TASK": {
          const task = await this.#resolveOne(action.taskQuery);
          await this.#stopActive(task.id);
          await this.#options.tasks.transition(task.id, "cancelled", { stage: "failed", latestSummary: "stopped at your request" });
          await this.drainQueue(context.conversationId);
          replies.push(`${task.title} is stopped. the task history is preserved.`);
          break;
        }
        case "RESUME_TASK": {
          const task = await this.#resolveOne(action.taskQuery);
          const latest = await this.#latestTask(task.id);
          const agent = latest.preferredAgent ?? "codex";
          const providerSessionId = await this.#latestProviderSession(latest, agent);
          await this.#startTask(latest, agent, context.conversationId, providerSessionId);
          await this.drainQueue(context.conversationId);
          replies.push(`${task.title} is running again.`);
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
    const state = await this.#options.store.read();
    const candidates = Object.values(state.tasks).filter((task) =>
      task.status === "failed" && task.metadata.interruptedByDaemonRestart === true,
    );
    let recovered = 0;
    for (const task of candidates) {
      const worker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
      const agent = worker?.agent ?? task.preferredAgent ?? "codex";
      const conversationId = typeof task.metadata.conversationId === "string"
        ? task.metadata.conversationId
        : "";
      const providerSessionId = worker?.providerSessionId
        ?? await this.#latestProviderSession(task, agent);
      const succeeded = await this.#recoverWorker(
        task.id,
        agent,
        providerSessionId,
        conversationId,
        "the local daemon restarted",
      );
      await this.#options.store.updateState((draft) => {
        const current = draft.tasks[task.id];
        if (current) delete current.metadata.interruptedByDaemonRestart;
      });
      if (succeeded) recovered += 1;
    }
    await this.drainQueue();
    return recovered;
  }

  async #drainQueueOnce(defaultConversationId?: string): Promise<void> {
    for (;;) {
      const state = await this.#options.store.read();
      const cloudWorkers = Object.values(state.workers).filter((worker) =>
        worker.target.kind === "modal" && (worker.status === "starting" || worker.status === "running"),
      ).length;
      const capacity = this.#options.config.maxConcurrency - this.#active.size - cloudWorkers;
      if (capacity <= 0) return;
      const task = Object.values(state.tasks)
        .filter((candidate) => candidate.status === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!task) return;
      const conversationId = typeof task.metadata.conversationId === "string"
        ? task.metadata.conversationId
        : defaultConversationId;
      try {
        if (task.executionPreference === "cloud") {
          if (!this.#options.mover) throw new Error("Cloud movement is not configured");
          if (conversationId) {
            await this.#options.notify(
              conversationId,
              `i'm starting a fresh ${task.preferredAgent ?? "codex"} cloud session for ${task.title} right now`,
            ).catch(() => undefined);
          }
          await this.#options.mover.moveToCloud(task, task.preferredAgent ?? "codex");
        } else {
          const adoptedProviderSessionId = typeof task.metadata.adoptedProviderSessionId === "string"
            ? task.metadata.adoptedProviderSessionId
            : undefined;
          await this.#startTask(
            task,
            chooseAgent(task, this.#active.size),
            conversationId ?? "",
            adoptedProviderSessionId,
          );
        }
      } catch (error) {
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
  ): Promise<void> {
    if (this.#active.has(task.id)) throw new Error(`${task.title} already has an active worker`);
    if (!(await this.#options.agents[agent].available())) throw new Error(`${agent} is not available on this Mac`);
    if (task.status === "completed") throw new Error(`${task.title} is already complete`);
    if (task.status !== "preparing") {
      await this.#options.tasks.transition(task.id, "preparing", { stage: agent === "claude" ? "investigating" : "implementing" });
    }
    const id = makeWorkerId();
    const now = new Date().toISOString();
    let worker = WorkerSessionSchema.parse({
      id,
      taskId: task.id,
      agent,
      target: { kind: "local", machineId: this.#options.config.deviceId ?? "local-mac" },
      status: "starting",
      startedAt: now,
      eventsPath: this.#options.paths.events,
    });
    await this.#options.store.updateState((state) => {
      state.workers[id] = worker;
      const current = state.tasks[task.id];
      if (!current) throw new Error(`Task disappeared: ${task.id}`);
      current.currentWorkerId = id;
      current.preferredAgent = agent;
      current.workerHistory.push(id);
      current.updatedAt = now;
    });
    if (conversationId) {
      await this.#options.notify(
        conversationId,
        resumeProviderSessionId
          ? `i'm resuming the saved ${agent} session for ${task.title} right now`
          : `i'm starting a fresh ${agent} session for ${task.title} right now`,
      ).catch(() => undefined);
    }

    const inheritedMemories = await this.#options.memory
      ?.query?.(task, task.originalRequest)
      .catch(() => []);
    const adapter = this.#options.agents[agent];
    let handle: AgentHandle;
    try {
      const runOptions = {
        cwd: task.worktreePath,
        prompt: workerPrompt(task, inheritedMemories),
        timeoutMs: 25 * 60_000,
        startupTimeoutMs: 45_000,
        ...(agent === "claude" ? { permissionMode: "auto" as const } : {}),
      };
      handle = resumeProviderSessionId
        ? await adapter.resume(resumeProviderSessionId, runOptions)
        : await adapter.start(runOptions);
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : String(error));
      const endedAt = new Date().toISOString();
      await this.#options.store.updateState((state) => {
        const current = state.workers[id];
        if (!current) return;
        current.status = "failed";
        current.endedAt = endedAt;
        current.lastMessage = message;
      });
      await this.#options.tasks.transition(task.id, "failed", {
        stage: "failed",
        blockedReason: message,
        latestSummary: `failed to start: ${message}`,
      });
      await this.#options.events.append({
        type: "worker.failed",
        taskId: task.id,
        workerId: id,
        payload: { phase: "startup", summary: message },
      });
      throw error;
    }
    this.#active.set(task.id, handle);
    worker = WorkerSessionSchema.parse({
      ...worker,
      status: "running",
      providerSessionId: handle.providerSessionId,
      ...(handle.pid ? { pid: handle.pid } : {}),
      lastEventAt: new Date().toISOString(),
    });
    await this.#options.store.updateState((state) => {
      state.workers[id] = worker;
    });
    await this.#options.tasks.transition(task.id, "running", { stage: agent === "claude" ? "investigating" : "implementing" });
    await this.#options.events.append({ type: "worker.started", taskId: task.id, workerId: id, payload: { agent, target: "local", providerSessionId: handle.providerSessionId } });
    const supervision = this.#supervise(task, worker, handle, conversationId);
    this.#supervisions.set(task.id, supervision);
    void supervision.then(
      () => this.#supervisions.delete(task.id),
      () => this.#supervisions.delete(task.id),
    );
  }

  async #supervise(task: DexTask, worker: WorkerSession, handle: AgentHandle, conversationId: string): Promise<void> {
    let shouldRecover = false;
    let failureSummary = "worker stopped unexpectedly";
    try {
      for await (const event of handle.events) {
        await this.#recordAgentEvent(task, worker, event);
        await this.#options.memory?.observe(task, worker, event).catch(() => undefined);
      }
      const result = await handle.result;
      const outcome = await this.#finishWorker(task, worker, result, conversationId);
      shouldRecover = outcome.shouldRecover;
      failureSummary = outcome.summary;
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : String(error));
      const deliberatelyStopping = this.#stopping.has(task.id);
      await this.#options.store.updateState((state) => {
        const current = state.workers[worker.id];
        if (current) {
          current.status = deliberatelyStopping ? "stopped" : "failed";
          current.endedAt = new Date().toISOString();
          current.lastMessage = message;
        }
      });
      if (!deliberatelyStopping) {
        await this.#options.tasks.transition(task.id, "failed", { stage: "failed", blockedReason: message, latestSummary: `failed: ${message}` });
        shouldRecover = true;
        failureSummary = message;
      }
    } finally {
      this.#active.delete(task.id);
    }
    if (shouldRecover && !this.#stopping.has(task.id)) {
      const recovered = await this.#recoverWorker(task.id, worker.agent, worker.providerSessionId, conversationId, failureSummary);
      if (!recovered) {
        await this.#options.notify(conversationId, `${task.title} failed. ${failureSummary}`).catch(() => undefined);
      }
    }
    if (!this.#stopping.has(task.id)) await this.drainQueue(conversationId);
  }

  async #recordAgentEvent(task: DexTask, worker: WorkerSession, event: AgentEvent): Promise<void> {
    const stage = stageForEvent(event);
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
      if (currentTask) {
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
  ): Promise<{ shouldRecover: boolean; summary: string }> {
    const succeeded = result.status === "completed" && result.exitCode === 0;
    const summary = concise(result.output || result.error || (succeeded ? "work completed" : "worker failed"));
    await this.#options.memory?.summarize?.(worker, summary).catch(() => undefined);
    await this.#options.store.updateState((state) => {
      const current = state.workers[worker.id];
      if (!current) return;
      current.status = succeeded ? "completed" : result.status === "cancelled" ? "stopped" : "failed";
      current.exitCode = result.exitCode ?? undefined;
      current.endedAt = result.finishedAt;
      current.lastMessage = summary;
    });
    await this.#options.events.append({
      type: succeeded ? "worker.completed" : "worker.failed",
      taskId: task.id,
      workerId: worker.id,
      payload: { status: result.status, exitCode: result.exitCode, summary },
    });
    if (succeeded) {
      await this.#options.tasks.transition(task.id, "completed", { stage: "done", latestSummary: summary });
      await this.#options.notify(conversationId, `${task.title} is done. ${summary}`).catch(() => undefined);
    } else if (result.status !== "cancelled") {
      await this.#options.tasks.transition(task.id, "failed", { stage: "failed", blockedReason: result.error ?? summary, latestSummary: summary });
    }
    return { shouldRecover: !succeeded && result.status !== "cancelled", summary };
  }

  async #stopActive(taskId: string): Promise<void> {
    const handle = this.#active.get(taskId);
    if (handle) {
      this.#stopping.add(taskId);
      try {
        await handle.stop();
        await this.#supervisions.get(taskId);
      } finally {
        this.#stopping.delete(taskId);
      }
    }
  }

  async #recoverWorker(
    taskId: string,
    agent: AgentKind,
    providerSessionId: string | undefined,
    conversationId: string,
    failureSummary: string,
  ): Promise<boolean> {
    const task = await this.#latestTask(taskId);
    const attempts = typeof task.metadata.workerRecoveryAttempts === "number"
      ? task.metadata.workerRecoveryAttempts
      : 0;
    if (task.status !== "failed" || attempts >= 1) return false;
    await this.#options.store.updateState((state) => {
      const current = state.tasks[taskId];
      if (!current) return;
      current.metadata.workerRecoveryAttempts = attempts + 1;
      current.latestSummary = "worker stopped unexpectedly; preserving context for recovery";
      current.updatedAt = new Date().toISOString();
    });
    try {
      await this.#startTask(await this.#latestTask(taskId), agent, conversationId, providerSessionId);
    } catch {
      if (!providerSessionId) return false;
      try {
        await this.#startTask(await this.#latestTask(taskId), agent, conversationId);
      } catch {
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

  async #latestProviderSession(task: DexTask, agent: AgentKind): Promise<string | undefined> {
    const state = await this.#options.store.read();
    for (const workerId of [...task.workerHistory].reverse()) {
      const worker = state.workers[workerId];
      if (worker?.agent === agent && worker.providerSessionId) return worker.providerSessionId;
    }
    return undefined;
  }

  async #latestTask(taskId: string): Promise<DexTask> {
    const state = await this.#options.store.read();
    const task = state.tasks[taskId];
    if (!task) throw new Error(`Unknown Dex task: ${taskId}`);
    return task;
  }

  async #resolveOne(query: string): Promise<DexTask> {
    const matches = await this.#options.tasks.find(query);
    if (matches.length === 0) throw new Error(`I couldn't find a task matching “${query}”.`);
    if (matches.length > 1) throw new Error(`I found multiple tasks matching “${query}”: ${matches.slice(0, 3).map((task) => task.title).join(", ")}.`);
    return matches[0]!;
  }
}

function chooseAgent(task: DexTask, index: number): AgentKind {
  if (task.preferredAgent) return task.preferredAgent;
  if (/\b(?:investigate|review|understand|diagnose)\b/i.test(task.originalRequest)) return "claude";
  return index === 1 ? "claude" : "codex";
}

function workerPrompt(task: DexTask, inheritedMemories: string[] = []): string {
  const memory = inheritedMemories.length > 0
    ? `\n\nRELEVANT PRIOR KNOWLEDGE:\n${inheritedMemories.slice(0, 15).map((item) => `- ${item}`).join("\n")}\n\nTreat recorded failed approaches as constraints. Do not repeat them without new evidence.`
    : "";
  return `You are a coding worker operating under Dex.\n\nTASK:\n${task.title}\n\nUSER'S ORIGINAL REQUEST:\n${task.originalRequest}\n\nREPOSITORY:\n${task.repositoryPath}\n\nBRANCH:\n${task.dexBranch}${memory}\n\nREQUIREMENTS:\n1. Complete the task rather than only explaining it.\n2. Inspect the existing implementation before modifying it.\n3. Preserve existing conventions.\n4. Run relevant tests.\n5. Do not push, deploy, merge, or perform destructive remote actions.\n6. Summarize changes, validation, failed approaches, and remaining issues.`;
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
