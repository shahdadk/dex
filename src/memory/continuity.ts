import path from "node:path";
import type { AgentEvent } from "../agents/types.js";
import type { DexTask, WorkerSession } from "../state/schemas.js";
import type { DexStateStore } from "../state/store.js";
import { discoverClaudeMemClient } from "./claude-mem.js";
import { redactMemoryValue } from "./redaction.js";
import {
  collectClaudeMemMemories,
  selectMemories,
  taskKnowledgeToMemories,
} from "./selection.js";
import type {
  MemoryBatchOptions,
  MemoryClient,
  MemoryObservation,
  MemorySearchOptions,
  MemoryTimelineOptions,
  TaskKnowledge,
} from "./types.js";

function mergeKnowledge(current: TaskKnowledge, update: TaskKnowledge): TaskKnowledge {
  return redactMemoryValue({
    learnedFacts: [...(current.learnedFacts ?? []), ...(update.learnedFacts ?? [])],
    facts: [...(current.facts ?? []), ...(update.facts ?? [])],
    decisions: [...(current.decisions ?? []), ...(update.decisions ?? [])],
    attemptedApproaches: [
      ...(current.attemptedApproaches ?? []),
      ...(update.attemptedApproaches ?? []),
    ],
    failedApproaches: [...(current.failedApproaches ?? []), ...(update.failedApproaches ?? [])],
    constraints: [...(current.constraints ?? []), ...(update.constraints ?? [])],
    nextSteps: [...(current.nextSteps ?? []), ...(update.nextSteps ?? [])],
    openQuestions: [...(current.openQuestions ?? []), ...(update.openQuestions ?? [])],
    filesChanged: [...(current.filesChanged ?? []), ...(update.filesChanged ?? [])],
    observations: [...(current.observations ?? []), ...(update.observations ?? [])],
  });
}

export class TaskKnowledgeStore {
  readonly #tasks = new Map<string, TaskKnowledge>();

