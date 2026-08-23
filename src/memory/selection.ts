import { createHash } from "node:crypto";
import { extractObservationIds } from "./claude-mem.js";
import { redactMemoryValue } from "./redaction.js";
import {
  MAX_HANDOFF_MEMORIES,
  MIN_HANDOFF_MEMORIES,
  type AttemptedApproach,
  type MemoryClient,
  type MemoryObservation,
  type TaskKnowledge,
} from "./types.js";

export interface MemorySelectionOptions {
  query: string;
  minimum?: number;
  maximum?: number;
  fallback?: readonly MemoryObservation[];
}

export interface CollectMemoryOptions {
  query: string;
  project?: string;
  searchLimit?: number;
  timelineDepth?: number;
  batchLimit?: number;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function cleanStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeAttempt(value: AttemptedApproach | string, failedByCollection: boolean): AttemptedApproach {
  if (typeof value === "string") return { approach: value, failed: failedByCollection };
  return {
    ...value,
    failed: value.failed ?? failedByCollection,
  };
}

export function taskKnowledgeToMemories(knowledge: TaskKnowledge): MemoryObservation[] {
  const memories: MemoryObservation[] = [];
  const seen = new Set<string>();

  const add = (
    type: string,
    titlePrefix: string,
    narrative: string,
    facts: string[] = [],
    filesModified: string[] = [],
  ): void => {
    const cleaned = narrative.trim();
    if (!cleaned) return;
    const fingerprint = `${type}\0${cleaned.toLowerCase()}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    memories.push(
      redactMemoryValue({
        id: `task-knowledge-${shortHash(fingerprint)}`,
        source: "task-knowledge",
        type,
        title: `${titlePrefix}: ${cleaned.slice(0, 100)}`,
        narrative: cleaned,
        facts,
        concepts: [type],
        filesRead: [],
        filesModified,
      }),
    );
  };

  for (const observation of knowledge.observations ?? []) {
    const normalized = redactMemoryValue({ ...observation, source: observation.source ?? "task-knowledge" });
    const fingerprint = `${normalized.type ?? "observation"}\0${normalized.narrative.toLowerCase()}`;
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      memories.push(normalized);
    }
  }
  for (const fact of cleanStrings([...(knowledge.learnedFacts ?? []), ...(knowledge.facts ?? [])])) {
    add("learned-fact", "Learned fact", fact, [fact]);
  }
  for (const decision of cleanStrings(knowledge.decisions)) {
    add("decision", "Decision", decision, [decision]);
  }

  const attempts = [
    ...(knowledge.attemptedApproaches ?? []).map((attempt) => normalizeAttempt(attempt, false)),
    ...(knowledge.failedApproaches ?? []).map((attempt) => normalizeAttempt(attempt, true)),
  ];
  for (const attempt of attempts) {
    const isFailed = attempt.failed === true || attempt.shouldRetry === false;
    const reason =
      attempt.reason ||
      attempt.outcome ||
      (isFailed ? "Recorded as unsuccessful; do not retry without new evidence." : "Outcome not recorded.");
    const narrative = `${attempt.approach}\nOutcome: ${reason}${
      isFailed ? "\nContinuation rule: do not repeat this approach without new evidence." : ""
    }`;
    add(isFailed ? "failed-approach" : "attempt", isFailed ? "Failed approach" : "Attempt", narrative, [reason]);
  }
  for (const constraint of cleanStrings(knowledge.constraints)) {
    add("constraint", "Constraint", constraint, [constraint]);
  }
  for (const nextStep of cleanStrings(knowledge.nextSteps)) {
    add("next-step", "Next step", nextStep);
  }
  for (const question of cleanStrings(knowledge.openQuestions)) {
    add("open-question", "Open question", question);
  }
  for (const file of cleanStrings(knowledge.filesChanged)) {
    add("file-change", "Changed file", file, [], [file]);
  }
  return memories;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((token) => token.length >= 3),
  );
}

function searchableText(memory: MemoryObservation): string {
  return [
    memory.title,
    memory.subtitle ?? "",
    memory.narrative,
    ...memory.facts,
    ...memory.concepts,
    ...memory.filesRead,
    ...memory.filesModified,
  ].join(" ");
}

function scoreMemory(memory: MemoryObservation, queryTokens: Set<string>, now: number): number {
  const text = searchableText(memory).toLowerCase();
  const memoryTokens = tokenize(text);
  let score = memory.source === "claude-mem" ? 2 : 1;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) score += 4;
    else if (text.includes(token)) score += 1;
  }
  const type = memory.type?.toLowerCase() ?? "";
  if (["decision", "bugfix", "discovery", "failed-approach", "learned-fact"].includes(type)) score += 5;
  if (/\b(?:failed|failure|avoid|do not|did not work|unsuccessful|regression)\b/i.test(text)) score += 7;
  if (memory.createdAtEpoch !== undefined) {
    const ageDays = Math.max(0, now - memory.createdAtEpoch) / 86_400_000;
    score += Math.max(0, 3 - ageDays / 30);
  }
  return score;
}

function memoryFingerprint(memory: MemoryObservation): string {
  return `${memory.source}:${String(memory.id)}:${shortHash(searchableText(memory).toLowerCase())}`;
}

export function selectMemories(
  candidates: readonly MemoryObservation[],
  options: MemorySelectionOptions,
): MemoryObservation[] {
  const minimum = options.minimum ?? MIN_HANDOFF_MEMORIES;
  const maximum = options.maximum ?? MAX_HANDOFF_MEMORIES;
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum < minimum) {
    throw new RangeError("Memory selection requires integer bounds with 1 <= minimum <= maximum");
  }
  if (minimum < MIN_HANDOFF_MEMORIES || maximum > MAX_HANDOFF_MEMORIES) {
    throw new RangeError(
      `Handoff memory bounds must stay within ${MIN_HANDOFF_MEMORIES}-${MAX_HANDOFF_MEMORIES}`,
    );
  }

  const unique = new Map<string, MemoryObservation>();
  for (const memory of [...candidates, ...(options.fallback ?? [])]) {
    const redacted = redactMemoryValue(memory);
    const key = memoryFingerprint(redacted);
    if (!unique.has(key)) unique.set(key, redacted);
  }
  if (unique.size < minimum) {
    throw new Error(
      `A cloud handoff requires at least ${minimum} memories; only ${unique.size} were available after TaskKnowledge fallback`,
    );
  }

  const now = Date.now();
  const queryTokens = tokenize(options.query);
  return [...unique.values()]
    .map((memory) => ({ memory, score: scoreMemory(memory, queryTokens, now) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const rightTime = right.memory.createdAtEpoch ?? 0;
      const leftTime = left.memory.createdAtEpoch ?? 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return String(left.memory.id).localeCompare(String(right.memory.id));
    })
    .slice(0, maximum)
    .map(({ memory, score }) => ({ ...memory, relevanceScore: Number(score.toFixed(3)) }));
}

export const selectHandoffMemories = selectMemories;

export async function collectClaudeMemMemories(
  client: MemoryClient,
  options: CollectMemoryOptions,
): Promise<MemoryObservation[]> {
  const search = await client.search({
    query: options.query,
    type: "observations",
    limit: Math.min(options.searchLimit ?? 30, 100),
    orderBy: "relevance",
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const searchIds = extractObservationIds(search);
  const timeline = await client.timeline({
    ...(searchIds[0] === undefined ? { query: options.query } : { anchor: searchIds[0] }),
    depthBefore: options.timelineDepth ?? 4,
    depthAfter: options.timelineDepth ?? 4,
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const ids = [...new Set([...searchIds, ...extractObservationIds(timeline)])].slice(
    0,
    options.batchLimit ?? 40,
  );
  if (ids.length === 0) return [];
  return client.getObservations({
    ids,
    orderBy: "date_desc",
    limit: options.batchLimit ?? 40,
    ...(options.project === undefined ? {} : { project: options.project }),
  });
}
