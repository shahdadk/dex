import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";
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
const PROCESS_START_SKEW_MS = 2_000;
const MAX_PROCESS_LAUNCH_DELAY_MS = 5 * 60_000;
export const DEX_LOCAL_AGENT_ARGV0_PREFIX = "dex-local-worker:";

const runningAgentProcesses = new Set<RunningAgent>();

export const nodeProcessSpawner = (
  command: Parameters<AgentProcessSpawner>[0],
  args: Parameters<AgentProcessSpawner>[1],
  options: Parameters<AgentProcessSpawner>[2],
  logicalProvider?: AgentProvider,
): SpawnedAgentProcess =>
  spawn(command, [...args], {
    // Recovery compares this marker with the persisted logical provider. The
    // executable may be a user-configured wrapper whose basename is unrelated
    // to that provider, so provider identity must win whenever it is known.
    argv0: `${DEX_LOCAL_AGENT_ARGV0_PREFIX}${logicalProvider ?? path.basename(command)}`,
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
  verifyTerminated(): Promise<void>;
  stop(reason?: StopReason): Promise<void>;
}

export class AgentTerminationUnverifiedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentTerminationUnverifiedError";
  }
}

const agentHandleTerminationChecks = new WeakMap<AgentHandle, () => Promise<void>>();

/** Waits for the OS-level termination proof of a Dex-launched provider. */
export async function awaitAgentHandleTermination(handle: AgentHandle): Promise<void> {
  const verify = agentHandleTerminationChecks.get(handle);
  if (verify) {
    await verify();
    return;
  }
  await handle.result;
}

export interface PersistedAgentProcessIdentity {
  provider: AgentProvider;
  pid?: number;
  cwd?: string;
  startedAt: string;
}

export interface AgentProcessGroupReconciliation {
  status: "not_running" | "terminated" | "unverified";
  processGroupId?: number;
  reason?: string;
}

export interface AgentProcessTerminationOptions {
  stopGraceMs?: number;
  killWaitMs?: number;
  pollIntervalMs?: number;
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

function providerEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  // Dex deliberately uses the authenticated local CLI accounts. API-key
  // variables would silently switch providers onto separately billed API
  // credentials, and daemon-level secrets must never reach a coding worker.
  // Apply the same denylist to explicit overrides so a caller cannot bypass
  // this boundary accidentally. Non-secret runtime settings such as
  // CODEX_HOME remain available.
  return Object.fromEntries(
    Object.entries({ ...nonSecretEnvironment(), ...(overrides ?? {}) })
      .filter(([name, value]) => value !== undefined && !SENSITIVE_ENVIRONMENT_NAME.test(name)),
  );
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
      verifyTerminated: async () => undefined,
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
  let child: SpawnedAgentProcess;

  try {
    const spawnOptions: Parameters<AgentProcessSpawner>[2] = {
      cwd: options.cwd,
      env: providerEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    };
    child = config.spawner
      ? config.spawner(config.command, config.args, spawnOptions)
      : nodeProcessSpawner(config.command, config.args, spawnOptions, provider);
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
    return {
      ready: ready.promise,
      verifyTerminated: async () => undefined,
      stop: async () => { await completed.promise; },
    };
  }

  let providerSessionId: string | undefined;
  let finalOutput = "";
  let lastCompleteAssistantMessage: string | undefined;
  let providerFailure: string | undefined;
  let providerCompleted = false;
  let stderr = "";
  let stopReason: StopReason | undefined;
  let terminal = false;
  let startupTimer: NodeJS.Timeout | undefined;
  let runTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let closeObserved = false;
  let processErrorObserved = false;
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";

  const emit = (event: AgentEvent): void => queue.push(event);

