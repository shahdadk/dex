import { launchJsonlAgent, probeAgentCommand } from "./process.js";
import type { InterpretedProviderEvent } from "./process.js";
import type {
  AgentAdapter,
  AgentHandle,
  AgentProcessSpawner,
  CodexItem,
  CodexJsonEvent,
  CodexRunOptions,
} from "./types.js";

export interface CodexAgentAdapterOptions {
  command?: string;
  spawner?: AgentProcessSpawner;
  availabilityTimeoutMs?: number;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return undefined;
  return stringField((error as Record<string, unknown>).message);
}

function itemStatus(
  eventType: string,
  item: CodexItem,
): "started" | "updated" | "completed" | "failed" {
  if (item.status === "failed") return "failed";
  if (eventType === "item.started") return "started";
  if (eventType === "item.completed") return "completed";
  return "updated";
}

export function buildCodexStartArgs(options: CodexRunOptions): string[] {
  assertSafeExtraArgs(options.extraArgs);
  const args = [
    "-C",
    options.cwd,
    "--sandbox",
    options.sandboxMode ?? "workspace-write",
    "--ask-for-approval",
    "never",
  ];
  if (options.model) args.push("--model", options.model);
  args.push(
    "exec",
    "--json",
    "--color",
    "never",
    "--ignore-user-config",
    ...(options.extraArgs ?? []),
    "-",
  );
  return args;
}

export function buildCodexResumeArgs(
  providerSessionId: string,
  options: CodexRunOptions,
): string[] {
  if (!providerSessionId.trim()) throw new TypeError("Codex thread ID is required");
  assertSafeExtraArgs(options.extraArgs);
  const args = [
    "-C",
    options.cwd,
    "--sandbox",
    options.sandboxMode ?? "workspace-write",
    "--ask-for-approval",
    "never",
  ];
  if (options.model) args.push("--model", options.model);
  args.push(
    "exec",
    "resume",
    "--json",
    "--ignore-user-config",
    ...(options.extraArgs ?? []),
    providerSessionId,
    "-",
  );
  return args;
}

function assertSafeExtraArgs(args: readonly string[] | undefined): void {
  const forbidden = new Set([
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
  ]);
  const unsafe = args?.find((arg) =>
    [...forbidden].some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
  if (unsafe) throw new TypeError(`Unsafe Codex argument is not allowed: ${unsafe}`);
}

export function codexThreadId(event: CodexJsonEvent): string | undefined {
  if (event.type !== "thread.started") return undefined;
  const record = event as Record<string, unknown>;
  return (
    stringField(record.thread_id) ??
    stringField(record.threadId) ??
    stringField(record.session_id) ??
    stringField(record.sessionId)
  );
}

export function interpretCodexEvent(event: CodexJsonEvent): InterpretedProviderEvent {
  if (event.type === "turn.completed") return { providerCompleted: true };
  if (event.type === "turn.failed") {
    const message = nestedErrorMessage(event.error) ?? "Codex turn failed";
    return { error: message, providerFailure: message };
  }
  if (event.type === "error") {
    const message = stringField(event.message) ?? "Codex reported an error";
    return { error: message, providerFailure: message };
  }

  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return {};
  }

  const candidate = (event as Record<string, unknown>).item;
  if (!candidate || typeof candidate !== "object") return {};
  const item = candidate as CodexItem;
  if (typeof item.type !== "string") return {};
  const status = itemStatus(event.type, item);
  if (item.type === "agent_message" || item.type === "message") {
    const text = stringField(item.text);
    return text
      ? {
          messages: [{ role: "assistant" as const, text, delta: false }],
          ...(status === "completed" ? { finalOutput: text } : {}),
        }
      : {};
  }

  if (item.type === "command_execution") {
    return {
      tools: [
        {
          name: stringField(item.command) ?? "command_execution",
          status,
          ...(stringField(item.id) ? { id: String(item.id) } : {}),
          ...(stringField(item.aggregated_output)
            ? { output: String(item.aggregated_output) }
            : {}),
        },
      ],
    };
  }

  if (item.type === "mcp_tool_call" || item.type === "tool_call" || item.type === "file_change") {
    const record = item as Record<string, unknown>;
    return {
      tools: [
        {
          name:
            stringField(record.name) ??
            stringField(record.tool) ??
            stringField(record.path) ??
            item.type,
          status,
          ...(stringField(item.id) ? { id: String(item.id) } : {}),
          ...(record.arguments === undefined ? {} : { input: record.arguments }),
          ...(record.output === undefined ? {} : { output: String(record.output) }),
        },
      ],
    };
  }

  return {};
}

export class CodexAgentAdapter implements AgentAdapter<CodexRunOptions> {
  readonly provider = "codex" as const;
  private readonly command: string;
  private readonly spawner: AgentProcessSpawner | undefined;
  private readonly availabilityTimeoutMs: number;

  constructor(options: CodexAgentAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.spawner = options.spawner;
    this.availabilityTimeoutMs = options.availabilityTimeoutMs ?? 3_000;
  }

  available(): Promise<boolean> {
    return probeAgentCommand(this.command, this.spawner, this.availabilityTimeoutMs);
  }

  isAvailable(): Promise<boolean> {
    return this.available();
  }

  start(options: CodexRunOptions): Promise<AgentHandle> {
    return this.launch(buildCodexStartArgs(options), options);
  }

  resume(providerSessionId: string, options: CodexRunOptions): Promise<AgentHandle> {
    return this.launch(buildCodexResumeArgs(providerSessionId, options), options);
  }

  stop(handle: AgentHandle): Promise<void> {
    if (handle.provider !== this.provider) {
      return Promise.reject(new TypeError("Cannot stop a non-Codex agent with CodexAgentAdapter"));
    }
    return handle.stop();
  }

  private launch(args: readonly string[], options: CodexRunOptions): Promise<AgentHandle> {
    return launchJsonlAgent<CodexJsonEvent>({
      provider: this.provider,
      command: this.command,
      args,
      options,
      ...(this.spawner ? { spawner: this.spawner } : {}),
      identify: codexThreadId,
      interpret: interpretCodexEvent,
      requireProviderCompletion: true,
    });
  }
}
