import { launchJsonlAgent, probeAgentCommand } from "./process.js";
import type { InterpretedProviderEvent, InterpretedTool } from "./process.js";
import type {
  AgentAdapter,
  AgentHandle,
  AgentProcessSpawner,
  ClaudeContentBlock,
  ClaudeRunOptions,
  ClaudeStreamJsonEvent,
} from "./types.js";

export interface ClaudeAgentAdapterOptions {
  command?: string;
  spawner?: AgentProcessSpawner;
  availabilityTimeoutMs?: number;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return stringField(record.text) ?? stringField(record.content) ?? "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

export function buildClaudeStartArgs(options: ClaudeRunOptions): string[] {
  return buildClaudeArgs(options);
}

export function buildClaudeResumeArgs(
  providerSessionId: string,
  options: ClaudeRunOptions,
): string[] {
  if (!providerSessionId.trim()) throw new TypeError("Claude session ID is required");
  return [...buildClaudeArgs(options), "--resume", providerSessionId];
}

function buildClaudeArgs(options: ClaudeRunOptions): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", options.permissionMode ?? "acceptEdits");
  }
  args.push(...(options.extraArgs ?? []));
  return args;
}

export function claudeSessionId(event: ClaudeStreamJsonEvent): string | undefined {
  const record = event as Record<string, unknown>;
  return stringField(record.session_id) ?? stringField(record.sessionId);
}

function messageBlocks(event: ClaudeStreamJsonEvent): ClaudeContentBlock[] {
  if (event.type !== "assistant" && event.type !== "user") return [];
  const message = (event as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

export function interpretClaudeEvent(
  event: ClaudeStreamJsonEvent,
  toolNames: Map<string, string> = new Map(),
): InterpretedProviderEvent {
  if (event.type === "result") {
    const record = event as Record<string, unknown>;
    const result = stringField(record.result) ?? "";
    const subtype = stringField(record.subtype);
    const errors = Array.isArray(record.errors)
      ? record.errors.filter((value): value is string => typeof value === "string")
      : [];
    const failure =
      record.is_error === true || (subtype !== undefined && subtype !== "success")
        ? errors.join("; ") || result || `Claude result: ${subtype}`
        : undefined;
    return {
      ...(result ? { finalOutput: result } : {}),
      ...(failure ? { error: failure, providerFailure: failure } : {}),
    };
  }

  if (event.type === "stream_event") {
    const stream = (event as Record<string, unknown>).event;
    if (!stream || typeof stream !== "object") return {};
    if ((stream as Record<string, unknown>).type !== "content_block_delta") return {};
    const delta = (stream as Record<string, unknown>).delta;
    if (!delta || typeof delta !== "object") return {};
    const text = stringField((delta as Record<string, unknown>).text);
    return text
      ? { messages: [{ role: "assistant" as const, text, delta: true }] }
      : {};
  }

  if (event.type !== "assistant" && event.type !== "user") return {};
  const role: "assistant" | "user" = event.type;
  const message = (event as Record<string, unknown>).message;
  const text =
    message && typeof message === "object"
      ? contentText((message as Record<string, unknown>).content)
      : undefined;
  const tools: InterpretedTool[] = [];
  for (const block of messageBlocks(event)) {
    if (block.type === "tool_use") {
      const id = stringField(block.id);
      const name = stringField(block.name) ?? "tool_use";
      if (id) toolNames.set(id, name);
      tools.push({
        name,
        status: "started",
        ...(id ? { id } : {}),
        ...(block.input === undefined ? {} : { input: block.input }),
      });
    }
    if (block.type === "tool_result") {
      const id = stringField(block.tool_use_id) ?? stringField(block.id);
      const output = contentText(block.content);
      tools.push({
        name: (id && toolNames.get(id)) ?? stringField(block.name) ?? "tool_result",
        status: block.is_error === true ? "failed" : "completed",
        ...(id ? { id } : {}),
        ...(output ? { output } : {}),
      });
      if (id) toolNames.delete(id);
    }
  }
  return {
    ...(text ? { messages: [{ role, text, delta: false }] } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

export class ClaudeAgentAdapter implements AgentAdapter<ClaudeRunOptions> {
  readonly provider = "claude" as const;
  private readonly command: string;
  private readonly spawner: AgentProcessSpawner | undefined;
  private readonly availabilityTimeoutMs: number;

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.command = options.command ?? "claude";
    this.spawner = options.spawner;
    this.availabilityTimeoutMs = options.availabilityTimeoutMs ?? 3_000;
  }

  available(): Promise<boolean> {
    return probeAgentCommand(this.command, this.spawner, this.availabilityTimeoutMs);
  }

  isAvailable(): Promise<boolean> {
    return this.available();
  }

  start(options: ClaudeRunOptions): Promise<AgentHandle> {
    return this.launch(buildClaudeStartArgs(options), options);
  }

  resume(providerSessionId: string, options: ClaudeRunOptions): Promise<AgentHandle> {
    return this.launch(buildClaudeResumeArgs(providerSessionId, options), options);
  }

  stop(handle: AgentHandle): Promise<void> {
    if (handle.provider !== this.provider) {
      return Promise.reject(new TypeError("Cannot stop a non-Claude agent with ClaudeAgentAdapter"));
    }
    return handle.stop();
  }

  private launch(args: readonly string[], options: ClaudeRunOptions): Promise<AgentHandle> {
    const toolNames = new Map<string, string>();
    return launchJsonlAgent<ClaudeStreamJsonEvent>({
      provider: this.provider,
      command: this.command,
      args,
      options,
      ...(this.spawner ? { spawner: this.spawner } : {}),
      identify: claudeSessionId,
      interpret: (event) => interpretClaudeEvent(event, toolNames),
    });
  }
}
