import path from "node:path";
import { z } from "zod";
import { AgentKindSchema } from "../state/schemas.js";
import {
  discoverSessions,
  findDiscoveredSessions,
  type DiscoveredSession,
} from "./session-discovery.js";
import type { AgentProvider } from "./types.js";

const ProviderSessionIdSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Session IDs may only contain provider-safe identifier characters");

const SessionCwdSchema = z.string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), "A discovered session cwd must be absolute")
  .refine((value) => !/^\/dev\/(?:tty|ttys|pts(?:\/|$))/i.test(value), "A discovered session cwd cannot be a TTY path");

export const SessionAdoptionIntentSchema = z.object({
  provider: AgentKindSchema.optional(),
  sessionId: ProviderSessionIdSchema.optional(),
  query: z.string().trim().min(1).max(400).optional(),
  recency: z.enum(["latest", "oldest"]).optional(),
}).strict().refine(
  (intent) => intent.sessionId !== undefined || intent.query !== undefined || intent.recency !== undefined,
  { message: "A session ID, query, or recency selector is required" },
);

export type SessionAdoptionIntent = z.infer<typeof SessionAdoptionIntentSchema>;

/**
 * Validated hand-off contract for the orchestrator. The orchestrator may create
 * a Dex task for this transcript and call agents[provider].resume(sessionId,
 * options). It must not attach to a PID/TTY or execute sourcePath; neither is
 * represented in this request. `cwd` and `summary` are normalized discovery
 * metadata and must remain data, not command-line fragments.
 */
export const SessionAdoptionRequestSchema = z.object({
  type: z.literal("ADOPT_SESSION"),
  provider: AgentKindSchema,
  sessionId: ProviderSessionIdSchema,
  cwd: SessionCwdSchema.optional(),
  updatedAt: z.string().datetime().optional(),
  summary: z.string().trim().min(1).max(180).optional(),
  active: z.boolean().optional(),
}).strict();

export type SessionAdoptionRequest = z.infer<typeof SessionAdoptionRequestSchema>;

export type SessionDiscoveryLoader = (
  provider?: AgentProvider,
) => Promise<readonly DiscoveredSession[]>;

export const defaultSessionDiscovery: SessionDiscoveryLoader = async (provider) => discoverSessions({
  ...(provider ? { provider } : {}),
});

