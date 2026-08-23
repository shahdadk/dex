import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult } from "../agents/types.js";
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
}

export class DexOrchestrator {
  readonly #options: DexOrchestratorOptions;
  readonly #active = new Map<string, AgentHandle>();
  readonly #supervisions = new Map<string, Promise<void>>();

  constructor(options: DexOrchestratorOptions) {
    this.#options = options;
  }

  async handle(actions: DexAction[], context: OrchestratorMessageContext): Promise<string> {
    const replies: string[] = [];
    const createActions = actions.filter((action): action is Extract<DexAction, { type: "CREATE_TASK" }> => action.type === "CREATE_TASK");
    const created = await this.#options.tasks.createTasks(createActions.map((action) => ({
      description: action.description,
      project: this.#options.project,
      ...(action.preferredAgent ? { preferredAgent: action.preferredAgent } : {}),
      ...(action.executionPreference ? { executionPreference: action.executionPreference } : {}),
    })));
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
            await this.#options.mover.moveToCloud(task, action.preferredAgent);
            replies.push(`${task.title} is being handed to ${action.preferredAgent ?? "codex"} in the cloud.`);
          } else {
            replies.push(`${task.title} is already durable; local return is not enabled in P0.`);
          }
          break;
        }
        case "CHANGE_AGENT": {
          const task = await this.#resolveOne(action.taskQuery);
          await this.#stopActive(task.id);
          await this.#startTask(task, action.agent, context.conversationId);
          replies.push(`${task.title} is continuing with ${action.agent}.`);
          break;
        }
        case "STOP_TASK": {
          const task = await this.#resolveOne(action.taskQuery);
          await this.#stopActive(task.id);
          await this.#options.tasks.transition(task.id, "cancelled", { stage: "failed", latestSummary: "stopped at your request" });
          replies.push(`${task.title} is stopped. the task history is preserved.`);
          break;
        }
        case "RESUME_TASK": {
          const task = await this.#resolveOne(action.taskQuery);
          await this.#startTask(task, task.preferredAgent ?? "codex", context.conversationId);
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
      const capacity = Math.max(0, this.#options.config.maxConcurrency - this.#active.size);
      const immediate = created.slice(0, capacity);
      await Promise.all(
        immediate.map((task, index) =>
          this.#startTask(task, chooseAgent(task, index), context.conversationId),
        ),
      );
      if (created.length === 1) replies.push(`on it. i'm working on ${created[0]?.title}.`);
      else replies.push(`on it. i'm handling all ${created.length}. i'll text you if anything needs you.`);
    }

    return replies.filter(Boolean).join("\n\n");
  }

  async #startTask(task: DexTask, agent: AgentKind, conversationId: string): Promise<void> {
    if (this.#active.has(task.id)) throw new Error(`${task.title} already has an active worker`);
    if (!(await this.#options.agents[agent].available())) throw new Error(`${agent} is not available on this Mac`);
    await this.#options.tasks.transition(task.id, "preparing", { stage: agent === "claude" ? "investigating" : "implementing" });
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

    const inheritedMemories = await this.#options.memory
      ?.query?.(task, task.originalRequest)
      .catch(() => []);
    const adapter = this.#options.agents[agent];
    const handle = await adapter.start({
      cwd: task.worktreePath,
      prompt: workerPrompt(task, inheritedMemories),
      timeoutMs: 25 * 60_000,
      startupTimeoutMs: 45_000,
      ...(agent === "claude" ? { permissionMode: "auto" } : {}),
    });
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
    try {
      for await (const event of handle.events) {
        await this.#recordAgentEvent(task, worker, event);
        await this.#options.memory?.observe(task, worker, event).catch(() => undefined);
      }
      const result = await handle.result;
      await this.#finishWorker(task, worker, result, conversationId);
    } catch (error) {
      const message = redactString(error instanceof Error ? error.message : String(error));
      await this.#options.store.updateState((state) => {
        const current = state.workers[worker.id];
        if (current) {
          current.status = "failed";
          current.endedAt = new Date().toISOString();
          current.lastMessage = message;
        }
      });
      await this.#options.tasks.transition(task.id, "failed", { stage: "failed", blockedReason: message, latestSummary: `failed: ${message}` });
      await this.#options.notify(conversationId, `${task.title} failed: ${message}`).catch(() => undefined);
    } finally {
      this.#active.delete(task.id);
    }
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

  async #finishWorker(task: DexTask, worker: WorkerSession, result: AgentResult, conversationId: string): Promise<void> {
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
      await this.#options.notify(conversationId, `${task.title} failed. ${summary}`).catch(() => undefined);
    }
  }

  async #stopActive(taskId: string): Promise<void> {
    const handle = this.#active.get(taskId);
    if (handle) {
      await handle.stop();
      await this.#supervisions.get(taskId);
    }
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