  let startupFailureStarted = false;
  let failStartupAfterTermination!: (error: Error, reason?: StopReason) => void;

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
    const startupError = !providerSessionId
      ? processError instanceof AgentStartupError
        ? processError
        : new AgentStartupError(
            `${provider} exited before reporting a session ID${
              stderr.trim() ? `: ${stderr.trim()}` : ""
            }`,
            provider,
            processError ? { cause: processError } : undefined,
          )
      : undefined;

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
    if (startupError) failStartupAfterTermination(startupError);
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
        stop: async () => stopAndVerify("requested"),
      };
      agentHandleTerminationChecks.set(handle, verifyTerminated);
      // A timeout/abort may have begun while the provider's startup event was
      // already buffered. Once shutdown starts, never hand a live handle back
      // to the orchestrator; the original startup must finish its termination
      // proof and reject instead.
      if (!startupFailureStarted) ready.resolve(handle);
    }

    emit({
      ...eventBase(provider, workerId),
      type: "provider_event",
      raw: redact(event),
    });

    const interpreted = config.interpret(event);
    const interpretedFinalOutput = interpreted.finalOutput === undefined
      ? undefined
      : redactString(interpreted.finalOutput);
    if (interpretedFinalOutput !== undefined) finalOutput = interpretedFinalOutput;
    if (interpreted.providerFailure) providerFailure = redactString(interpreted.providerFailure);
    if (interpreted.providerCompleted) providerCompleted = true;

    for (const message of interpreted.messages ?? []) {
      if (!message.text) continue;
      const text = redactString(message.text);
      const delta = message.delta ?? false;
      emit({
        ...eventBase(provider, workerId),
        type: "message",
        role: message.role,
        text,
        delta,
        raw: redact(event),
      });
      if (message.role === "assistant" && !delta) {
        lastCompleteAssistantMessage = text.trim();
      }
    }
    // Some providers publish their terminal answer only on the result channel.
    // Promote it to the canonical message stream so status, deterministic task
    // knowledge, and external memory all observe the same completion. Providers
    // such as Codex already emit a complete assistant message, so suppress the
    // synthetic event when the terminal answer is identical.
    const completeAssistantMessage = interpretedFinalOutput?.trim();
    if (
      completeAssistantMessage &&
      !interpreted.providerFailure &&
      !interpreted.error &&
      completeAssistantMessage !== lastCompleteAssistantMessage
    ) {
      emit({
        ...eventBase(provider, workerId),
        type: "message",
        role: "assistant",
        text: interpretedFinalOutput!,
        delta: false,
        raw: redact(event),
      });
      lastCompleteAssistantMessage = completeAssistantMessage;
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
    if (!ready.settled) {
      failStartupAfterTermination(
        new AgentCancelledError(`${provider} worker was cancelled during startup`, provider),
        "aborted",
      );
      return;
    }
    void stopAndVerify("aborted").catch(() => undefined);
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
    processErrorObserved = true;
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
    closeObserved = true;
    flushStdout();
    settle(code, signal);
  });

  if (startupTimeoutMs > 0) {
    startupTimer = setTimeout(() => {
      failStartupAfterTermination(
        new AgentStartupTimeoutError(
          `${provider} did not report a session ID within ${startupTimeoutMs}ms`,
          provider,
        ),
        "startup_timeout",
      );
    }, startupTimeoutMs);
    startupTimer.unref();
  }
  if (timeoutMs > 0) {
    runTimer = setTimeout(() => void stopAndVerify("timeout").catch(() => undefined), timeoutMs);
    runTimer.unref();
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const verifyTerminated = async (): Promise<void> => {
    await completed.promise;
    if (process.platform === "win32") {
      if (!closeObserved && !processErrorObserved) {
        throw new AgentTerminationUnverifiedError(
          `${provider} worker termination could not be verified after the stop timeout`,
        );
      }
      return;
    }
    if (child.pid) {
      if (await processGroupIsAlive(child.pid)) {
        try {
          await terminateProcessGroup(child.pid, 0, 1_000, 25);
        } catch (error) {
          throw new AgentTerminationUnverifiedError(
            `Dex worker process group ${child.pid} remained alive after SIGKILL`,
            { cause: error },
          );
        }
      }
      return;
    }
    if (!closeObserved && !processErrorObserved) {
      throw new AgentTerminationUnverifiedError(
        `${provider} worker termination could not be verified because the process had no PID and emitted no close event`,
      );
    }
  };
  const stopAndVerify = async (reason: StopReason = "requested"): Promise<void> => {
    await requestStop(reason);
    await verifyTerminated();
  };
  failStartupAfterTermination = (error: Error, reason?: StopReason): void => {
    if (ready.settled || startupFailureStarted) return;
    startupFailureStarted = true;
    void (async () => {
      try {
        if (reason) await stopAndVerify(reason);
        else await verifyTerminated();
        ready.reject(error);
      } catch (terminationError) {
        ready.reject(new AgentTerminationUnverifiedError(
          `${provider} startup failed, but process-group termination could not be verified`,
          { cause: new AggregateError([error, terminationError], "startup and termination both failed") },
        ));
      }
    })();
  };
  const running: RunningAgent = {
    ready: ready.promise,
    verifyTerminated,
    stop: stopAndVerify,
  };
  runningAgentProcesses.add(running);
  void completed.promise.then(() => verifyTerminated()).then(
    () => runningAgentProcesses.delete(running),
    () => undefined,
  );

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

  return running;
}

/** Stops every provider process launched by this daemon, including workers that
 * have not reported a provider session ID yet. */
