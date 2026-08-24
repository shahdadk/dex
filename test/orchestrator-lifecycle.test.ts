import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentProvider,
  AgentResult,
  AgentRunOptions,
  AgentTerminalStatus,
} from "../src/agents/types.js";
import { DexConfigSchema } from "../src/config/config.js";
import { resolveDexPaths } from "../src/config/paths.js";
import { DexOrchestrator } from "../src/dex/orchestrator.js";
import { EventLog } from "../src/state/events.js";
import { DexProjectSchema, WorkerSessionSchema, type DexTask } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { TaskManager } from "../src/tasks/task-manager.js";
import { execFile } from "../src/utils/exec.js";

const roots: string[] = [];
const adapters: ControlledAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  })));
});

describe("DexOrchestrator durable worker lifecycle", () => {
  it("starts queued work as soon as capacity becomes available", async () => {
    const fixture = await createFixture(1);
    const reply = await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      { type: "CREATE_TASK", description: "add dark mode", preferredAgent: "codex" },
    ], fixture.context);

    expect(fixture.codex.runs).toHaveLength(1);
    expect(reply).toBe("");
    expect(fixture.notifications.slice(0, 2)).toEqual([
      "on it i'm handling all 2",
      "i'm starting a fresh codex session for auth right now",
    ]);
    expect(Object.values((await fixture.store.read()).tasks).map(({ status }) => status).sort()).toEqual(["queued", "running"]);

    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect(fixture.codex.runs).toHaveLength(2);
      expect(Object.values((await fixture.store.read()).tasks).map(({ status }) => status).sort()).toEqual(["completed", "running"]);
    });
  });

  it("keeps one task identity while changing from Codex to Claude", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;

    await fixture.orchestrator.handle([
      { type: "CHANGE_AGENT", taskQuery: "checkout", agent: "claude" },
    ], fixture.context);

    const state = await fixture.store.read();
    expect(Object.keys(state.tasks)).toEqual([original.id]);
    expect(state.tasks[original.id]).toMatchObject({ status: "running", preferredAgent: "claude" });
    expect(state.tasks[original.id]?.workerHistory).toHaveLength(2);
    expect(fixture.claude.runs).toHaveLength(1);
  });

  it("automatically resumes one crashed worker without losing the task", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;

    fixture.codex.finish(0, "failed", "provider connection closed");
    await eventually(async () => {
      expect(fixture.codex.runs).toHaveLength(2);
      const state = await fixture.store.read();
      expect(Object.keys(state.tasks)).toEqual([original.id]);
      expect(state.tasks[original.id]).toMatchObject({
        status: "running",
        metadata: { workerRecoveryAttempts: 1 },
      });
      expect(state.tasks[original.id]?.workerHistory).toHaveLength(2);
    });
    expect(fixture.codex.runs[1]?.resumedFrom).toBe(fixture.codex.runs[0]?.handle.providerSessionId);
  });

  it("recovers an interrupted local worker after daemon restart reconciliation", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "cancelled");
    await eventually(async () => {
      expect((await fixture.store.read()).workers[task.currentWorkerId!]?.status).toBe("stopped");
    });
    await fixture.store.updateState((state) => {
      const current = state.tasks[task.id]!;
      current.status = "failed";
      current.stage = "failed";
      current.metadata.interruptedByDaemonRestart = true;
    });

    await expect(fixture.orchestrator.recoverInterruptedTasks()).resolves.toBe(1);
    await eventually(async () => {
      expect(fixture.codex.runs).toHaveLength(2);
      expect((await fixture.store.read()).tasks[task.id]).toMatchObject({ status: "running" });
    });
    expect((await fixture.store.read()).tasks[task.id]?.metadata.interruptedByDaemonRestart).toBeUndefined();
  });

  it("honors a cloud execution preference without starting a local agent", async () => {
    const fixture = await createFixture(2, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex", executionPreference: "cloud" },
    ], fixture.context);

    expect(fixture.codex.runs).toHaveLength(0);
    expect(fixture.moved).toHaveLength(1);
    expect(fixture.moved[0]).toMatchObject({ title: "checkout", executionPreference: "cloud" });
    expect(Object.values((await fixture.store.read()).tasks)[0]).toMatchObject({ status: "running" });
  });

  it("lists normalized recent provider sessions without exposing transcript paths", async () => {
    const fixture = await createFixture(1, false, [{
      provider: "codex",
      sessionId: "thread-checkout",
      cwd: "/repo/checkout",
      updatedAt: "2026-08-23T12:00:00.000Z",
      summary: "Checkout webhook investigation",
      active: false,
      sourcePath: "/private/transcript.jsonl",
    }]);

    const reply = await fixture.orchestrator.handle([
      { type: "LIST_SESSIONS", provider: "codex", limit: 5 },
    ], fixture.context);

    expect(reply).toContain("codex · thread-checkout — Checkout webhook investigation");
    expect(reply).not.toContain("/private/transcript.jsonl");
  });

  it("adopts a discovered provider session as a durable task and resumes it", async () => {
    const fixture = await createFixture(1);

    const reply = await fixture.orchestrator.handle([{
      type: "ADOPT_SESSION",
      provider: "codex",
      sessionId: "thread-checkout",
      summary: "Checkout webhook investigation",
      cwd: "/repo/checkout",
      updatedAt: "2026-08-23T12:00:00.000Z",
      active: false,
    }], fixture.context);

    expect(reply).toContain("the task is durable now");
    expect(fixture.codex.runs).toHaveLength(1);
    expect(fixture.codex.runs[0]?.resumedFrom).toBe("thread-checkout");
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    expect(task).toMatchObject({
      status: "running",
      preferredAgent: "codex",
      metadata: {
        adoptedProviderSessionId: "thread-checkout",
        adoptedProvider: "codex",
        conversationId: "conversation-fixture",
      },
    });
    expect(fixture.notifications).toContain("i'm resuming the saved codex session for Checkout webhook investigation right now");
  });
});