  update(taskId: string, knowledge: TaskKnowledge): TaskKnowledge {
    if (!taskId.trim()) throw new TypeError("TaskKnowledge taskId is required");
    const merged = mergeKnowledge(this.#tasks.get(taskId) ?? {}, knowledge);
    this.#tasks.set(taskId, merged);
    return structuredClone(merged);
  }

  get(taskId: string): TaskKnowledge {
    return structuredClone(this.#tasks.get(taskId) ?? {});
  }

  delete(taskId: string): boolean {
    return this.#tasks.delete(taskId);
  }
}

export interface MemoryContinuityOptions {
  client?: MemoryClient | null;
  discover?: () => Promise<MemoryClient | null>;
  taskKnowledge?: TaskKnowledgeStore;
  store?: DexStateStore;
}

function hasKnowledge(knowledge: TaskKnowledge): boolean {
  return Object.values(knowledge).some((value) => Array.isArray(value) && value.length > 0);
}

function knowledgeFromEvent(event: AgentEvent): TaskKnowledge {
  if (event.type === "message" && event.role === "assistant" && !event.delta && event.text.trim()) {
    return { learnedFacts: [event.text.trim()] };
  }
  if (event.type === "tool" && event.status === "failed") {
    return {
      failedApproaches: [
        {
          approach: event.name,
          reason: event.output?.trim() || "The worker reported that this tool approach failed.",
          failed: true,
          shouldRetry: false,
        },
      ],
    };
  }
  if (event.type === "error" || event.type === "protocol_error") {
    return { openQuestions: [event.message] };
  }
  return {};
}

function observationPayload(event: AgentEvent): { toolName: string; toolInput: unknown; toolResponse: unknown } {
  switch (event.type) {
    case "tool":
      return {
        toolName: event.name,
        toolInput: {
          status: event.status,
          ...(event.id === undefined ? {} : { id: event.id }),
          ...(event.input === undefined ? {} : { input: event.input }),
        },
        toolResponse: event.output ?? { status: event.status },
      };
    case "message":
      return {
        toolName: "dex_agent_message",
        toolInput: { role: event.role, delta: event.delta },
        toolResponse: { text: event.text },
      };
    default:
      return {
        toolName: `dex_agent_${event.type}`,
        toolInput: { type: event.type, timestamp: event.timestamp },
        toolResponse: event,
      };
  }
}

function dexMemorySessionId(worker: WorkerSession): string {
  return `dex:${worker.taskId}:${worker.id}`;
}

function observationToolUseId(event: AgentEvent): string {
  if (event.type === "tool" && event.id) return event.id;
  return `${event.type}:${event.timestamp}`;
}

function memoryText(memory: MemoryObservation): string {
  const details = [
    memory.narrative,
    ...memory.facts,
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const text = [memory.title.trim(), ...details].filter(Boolean).join(" — ");
  return text.length > 600 ? `${text.slice(0, 597)}…` : text;
}

function textResults(payload: unknown): string[] {
  const text: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      text.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(payload);
  return text
    .flatMap((value) => value.split(/\r?\n/))
    .map((value) => value.trim())
    .filter((value) => /^\|\s*#\d+\s*\|/.test(value) || (!value.startsWith("|") && value.length > 0));
}

/**
 * Runtime bridge used by the orchestrator. Every event is retained locally as
 * TaskKnowledge first, so a failed/unavailable Claude-Mem worker cannot erase
 * the continuation context.
 */
export class MemoryContinuity {
  readonly taskKnowledge: TaskKnowledgeStore;
  readonly #discover: () => Promise<MemoryClient | null>;
  readonly #store: DexStateStore | undefined;
  #client: MemoryClient | null | undefined;
  #clientPromise: Promise<MemoryClient | null> | undefined;

  constructor(options: MemoryContinuityOptions = {}) {
    this.#client = options.client;
    this.#discover = options.discover ?? (() => discoverClaudeMemClient());
    this.taskKnowledge = options.taskKnowledge ?? new TaskKnowledgeStore();
    this.#store = options.store;
  }

  async client(): Promise<MemoryClient | null> {
    if (this.#client !== undefined) return this.#client;
    this.#clientPromise ??= this.#discover().then((client) => {
      this.#client = client;
      return client;
    });
    return this.#clientPromise;
  }

  addTaskKnowledge(taskId: string, knowledge: TaskKnowledge): TaskKnowledge {
    return this.taskKnowledge.update(taskId, knowledge);
  }

  getTaskKnowledge(taskId: string): TaskKnowledge {
    return this.taskKnowledge.get(taskId);
  }

  snapshot(taskId: string): TaskKnowledge {
    return this.getTaskKnowledge(taskId);
  }

  async observe(task: DexTask, worker: WorkerSession, event: AgentEvent): Promise<void> {
    if (["provider_event", "stderr", "started", "finished"].includes(event.type)) return;
    const eventKnowledge = knowledgeFromEvent(redactMemoryValue(event));
    if (hasKnowledge(eventKnowledge)) {
      const durableKnowledge = this.taskKnowledge.update(task.id, eventKnowledge);
      await this.#store?.updateState((state) => {
        const current = state.tasks[task.id];
        if (!current) return;
        current.metadata.taskKnowledge = durableKnowledge;
        current.updatedAt = new Date().toISOString();
      });
    }
    const client = await this.client();
    if (!client) return;
    const sessionId = dexMemorySessionId(worker);
    const payload = observationPayload(redactMemoryValue(event));
    await client.recordObservation({
      claudeSessionId: sessionId,
      contentSessionId: sessionId,
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      toolResponse: payload.toolResponse,
      cwd: task.worktreePath,
      agentId: worker.id,
      agentType: worker.agent,
      platformSource: worker.agent === "claude" ? "claude-code" : "codex",
      toolUseId: observationToolUseId(event),
    });
  }

  async search(options: MemorySearchOptions): Promise<unknown> {
    return (await this.client())?.search(options) ?? { content: [] };
  }

  async timeline(options: MemoryTimelineOptions): Promise<unknown> {
    return (await this.client())?.timeline(options) ?? { content: [] };
  }

  async batch(options: MemoryBatchOptions | readonly number[]): Promise<MemoryObservation[]> {
    return (await this.client())?.getObservations(options) ?? [];
  }

  async query(task: DexTask | undefined, query: string): Promise<string[]> {
    const project = task === undefined ? undefined : path.basename(task.repositoryPath);
    if (task && this.#store) {
      await this.#store.updateState((state) => {
        const current = state.tasks[task.id];
        if (!current) return;
        current.memoryQueries = [...new Set([...current.memoryQueries, query])].slice(-100);
        current.updatedAt = new Date().toISOString();
      });
    }

    const fallbackKnowledge = task === undefined
      ? {}
      : mergeKnowledge(
          this.getTaskKnowledge(task.id),
          (task.metadata.taskKnowledge && typeof task.metadata.taskKnowledge === "object")
            ? task.metadata.taskKnowledge as TaskKnowledge
            : {},
        );
    const fallback = taskKnowledgeToMemories(fallbackKnowledge);
    const client = await this.client();
    if (!client) return fallback.slice(0, 15).map(memoryText);

    try {
      const discovered = await collectClaudeMemMemories(client, {
        query,
        ...(project === undefined ? {} : { project }),
        batchLimit: 30,
      });
      const candidates = [...discovered, ...fallback];
      const selected = candidates.length >= 5
        ? selectMemories(candidates, { query, fallback })
        : candidates.slice(0, 15);
      return selected.map(memoryText).filter(Boolean);
    } catch {
      const result = await client.search({
        query,
        type: "observations",
        limit: 15,
        orderBy: "relevance",
        ...(project === undefined ? {} : { project }),
      }).catch(() => ({ content: [] }));
      return [...fallback.map(memoryText), ...textResults(result)].slice(0, 15);
    }
  }

  async summarize(worker: WorkerSession, lastAssistantMessage?: string): Promise<void> {
    const client = await this.client();
    if (!client) return;
    const sessionId = dexMemorySessionId(worker);
    await client.summarizeSession({
      contentSessionId: sessionId,
      ...(lastAssistantMessage === undefined ? {} : { lastAssistantMessage }),
      platformSource: worker.agent === "claude" ? "claude-code" : "codex",
    });
  }
}

export const ClaudeMemMemory = MemoryContinuity;
