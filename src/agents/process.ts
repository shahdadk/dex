import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  AgentCancelledError,
  AgentStartupError,
  AgentStartupTimeoutError,
} from "./errors.js";
import type {
  AgentEvent,
  AgentHandle,
  AgentProcessSpawner,
  AgentProvider,
  AgentProviderEvent,
  AgentResult,
  AgentRunOptions,
  AgentTerminalStatus,
  SpawnedAgentProcess,
} from "./types.js";
import { redact, redactString } from "../utils/redact.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_GRACE_MS = 1_500;
const MAX_STDERR_CHARS = 64 * 1024;

export const nodeProcessSpawner: AgentProcessSpawner = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [...options.stdio],
    shell: options.shell,
    windowsHide: options.windowsHide,
    detached: options.detached,
  });

class Deferred<T> {
  readonly promise: Promise<T>;
  settled = false;
  private resolvePromise!: (value: T | PromiseLike<T>) => void;
  private rejectPromise!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise(value);
  }

  reject(reason: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectPromise(reason);
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<{
    resolve: (result: IteratorResult<T>) => void;
  }> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.readers.push({ resolve });
        });
      },
    };
  }
}

export interface InterpretedMessage {
  role: "assistant" | "user" | "system";
  text: string;
  delta?: boolean;
}

export interface InterpretedTool {
  name: string;
  status: "started" | "updated" | "completed" | "failed";
  id?: string;
  input?: unknown;
  output?: string;
}

export interface InterpretedProviderEvent {
  messages?: readonly InterpretedMessage[];
  tools?: readonly InterpretedTool[];
  error?: string;
  finalOutput?: string;
  providerFailure?: string;
  providerCompleted?: boolean;
}

export interface JsonlAgentLaunch<TEvent extends AgentProviderEvent> {
  provider: AgentProvider;
  command: string;
  args: readonly string[];
  options: AgentRunOptions;
  spawner?: AgentProcessSpawner;
  identify(event: TEvent): string | undefined;
  interpret(event: TEvent): InterpretedProviderEvent;
  requireProviderCompletion?: boolean;
}

type StopReason = "requested" | "aborted" | "timeout" | "startup_timeout";

interface RunningAgent {
  readonly ready: Promise<AgentHandle>;
  stop(reason?: StopReason): Promise<AgentResult>;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Agent timeout values must be finite non-negative numbers");
  }
  return value;
}

function eventBase(provider: AgentProvider, workerId: string) {
  return {
    provider,
    workerId,
    timestamp: new Date().toISOString(),
  } as const;
}

function errorText(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL)(?:_|$)/i;

function nonSecretEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)),
  );
}