class ControlledAdapter implements AgentAdapter {
  readonly provider: AgentProvider;
  readonly runs: ControlledRun[] = [];

  constructor(provider: AgentProvider) {
    this.provider = provider;
    adapters.push(this);
  }

  async available(): Promise<boolean> { return true; }
  async isAvailable(): Promise<boolean> { return true; }

  async start(_options: AgentRunOptions): Promise<AgentHandle> {
    return this.createRun();
  }

  async resume(providerSessionId: string, _options: AgentRunOptions): Promise<AgentHandle> {
    return this.createRun(providerSessionId);
  }

  async stop(handle: AgentHandle): Promise<void> {
    await handle.stop();
  }

  finish(index: number, status: AgentTerminalStatus, error?: string): void {
    this.runs[index]?.finish(status, error);
  }

  stopAll(): void {
    for (const run of this.runs) run.finish("cancelled");
  }

  private createRun(resumedFrom?: string): AgentHandle {
    const run = new ControlledRun(this.provider, this.runs.length + 1, resumedFrom);
    this.runs.push(run);
    return run.handle;
  }
}

class ControlledRun {
  readonly resumedFrom: string | undefined;
  readonly handle: AgentHandle;
  #resolve!: (result: AgentResult) => void;
  #finished = false;

  constructor(provider: AgentProvider, number: number, resumedFrom?: string) {
    this.resumedFrom = resumedFrom;
    const providerSessionId = `${provider}-session-${number}`;
    const workerId = `${provider}-process-${number}`;
    const startedAt = new Date().toISOString();
    const result = new Promise<AgentResult>((resolve) => { this.#resolve = resolve; });
    this.handle = {
      provider,
      workerId,
      providerSessionId,
      sessionId: providerSessionId,
      events: emptyEvents(),
      result,
      signal: new AbortController().signal,
      stop: async () => this.finish("cancelled"),
    };
    void startedAt;
  }

  finish(status: AgentTerminalStatus, error?: string): void {
    if (this.#finished) return;
    this.#finished = true;
    const timestamp = new Date().toISOString();
    this.#resolve({
      provider: this.handle.provider,
      workerId: this.handle.workerId,
      providerSessionId: this.handle.providerSessionId,
      status,
      exitCode: status === "completed" ? 0 : status === "cancelled" ? null : 1,
      signal: status === "cancelled" ? "SIGTERM" : null,
      output: status === "completed" ? "validated implementation" : "",
      ...(error ? { error } : {}),
      startedAt: timestamp,
      finishedAt: timestamp,
    });
  }
}

async function* emptyEvents(): AsyncIterable<AgentEvent> {
  // The controlled result promise drives the terminal state in these tests.
}

async function createFixture(
  maxConcurrency: number,
  cloud = false,
  discoveredSessions: Array<{
    provider: "claude" | "codex";
    sessionId: string;
    cwd?: string;
    updatedAt: string;
    summary?: string;
    active: boolean;
    sourcePath: string;
  }> = [],
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dex-orchestrator-"));
  roots.push(root);
  const repository = path.join(root, "repo");
  await execFile("git", ["init", "-b", "main", repository]);
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await execFile("git", ["-C", repository, "add", "README.md"]);
  await execFile("git", ["-C", repository, "-c", "user.name=Dex Tests", "-c", "user.email=dex@example.test", "commit", "-m", "fixture"]);
  const paths = resolveDexPaths(path.join(root, "dex-home"));
  const store = new DexStateStore(paths.state);
  const events = new EventLog(paths.events);
  const tasks = new TaskManager(store, events, paths);
  const project = DexProjectSchema.parse({
    id: "project-fixture",
    name: "fixture",
    path: repository,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  const codex = new ControlledAdapter("codex");
  const claude = new ControlledAdapter("claude");
  const moved: DexTask[] = [];
  const notifications: string[] = [];
  const orchestrator = new DexOrchestrator({
    store,
    events,
    tasks,
    paths,
    config: DexConfigSchema.parse({ maxConcurrency, deviceId: "device-fixture" }),
    project,
    agents: { codex, claude },
    discoverSessions: async (provider) => discoveredSessions.filter((session) =>
      provider === undefined || session.provider === provider),
    notify: async (_conversationId, text) => { notifications.push(text); },
    ...(cloud ? {
      mover: {
        moveToCloud: async (task: DexTask) => {
          moved.push(task);
          await tasks.transition(task.id, "checkpointing", { stage: "checkpointing" });
          await tasks.transition(task.id, "handoff", { stage: "handing_off" });
          const worker = WorkerSessionSchema.parse({
            id: `modal-${task.id}`,
            taskId: task.id,
            agent: "codex",
            target: { kind: "modal", sandboxId: `sandbox-${task.id}` },
            status: "running",
            startedAt: new Date().toISOString(),
          });
          await store.updateState((state) => {
            state.workers[worker.id] = worker;
            state.tasks[task.id]!.currentWorkerId = worker.id;
          });
          await tasks.transition(task.id, "running", { stage: "implementing" });
        },
      },
    } : {}),
  });
  return {
    orchestrator,
    store,
    codex,
    claude,
    moved,
    notifications,
    context: { conversationId: "conversation-fixture", messageId: "message-fixture" },
  };
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
