import { DexActionsSchema, type DexAction, type RouteResult } from "./actions.js";
import {
  defaultSessionDiscovery,
  parseSessionAdoptionIntent,
  resolveSessionAdoption,
  type SessionDiscoveryLoader,
} from "../agents/session-adoption.js";
import { GeminiRouter } from "./gemini.js";

const STATUS = /^(?:dex[:,]?\s*)?(?:status\??|what(?:'s| is) (?:running|going on)|what are you working on)\s*$/i;
const LIST_SESSIONS = /^(?:(?:what|which)\s+(?:(?:recent|old)\s+)?(?:(?:claude|codex)\s+)?sessions?\s+(?:do\s+)?(?:i|we)\s+have|(?:show|list)(?:\s+me)?\s+(?:my\s+)?(?:(?:recent|old)\s+)?(?:(?:claude|codex)\s+)?sessions?)\??$/i;
const MEMORY = /^(?:dex[:,]?\s*)?(?:didn't we|did we|what did we|what happened with|do you remember)\b/i;
const KEEP_AWAKE = /\bkeep (?:this|my|the)?\s*mac awake(?: until (?:everything|all tasks) (?:is|are) (?:done|finished))?/i;
const SLEEP = /\bsleep (?:this|my|the)?\s*mac\b|\bwhen (?:everything|all tasks) (?:is|are) (?:done|finished),? sleep/i;
const MOVE = /\bmove\s+(.+?)\s+to\s+(?:the\s+)?(cloud|local)(?:\s+and\s+use\s+(claude|codex))?/i;
const CHANGE = /\b(?:give|have|use)\s+(?:the\s+)?(.+?)\s+(?:to|with|use)\s+(claude|codex)\b|\b(?:claude|codex)\s+(?:take over|handle)\s+(.+)/i;
const CHANGE_AGENT_FIRST = /\b(?:use|switch to)\s+(claude|codex)\s+(?:for|on)\s+(.+)/i;
const STOP = /^(?:dex[:,]?\s*)?(?:stop|cancel|pause)\s+(.+)$/i;
const RESUME = /^(?:dex[:,]?\s*)?(?:resume|continue)\s+(.+)$/i;

export interface MessageRouterOptions {
  gemini?: GeminiRouter;
  sessionDiscovery?: SessionDiscoveryLoader;
}

export class MessageRouter {
  readonly #gemini: GeminiRouter;
  readonly #sessionDiscovery: SessionDiscoveryLoader;

  constructor(options: MessageRouterOptions = {}) {
    this.#gemini = options.gemini ?? new GeminiRouter();
    this.#sessionDiscovery = options.sessionDiscovery ?? defaultSessionDiscovery;
  }

  async route(rawMessage: string): Promise<RouteResult> {
    const message = rawMessage.trim().replace(/[‘’]/g, "'").replace(/^dex[:,]?\s*/i, "");
    if (!message) throw new Error("Dex received an empty message");

    const adoptionIntent = parseSessionAdoptionIntent(message);
    if (adoptionIntent) {
      const sessions = await this.#sessionDiscovery(adoptionIntent.provider);
      const action = resolveSessionAdoption(sessions, adoptionIntent);
      return { actions: DexActionsSchema.parse([action]), source: "deterministic" };
    }

    const exact = deterministicActions(message);
    if (exact.length > 0) return { actions: DexActionsSchema.parse(exact), source: "deterministic" };

    if (hasExplicitAgentAssignment(message)) {
      return { actions: DexActionsSchema.parse(deterministicTaskSplit(message)), source: "deterministic" };
    }

    const ambiguous = isAmbiguous(message);
    if (this.#gemini.available) {
      try {
        const actions = await this.#gemini.route(message, ambiguous ? "brain" : "fast");
        const resolved = await Promise.all(actions.map(async (action) => {
          if (action.type !== "ADOPT_SESSION") return action;
          const sessions = await this.#sessionDiscovery(action.provider);
          return resolveSessionAdoption(sessions, {
            provider: action.provider,
            sessionId: action.sessionId,
          });
        }));
        return { actions: DexActionsSchema.parse(resolved), source: ambiguous ? "flash" : "flash-lite" };
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
  if (LIST_SESSIONS.test(message)) {
    const provider = message.match(/\b(claude|codex)\b/i)?.[1]?.toLowerCase() as "claude" | "codex" | undefined;
    return [{ type: "LIST_SESSIONS", ...(provider ? { provider } : {}) }];
  }
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
  const agentFirstChange = message.match(CHANGE_AGENT_FIRST);
  if (change || agentFirstChange) {
    const taskQuery = agentFirstChange?.[2] ?? change?.[1] ?? change?.[3];
    const explicitAgent = agentFirstChange?.[1] ?? change?.[2] ?? message.match(/\b(claude|codex)\b/i)?.[1];
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

function hasExplicitAgentAssignment(message: string): boolean {
  return /\b(?:have|use)\s+(?:claude|codex)\b|\b(?:with|using)\s+(?:claude|codex)\b|\b(?:claude|codex)\s+(?:to\s+)?(?:fix|investigate|implement|build|review|debug|add|finish|test)\b/i.test(message);
}

function normalizeTaskQuery(value: string): string {
  return value.replace(/\b(?:task|thing)\b/gi, "").replace(/\s+/g, " ").trim();
}