export async function stopAllDexLocalAgentProcesses(): Promise<void> {
  for (;;) {
    const running = [...runningAgentProcesses];
    if (running.length === 0) return;
    await Promise.all(running.map(async (agent) => {
      await agent.stop("requested");
      await agent.verifyTerminated();
    }));
  }
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

interface ProcessTableRecord {
  pid: number;
  processGroupId: number;
  startedAtMs: number;
  command: string;
}

/**
 * Reconciles a detached provider process left by a previous daemon. A group is
 * signalled only after its leader matches Dex's argv marker. Older unmarked
 * processes deliberately fail closed because provider/cwd/PID coincidence is
 * not proof that Dex owns a process.
 */
export async function terminateSurvivingDexAgentProcessGroup(
  identity: PersistedAgentProcessIdentity,
  options: AgentProcessTerminationOptions = {},
): Promise<AgentProcessGroupReconciliation> {
  if (process.platform === "win32") {
    return {
      status: "unverified",
      reason: "detached Dex process-group reconciliation is unavailable on Windows",
    };
  }
  const startedAtMs = Date.parse(identity.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return { status: "unverified", reason: "the persisted worker start time is invalid" };
  }
  if (identity.pid !== undefined && (!Number.isSafeInteger(identity.pid) || identity.pid <= 1)) {
    return { status: "unverified", reason: "the persisted worker PID is invalid" };
  }

  const records = await processTable();
  let leader: ProcessTableRecord | undefined;
  if (identity.pid !== undefined) {
    const group = records.filter((record) => record.processGroupId === identity.pid);
    if (group.length === 0) return { status: "not_running" };
    leader = group.find((record) => record.pid === identity.pid);
    if (!leader) {
      return {
        status: "unverified",
        processGroupId: identity.pid,
        reason: "the persisted process group is alive but its Dex group leader is gone",
      };
    }
    if (!(await isVerifiedDexLeader(leader, identity))) {
      return {
        status: "unverified",
        processGroupId: identity.pid,
        reason: "the live process group does not match the persisted Dex worker identity",
      };
    }
  } else {
    const markedLeaders = records.filter((record) =>
      record.pid === record.processGroupId &&
      hasDexArgvMarker(record, identity.provider));
    const plausible = markedLeaders.filter((record) =>
      startedWithinWorkerLaunch(record, startedAtMs));
    if (plausible.length === 0) {
      // A missing PID is the least trustworthy recovery state. The launch-time
      // window may disambiguate a recent worker, but it must never turn an
      // older, exactly marked Dex process into evidence that no process is
      // running. Preserve the fence unless every marked leader can be proven
      // to belong to a different working directory.
      const possibleOlderLeaders = await possiblyMatchingOlderDexLeaders(markedLeaders, identity);
      if (possibleOlderLeaders.length > 0) {
        return {
          status: "unverified",
          ...(possibleOlderLeaders.length === 1
            ? { processGroupId: possibleOlderLeaders[0]!.processGroupId }
            : {}),
          reason: possibleOlderLeaders.length === 1
            ? "an older marked Dex process group may belong to this PID-less worker"
            : "multiple older marked Dex process groups may belong to this PID-less worker",
        };
      }
      return { status: "not_running" };
    }
    if (plausible.length > 1) {
      return {
        status: "unverified",
        reason: "multiple Dex process groups match the worker that stopped during startup",
      };
    }
    const plausibleLeader = plausible[0]!;
    const verification = await verifyDexLeader(plausibleLeader, identity);
    if (!verification.verified) {
      return {
        status: "unverified",
        processGroupId: plausibleLeader.processGroupId,
        reason: verification.reason ?? "the plausible Dex worker could not be verified",
      };
    }
    leader = plausibleLeader;
  }
  if (!leader) {
    return { status: "unverified", reason: "Dex worker process leader could not be resolved" };
  }

  const processGroupId = leader.processGroupId;
  if (processGroupId === process.pid || records.some((record) =>
    record.pid === process.pid && record.processGroupId === processGroupId)) {
    return {
      status: "unverified",
      processGroupId,
      reason: "refusing to signal the current daemon process group",
    };
  }

  // Minimize the PID-reuse window between inspection and signalling.
  const refreshed = (await processTable()).find((record) => record.pid === leader.pid);
  if (!refreshed || !(await isVerifiedDexLeader(refreshed, identity))) {
    return (await processGroupIsAlive(processGroupId))
      ? {
          status: "unverified",
          processGroupId,
          reason: "the Dex process identity changed while restart reconciliation was running",
        }
      : { status: "not_running" };
  }

  const stopGraceMs = positiveDuration(options.stopGraceMs, DEFAULT_STOP_GRACE_MS);
  const killWaitMs = positiveDuration(options.killWaitMs, 1_000);
  const pollIntervalMs = Math.max(1, positiveDuration(options.pollIntervalMs, 25));
  await terminateProcessGroup(processGroupId, stopGraceMs, killWaitMs, pollIntervalMs);
  return { status: "terminated", processGroupId };
}

async function possiblyMatchingOlderDexLeaders(
  leaders: readonly ProcessTableRecord[],
  identity: PersistedAgentProcessIdentity,
): Promise<ProcessTableRecord[]> {
  if (leaders.length === 0) return [];
  if (!identity.cwd) return [...leaders];
  const expectedCwd = await canonicalPath(identity.cwd);
  const matches = await Promise.all(leaders.map(async (leader) => ({
    leader,
    cwd: await processCwd(leader.pid),
  })));
  // Failure to inspect cwd is not evidence that the marked process is
  // unrelated. Only a positively different cwd permits releasing the fence.
  return matches
    .filter(({ cwd }) => cwd === undefined || cwd === expectedCwd)
    .map(({ leader }) => leader);
}

async function isVerifiedDexLeader(
  record: ProcessTableRecord,
  identity: PersistedAgentProcessIdentity,
): Promise<boolean> {
  return (await verifyDexLeader(record, identity)).verified;
}

async function verifyDexLeader(
  record: ProcessTableRecord,
  identity: PersistedAgentProcessIdentity,
): Promise<{ verified: boolean; reason?: string }> {
  if (record.pid !== record.processGroupId) {
    return { verified: false, reason: "the plausible Dex process is not its process-group leader" };
  }
  const workerStart = Date.parse(identity.startedAt);
  if (!startedWithinWorkerLaunch(record, workerStart)) {
    return { verified: false, reason: "the plausible Dex process start time does not match" };
  }
  if (!hasDexArgvMarker(record, identity.provider)) {
    return { verified: false, reason: "the plausible process lacks the persisted Dex provider marker" };
  }
  if (!identity.cwd) return { verified: true };
  const [actualCwd, expectedCwd] = await Promise.all([
    processCwd(record.pid),
    canonicalPath(identity.cwd),
  ]);
  if (actualCwd === undefined) {
    return {
      verified: false,
      reason: "the plausible Dex process working directory could not be inspected",
    };
  }
  if (actualCwd !== expectedCwd) {
    return {
      verified: false,
      reason: "the plausible Dex process working directory does not match durable task state",
    };
  }
  return { verified: true };
}

function hasDexArgvMarker(record: ProcessTableRecord, provider: AgentProvider): boolean {
  const marker = `${DEX_LOCAL_AGENT_ARGV0_PREFIX}${provider}`;
  return record.command === marker || record.command.startsWith(`${marker} `);
}

function startedWithinWorkerLaunch(record: ProcessTableRecord, workerStartMs: number): boolean {
  return record.startedAtMs >= workerStartMs - PROCESS_START_SKEW_MS &&
    record.startedAtMs <= workerStartMs + MAX_PROCESS_LAUNCH_DELAY_MS;
}

async function processTable(): Promise<ProcessTableRecord[]> {
  const output = await execFileText("ps", [
    "-axo",
    "pid=,pgid=,lstart=,command=",
  ]);
  const records: ProcessTableRecord[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) continue;
    const startedAtMs = Date.parse(match[3] ?? "");
    if (!Number.isFinite(startedAtMs)) continue;
    records.push({
      pid: Number(match[1]),
      processGroupId: Number(match[2]),
      startedAtMs,
      command: match[4] ?? "",
    });
  }
  return records;
}

async function processCwd(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
    return cwd ? canonicalPath(cwd) : undefined;
  }
  const output = await execFileText("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .catch(() => "");
  const cwd = output.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  return cwd ? canonicalPath(cwd) : undefined;
}

async function canonicalPath(file: string): Promise<string> {
  return realpath(file).catch(() => path.resolve(file));
}

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(file, [...args], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function processGroupIsAlive(processGroupId: number): Promise<boolean> {
  return (await processTable()).some((record) => record.processGroupId === processGroupId);
}

async function terminateProcessGroup(
  processGroupId: number,
  stopGraceMs: number,
  killWaitMs: number,
  pollIntervalMs: number,
): Promise<void> {
  if (!(await processGroupIsAlive(processGroupId))) return;
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (await waitForGroupExit(processGroupId, stopGraceMs, pollIntervalMs)) return;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (!(await waitForGroupExit(processGroupId, killWaitMs, pollIntervalMs))) {
    throw new Error(`Dex worker process group ${processGroupId} did not exit after SIGKILL`);
  }
}

async function waitForGroupExit(
  processGroupId: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await processGroupIsAlive(processGroupId))) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  } while (true);
}
