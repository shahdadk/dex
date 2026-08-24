import { DexActionsSchema, type DexAction, type RouteResult } from "./actions.js";
import {
  defaultSessionDiscovery,
  parseSessionAdoptionIntent,
  resolveSessionAdoption,
  type SessionDiscoveryLoader,
} from "../agents/session-adoption.js";
import { GeminiRouter } from "./gemini.js";

const STATUS = /^(?:dex[:,]?\s*)?(?:status|what(?:'s| is) (?:running|going on)|what are you working on)[?.!]*\s*$/i;
const LIST_SESSIONS = /^(?:(?:what|which)\s+(?:(?:recent|old)\s+)?(?:(?:claude|codex)\s+)?sessions?\s+(?:do\s+)?(?:i|we)\s+have|(?:show|list)(?:\s+me)?\s+(?:my\s+)?(?:(?:recent|old)\s+)?(?:(?:claude|codex)\s+)?sessions?)\??$/i;
const ADOPT_LISTED_SESSION = /^(?:please\s+)?(?:continue|resume|adopt|pick\s+(?:back\s+)?up)\s+(?:the\s+)?(first|second|third|fourth|fifth|\d{1,2}(?:st|nd|rd|th)?)\s+(?:one|session)?[?.!]*$/i;
const MEMORY = /^(?:dex[:,]?\s*)?(?:didn't we|did we|what did we|what happened with|do you remember)\b/i;
const REVIEW_RESULT = /^(?:show(?:\s+me)?(?:\s+the)?(?:\s+full)?\s+review(?:\s+(?:findings|result))?|what\s+did\s+(?:the\s+)?(?:(?:claude|codex)\s+)?review\s+find|review\s+(?:findings|results?))(?:\s+(?:for|on)\s+(.+?))?[?.!]*$/i;
const CROSS_AGENT_REVIEW = /^(?:please\s+)?(?:have|ask|use)\s+(claude|codex)\s+(?:to\s+)?review\s+what\s+(claude|codex)\s+(?:did|changed|implemented|built)(?:\s+(?:on|for)\s+(.+))?$/i;
const NAMED_TASK_REVIEW = /^(?:please\s+)?(?:have|ask|use)\s+(claude|codex)\s+(?:to\s+)?review\s+(?:the\s+)?(.+?)\s+(?:task|work|changes)$/i;
const KEEP_AWAKE = /\bkeep (?:this|my|the)?\s*mac awake(?: until (?:everything|all tasks) (?:is|are) (?:done|finished))?/i;
const SLEEP = /\bsleep (?:this|my|the)?\s*mac\b|\bwhen (?:everything|all tasks) (?:is|are) (?:done|finished),? sleep/i;
const SLEEP_AFTER_TASKS = /\b(?:when|after|once)\s+(?:(?:everything|all tasks|the tasks|the work)\s+(?:(?:is|are)\s+)?(?:done|finished|complete)|(?:everything|all tasks|the tasks|the work)\s+(?:finishes|completes)|it(?:(?:'s| is)\s+(?:done|finished|complete)|\s+(?:finishes|completes))|you(?:'re| are)\s+done)\b/i;
const MOVE = /\bmove\s+(.+?)\s+to\s+(?:the\s+)?(cloud|local)(?:\s+and\s+use\s+(claude|codex))?/i;
const CHANGE = /\b(?:give|have|use)\s+(?:the\s+)?(.+?)\s+(?:to|with|use)\s+(claude|codex)\b|\b(?:claude|codex)\s+(?:take over|handle)\s+(.+)/i;
const CHANGE_AGENT_FIRST = /\b(?:use|switch to)\s+(claude|codex)\s+(?:for|on)\s+(.+)/i;
const IMPLICIT_TAKEOVER = /^(?:please\s+)?(?:have\s+)?(claude|codex)\s+(?:take over|handle it|handle that|handle this)$/i;
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
  const listedSession = message.match(ADOPT_LISTED_SESSION)?.[1];
  if (listedSession) return [{ type: "ADOPT_LISTED_SESSION", ordinal: sessionOrdinal(listedSession) }];
  if (LIST_SESSIONS.test(message)) {
    const provider = message.match(/\b(claude|codex)\b/i)?.[1]?.toLowerCase() as "claude" | "codex" | undefined;
    return [{ type: "LIST_SESSIONS", ...(provider ? { provider } : {}) }];
  }
  const reviewResult = message.match(REVIEW_RESULT);
  if (reviewResult) {
    return [{
      type: "REVIEW_RESULT",
      ...(reviewResult[1] ? { taskQuery: normalizeTaskQuery(reviewResult[1]) } : {}),
    }];
  }
  if (MEMORY.test(message)) return [{ type: "MEMORY_QUERY", query: message }];

  const crossAgentReview = message.match(CROSS_AGENT_REVIEW);
  if (crossAgentReview?.[1] && crossAgentReview[2]) {
    return [{
      type: "REVIEW_TASK",
      reviewer: crossAgentReview[1].toLowerCase() as "claude" | "codex",
      sourceAgent: crossAgentReview[2].toLowerCase() as "claude" | "codex",
      ...(crossAgentReview[3] ? { taskQuery: normalizeTaskQuery(crossAgentReview[3]) } : {}),
    }];
  }
  const namedTaskReview = message.match(NAMED_TASK_REVIEW);
  if (namedTaskReview?.[1] && namedTaskReview[2]) {
    return [{
      type: "REVIEW_TASK",
      reviewer: namedTaskReview[1].toLowerCase() as "claude" | "codex",
      taskQuery: normalizeTaskQuery(namedTaskReview[2]),
    }];
  }

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
  const implicitTakeover = message.match(IMPLICIT_TAKEOVER);
  if (change || agentFirstChange || implicitTakeover) {
    const taskQuery = agentFirstChange?.[2] ?? change?.[1] ?? change?.[3] ?? (implicitTakeover ? "it" : undefined);
    const explicitAgent = agentFirstChange?.[1] ?? change?.[2] ?? implicitTakeover?.[1] ?? message.match(/\b(claude|codex)\b/i)?.[1];
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
      when: SLEEP_AFTER_TASKS.test(message) ? "tasks_complete" : "now",
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
  return value
    .replace(/\b(?:task|thing)\b/gi, "")
    .replace(/^the\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sessionOrdinal(value: string): number {
  const named: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  return named[value.toLowerCase()] ?? Number.parseInt(value, 10);
}
