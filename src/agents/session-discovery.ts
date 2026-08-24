import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { redactString } from "../utils/redact.js";
import type { AgentProvider } from "./types.js";

export interface DiscoveredSession {
  provider: AgentProvider;
  sessionId: string;
  cwd?: string;
  updatedAt: string;
  summary?: string;
  active: boolean;
  sourcePath: string;
}

export interface SessionDiscoveryOptions {
  claudeRoot?: string;
  codexRoot?: string;
  maxSessions?: number;
  activeWindowMs?: number;
  now?: () => number;
}

interface SessionCandidate {
  file: string;
  modifiedAt: number;
}

interface ParsedTranscript {
  sessionId: string | undefined;
  cwd: string | undefined;
  updatedAt: string | undefined;
  title: string | undefined;
  firstUserMessage: string | undefined;
  lastAssistantMessage: string | undefined;
}

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60_000;

export async function discoverClaudeSessions(options: SessionDiscoveryOptions = {}): Promise<DiscoveredSession[]> {
  return discoverProviderSessions(
    "claude",
    options.claudeRoot ?? path.join(os.homedir(), ".claude", "projects"),
    options,
  );
}

export async function discoverCodexSessions(options: SessionDiscoveryOptions = {}): Promise<DiscoveredSession[]> {
  return discoverProviderSessions(
    "codex",
    options.codexRoot ?? path.join(os.homedir(), ".codex", "sessions"),
    options,
  );
}

export async function discoverSessions(
  options: SessionDiscoveryOptions & { provider?: AgentProvider } = {},
): Promise<DiscoveredSession[]> {
  const sessions = options.provider === "claude"
    ? await discoverClaudeSessions(options)
    : options.provider === "codex"
      ? await discoverCodexSessions(options)
      : (await Promise.all([discoverClaudeSessions(options), discoverCodexSessions(options)])).flat();
  return sessions
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, normalizedLimit(options.maxSessions));
}

export function findDiscoveredSessions(
  sessions: readonly DiscoveredSession[],
  query: string,
  provider?: AgentProvider,
): DiscoveredSession[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1);
  return sessions
    .filter((session) => provider === undefined || session.provider === provider)
    .map((session) => {
      const haystack = `${session.sessionId} ${session.cwd ?? ""} ${session.summary ?? ""}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { session, score };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || right.session.updatedAt.localeCompare(left.session.updatedAt))
    .map(({ session }) => session);
}

async function discoverProviderSessions(
  provider: AgentProvider,
  root: string,
  options: SessionDiscoveryOptions,
): Promise<DiscoveredSession[]> {
  const limit = normalizedLimit(options.maxSessions);
  const candidates = (await collectJsonl(root, provider === "claude"))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, Math.max(limit * 3, limit));
  const now = options.now?.() ?? Date.now();
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const parsed: Array<DiscoveredSession | undefined> = await Promise.all(candidates.map(async (candidate) => {
    const transcript = await parseTranscript(provider, candidate.file).catch(() => emptyTranscript());
    const fallbackId = path.basename(candidate.file, ".jsonl")
      .replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "");
    const sessionId = transcript.sessionId?.trim() || fallbackId;
    if (!sessionId) return undefined;
    const updatedAt = validTimestamp(transcript.updatedAt)
      ? new Date(transcript.updatedAt!).toISOString()
      : new Date(candidate.modifiedAt).toISOString();
    const summary = concise(transcript.title ?? transcript.firstUserMessage ?? transcript.lastAssistantMessage);
    return {
      provider,
      sessionId,
      ...(transcript.cwd ? { cwd: transcript.cwd } : {}),
      updatedAt,
      ...(summary ? { summary } : {}),
      active: now - Date.parse(updatedAt) <= activeWindowMs,
      sourcePath: candidate.file,
    } satisfies DiscoveredSession;
  }));
  return parsed
    .filter((session): session is DiscoveredSession => session !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

async function collectJsonl(root: string, skipClaudeSubagents: boolean): Promise<SessionCandidate[]> {
  const results: SessionCandidate[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (skipClaudeSubagents && entry.name === "subagents") return;
        await visit(file);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      const metadata = await stat(file);
      results.push({ file, modifiedAt: metadata.mtimeMs });
    }));
  };
  await visit(root);
  return results;
}

async function parseTranscript(provider: AgentProvider, file: string): Promise<ParsedTranscript> {
  const parsed = emptyTranscript();
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      record = value as Record<string, unknown>;
    } catch {
      continue;
    }
    if (provider === "claude") consumeClaudeRecord(parsed, record);
    else consumeCodexRecord(parsed, record);
  }
  return parsed;
}

function emptyTranscript(): ParsedTranscript {
  return {
    sessionId: undefined,
    cwd: undefined,
    updatedAt: undefined,
    title: undefined,
    firstUserMessage: undefined,
    lastAssistantMessage: undefined,
  };
}

function consumeClaudeRecord(parsed: ParsedTranscript, record: Record<string, unknown>): void {
  parsed.sessionId ??= text(record.sessionId) ?? text(record.session_id);
  parsed.cwd ??= text(record.cwd);
  parsed.updatedAt = laterTimestamp(parsed.updatedAt, text(record.timestamp));
  if (record.type === "ai-title") parsed.title ??= text(record.aiTitle);
  const role = record.type === "user" || record.type === "assistant" ? record.type : undefined;
  const message = object(record.message);
  const content = message ? contentText(message.content) : undefined;
  if (role === "user" && content && !parsed.firstUserMessage) parsed.firstUserMessage = content;
  if (role === "assistant" && content) parsed.lastAssistantMessage = content;
}

function consumeCodexRecord(parsed: ParsedTranscript, record: Record<string, unknown>): void {
  parsed.updatedAt = laterTimestamp(parsed.updatedAt, text(record.timestamp));
  const payload = object(record.payload);
  if (!payload) return;
  if (record.type === "session_meta") {
    parsed.sessionId ??= text(payload.id) ?? text(payload.session_id);
    parsed.cwd ??= text(payload.cwd);
    parsed.updatedAt = laterTimestamp(parsed.updatedAt, text(payload.timestamp));
    return;
  }
  parsed.cwd ??= text(payload.cwd);
  if (record.type !== "response_item" || payload.type !== "message") return;
  const role = text(payload.role);
  const content = contentText(payload.content);
  if (role === "user" && content && !parsed.firstUserMessage) parsed.firstUserMessage = content;
  if (role === "assistant" && content) parsed.lastAssistantMessage = content;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const block = object(item);
    if (!block) return [];
    const value = text(block.text) ?? text(block.content);
    return value ? [value] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function laterTimestamp(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!validTimestamp(candidate)) return current;
  if (!validTimestamp(current) || Date.parse(candidate!) > Date.parse(current!)) return candidate;
  return current;
}

function validTimestamp(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function concise(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = redactString(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}…` : cleaned;
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SESSIONS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("Session discovery maxSessions must be between 1 and 1000");
  }
  return value;
}