/** Recognizes only explicit continuation language that names a session/thread. */
export function parseSessionAdoptionIntent(message: string): SessionAdoptionIntent | undefined {
  const continuation = message.trim().match(
    /^(?:please\s+)?(?:continue|resume|adopt|pick\s+(?:back\s+)?up)\s+(.+?)[?.!]*$/i,
  );
  const body = continuation?.[1]?.trim();
  if (!body || !/\b(?:session|conversation|thread)\b/i.test(body)) return undefined;

  const providers = [...body.matchAll(/\b(claude|codex)\b/gi)]
    .map((match) => match[1]!.toLowerCase() as AgentProvider);
  const distinctProviders = [...new Set(providers)];
  if (distinctProviders.length > 1) {
    throw new Error("Choose either Claude or Codex for the session, not both.");
  }
  const provider = distinctProviders[0];
  const recency = /\b(?:old|older|oldest)\b/i.test(body)
    ? "oldest" as const
    : /\b(?:latest|newest|recent|last)\b/i.test(body)
      ? "latest" as const
      : undefined;

  const providerFree = body
    .replace(/\b(?:with|using|via|in|from)\s+(?:claude|codex)\b/gi, " ")
    .replace(/^(?:claude|codex)\s+/i, "")
    .replace(/\b(?:claude|codex)\s+(?=(?:session|conversation|thread)\b)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const marker = providerFree.match(/\b(?:session|conversation|thread)\b/i);
  if (!marker || marker.index === undefined) return undefined;

  const before = providerFree.slice(0, marker.index).trim();
  const after = providerFree.slice(marker.index + marker[0].length)
    .replace(/^(?:with\s+)?(?:id\s+|#)/i, "")
    .replace(/\s+please$/i, "")
    .trim();
  const sessionId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(after) ? after : undefined;
  const trailingQuery = after && !sessionId
    ? after.replace(/^(?:about|for|called|named)\s+/i, "").trim()
    : "";
  const query = [normalizeSessionQuery(before), normalizeSessionQuery(trailingQuery)]
    .filter(Boolean)
    .join(" ") || undefined;

  if (!sessionId && !query && !recency) return undefined;
  return SessionAdoptionIntentSchema.parse({
    ...(provider ? { provider } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(query ? { query } : {}),
    ...(recency ? { recency } : {}),
  });
}

export async function resolveSessionAdoptionIntent(
  rawIntent: SessionAdoptionIntent,
  loadSessions: SessionDiscoveryLoader = defaultSessionDiscovery,
): Promise<SessionAdoptionRequest> {
  const intent = SessionAdoptionIntentSchema.parse(rawIntent);
  const sessions = await loadSessions(intent.provider);
  return resolveSessionAdoption(sessions, intent);
}

export function resolveSessionAdoption(
  sessions: readonly DiscoveredSession[],
  rawIntent: SessionAdoptionIntent,
): SessionAdoptionRequest {
  const intent = SessionAdoptionIntentSchema.parse(rawIntent);
  const candidates = deduplicateSessions(sessions)
    .filter((session) => intent.provider === undefined || session.provider === intent.provider);

  let matches: DiscoveredSession[];
  if (intent.sessionId) {
    matches = candidates.filter((session) => session.sessionId === intent.sessionId);
  } else if (intent.query) {
    matches = findDiscoveredSessions(candidates, intent.query, intent.provider);
  } else {
    matches = [...candidates];
  }

  if (matches.length === 0) {
    const selector = intent.sessionId ?? intent.query ?? intent.recency ?? "requested";
    const provider = intent.provider ? ` ${intent.provider}` : "";
    throw new Error(`I couldn't find a discovered${provider} session matching “${selector}”.`);
  }

  const identities = new Set(matches.map((session) => `${session.provider}\0${session.sessionId}`));
  let selected: DiscoveredSession;
  if (identities.size === 1) {
    selected = newest(matches);
  } else if (intent.recency === "oldest") {
    selected = oldest(matches);
  } else if (intent.recency === "latest") {
    selected = newest(matches);
  } else {
    const labels = matches
      .slice(0, 3)
      .map((session) => `${session.provider}:${session.sessionId}`)
      .join(", ");
    throw new Error(`I found multiple discovered sessions matching that request: ${labels}. Use a provider/session ID.`);
  }

  return SessionAdoptionRequestSchema.parse({
    type: "ADOPT_SESSION",
    provider: selected.provider,
    sessionId: selected.sessionId,
    ...(selected.cwd ? { cwd: selected.cwd } : {}),
    updatedAt: selected.updatedAt,
    ...(selected.summary ? { summary: selected.summary } : {}),
    active: selected.active,
  });
}

function normalizeSessionQuery(value: string): string {
  return value
    .replace(/\b(?:that|the|my|an?|old(?:est|er)?|latest|newest|recent|last|saved|discovered|claude|codex)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deduplicateSessions(sessions: readonly DiscoveredSession[]): DiscoveredSession[] {
  const unique = new Map<string, DiscoveredSession>();
  for (const session of sessions) {
    const key = `${session.provider}\0${session.sessionId}`;
    const current = unique.get(key);
    if (!current || session.updatedAt > current.updatedAt) unique.set(key, session);
  }
  return [...unique.values()];
}

function newest(sessions: readonly DiscoveredSession[]): DiscoveredSession {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!;
}

function oldest(sessions: readonly DiscoveredSession[]): DiscoveredSession {
  return [...sessions].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0]!;
}
