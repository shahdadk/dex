import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSecrets,
  collectClaudeMemMemories,
  createGitCheckpoint,
  createManifest,
  discoverClaudeMem,
  MAX_HANDOFF_MEMORIES,
  MIN_HANDOFF_MEMORIES,
  redactMemoryValue,
  selectMemories,
  signManifest,
  taskKnowledgeToMemories,
  verifyManifest,
  type GitCheckpoint,
  type GitCheckpointOptions,
  type IntegrityManifest,
  type ManifestArtifactInput,
  type ManifestSigner,
  type ManifestVerifier,
  type MemoryClient,
  type MemoryObservation,
  type TaskKnowledge,
} from "../memory/index.js";

export interface HandoffRepositoryInput {
  url?: string;
  path?: string;
  project?: string;
  baseCommit: string;
  workingBranch: string;
  headCommit?: string;
  checkpoint?: GitCheckpoint;
}

export interface HandoffValidationInput {
  commands: Array<string | string[]>;
  expectedEvidence: string[];
}

export interface HandoffInput {
  taskId: string;
  goal: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  repository: HandoffRepositoryInput;
  validation?: HandoffValidationInput;
  memories?: MemoryObservation[];
  taskKnowledge?: TaskKnowledge;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface FailedApproachHandoff {
  approach: string;
  reason: string;
  doNotRepeat: boolean;
  sourceMemoryId?: string | number;
}

export interface HandoffDocument {
  version: 1;
  taskId: string;
  createdAt: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  repository: {
    url?: string;
    path?: string;
    baseCommit: string;
    workingBranch: string;
    headCommit: string;
    checkpoint?: GitCheckpoint;
  };
  memories: MemoryObservation[];
  memorySelection: {
    minimum: number;
    maximum: number;
    selected: number;
    sources: Array<MemoryObservation["source"]>;
    warnings: string[];
  };
  learnedFacts: string[];
  failedApproaches: FailedApproachHandoff[];
  validation: HandoffValidationInput;
  metadata: Record<string, unknown>;
  contentHash: string;
  integrity: IntegrityManifest;
}

export interface CreateHandoffOptions {
  memoryClient?: MemoryClient | null;
  discoverMemory?: boolean;
  taskKnowledgeProvider?: () => Promise<TaskKnowledge | undefined> | TaskKnowledge | undefined;
  gitCheckpoint?: Omit<GitCheckpointOptions, "repositoryPath" | "baseCommit" | "branch">;
  signer?: ManifestSigner;
  signingKey?: string | Uint8Array;
  signingKeyId?: string;
  artifacts?: ManifestArtifactInput[];
  now?: () => Date;
}

export type HandoffVerifier = ManifestVerifier | string | Uint8Array;

function nonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function mergeTaskKnowledge(left: TaskKnowledge, right: TaskKnowledge): TaskKnowledge {
  return {
    learnedFacts: [...(left.learnedFacts ?? []), ...(right.learnedFacts ?? [])],
    facts: [...(left.facts ?? []), ...(right.facts ?? [])],
    decisions: [...(left.decisions ?? []), ...(right.decisions ?? [])],
    attemptedApproaches: [
      ...(left.attemptedApproaches ?? []),
      ...(right.attemptedApproaches ?? []),
    ],
    failedApproaches: [...(left.failedApproaches ?? []), ...(right.failedApproaches ?? [])],
    constraints: [...(left.constraints ?? []), ...(right.constraints ?? [])],
    nextSteps: [...(left.nextSteps ?? []), ...(right.nextSteps ?? [])],
    openQuestions: [...(left.openQuestions ?? []), ...(right.openQuestions ?? [])],
    filesChanged: [...(left.filesChanged ?? []), ...(right.filesChanged ?? [])],
    observations: [...(left.observations ?? []), ...(right.observations ?? [])],
  };
}

function continuationFallback(input: HandoffInput, checkpoint?: GitCheckpoint): TaskKnowledge {
  const constraints = nonEmpty(input.constraints);
  const acceptanceCriteria = nonEmpty(input.acceptanceCriteria);
  const validation = input.validation ?? { commands: [], expectedEvidence: [] };
  const validationSummary = [
    ...validation.commands.map((command) => (Array.isArray(command) ? command.join(" ") : command)),
    ...validation.expectedEvidence,
  ];
  const head = checkpoint?.headCommit ?? input.repository.headCommit ?? input.repository.baseCommit;

  return {
    learnedFacts: [
      `The continuation goal is: ${input.goal}`,
      `Repository continuation starts from ${head} on ${input.repository.workingBranch}.`,
      ...(acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((criterion) => `Acceptance criterion: ${criterion}`)
        : ["Acceptance requires completing the stated task goal with verifiable evidence."]),
    ],
    constraints:
      constraints.length > 0
        ? constraints
        : ["Preserve the repository scope and do not claim completion without validation."],
    nextSteps:
      validationSummary.length > 0
        ? validationSummary.map((item) => `Validation requirement: ${item}`)
        : ["Inspect the checkpoint, complete the goal, and record concrete validation evidence."],
    decisions: [
      checkpoint
        ? `Reconstruct local work from bundle ${path.basename(checkpoint.bundle.path)} with SHA-256 ${checkpoint.bundle.sha256}.`
        : `Continue from commit ${head}; no separate Git bundle was attached.`,
    ],
  };
}

function normalizeFailedApproaches(
  knowledge: TaskKnowledge,
  memories: readonly MemoryObservation[],
): FailedApproachHandoff[] {
  const results: FailedApproachHandoff[] = [];
  const seen = new Set<string>();
  const add = (approach: string, reason: string, sourceMemoryId?: string | number): void => {
    const cleanApproach = approach.trim();
    const cleanReason = reason.trim();
    if (!cleanApproach || !cleanReason) return;
    const key = `${cleanApproach.toLowerCase()}\0${cleanReason.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      approach: cleanApproach,
      reason: cleanReason,
      doNotRepeat: true,
      ...(sourceMemoryId === undefined ? {} : { sourceMemoryId }),
    });
  };

  const attempts = [
    ...(knowledge.attemptedApproaches ?? []),
    ...(knowledge.failedApproaches ?? []),
  ];
  for (const attempt of attempts) {
    if (typeof attempt === "string") {
      add(attempt, "Recorded as unsuccessful in TaskKnowledge; do not retry without new evidence.");
      continue;
    }
    const isFailed =
      (knowledge.failedApproaches ?? []).includes(attempt) ||
      attempt.failed === true ||
      attempt.shouldRetry === false;
    if (!isFailed) continue;
    add(
      attempt.approach,
      attempt.reason || attempt.outcome || "Recorded as unsuccessful; do not retry without new evidence.",
    );
  }
  for (const memory of memories) {
    if (memory.type === "failed-approach") {
      const [approach = memory.title, ...rest] = memory.narrative.split(/\r?\n/);
      const outcome = rest.find((line) => line.startsWith("Outcome:"));
      add(
        approach,
        outcome?.slice("Outcome:".length).trim() || memory.facts[0] || "The prior worker recorded this approach as unsuccessful.",
        memory.id,
      );
      continue;
    }

    // Claude-Mem's semantic classifier may store an explicitly documented
    // failed approach as a broader "discovery". Preserve the engineering
    // meaning instead of depending on that classifier label alone. Do not
    // reinterpret deterministic TaskKnowledge constraints as failed attempts.
    if (memory.source !== "claude-mem") continue;
    const evidence = [...memory.facts, memory.title, memory.narrative]
      .flatMap((value) => value.split(/\r?\n/))
      .map((value) => value.trim())
      .filter(Boolean);
    for (const line of evidence) {
      const causal = line.match(/^(.{5,240}?)\s+(risks?|causes?|caused|leads? to|resulted in)\s+(.{5,400})$/i);
      const approachLike = causal &&
        causal[1]!.length <= 180 &&
        /\b(?:perform(?:ing|ed)?|mov(?:ing|ed)?|plac(?:ing|ed)?|call(?:ing|ed)?|retry(?:ing|ied)?|skipp(?:ing|ed)?|disabl(?:ing|ed)?|assum(?:ing|ed)?|mark(?:ing|ed)?|execut(?:ing|ed)?|send(?:ing|sent)?|writ(?:ing|ten)?|delet(?:ing|ed)?)\b/i.test(causal[1]!);
      if (causal && approachLike && /\b(?:duplicate|twice|failure|failed|regression|unsafe|breaks?|corrupts?)\b/i.test(causal[3]!)) {
        add(causal[1]!, `${causal[2]} ${causal[3]}`, memory.id);
        break;
      }
      const prohibition = line.match(/\bdo not\s+(.{5,300}?)(?:[.;]|$)/i);
      if (prohibition) {
        const reason = evidence.find((candidate) =>
          candidate !== line && /\b(?:duplicate|twice|failure|failed|regression|unsafe|breaks?|corrupts?|risk)\b/i.test(candidate));
        add(
          prohibition[1]!,
          reason ?? "The prior memory explicitly prohibited this approach.",
          memory.id,
        );
        break;
      }
    }
  }
  return results;
}

function deriveLearnedFacts(
  knowledge: TaskKnowledge,
  memories: readonly MemoryObservation[],
): string[] {
  return nonEmpty([
    ...(knowledge.learnedFacts ?? []),
    ...(knowledge.facts ?? []),
    ...memories.flatMap((memory) => memory.facts),
  ]).slice(0, 100);
}

function approachText(value: TaskKnowledge["failedApproaches"] extends readonly (infer T)[] | undefined ? T : never): string[] {
  if (typeof value === "string") return [value];
  if (!value) return [];
  return [value.approach, value.reason ?? "", value.outcome ?? ""];
}

function buildMemoryQuery(input: HandoffInput, knowledge: TaskKnowledge): string {
  // Short task titles such as "fix checkout" are not discriminative enough
  // in a long-lived engineering memory store. Include the worker's concrete
  // discoveries and decisions so semantic retrieval finds the exact failure
  // mode instead of unrelated historical bug fixes.
  const taskContext = [
    ...(knowledge.learnedFacts ?? []),
    ...(knowledge.facts ?? []),
    ...(knowledge.decisions ?? []),
    ...(knowledge.failedApproaches ?? []).flatMap(approachText),
    ...(knowledge.attemptedApproaches ?? []).flatMap(approachText),
    ...(knowledge.nextSteps ?? []),
  ];
  return nonEmpty([
    input.goal,
    ...taskContext,
  ]).join(" ").slice(0, 12_000);
}

export function handoffContent(document: HandoffDocument): Omit<HandoffDocument, "contentHash" | "integrity"> {
  const { contentHash: _contentHash, integrity: _integrity, ...content } = document;
  return content;
}

async function resolveCheckpoint(
  input: HandoffInput,
  options: CreateHandoffOptions,
): Promise<GitCheckpoint | undefined> {
  if (input.repository.checkpoint !== undefined) return input.repository.checkpoint;
  if (options.gitCheckpoint === undefined) return undefined;
  if (!input.repository.path) {
    throw new Error("A repository path is required to create a Git checkpoint");
  }
  return createGitCheckpoint({
    ...options.gitCheckpoint,
    repositoryPath: input.repository.path,
    baseCommit: input.repository.baseCommit,
    branch: input.repository.workingBranch,
  });
}

export async function createHandoff(
  rawInput: HandoffInput,
  options: CreateHandoffOptions = {},
): Promise<HandoffDocument> {
  if (!rawInput.taskId.trim()) throw new TypeError("Handoff taskId is required");
  if (!rawInput.goal.trim()) throw new TypeError("Handoff goal is required");
  if (!rawInput.repository.baseCommit.trim() || !rawInput.repository.workingBranch.trim()) {
    throw new TypeError("Handoff repository baseCommit and workingBranch are required");
  }

  const input = redactMemoryValue(rawInput);
  const checkpoint = await resolveCheckpoint(input, options);
  let knowledge = input.taskKnowledge ?? {};
  if (options.taskKnowledgeProvider !== undefined) {
    const provided = await options.taskKnowledgeProvider();
    if (provided !== undefined) knowledge = mergeTaskKnowledge(knowledge, provided);
  }
  // Build retrieval from task-specific worker knowledge before adding generic
  // continuity constraints and validation instructions.
  knowledge = redactMemoryValue(knowledge);
  const memoryQuery = buildMemoryQuery(input, knowledge);
  knowledge = redactMemoryValue(mergeTaskKnowledge(
    knowledge,
    continuationFallback(input, checkpoint),
  ));
  const fallbackMemories = taskKnowledgeToMemories(knowledge);
  const memoryWarnings: string[] = [];
  const candidates = [...(input.memories ?? [])];

  if (candidates.length < MIN_HANDOFF_MEMORIES) {
    let memoryClient = options.memoryClient;
    if (memoryClient === undefined && options.discoverMemory !== false) {
      const discovery = await discoverClaudeMem();
      memoryClient = discovery.client ?? null;
      if (!discovery.available) memoryWarnings.push("Claude-Mem unavailable; used TaskKnowledge fallback.");
    }
    if (memoryClient) {
      try {
        candidates.push(
          ...(await collectClaudeMemMemories(memoryClient, {
            query: memoryQuery,
            ...(input.repository.project === undefined
              ? input.repository.path === undefined
                ? {}
                : { project: path.basename(input.repository.path) }
              : { project: input.repository.project }),
          })),
        );
      } catch (error) {
        memoryWarnings.push(
          `Claude-Mem retrieval failed; used TaskKnowledge fallback (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
  }

  const memories = selectMemories(candidates, {
    query: memoryQuery,
    fallback: fallbackMemories,
  });
  const validation = input.validation ?? { commands: [], expectedEvidence: [] };
  const createdAt = input.createdAt ?? (options.now?.() ?? new Date()).toISOString();
  if (Number.isNaN(Date.parse(createdAt))) throw new TypeError("Handoff createdAt must be an ISO timestamp");
  const headCommit = checkpoint?.headCommit ?? input.repository.headCommit ?? input.repository.baseCommit;
  const sources = [...new Set(memories.map((memory) => memory.source))];

  const unsignedContent = redactMemoryValue({
    version: 1 as const,
    taskId: input.taskId,
    createdAt,
    goal: input.goal,
    constraints: nonEmpty(input.constraints),
    acceptanceCriteria: nonEmpty(input.acceptanceCriteria),
    repository: {
      ...(input.repository.url === undefined ? {} : { url: input.repository.url }),
      ...(input.repository.path === undefined ? {} : { path: input.repository.path }),
      baseCommit: input.repository.baseCommit,
      workingBranch: input.repository.workingBranch,
      headCommit,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    },
    memories,
    memorySelection: {
      minimum: MIN_HANDOFF_MEMORIES,
      maximum: MAX_HANDOFF_MEMORIES,
      selected: memories.length,
      sources,
      warnings: memoryWarnings,
    },
    learnedFacts: deriveLearnedFacts(knowledge, memories),
    failedApproaches: normalizeFailedApproaches(knowledge, memories),
    validation: {
      commands: validation.commands.map((command) =>
        Array.isArray(command) ? [...command] : command,
      ),
      expectedEvidence: nonEmpty(validation.expectedEvidence),
    },
    metadata: input.metadata ?? {},
  });
  assertNoSecrets(unsignedContent);

  const artifacts: ManifestArtifactInput[] = [...(options.artifacts ?? [])];
  if (checkpoint !== undefined) {
    artifacts.push({
      path: path.basename(checkpoint.bundle.path),
      bytes: checkpoint.bundle.bytes,
      sha256: checkpoint.bundle.sha256,
    });
  }
  let integrity = createManifest(unsignedContent, artifacts);
  if (options.signer !== undefined) {
    integrity = await signManifest(integrity, options.signer, options.signingKeyId);
  } else if (options.signingKey !== undefined) {
    integrity = await signManifest(integrity, options.signingKey, options.signingKeyId);
  }
  const document: HandoffDocument = {
    ...unsignedContent,
    contentHash: integrity.contentSha256,
    integrity,
  };
  assertNoSecrets(document);
  return document;
}

export const createHandoffPackage = createHandoff;

export async function verifyHandoff(
  document: HandoffDocument,
  verifier?: HandoffVerifier,
): Promise<boolean> {
  if (
    document.version !== 1 ||
    document.memories.length < MIN_HANDOFF_MEMORIES ||
    document.memories.length > MAX_HANDOFF_MEMORIES ||
    document.contentHash !== document.integrity.contentSha256
  ) {
    return false;
  }
  try {
    assertNoSecrets(document);
  } catch {
    return false;
  }
  return verifyManifest(handoffContent(document), document.integrity, verifier);
}

export async function assertValidHandoff(
  document: HandoffDocument,
  verifier?: HandoffVerifier,
): Promise<void> {
  if (!(await verifyHandoff(document, verifier))) {
    throw new Error("Handoff verification failed");
  }
}

export async function writeHandoff(file: string, document: HandoffDocument): Promise<void> {
  if (!(await verifyHandoff(document, document.integrity.signature === undefined ? undefined : () => true))) {
    throw new Error("Refusing to write an invalid handoff");
  }
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readHandoff(
  file: string,
  verifier?: HandoffVerifier,
): Promise<HandoffDocument> {
  const document = JSON.parse(await readFile(file, "utf8")) as HandoffDocument;
  await assertValidHandoff(document, verifier);
  return document;
}
