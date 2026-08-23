import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactMemoryValue } from "./redaction.js";
import type {
  DirectObservation,
  MemoryBatchOptions,
  MemoryClient,
  MemoryObservation,
  MemorySearchOptions,
  MemoryTimelineOptions,
  ObservationWriteResult,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface ClaudeMemClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ClaudeMemDiscoveryOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ClaudeMemDiscovery {
  available: boolean;
  source?: "explicit" | "environment" | "settings" | "pid" | "default";
  baseUrl?: string;
  client?: ClaudeMemClient;
  errors: string[];
}

export class ClaudeMemError extends Error {
  readonly status?: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClaudeMemError";
    if (options.status !== undefined) this.status = options.status;
  }
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function finiteInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Older Claude-Mem records can contain newline-delimited values.
  }
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeClaudeMemObservation(value: unknown, index = 0): MemoryObservation {
  const record = asRecord(value);
  const numericId = finiteInteger(record.id);
  const rawId = numericId ?? (typeof record.id === "string" ? record.id : `claude-mem-${index}`);
  const narrativeCandidates = [record.narrative, record.text, record.content, record.subtitle];
  const narrative =
    narrativeCandidates.find((candidate): candidate is string => typeof candidate === "string") ?? "";
  const title =
    (typeof record.title === "string" && record.title.trim()) ||
    narrative.slice(0, 120) ||
    `Claude-Mem observation ${String(rawId)}`;

  const observation: MemoryObservation = {
    id: rawId,
    source: "claude-mem",
    title,
    narrative,
    facts: parseStringArray(record.facts),
    concepts: parseStringArray(record.concepts),
    filesRead: parseStringArray(record.files_read ?? record.filesRead),
    filesModified: parseStringArray(record.files_modified ?? record.filesModified),
  };
  if (typeof record.project === "string") observation.project = record.project;
  if (typeof record.type === "string") observation.type = record.type;
  if (typeof record.subtitle === "string") observation.subtitle = record.subtitle;
  if (typeof record.created_at === "string") observation.createdAt = record.created_at;
  else if (typeof record.createdAt === "string") observation.createdAt = record.createdAt;
  const epoch = finiteInteger(record.created_at_epoch ?? record.createdAtEpoch);
  if (epoch !== undefined) observation.createdAtEpoch = epoch;
  return redactMemoryValue(observation);
}

export function extractObservationIds(payload: unknown): number[] {
  const ids = new Set<number>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/(?:^|\s)#(\d+)\b/g)) {
        const id = finiteInteger(match[1]);
        if (id !== undefined) ids.add(id);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = finiteInteger(record.id ?? record.observationId ?? record.observation_id);
    if (id !== undefined) ids.add(id);
    Object.values(record).forEach(visit);
  };
  visit(payload);
  return [...ids];
}

