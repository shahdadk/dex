import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentStartupTimeoutError,
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  buildClaudeResumeArgs,
  buildCodexStartArgs,
  buildCodexResumeArgs,
  buildCodexWorkerPrompt,
  type AgentEvent,
  type AgentProcessSpawner,
  type AgentSpawnOptions,
  type SpawnedAgentProcess,
} from "../src/agents/index.js";
import { MemoryContinuity } from "../src/memory/index.js";
import { DexTaskSchema, WorkerSessionSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { createHandoff } from "../src/tasks/handoff.js";

class FakeAgentProcess extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  prompt = "";
  private closed = false;

  constructor(private readonly closeWhenKilled = true, pid: number | null = 4242) {
    super();
    this.pid = pid ?? undefined;
    this.stdin.on("data", (chunk) => {
      this.prompt += chunk.toString("utf8");
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.closeWhenKilled) {
      queueMicrotask(() =>
        this.finish(null, typeof signal === "string" ? signal : "SIGTERM"),
      );
    }
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: AgentSpawnOptions;
}

function fakeSpawner(processes: FakeAgentProcess[]) {
  const calls: SpawnCall[] = [];
  const spawner: AgentProcessSpawner = (command, args, options) => {
    const process = processes.shift();
    if (!process) throw new Error("No fake process queued");
    calls.push({ command, args: [...args], options });
    return process as SpawnedAgentProcess;
  };
  return { calls, spawner };
}

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("CodexAgentAdapter", () => {
  it("uses account auth and strips provider keys plus unrelated daemon secrets", async () => {
    vi.stubEnv("CODEX_API_KEY", "codex-test-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("MODAL_TOKEN_SECRET", "modal-test-secret");
    vi.stubEnv("DEX_HANDOFF_SIGNING_KEY", "handoff-test-key");
    const process = new FakeAgentProcess();
    const { calls, spawner } = fakeSpawner([process]);
    const pending = new CodexAgentAdapter({ spawner }).start({
      cwd: "/repo",
      prompt: "work",
      env: {
        CODEX_HOME: "/private/codex-home",
        CODEX_API_KEY: "override-codex-key",
        OPENAI_API_KEY: "override-openai-key",
      },
    });
    process.stdout.write('{"type":"thread.started","thread_id":"thread-env"}\n');
    const handle = await pending;
    process.stdout.write('{"type":"turn.completed"}\n');
    process.finish(0);
    await handle.result;

    expect(calls[0]?.options.env.CODEX_HOME).toBe("/private/codex-home");
    expect(calls[0]?.options.env.CODEX_API_KEY).toBeUndefined();
    expect(calls[0]?.options.env.OPENAI_API_KEY).toBeUndefined();
    expect(calls[0]?.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0]?.options.env.GEMINI_API_KEY).toBeUndefined();
    expect(calls[0]?.options.env.MODAL_TOKEN_SECRET).toBeUndefined();
    expect(calls[0]?.options.env.DEX_HANDOFF_SIGNING_KEY).toBeUndefined();
  });

  it("parses fragmented JSONL and returns as soon as the thread ID is available", async () => {
    const process = new FakeAgentProcess();
    const { calls, spawner } = fakeSpawner([process]);
    const adapter = new CodexAgentAdapter({ spawner });
    const handlePromise = adapter.start({ cwd: "/repo", prompt: "Fix checkout" });

    process.stdout.write('{"type":"thread.star');
    let returned = false;
    void handlePromise.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    process.stdout.write('ted","thread_id":"thread-1"}\r\n');
    const handle = await handlePromise;
    expect(handle.providerSessionId).toBe("thread-1");
    expect(process.exitCode).toBeNull();

    const eventsPromise = collectEvents(handle.events);
    process.stdout.write(
      '{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"npm test","status":"in_progress"}}\n' +
        '{"type":"item.updated","item":{"id":"cmd-1","type":"command_execution","command":"npm test","aggregated_output":"passing","status":"in_progress"}}\n',
    );
    process.stdout.write(
      '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"Done"}}',
    );
    process.stdout.write('\n{"type":"turn.completed","usage":{}}\n');
    process.finish(0);

    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      output: "Done",
      providerSessionId: "thread-1",
    });
    const events = await eventsPromise;
    expect(events[0]).toMatchObject({ type: "started", providerSessionId: "thread-1" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        id: "cmd-1",
        name: "npm test",
        status: "updated",
        output: "passing",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", text: "Done", delta: false }),
    );
    const doneMessages = events.filter((event) =>
      event.type === "message" && event.text === "Done" && !event.delta
    );
    expect(doneMessages).toHaveLength(1);
    expect(events.indexOf(doneMessages[0]!)).toBeLessThan(
      events.findIndex((event) => event.type === "finished"),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args).toEqual([
      "-C",
      "/repo",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--color",
      "never",
      "--ignore-user-config",
      "-",
    ]);
    expect(calls[0]?.options.shell).toBe(false);
    expect(process.prompt).toBe("Fix checkout");
    expect(calls[0]?.args).not.toContain("Fix checkout");
  });

  it("uses an argv-only resume invocation", () => {
    expect(
      buildCodexResumeArgs("thread old; touch /tmp/nope", {
        cwd: "/repo with spaces",
        prompt: "continue",
        model: "gpt-test",
      }),
    ).toEqual([
      "-C",
      "/repo with spaces",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--model",
      "gpt-test",
      "exec",
      "resume",
      "--json",
      "--ignore-user-config",
      "thread old; touch /tmp/nope",
      "-",
    ]);
  });

  it("enforces an explicit read-only sandbox for review workers", () => {
    expect(buildCodexStartArgs({
      cwd: "/repo",
      prompt: "review",
      sandboxMode: "read-only",
    })).toEqual([
      "-C",
      "/repo",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--color",
      "never",
      "--ignore-user-config",
      "-",
    ]);
  });

  it("requires turn.completed as well as exit code zero", async () => {
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const adapter = new CodexAgentAdapter({ spawner });
    const handlePromise = adapter.start({ cwd: "/repo", prompt: "work" });
    process.stdout.write('{"type":"thread.started","thread_id":"thread-incomplete"}\n');
    const handle = await handlePromise;
    process.finish(0);

    await expect(handle.result).resolves.toMatchObject({
      status: "failed",
      error: "codex exited without a completion event",
    });
  });

  it("fails a completed turn when the process exits non-zero and forbids bypass flags", async () => {
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const adapter = new CodexAgentAdapter({ spawner });
    const handlePromise = adapter.start({ cwd: "/repo", prompt: "work" });
    process.stdout.write(
      '{"type":"thread.started","thread_id":"thread-bad-exit"}\n' +
        '{"type":"turn.completed","usage":{}}\n',
    );
    const handle = await handlePromise;
    process.stderr.write("provider exited badly");
    process.finish(17);
    await expect(handle.result).resolves.toMatchObject({ status: "failed", exitCode: 17 });

    expect(() =>
      buildCodexResumeArgs("thread-1", {
        cwd: "/repo",
        prompt: "continue",
        extraArgs: ["--full-auto"],
      }),
    ).toThrow("Unsafe Codex argument");
    expect(() =>
      buildCodexResumeArgs("thread-1", {
        cwd: "/repo",
        prompt: "continue",
        extraArgs: ["--dangerously-bypass-approvals-and-sandbox=true"],
      }),
    ).toThrow("Unsafe Codex argument");
  });
});

describe("ClaudeAgentAdapter", () => {
  it("uses account auth and strips Claude credentials plus unrelated daemon secrets", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "anthropic-test-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("MODAL_TOKEN_SECRET", "modal-test-secret");
    const process = new FakeAgentProcess();
    const { calls, spawner } = fakeSpawner([process]);
    const pending = new ClaudeAgentAdapter({ spawner }).start({
      cwd: "/repo",
      prompt: "work",
      env: {
        ANTHROPIC_AUTH_TOKEN: "override-token",
        ANTHROPIC_API_KEY: "override-key",
      },
    });
    process.stdout.write('{"type":"system","subtype":"init","session_id":"session-env"}\n');
    const handle = await pending;
    process.stdout.write('{"type":"result","subtype":"success","result":"done"}\n');
    process.finish(0);
    await handle.result;

    expect(calls[0]?.options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(calls[0]?.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0]?.options.env.GEMINI_API_KEY).toBeUndefined();
    expect(calls[0]?.options.env.MODAL_TOKEN_SECRET).toBeUndefined();
  });

  it("captures the init session ID and emits partial stream-json text", async () => {
    const process = new FakeAgentProcess();
    const { calls, spawner } = fakeSpawner([process]);
    const adapter = new ClaudeAgentAdapter({ spawner });
    const handlePromise = adapter.resume("session-old", {
      cwd: "/repo",
      prompt: "Continue the fix",
    });

    process.stdout.write(
      '{"type":"system","subtype":"init","session_id":"session-old"}\n',
    );
    const handle = await handlePromise;
    const eventsPromise = collectEvents(handle.events);
    process.stdout.write(
      '{"type":"stream_event","session_id":"session-old","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel',
    );
    process.stdout.write('lo"}}}\n');
    process.stdout.write(
      '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"session-old"}\n',
    );
    process.finish(0);

    const events = await eventsPromise;
    expect(events.filter((event) => event.type === "message" && event.text === "hello"))
      .toEqual([
        expect.objectContaining({ type: "message", text: "hello", delta: true }),
        expect.objectContaining({ type: "message", text: "hello", delta: false }),
      ]);
    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      output: "hello",
    });
    expect(calls[0]?.args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      "--resume",
      "session-old",
    ]);
    expect(process.prompt).toBe("Continue the fix");
  });

  it("does not duplicate a terminal result already emitted as a complete message", async () => {
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const adapter = new ClaudeAgentAdapter({ spawner });
    const handlePromise = adapter.start({ cwd: "/repo", prompt: "Investigate checkout" });
    process.stdout.write('{"type":"system","subtype":"init","session_id":"session-dedup"}\n');
    const handle = await handlePromise;
    const eventsPromise = collectEvents(handle.events);
    process.stdout.write(`${JSON.stringify({
      type: "assistant",
      session_id: "session-dedup",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Investigation saved" }],
      },
    })}\n`);
    process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"Investigation saved","session_id":"session-dedup"}\n');
    process.finish(0);

    const events = await eventsPromise;
    expect(events.filter((event) =>
      event.type === "message" && event.text === "Investigation saved" && !event.delta
    )).toHaveLength(1);
    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      output: "Investigation saved",
    });
  });

  it("does not promote a failed terminal result into an assistant fact", async () => {
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const handlePromise = new ClaudeAgentAdapter({ spawner }).start({
      cwd: "/repo",
      prompt: "Investigate checkout",
    });
    process.stdout.write('{"type":"system","subtype":"init","session_id":"session-failed-result"}\n');
    const handle = await handlePromise;
    const eventsPromise = collectEvents(handle.events);
    process.stdout.write('{"type":"result","subtype":"error","is_error":true,"result":"Could not complete checkout","errors":["validation failed"],"session_id":"session-failed-result"}\n');
    process.finish(0);

    const events = await eventsPromise;
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      message: "validation failed",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "message",
      text: "Could not complete checkout",
      delta: false,
    }));
    await expect(handle.result).resolves.toMatchObject({
      status: "failed",
      output: "Could not complete checkout",
      error: "validation failed",
    });
  });

  it("materializes a terminal-only result into durable handoff knowledge", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-claude-terminal-memory-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    const now = new Date().toISOString();
    const task = DexTaskSchema.parse({
      id: "checkout-terminal-memory",
      projectId: "project-1",
      title: "checkout ordering",
      originalRequest: "investigate checkout ordering",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/checkout-terminal-memory",
      worktreePath: "/repo-worktree",
      status: "running",
      stage: "investigating",
      createdAt: now,
      updatedAt: now,
    });
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const handlePromise = new ClaudeAgentAdapter({ spawner }).start({
      cwd: task.worktreePath,
      prompt: task.originalRequest,
    });
    process.stdout.write('{"type":"system","subtype":"init","session_id":"session-memory"}\n');
    const handle = await handlePromise;
    const worker = WorkerSessionSchema.parse({
      id: handle.workerId,
      taskId: task.id,
      agent: "claude",
      target: { kind: "local", machineId: "mac-1" },
      status: "running",
      providerSessionId: handle.providerSessionId,
      startedAt: now,
    });
    await store.updateState((state) => {
      state.tasks[task.id] = task;
      state.workers[worker.id] = worker;
    });
    const continuity = new MemoryContinuity({ client: null, store });
    const observeEvents = (async () => {
      for await (const event of handle.events) {
        await continuity.observe(task, worker, event);
      }
    })();
    const terminalSummary = "Found the checkout ordering race. Failed approach: moving idempotency after charge creation caused duplicate charges. Next step: preserve the check before the external charge. Next step: add the webhook ordering regression test.";
    process.stdout.write(`${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: terminalSummary,
      session_id: "session-memory",
    })}\n`);
    process.finish(0);

    await observeEvents;
    await expect(handle.result).resolves.toMatchObject({ output: terminalSummary });
    const persisted = (await store.read()).tasks[task.id]?.metadata.taskKnowledge;
    expect(persisted).toMatchObject({
      learnedFacts: [terminalSummary],
      failedApproaches: [{
        approach: "moving idempotency after charge creation",
        reason: "caused duplicate charges",
        failed: true,
        shouldRetry: false,
      }],
      nextSteps: [
        "preserve the check before the external charge",
        "add the webhook ordering regression test",
      ],
    });
    const handoff = await createHandoff({
      taskId: task.id,
      goal: task.originalRequest,
      repository: { baseCommit: "abc123", workingBranch: task.dexBranch },
      taskKnowledge: persisted,
    }, { discoverMemory: false });
    expect(handoff.memories.some(({ narrative }) => narrative.includes("checkout ordering race")))
      .toBe(true);
    expect(handoff.failedApproaches).toContainEqual(expect.objectContaining({
      approach: "moving idempotency after charge creation",
      doNotRepeat: true,
    }));
  });

  it("keeps resume IDs as one argv entry", () => {
    const args = buildClaudeResumeArgs("id with spaces; echo nope", {
      cwd: "/repo",
      prompt: "continue",
    });
    expect(args.slice(-2)).toEqual(["--resume", "id with spaces; echo nope"]);
  });

  it("correlates failed tool results with the original Claude tool name", async () => {
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const adapter = new ClaudeAgentAdapter({ spawner });
    const handlePromise = adapter.start({ cwd: "/repo", prompt: "Investigate checkout" });
    process.stdout.write('{"type":"system","subtype":"init","session_id":"session-tools"}\n');
    const handle = await handlePromise;
    const eventsPromise = collectEvents(handle.events);
    process.stdout.write(`${JSON.stringify({
      type: "assistant",
      session_id: "session-tools",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "npm test -- checkout",
          input: {},
        }],
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: "user",
      session_id: "session-tools",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
          content: "The test deadlocked.",
        }],
      },
    })}\n`);
    process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"Investigation saved","session_id":"session-tools"}\n');
    process.finish(0);

    const events = await eventsPromise;
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool",
      id: "toolu_1",
      name: "npm test -- checkout",
      status: "failed",
      output: "The test deadlocked.",
    }));
    await expect(handle.result).resolves.toMatchObject({ status: "completed" });
  });
});

