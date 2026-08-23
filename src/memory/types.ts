export const MIN_HANDOFF_MEMORIES = 5;
export const MAX_HANDOFF_MEMORIES = 15;

export type MemorySource = "claude-mem" | "task-knowledge";

export interface MemoryObservation {
  id: number | string;
  source: MemorySource;
  project?: string;
  type?: string;
  title: string;
  subtitle?: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  createdAt?: string;
  createdAtEpoch?: number;
  relevanceScore?: number;
}

export interface AttemptedApproach {
  approach: string;
  outcome?: string;
  reason?: string;
  failed?: boolean;
  shouldRetry?: boolean;
}

/**
 * Facts retained by Dex while a worker is active. This is deliberately useful
 * without Claude-Mem so a handoff can be made after the local service exits.
 */
export interface TaskKnowledge {
  learnedFacts?: string[];
  facts?: string[];
  decisions?: string[];
  attemptedApproaches?: Array<AttemptedApproach | string>;
  failedApproaches?: Array<AttemptedApproach | string>;
  constraints?: string[];
  nextSteps?: string[];
  openQuestions?: string[];
  filesChanged?: string[];
  observations?: MemoryObservation[];
}

export interface MemorySearchOptions {
  query?: string;
  project?: string;
  type?: "observations" | "sessions" | "prompts";
  observationType?: string;
  dateStart?: string | number;
  dateEnd?: string | number;
  offset?: number;
  limit?: number;
  orderBy?: "date_desc" | "date_asc" | "relevance";
}

export interface MemoryTimelineOptions {
  anchor?: number;
  query?: string;
  project?: string;
  depthBefore?: number;
  depthAfter?: number;
}

export interface MemoryBatchOptions {
  ids: number[];
  project?: string;
  limit?: number;
  orderBy?: "date_desc" | "date_asc";
}

export interface DirectObservation {
  /** Preferred Dex name for the provider session. */
  claudeSessionId?: string;
  /** Claude-Mem 13.x compatibility name. */
  contentSessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  content?: string;
  title?: string;
  type?: string;
  cwd?: string;
  agentId?: string;
  agentType?: string;
  platformSource?: string;
  toolUseId?: string;
}

export interface ObservationWriteResult {
  status: "queued" | "skipped" | "stored";
  reason?: string;
}

export interface MemoryClient {
  recordObservation(input: DirectObservation): Promise<ObservationWriteResult>;
  summarizeSession(input: {
    contentSessionId: string;
    lastAssistantMessage?: string;
    platformSource?: string;
  }): Promise<ObservationWriteResult>;
  search(options: MemorySearchOptions): Promise<unknown>;
  timeline(options: MemoryTimelineOptions): Promise<unknown>;
  getObservations(options: MemoryBatchOptions | readonly number[]): Promise<MemoryObservation[]>;
}
