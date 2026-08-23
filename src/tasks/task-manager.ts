import path from "node:path";
import type { DexPaths } from "../config/paths.js";
import type { EventLog } from "../state/events.js";
import {
  DexTaskSchema,
  type AgentKind,
  type DexProject,
  type DexState,
  type DexTask,
  type SemanticStage,
  type TaskStatus,
} from "../state/schemas.js";
import type { DexStateStore } from "../state/store.js";
import { taskId as makeTaskId } from "../utils/ids.js";
import { createWorktree, inspectRepository } from "./worktree.js";

const ALLOWED: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["preparing", "cancelled", "failed"]),
  preparing: new Set(["running", "failed", "cancelled"]),
  running: new Set(["waiting_user", "checkpointing", "completed", "failed", "cancelled"]),
  waiting_user: new Set(["running", "cancelled", "failed"]),
  checkpointing: new Set(["handoff", "running", "failed", "cancelled"]),
  handoff: new Set(["running", "failed", "cancelled"]),
  completed: new Set(["checkpointing"]),
  failed: new Set(["preparing", "cancelled"]),
  cancelled: new Set(["preparing"]),
};

export interface CreateTaskInput {
  description: string;
  project: DexProject;
  preferredAgent?: AgentKind;
  executionPreference?: "local" | "cloud";
  createWorktree?: boolean;
}

export class TaskManager {
  readonly #store: DexStateStore;
  readonly #events: EventLog;
  readonly #paths: DexPaths;

  constructor(store: DexStateStore, events: EventLog, paths: DexPaths) {
    this.#store = store;
    this.#events = events;
    this.#paths = paths;
  }

  async createTask(input: CreateTaskInput): Promise<DexTask> {
    return (await this.createTasks([input]))[0]!;
  }

  async createTasks(inputs: readonly CreateTaskInput[]): Promise<DexTask[]> {
    if (inputs.length === 0) return [];
    const tasks: DexTask[] = [];
    for (const input of inputs) {
      const id = makeTaskId(taskTitle(input.description));
      const repository = await inspectRepository(input.project.path);
      const worktree = input.createWorktree === false
        ? { branch: `dex/${id}`, path: path.join(this.#paths.worktrees, id) }
        : await createWorktree(repository, this.#paths.worktrees, id);
      const now = new Date().toISOString();
      tasks.push(DexTaskSchema.parse({
        id,
        kind: "dex",
        projectId: input.project.id,
        title: taskTitle(input.description),
        originalRequest: input.description,
        repositoryPath: repository.root,
        repositoryRemote: repository.remote,
        baseBranch: repository.branch,
        dexBranch: worktree.branch,
        worktreePath: worktree.path,
        status: "queued",
        stage: "queued",
        createdAt: now,
        updatedAt: now,
        preferredAgent: input.preferredAgent,
        executionPreference: input.executionPreference,
        workerHistory: [],
        memoryQueries: [],
        metadata: {},
      }));
    }
    await this.#store.updateState((state) => {
      for (const task of tasks) state.tasks[task.id] = task;
    });
    await Promise.all(tasks.map((task) => this.#events.append({
      type: "task.created",
      taskId: task.id,
      payload: { title: task.title, projectId: task.projectId },
    })));
    return tasks;
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
        updatedAt: new Date().toISOString(),
      });
      state.tasks[taskId] = updated;
    });
    if (!updated) throw new Error(`Task ${taskId} was not updated`);
    const eventType = status === "completed" ? "task.completed" : status === "failed" ? "task.failed" : status === "waiting_user" ? "task.blocked" : "task.started";
    await this.#events.append({ type: eventType, taskId, payload: { status, stage: updated.stage, summary: updated.latestSummary } });
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

function taskTitle(description: string): string {
  return description
    .replace(/^(?:please\s+)?(?:fix|finish|investigate|add|implement|build|review)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim()
    .slice(0, 72) || "engineering task";
}