function providerEnvironment(provider: AgentProvider): NodeJS.ProcessEnv {
  const environment = nonSecretEnvironment();
  const allowed = provider === "codex"
    ? ["CODEX_API_KEY"]
    : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  for (const name of allowed) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function appendBounded(existing: string, chunk: string): string {
  const combined = existing + chunk;
  return combined.length <= MAX_STDERR_CHARS
    ? combined
    : combined.slice(combined.length - MAX_STDERR_CHARS);
}

function writePrompt(process: SpawnedAgentProcess, prompt: string): void {
  if (!process.stdin) {
    throw new Error("Agent process did not expose stdin");
  }
  process.stdin.end(prompt);
}

export function launchJsonlAgent<TEvent extends AgentProviderEvent>(
  config: JsonlAgentLaunch<TEvent>,
): Promise<AgentHandle> {
  const running = createRunningAgent(config);
  return running.ready;
}

function createRunningAgent<TEvent extends AgentProviderEvent>(
  config: JsonlAgentLaunch<TEvent>,
): RunningAgent {
  const { provider, options } = config;
  if (options.signal?.aborted) {
    const reason = new AgentCancelledError(
      `${provider} worker was cancelled before launch`,
      provider,
    );
    return {
      ready: Promise.reject(reason),
      stop: () => Promise.reject(reason),
    };
  }

  const startupTimeoutMs = positiveDuration(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
  );
  const timeoutMs = positiveDuration(options.timeoutMs, 0);
  const stopGraceMs = positiveDuration(options.stopGraceMs, DEFAULT_STOP_GRACE_MS);
  const workerId = `worker_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const queue = new AsyncEventQueue<AgentEvent>();
  const ready = new Deferred<AgentHandle>();
  const completed = new Deferred<AgentResult>();
  const controller = new AbortController();
  const spawner = config.spawner ?? nodeProcessSpawner;
  let child: SpawnedAgentProcess;

  try {
    child = spawner(config.command, config.args, {
      cwd: options.cwd,
      env: { ...providerEnvironment(provider), ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    const startupError = new AgentStartupError(
      `Could not start ${provider}: ${errorText(error)}`,
      provider,
      { cause: error },
    );
    ready.reject(startupError);
    completed.resolve({
      provider,
      workerId,
      providerSessionId: "",
      status: "failed",
      exitCode: null,
      signal: null,
      output: "",
      error: startupError.message,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return { ready: ready.promise, stop: () => completed.promise };
  }

  let providerSessionId: string | undefined;
  let finalOutput = "";
  let providerFailure: string | undefined;
  let providerCompleted = false;
  let stderr = "";
  let stopReason: StopReason | undefined;
  let terminal = false;
  let startupTimer: NodeJS.Timeout | undefined;
  let runTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";

  const emit = (event: AgentEvent): void => queue.push(event);

  const rejectStartup = (error: Error): void => {
    ready.reject(error);
  };

  const statusFor = (code: number | null): AgentTerminalStatus => {
    if (stopReason === "timeout" || stopReason === "startup_timeout") return "timed_out";
    if (stopReason === "requested" || stopReason === "aborted") return "cancelled";
    if (providerFailure || code !== 0) return "failed";
    return "completed";
  };

  const settle = (
    code: number | null,
    signal: NodeJS.Signals | null,
    processError?: Error,
  ): void => {
    if (terminal) return;
    terminal = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (runTimer) clearTimeout(runTimer);
    if (killTimer) clearTimeout(killTimer);
    if (settleTimer) clearTimeout(settleTimer);
    options.signal?.removeEventListener("abort", onAbort);

    if (processError) providerFailure = redactString(processError.message);
    if (
      !stopReason &&
      code === 0 &&
      config.requireProviderCompletion &&
      !providerCompleted &&
      !providerFailure
    ) {
      providerFailure = `${provider} exited without a completion event`;
    }
    if (!providerSessionId) {
      rejectStartup(
        processError instanceof AgentStartupError
          ? processError
          : new AgentStartupError(
              `${provider} exited before reporting a session ID${
                stderr.trim() ? `: ${stderr.trim()}` : ""
              }`,
              provider,
              processError ? { cause: processError } : undefined,
            ),
      );
    }

    const status = statusFor(code);
    const result: AgentResult = {
      provider,
      workerId,
      providerSessionId: providerSessionId ?? "",
      status,
      exitCode: code,
      signal,
      output: redactString(finalOutput),
      ...(providerFailure || (status === "failed" && stderr.trim())
        ? { error: redactString(providerFailure ?? stderr.trim()) }
        : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    emit({
      ...eventBase(provider, workerId),
      type: "finished",
      status,
      exitCode: code,
      signal,
    });
    queue.close();
    completed.resolve(result);
  };

  const parseLine = (lineWithWhitespace: string): void => {
    const line = lineWithWhitespace.trim();
    if (!line) return;
    let event: TEvent;
    try {
      event = JSON.parse(line) as TEvent;
    } catch (error) {
      emit({
        ...eventBase(provider, workerId),
        type: "protocol_error",
        message: `Invalid ${provider} JSONL: ${errorText(error)}`,
        line: redactString(line),
      });
      return;
    }

    const identified = config.identify(event);
    if (!providerSessionId && identified) {
      providerSessionId = identified;
      if (startupTimer) clearTimeout(startupTimer);
      const startedEvent: AgentEvent = {
        ...eventBase(provider, workerId),
        type: "started",
        providerSessionId: identified,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        raw: redact(event),
      };
      emit(startedEvent);

      const handle: AgentHandle = {
        provider,
        workerId,
        providerSessionId: identified,
        sessionId: identified,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        events: queue,
        result: completed.promise,
        signal: controller.signal,
        stop: async () => {
          await requestStop("requested");
        },
      };
      ready.resolve(handle);
    }

    emit({
      ...eventBase(provider, workerId),
      type: "provider_event",
      raw: redact(event),
    });

    const interpreted = config.interpret(event);
    if (interpreted.finalOutput !== undefined) finalOutput = redactString(interpreted.finalOutput);
    if (interpreted.providerFailure) providerFailure = redactString(interpreted.providerFailure);
    if (interpreted.providerCompleted) providerCompleted = true;

    for (const message of interpreted.messages ?? []) {
      if (!message.text) continue;
      emit({
        ...eventBase(provider, workerId),
        type: "message",
        role: message.role,
        text: redactString(message.text),
        delta: message.delta ?? false,
        raw: redact(event),
      });
    }
    for (const tool of interpreted.tools ?? []) {
      emit({
        ...eventBase(provider, workerId),
        type: "tool",
        name: tool.name,
        status: tool.status,
        ...(tool.id === undefined ? {} : { id: tool.id }),
        ...(tool.input === undefined ? {} : { input: redact(tool.input) }),
        ...(tool.output === undefined ? {} : { output: redactString(tool.output) }),
        raw: redact(event),
      });
    }
    if (interpreted.error) {
      emit({
        ...eventBase(provider, workerId),
        type: "error",
        message: redactString(interpreted.error),
        raw: redact(event),
      });
    }
  };

  const consumeStdout = (chunk: unknown): void => {
    stdoutBuffer += Buffer.isBuffer(chunk)
      ? decoder.write(chunk)
      : typeof chunk === "string"
        ? chunk
        : String(chunk);
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      parseLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  };

  const flushStdout = (): void => {
    stdoutBuffer += decoder.end();
    if (!stdoutBuffer) return;
    const line = stdoutBuffer;
    stdoutBuffer = "";
    parseLine(line);
  };

  const requestStop = async (reason: StopReason = "requested"): Promise<AgentResult> => {
    if (terminal) return completed.promise;
    if (!stopReason) stopReason = reason;
    controller.abort(reason);

    try {
      signalProcessTree(child, "SIGTERM");
    } catch {
      // The close/error event or fallback timer owns terminal settlement.
    }

    if (terminal) return completed.promise;

    if (!killTimer) {
      killTimer = setTimeout(() => {
        try {
          signalProcessTree(child, "SIGKILL");
        } catch {
          // The fallback settlement below prevents a hung stop.
        }
      }, stopGraceMs);
      killTimer.unref();
    }
    if (!settleTimer) {
      settleTimer = setTimeout(
        () => settle(child.exitCode, child.signalCode ?? "SIGKILL"),
        stopGraceMs + 1_000,
      );
      settleTimer.unref();
    }
    return completed.promise;
  };

  function onAbort(): void {
    if (!providerSessionId) {
      rejectStartup(
        new AgentCancelledError(`${provider} worker was cancelled during startup`, provider),
      );
    }
    void requestStop("aborted");
  }

  child.stdout?.on("data", consumeStdout);
  child.stdout?.on("end", flushStdout);
  child.stderr?.on("data", (chunk: unknown) => {
    const text = redactString(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    stderr = appendBounded(stderr, text);
    emit({ ...eventBase(provider, workerId), type: "stderr", text });
  });
  child.stdin?.on("error", (error: Error) => {
    settle(
      child.exitCode,
      child.signalCode,
      new AgentStartupError(
        `${provider} prompt stream error: ${error.message}`,
        provider,
        { cause: error },
      ),
    );
  });
  child.once("error", (error) => {
    settle(
      null,
      null,
      new AgentStartupError(
        `${provider} process error: ${error.message}`,
        provider,
        { cause: error },
      ),
    );
  });
  child.once("close", (code, signal) => {
    flushStdout();
    settle(code, signal);
  });

  if (startupTimeoutMs > 0) {
    startupTimer = setTimeout(() => {
      rejectStartup(
        new AgentStartupTimeoutError(
          `${provider} did not report a session ID within ${startupTimeoutMs}ms`,
          provider,
        ),
      );
      void requestStop("startup_timeout");
    }, startupTimeoutMs);
    startupTimer.unref();
  }
  if (timeoutMs > 0) {
    runTimer = setTimeout(() => void requestStop("timeout"), timeoutMs);
    runTimer.unref();
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    writePrompt(child, options.prompt);
  } catch (error) {
    settle(
      null,
      null,
      new AgentStartupError(
        `Could not send prompt to ${provider}: ${errorText(error)}`,
        provider,
        { cause: error },
      ),
    );
  }

  return { ready: ready.promise, stop: requestStop };
}

export async function probeAgentCommand(
  command: string,
  spawner: AgentProcessSpawner = nodeProcessSpawner,
  timeoutMs = 3_000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let child: SpawnedAgentProcess;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };

    try {
      child = spawner(command, ["--version"], {
        cwd: process.cwd(),
        env: nonSecretEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: false,
      });
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Availability probes intentionally collapse all failures to false.
      }
      finish(false);
    }, positiveDuration(timeoutMs, 3_000));
    timer.unref();

    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin?.end();
  });
}

function signalProcessTree(child: SpawnedAgentProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}