export class ClaudeMemClient implements MemoryClient {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ClaudeMemClientOptions | string) {
    const normalized = typeof options === "string" ? { baseUrl: options } : options;
    this.baseUrl = trimBaseUrl(normalized.baseUrl);
    this.#fetch = normalized.fetch ?? globalThis.fetch;
    this.#timeoutMs = normalized.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!this.baseUrl) throw new TypeError("Claude-Mem baseUrl is required");
  }

  async health(): Promise<unknown> {
    return this.#request("/api/health");
  }

  async recordObservation(input: DirectObservation): Promise<ObservationWriteResult> {
    const claudeSessionId = input.claudeSessionId ?? input.contentSessionId;
    if (!claudeSessionId) {
      throw new TypeError("Direct observations require claudeSessionId or contentSessionId");
    }
    const contentSessionId = input.contentSessionId ?? claudeSessionId;
    const toolName = input.toolName ?? "dex_memory_observation";
    const toolInput =
      input.toolInput ??
      (input.title || input.type
        ? { ...(input.title ? { title: input.title } : {}), ...(input.type ? { type: input.type } : {}) }
        : undefined);
    const toolResponse = input.toolResponse ?? (input.content === undefined ? undefined : { content: input.content });
    const body = redactMemoryValue({
      // Keep Dex's preferred identity while sending the worker's compatibility field.
      claudeSessionId,
      contentSessionId,
      tool_name: toolName,
      ...(toolInput === undefined ? {} : { tool_input: toolInput }),
      ...(toolResponse === undefined ? {} : { tool_response: toolResponse }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.agentType === undefined ? {} : { agentType: input.agentType }),
      ...(input.platformSource === undefined ? {} : { platformSource: input.platformSource }),
      ...(input.toolUseId === undefined
        ? {}
        : { toolUseId: input.toolUseId, tool_use_id: input.toolUseId }),
    });
    const result = asRecord(await this.#request("/api/sessions/observations", {
      method: "POST",
      body,
    }));
    const status = result.status;
    if (status === "skipped") {
      return {
        status,
        ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
      };
    }
    return { status: status === "stored" ? "stored" : "queued" };
  }

  addObservation(input: DirectObservation): Promise<ObservationWriteResult> {
    return this.recordObservation(input);
  }

  async summarizeSession(input: {
    contentSessionId: string;
    lastAssistantMessage?: string;
    platformSource?: string;
  }): Promise<ObservationWriteResult> {
    if (!input.contentSessionId.trim()) throw new TypeError("Claude-Mem contentSessionId is required");
    const result = asRecord(await this.#request("/api/sessions/summarize", {
      method: "POST",
      body: redactMemoryValue({
        contentSessionId: input.contentSessionId,
        ...(input.lastAssistantMessage === undefined
          ? {}
          : { last_assistant_message: input.lastAssistantMessage }),
        ...(input.platformSource === undefined ? {} : { platformSource: input.platformSource }),
      }),
    }));
    const status = result.status;
    if (status === "skipped") {
      return {
        status,
        ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
      };
    }
    return { status: status === "stored" ? "stored" : "queued" };
  }

  search(options: MemorySearchOptions): Promise<unknown> {
    return this.#request(`/api/search?${toSearchParams({
      query: options.query,
      project: options.project,
      type: options.type,
      obs_type: options.observationType,
      dateStart: options.dateStart,
      dateEnd: options.dateEnd,
      offset: options.offset,
      limit: options.limit,
      orderBy: options.orderBy,
    })}`);
  }

  timeline(options: MemoryTimelineOptions): Promise<unknown> {
    return this.#request(`/api/timeline?${toSearchParams({
      anchor: options.anchor,
      query: options.query,
      project: options.project,
      depth_before: options.depthBefore,
      depth_after: options.depthAfter,
    })}`);
  }

  async getObservations(
    options: MemoryBatchOptions | readonly number[],
  ): Promise<MemoryObservation[]> {
    const normalized: MemoryBatchOptions = Array.isArray(options)
      ? { ids: [...options] }
      : (options as MemoryBatchOptions);
    if (normalized.ids.length === 0) return [];
    const result = await this.#request("/api/observations/batch", {
      method: "POST",
      body: {
        ids: normalized.ids,
        ...(normalized.project === undefined ? {} : { project: normalized.project }),
        ...(normalized.limit === undefined ? {} : { limit: normalized.limit }),
        ...(normalized.orderBy === undefined ? {} : { orderBy: normalized.orderBy }),
      },
    });
    const records = Array.isArray(result)
      ? result
      : Array.isArray(asRecord(result).observations)
        ? (asRecord(result).observations as unknown[])
        : [];
    return records.map(normalizeClaudeMemObservation);
  }

  batch(options: MemoryBatchOptions | readonly number[]): Promise<MemoryObservation[]> {
    return this.getObservations(options);
  }

  async #request(
    resource: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<unknown> {
    const method = options.method ?? "GET";
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${resource}`, {
        method,
        ...(options.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(options.body),
            }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ClaudeMemError(`Claude-Mem ${method} ${resource} failed`, { cause: error });
    }
    if (!response.ok) {
      throw new ClaudeMemError(
        `Claude-Mem ${method} ${resource} returned HTTP ${response.status}`,
        { status: response.status },
      );
    }
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ClaudeMemError(`Claude-Mem ${method} ${resource} returned invalid JSON`, {
        cause: error,
      });
    }
  }
}

function toSearchParams(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

interface DiscoveryCandidate {
  baseUrl: string;
  source: NonNullable<ClaudeMemDiscovery["source"]>;
}

async function readJsonRecord(file: string): Promise<Record<string, unknown>> {
  try {
    return asRecord(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch {
    return {};
  }
}

export async function discoverClaudeMem(
  options: ClaudeMemDiscoveryOptions = {},
): Promise<ClaudeMemDiscovery> {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const dataDirectory = env.CLAUDE_MEM_DATA_DIR || path.join(homeDirectory, ".claude-mem");
  const settings = await readJsonRecord(path.join(dataDirectory, "settings.json"));
  const pid = await readJsonRecord(path.join(dataDirectory, "worker.pid"));
  const candidates: DiscoveryCandidate[] = [];
  const push = (baseUrl: string | undefined, source: DiscoveryCandidate["source"]): void => {
    if (baseUrl?.trim()) candidates.push({ baseUrl: trimBaseUrl(baseUrl), source });
  };

  push(options.baseUrl, "explicit");
  push(env.CLAUDE_MEM_WORKER_URL, "environment");
  const envPort = finiteInteger(env.CLAUDE_MEM_WORKER_PORT);
  if (envPort !== undefined) {
    push(`http://${env.CLAUDE_MEM_WORKER_HOST || "127.0.0.1"}:${envPort}`, "environment");
  }
  const settingsPort = finiteInteger(settings.CLAUDE_MEM_WORKER_PORT);
  if (settingsPort !== undefined) {
    const host =
      typeof settings.CLAUDE_MEM_WORKER_HOST === "string"
        ? settings.CLAUDE_MEM_WORKER_HOST
        : "127.0.0.1";
    push(`http://${host}:${settingsPort}`, "settings");
  }
  const pidPort = finiteInteger(pid.port);
  if (pidPort !== undefined) push(`http://127.0.0.1:${pidPort}`, "pid");
  const uid = process.getuid?.() ?? 77;
  push(`http://127.0.0.1:${37700 + (uid % 100)}`, "default");

  const seen = new Set<string>();
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.baseUrl)) continue;
    seen.add(candidate.baseUrl);
    const client = new ClaudeMemClient({
      baseUrl: candidate.baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      timeoutMs: options.timeoutMs ?? 1_500,
    });
    try {
      await client.health();
      return {
        available: true,
        source: candidate.source,
        baseUrl: candidate.baseUrl,
        client,
        errors,
      };
    } catch (error) {
      errors.push(`${candidate.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { available: false, errors };
}

export async function discoverClaudeMemClient(
  options: ClaudeMemDiscoveryOptions = {},
): Promise<ClaudeMemClient | null> {
  return (await discoverClaudeMem(options)).client ?? null;
}
