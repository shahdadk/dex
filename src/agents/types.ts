import type { ChildProcess } from "node:child_process";

export type AgentProvider = "codex" | "claude";

export type AgentTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface AgentRunOptions {
  /** Absolute or caller-resolved working directory for the worker. */
  cwd: string;
  /** The complete user/task prompt. It is written to stdin, never interpolated into a shell. */
  prompt: string;
  model?: string;
  /** Maximum duration of the complete worker run. Set to 0 to disable. */
  timeoutMs?: number;
  /** Maximum duration to wait for the provider's durable session/thread ID. */
  startupTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  stopGraceMs?: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  /** Additional provider arguments, passed as individual argv entries. */
  extraArgs?: readonly string[];
}

export type CodexRunOptions = AgentRunOptions;

export interface ClaudeRunOptions extends AgentRunOptions {
  permissionMode?:
    | "default"
    | "manual"
    | "acceptEdits"
    | "auto"
    | "dontAsk"
    | "plan"
    | "bypassPermissions";
  dangerouslySkipPermissions?: boolean;
  appendSystemPrompt?: string;
}

export interface CodexItem {
  id?: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  status?: string;
  [key: string]: unknown;
}

export type CodexJsonEvent =
  | { type: "thread.started"; thread_id: string; [key: string]: unknown }
  | { type: "turn.started"; [key: string]: unknown }
  | { type: "turn.completed"; usage?: unknown; [key: string]: unknown }
  | { type: "turn.failed"; error?: unknown; [key: string]: unknown }
  | {
      type: "item.started" | "item.updated" | "item.completed";
      item: CodexItem;
      [key: string]: unknown;
    }
  | { type: "error"; message?: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface ClaudeMessage {
  id?: string;
  role?: string;
  content?: ClaudeContentBlock[] | string;
  model?: string;
  stop_reason?: string | null;
  [key: string]: unknown;
}

export type ClaudeStreamJsonEvent =
  | {
      type: "system";
      subtype: string;
      session_id?: string;
      [key: string]: unknown;
    }
  | {
      type: "assistant" | "user";
      session_id?: string;
      message?: ClaudeMessage;
      parent_tool_use_id?: string | null;
      [key: string]: unknown;
    }
  | {
      type: "stream_event";
      session_id?: string;
      event?: Record<string, unknown>;
      parent_tool_use_id?: string | null;
      [key: string]: unknown;
    }
  | {
      type: "result";
      subtype?: string;
      session_id?: string;
      is_error?: boolean;
      result?: string;
      errors?: string[];
      [key: string]: unknown;
    }
  | { type: string; session_id?: string; [key: string]: unknown };

export type AgentProviderEvent = CodexJsonEvent | ClaudeStreamJsonEvent;

interface AgentEventBase {
  provider: AgentProvider;
  workerId: string;
  timestamp: string;
}

export type AgentEvent =
  | (AgentEventBase & {
      type: "started";
      providerSessionId: string;
      pid?: number;
      raw: AgentProviderEvent;
    })
  | (AgentEventBase & {
      type: "message";
      role: "assistant" | "user" | "system";
      text: string;
      delta: boolean;
      raw: AgentProviderEvent;
    })
  | (AgentEventBase & {
      type: "tool";
      name: string;
      status: "started" | "updated" | "completed" | "failed";
      id?: string;
      input?: unknown;
      output?: string;
      raw: AgentProviderEvent;
    })
  | (AgentEventBase & {
      type: "provider_event";
      raw: AgentProviderEvent;
    })
  | (AgentEventBase & {
      type: "stderr";
      text: string;
    })
  | (AgentEventBase & {
      type: "protocol_error";
      message: string;
      line: string;
    })
  | (AgentEventBase & {
      type: "error";
      message: string;
      raw?: AgentProviderEvent;
    })
  | (AgentEventBase & {
      type: "finished";
      status: AgentTerminalStatus;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    });

export interface AgentResult {
  provider: AgentProvider;
  workerId: string;
  providerSessionId: string;
  status: AgentTerminalStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface AgentHandle {
  readonly provider: AgentProvider;
  readonly workerId: string;
  /** Durable Codex thread ID or Claude session ID. */
  readonly providerSessionId: string;
  /** Alias useful to callers that do not need provider-specific terminology. */
  readonly sessionId: string;
  readonly pid?: number;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentResult>;
  readonly signal: AbortSignal;
  stop(): Promise<void>;
}

export interface AgentAdapter<Options extends AgentRunOptions = AgentRunOptions> {
  readonly provider: AgentProvider;
  available(): Promise<boolean>;
  isAvailable(): Promise<boolean>;
  start(options: Options): Promise<AgentHandle>;
  resume(providerSessionId: string, options: Options): Promise<AgentHandle>;
  stop(handle: AgentHandle): Promise<void>;
}

export interface SpawnedAgentProcess {
  readonly pid?: number | undefined;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface AgentSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: readonly ["pipe", "pipe", "pipe"];
  shell: false;
  windowsHide: true;
  detached: boolean;
}

export type AgentProcessSpawner = (
  command: string,
  args: readonly string[],
  options: AgentSpawnOptions,
) => SpawnedAgentProcess;

/** Makes Node's ChildProcess type visibly compatible for adapter consumers. */
export type NodeAgentProcess = ChildProcess;