describe("agent lifecycle", () => {
  it("reports command availability without a shell", async () => {
    const process = new FakeAgentProcess();
    const { calls, spawner } = fakeSpawner([process]);
    queueMicrotask(() => process.finish(0));
    const adapter = new CodexAgentAdapter({ spawner });

    await expect(adapter.available()).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ command: "codex", args: ["--version"] });
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("times out a running worker and terminates it", async () => {
    vi.useFakeTimers();
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const adapter = new CodexAgentAdapter({ spawner });
    const handlePromise = adapter.start({ cwd: "/repo", prompt: "work", timeoutMs: 25 });
    process.stdout.write('{"type":"thread.started","thread_id":"thread-timeout"}\n');
    const handle = await handlePromise;

    await vi.advanceTimersByTimeAsync(25);
    await expect(handle.result).resolves.toMatchObject({ status: "timed_out" });
    expect(process.signals).toContain("SIGTERM");
  });

  it("honors AbortSignal and explicit stop", async () => {
    const first = new FakeAgentProcess();
    const second = new FakeAgentProcess();
    const { spawner } = fakeSpawner([first, second]);
    const adapter = new ClaudeAgentAdapter({ spawner });
    const abort = new AbortController();
    const firstPromise = adapter.start({
      cwd: "/repo",
      prompt: "work",
      signal: abort.signal,
    });
    first.stdout.write('{"type":"system","subtype":"init","session_id":"s1"}\n');
    const firstHandle = await firstPromise;
    abort.abort();
    await expect(firstHandle.result).resolves.toMatchObject({ status: "cancelled" });

    const secondPromise = adapter.start({ cwd: "/repo", prompt: "work" });
    second.stdout.write('{"type":"system","subtype":"init","session_id":"s2"}\n');
    const secondHandle = await secondPromise;
    await adapter.stop(secondHandle);
    await expect(secondHandle.result).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects stop when TERM and KILL produce no verifiable process exit", async () => {
    vi.useFakeTimers();
    const process = new FakeAgentProcess(false, null);
    const { spawner } = fakeSpawner([process]);
    const adapter = new CodexAgentAdapter({ spawner });
    const pending = adapter.start({
      cwd: "/repo",
      prompt: "work",
      stopGraceMs: 10,
    });
    process.stdout.write('{"type":"thread.started","thread_id":"thread-resistant"}\n');
    const handle = await pending;

    const stopping = handle.stop();
    const rejected = expect(stopping).rejects.toThrow(/termination could not be verified/i);
    await vi.advanceTimersByTimeAsync(1_011);

    await rejected;
    await expect(handle.result).resolves.toMatchObject({ status: "cancelled" });
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects startup when no provider ID arrives", async () => {
    vi.useFakeTimers();
    const process = new FakeAgentProcess();
    const { spawner } = fakeSpawner([process]);
    const adapter = new CodexAgentAdapter({ spawner });
    const handle = adapter.start({
      cwd: "/repo",
      prompt: "work",
      startupTimeoutMs: 10,
    });

    const rejected = expect(handle).rejects.toBeInstanceOf(AgentStartupTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
  });
});

describe("worker prompts", () => {
  it("carries continuity evidence and argv validation into a fresh worker", () => {
    const prompt = buildCodexWorkerPrompt({
      taskId: "checkout-1",
      goal: "Fix checkout",
      learnedFacts: ["The failing path uses the EU endpoint"],
      failedApproaches: ["Do not retry the legacy token refresh"],
      validationCommands: [["npm", "test", "--", "checkout flow"]],
    });

    expect(prompt).toContain("fresh Codex worker");
    expect(prompt).toContain("The failing path uses the EU endpoint");
    expect(prompt).toContain("Do not retry the legacy token refresh");
    expect(prompt).toContain('["npm","test","--","checkout flow"]');
  });
});
