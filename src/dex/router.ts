import { DexActionsSchema, type DexAction, type RouteResult } from "./actions.js";
import { GeminiRouter } from "./gemini.js";

const STATUS = /^(?:dex[:,]?\s*)?(?:status\??|what(?:'s| is) (?:running|going on)|what are you working on)\s*$/i;
const MEMORY = /^(?:dex[:,]?\s*)?(?:didn't we|did we|what did we|what happened with|do you remember)\b/i;
const KEEP_AWAKE = /\bkeep (?:this|my|the)?\s*mac awake(?: until (?:everything|all tasks) (?:is|are) (?:done|finished))?/i;
const SLEEP = /\bsleep (?:this|my|the)?\s*mac\b|\bwhen (?:everything|all tasks) (?:is|are) (?:done|finished),? sleep/i;
const MOVE = /\bmove\s+(.+?)\s+to\s+(?:the\s+)?(cloud|local)(?:\s+and\s+use\s+(claude|codex))?/i;
const CHANGE = /\b(?:give|have|use)\s+(?:the\s+)?(.+?)\s+(?:to|with|use)\s+(claude|codex)\b|\b(?:claude|codex)\s+(?:take over|handle)\s+(.+)/i;
const STOP = /^(?:dex[:,]?\s*)?(?:stop|cancel|pause)\s+(.+)$/i;
const RESUME = /^(?:dex[:,]?\s*)?(?:resume|continue)\s+(.+)$/i;

export interface MessageRouterOptions {
  gemini?: GeminiRouter;
}

export class MessageRouter {
  readonly #gemini: GeminiRouter;

  constructor(options: MessageRouterOptions = {}) {
    this.#gemini = options.gemini ?? new GeminiRouter();
  }

  async route(rawMessage: string): Promise<RouteResult> {
    const message = rawMessage.trim().replace(/^dex[:,]?\s*/i, "");
    if (!message) throw new Error("Dex received an empty message");

    const exact = deterministicActions(message);
    if (exact.length > 0) return { actions: DexActionsSchema.parse(exact), source: "deterministic" };

    const ambiguous = isAmbiguous(message);
    if (this.#gemini.available) {
      try {
        const actions = await this.#gemini.route(message, ambiguous ? "brain" : "fast");
        return { actions, source: ambiguous ? "flash" : "flash-lite" };
      } catch {
        // A model outage must not prevent obvious engineering work from becoming a task.
      }
    }

    return {
      actions: deterministicTaskSplit(message),
      source: "deterministic",
    };
  }
}

export function deterministicActions(message: string): DexAction[] {
  if (STATUS.test(message)) return [{ type: "STATUS" }];
  if (MEMORY.test(message)) return [{ type: "MEMORY_QUERY", query: message }];

  const actions: DexAction[] = [];
  const move = message.match(MOVE);
  if (move?.[1] && move[2]) {
    actions.push({
      type: "MOVE_TASK",
      taskQuery: normalizeTaskQuery(move[1]),
      destination: move[2].toLowerCase() === "cloud" ? "cloud" : "local",
      ...(move[3] ? { preferredAgent: move[3].toLowerCase() as "claude" | "codex" } : {}),
    });
  }

  const change = message.match(CHANGE);
  if (change) {
    const taskQuery = change[1] ?? change[3];
    const explicitAgent = change[2] ?? message.match(/\b(claude|codex)\b/i)?.[1];
    if (taskQuery && explicitAgent && !move) {
      actions.push({
        type: "CHANGE_AGENT",
        taskQuery: normalizeTaskQuery(taskQuery),
        agent: explicitAgent.toLowerCase() as "claude" | "codex",
      });
    }
  }

  const stop = message.match(STOP);
  if (stop?.[1]) actions.push({ type: "STOP_TASK", taskQuery: normalizeTaskQuery(stop[1]) });
  const resume = message.match(RESUME);
  if (resume?.[1]) actions.push({ type: "RESUME_TASK", taskQuery: normalizeTaskQuery(resume[1]) });
  if (KEEP_AWAKE.test(message)) actions.push({ type: "KEEP_AWAKE", until: "tasks_complete" });
  if (SLEEP.test(message)) {
    actions.push({
      type: "SLEEP",
      when: /\bwhen\s+(?:everything|all tasks).*(?:done|finished)\b|\bafter\s+(?:everything|all tasks).*(?:done|finished)\b/i.test(message)
        ? "tasks_complete"
        : "now",
    });
  }
  return actions;
}

function deterministicTaskSplit(message: string): DexAction[] {
  const globalAgent = message.match(/^(?:please\s+)?(?:have|use)\s+(claude|codex)\s+(?:to\s+)?/i)?.[1]?.toLowerCase() as
    | "claude"
    | "codex"
    | undefined;
  const parts = message
    .split(/\s*(?:,|;|\band also\b|\balso have\b|\band have\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2)
    .slice(0, 3);
  return (parts.length > 0 ? parts : [message]).map((part) => {
    const preferredAgent = part.match(/\b(claude|codex)\b/i)?.[1]?.toLowerCase() as
      | "claude"
      | "codex"
      | undefined ?? globalAgent;
    const executionPreference = /\bcloud\b/i.test(part)
      ? "cloud"
      : /\b(?:on|locally|this)\s+(?:my\s+)?mac\b|\blocal(?:ly)?\b/i.test(part)
        ? "local"
        : undefined;
    const description = part
      .replace(/^(?:please\s+)?(?:have|use)\s+(?:claude|codex)\s+(?:to\s+)?/i, "")
      .replace(/^(?:claude|codex)\s+/i, "")
      .replace(/\b(?:with|using|use)\s+(?:claude|codex)\b/gi, "")
      .replace(/\b(?:in|on)\s+the\s+cloud\b/gi, "")
      .trim();
    return {
      type: "CREATE_TASK" as const,
      description,
      ...(preferredAgent ? { preferredAgent } : {}),
      ...(executionPreference ? { executionPreference } : {}),
    };
  });
}

function isAmbiguous(message: string): boolean {
  return message.length > 240 || /\b(?:it|that|this|thing|same|before|figure out|whatever)\b/i.test(message);
}

function normalizeTaskQuery(value: string): string {
  return value.replace(/\b(?:task|thing)\b/gi, "").replace(/\s+/g, " ").trim();
}
