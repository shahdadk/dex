import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentProvider,
  AgentResult,
  AgentRunOptions,
  AgentTerminalStatus,
} from "../src/agents/types.js";
import { AgentTerminationUnverifiedError } from "../src/agents/process.js";
import { DexConfigSchema } from "../src/config/config.js";
import { resolveDexPaths } from "../src/config/paths.js";
import { DexOrchestrator } from "../src/dex/orchestrator.js";
import { EventLog } from "../src/state/events.js";
import { DexProjectSchema, WorkerSessionSchema, type AgentKind, type DexTask } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { TaskManager, type TaskPreparationOperations } from "../src/tasks/task-manager.js";
import { createWorktree } from "../src/tasks/worktree.js";
import { CodexAuthLeaseBusyError } from "../src/setup/modal-auth.js";
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
  it("durably acknowledges accepted work before delayed worktree preparation and fences worker startup", async () => {
    let releasePreparation!: () => void;
    let markPreparationStarted!: () => void;
    const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
    const preparationReleased = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const fixture = await createFixture(1, false, [], {
      createWorktree: async (repository, worktreesRoot, taskId) => {
        markPreparationStarted();
        await preparationReleased;
        return createWorktree(repository, worktreesRoot, taskId);
      },
    });

    const handling = fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    await preparationStarted;

    expect(fixture.notifications).toEqual(["on it"]);
    expect(fixture.codex.runs).toHaveLength(0);
    const accepted = Object.values((await fixture.store.read()).tasks);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      status: "queued",
      metadata: { preparationStatus: "pending", conversationId: fixture.context.conversationId },
    });

    // Even a concurrent queue drain must not start a worker against the
    // placeholder worktree path.
    await fixture.orchestrator.drainQueue(fixture.context.conversationId);
    expect(fixture.codex.runs).toHaveLength(0);

    releasePreparation();
    await handling;
    expect(fixture.codex.runs).toHaveLength(1);
    expect(Object.values((await fixture.store.read()).tasks)[0]).toMatchObject({
      status: "running",
      metadata: { preparationStatus: "ready" },
    });
  });

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

  it("keeps a local completion message durable when its immediate transport flush fails", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.failNextTransportFlush();
    fixture.codex.finish(0, "completed", undefined, "38 tests passing");

    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed");
    });
    await eventually(() => { expect(fixture.transportFlushAttempts()).toBe(1); });
    const state = await fixture.store.read();
    expect(state.pendingTransportEvents).toHaveLength(1);
    expect(state.pendingTransportEvents[0]).toMatchObject({
      id: state.tasks[task.id]?.metadata.terminalNotificationEventId,
      type: "message.sent",
      taskId: task.id,
      payload: { text: "checkout is done. 38 tests passing" },
    });
    expect(fixture.notifications).not.toContain("checkout is done. 38 tests passing");

    await fixture.flushTransport();
    expect((await fixture.store.read()).pendingTransportEvents).toEqual([]);
    expect(fixture.notifications).toContain("checkout is done. 38 tests passing");
  });

  it("queues exactly one final failure only after local recovery is exhausted", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;

    fixture.codex.finish(0, "failed", "provider disconnected");
    await eventually(() => { expect(fixture.codex.runs).toHaveLength(2); });
    expect(["preparing", "running"]).toContain((await fixture.store.read()).tasks[task.id]?.status);
    expect(fixture.notifications.some((message) => message.includes("checkout failed"))).toBe(false);

    fixture.failNextTransportFlush();
    fixture.codex.finish(1, "failed", "provider still unavailable");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]).toMatchObject({
        status: "failed",
        metadata: {
          localTerminalEffects: { phase: "notification_pending", kind: "work_failed" },
        },
      });
    });
    await eventually(() => { expect(fixture.transportFlushAttempts()).toBeGreaterThanOrEqual(1); });
    expect((await fixture.store.read()).pendingTransportEvents).toHaveLength(1);
    expect(fixture.notifications.filter((message) => message.includes("checkout failed"))).toHaveLength(0);

    await fixture.flushTransport();
    await fixture.flushTransport();
    expect(fixture.notifications.filter((message) => message.includes("checkout failed"))).toHaveLength(1);
  });

  it("starts three independent workers when configured for three-way concurrency", async () => {
    const fixture = await createFixture(3);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      { type: "CREATE_TASK", description: "investigate checkout", preferredAgent: "claude" },
      { type: "CREATE_TASK", description: "add dark mode", preferredAgent: "codex" },
    ], fixture.context);

    expect(fixture.codex.runs).toHaveLength(2);
    expect(fixture.claude.runs).toHaveLength(1);
    expect(Object.values((await fixture.store.read()).tasks).map(({ status }) => status)).toEqual([
      "running",
      "running",
      "running",
    ]);
  });

  it("stops every unfinished task in the current conversation", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      { type: "CREATE_TASK", description: "investigate checkout", preferredAgent: "claude" },
    ], fixture.context);

    const reply = await fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "everything" },
    ], fixture.context);

    expect(reply).toContain("auth is stopped");
    expect(reply).toContain("checkout is stopped");
    expect(Object.values((await fixture.store.read()).tasks).map(({ status }) => status))
      .toEqual(["cancelled", "cancelled"]);
  });

  it("moves every unfinished task in the current conversation toward cloud execution", async () => {
    const fixture = await createFixture(2, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      { type: "CREATE_TASK", description: "investigate checkout", preferredAgent: "claude" },
    ], fixture.context);

    const reply = await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "everything unfinished",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);

    expect(reply).toContain("auth is being handed to codex in the cloud");
    expect(reply).toContain("checkout is being handed to codex in the cloud");
    expect(Object.values((await fixture.store.read()).tasks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "auth", executionPreference: "cloud", preferredAgent: "codex" }),
      expect.objectContaining({ title: "checkout", executionPreference: "cloud", preferredAgent: "codex" }),
    ]));
    expect(fixture.moved).toHaveLength(2);
  });

  it("preserves a user's updated outcome on the same task during cloud handoff", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "investigate checkout", preferredAgent: "claude" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.claude.finish(0, "completed", undefined, "The ordering failure is understood.");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]?.status).toBe("completed");
    });

    await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
      instruction: "implement the recommended fix and run the regression test",
    }], fixture.context);

    expect(fixture.moved).toHaveLength(1);
    expect(fixture.moved[0]).toMatchObject({
      id: original.id,
      nextStep: "implement the recommended fix and run the regression test",
    });
    expect((await fixture.store.read()).tasks[original.id]).toMatchObject({
      id: original.id,
      nextStep: "implement the recommended fix and run the regression test",
      status: "running",
      executionPreference: "cloud",
    });
  });

  it("does not claim an updated outcome reached a task already running in Modal", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);

    const reply = await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
      instruction: "also add the duplicate-delivery regression test",
    }], fixture.context);

    expect(fixture.moved).toHaveLength(1);
    expect((await fixture.store.read()).tasks[original.id]).toMatchObject({
      id: original.id,
      status: "running",
    });
    expect((await fixture.store.read()).tasks[original.id]?.nextStep).toBeUndefined();
    expect(reply).toContain("can't change its outcome mid-run");
  });

  it("continues a multi-task cloud move when one target is already in Modal", async () => {
    const fixture = await createFixture(2, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      { type: "CREATE_TASK", description: "investigate checkout", preferredAgent: "claude" },
    ], fixture.context);
    await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "auth",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);

    const reply = await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "everything unfinished",
      destination: "cloud",
      preferredAgent: "codex",
      instruction: "implement the verified remediation",
    }], fixture.context);

    expect(fixture.moved).toHaveLength(2);
    const state = await fixture.store.read();
    const auth = Object.values(state.tasks).find((task) => task.title === "auth")!;
    const checkout = Object.values(state.tasks).find((task) => task.title === "checkout")!;
    expect(auth.nextStep).toBeUndefined();
    expect(checkout.nextStep).toBe("implement the verified remediation");
    expect(reply).toContain("auth is already running in the cloud");
    expect(reply).toContain("checkout is being handed to codex in the cloud");
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

  it("cancels an in-flight provider startup before stopping the durable task", async () => {
    const fixture = await createFixture(1);
    const release = fixture.codex.pauseNextStart();
    const creation = fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    await eventually(async () => {
      expect(Object.values((await fixture.store.read()).workers)).toContainEqual(
        expect.objectContaining({ status: "starting", agent: "codex" }),
      );
    });

    const reply = await fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context);
    release();
    await creation;

    const state = await fixture.store.read();
    expect(reply).toContain("checkout is stopped");
    expect(Object.values(state.tasks)[0]).toMatchObject({ status: "cancelled" });
    expect(Object.values(state.workers)).toContainEqual(expect.objectContaining({ status: "stopped" }));
    expect(fixture.codex.runs).toHaveLength(0);
  });

  it("cancels an in-flight startup before changing agents", async () => {
    const fixture = await createFixture(1);
    const release = fixture.codex.pauseNextStart();
    const creation = fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    await eventually(async () => {
      expect(Object.values((await fixture.store.read()).workers)).toContainEqual(
        expect.objectContaining({ status: "starting", agent: "codex" }),
      );
    });

    const reply = await fixture.orchestrator.handle([
      { type: "CHANGE_AGENT", taskQuery: "checkout", agent: "claude" },
    ], fixture.context);
    release();
    await creation;

    const state = await fixture.store.read();
    expect(reply).toContain("checkout work is continuing with claude");
    expect(state.tasks[Object.keys(state.tasks)[0]!]).toMatchObject({ status: "running", preferredAgent: "claude" });
    expect(Object.values(state.workers)).toContainEqual(expect.objectContaining({ status: "stopped", agent: "codex" }));
    expect(fixture.codex.runs).toHaveLength(0);
    expect(fixture.claude.runs).toHaveLength(1);
  });

  it("cancels an in-flight local startup before handing the same task to cloud", async () => {
    const fixture = await createFixture(1, true);
    const release = fixture.codex.pauseNextStart();
    const creation = fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    await eventually(async () => {
      expect(Object.values((await fixture.store.read()).workers)).toContainEqual(
        expect.objectContaining({ status: "starting", target: { kind: "local", machineId: "device-fixture" } }),
      );
    });

    const reply = await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);
    release();
    await creation;

    const state = await fixture.store.read();
    const task = Object.values(state.tasks)[0]!;
    expect(reply).toContain("checkout is being handed to codex in the cloud");
    expect(task).toMatchObject({ status: "running", executionPreference: "cloud" });
    expect(state.workers[task.currentWorkerId!]?.target).toMatchObject({ kind: "modal" });
    expect(Object.values(state.workers)).toContainEqual(expect.objectContaining({ status: "stopped", agent: "codex" }));
    expect(fixture.codex.runs).toHaveLength(0);
    expect(fixture.moved).toHaveLength(1);
  });

  it("does not start a battery handoff when local completion wins the exact-worker claim", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const before = Object.values((await fixture.store.read()).tasks)[0]!;
    const workerId = before.currentWorkerId!;
    const lifecycleGeneration = typeof before.metadata.lifecycleGeneration === "number"
      ? before.metadata.lifecycleGeneration
      : 0;

    fixture.codex.finish(0, "completed", undefined, "local validation passed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[before.id]?.status).toBe("completed");
    });

    await expect(fixture.orchestrator.moveCapturedLocalTaskToCloud({
      taskId: before.id,
      workerId,
      lifecycleGeneration,
    }, fixture.context)).resolves.toEqual({
      status: "local_completed",
      title: "checkout",
    });
    expect(fixture.moved).toHaveLength(0);
    expect((await fixture.store.read()).tasks[before.id]).toMatchObject({
      status: "completed",
      currentWorkerId: workerId,
    });
  });

  it("fences a racing local completion once the battery handoff claim wins", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const before = Object.values((await fixture.store.read()).tasks)[0]!;
    const workerId = before.currentWorkerId!;
    const lifecycleGeneration = typeof before.metadata.lifecycleGeneration === "number"
      ? before.metadata.lifecycleGeneration
      : 0;
    fixture.codex.completeOnStop(0, "local completion raced with handoff");
    const gate = fixture.pauseNextCloudMove();

    const moving = fixture.orchestrator.moveCapturedLocalTaskToCloud({
      taskId: before.id,
      workerId,
      lifecycleGeneration,
    }, fixture.context);
    await gate.started;

    const claimed = await fixture.store.read();
    expect(claimed.tasks[before.id]).toMatchObject({
      status: "checkpointing",
      currentWorkerId: workerId,
      metadata: { lifecycleGeneration: lifecycleGeneration + 1 },
    });
    expect(claimed.workers[workerId]).toMatchObject({ status: "completed" });
    expect(claimed.pendingTransportEvents).toEqual([]);
    expect(fixture.notifications).not.toContain("checkout is done. local completion raced with handoff");

    gate.release();
    await expect(moving).resolves.toEqual({ status: "started", title: "checkout" });
    const handedOff = await fixture.store.read();
    expect(fixture.moved).toHaveLength(1);
    expect(handedOff.tasks[before.id]).toMatchObject({ status: "running", executionPreference: "cloud" });
    expect(handedOff.workers[handedOff.tasks[before.id]!.currentWorkerId!]?.target)
      .toMatchObject({ kind: "modal" });
    expect(handedOff.pendingTransportEvents).toEqual([]);
  });

  it("holds one atomic capacity slot while a cloud handoff is being created", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const checkout = Object.values((await fixture.store.read()).tasks)[0]!;
    const gate = fixture.pauseNextCloudMove();
    const move = fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);
    await gate.started;

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ], fixture.context);
    const duringMove = await fixture.store.read();
    const auth = Object.values(duringMove.tasks).find((task) => task.id !== checkout.id)!;
    expect(auth).toMatchObject({ status: "queued" });
    expect(fixture.codex.runs).toHaveLength(1);
    expect(fixture.moved).toHaveLength(0);

    gate.release();
    await move;
    const completedMove = await fixture.store.read();
    expect(completedMove.tasks[checkout.id]).toMatchObject({ status: "running", executionPreference: "cloud" });
    expect(completedMove.workers[completedMove.tasks[checkout.id]!.currentWorkerId!]?.target).toMatchObject({ kind: "modal" });
    expect(completedMove.tasks[auth.id]).toMatchObject({ status: "queued" });
    expect(fixture.codex.runs).toHaveLength(1);
  });

  it("queues a direct cloud move when another task owns the only worker slot", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const state = await fixture.store.read();
    const auth = Object.values(state.tasks).find((task) => task.title === "auth")!;
    const checkout = Object.values(state.tasks).find((task) => task.title === "checkout")!;

    const reply = await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);

    expect(reply).toContain("checkout is queued to move to codex in the cloud");
    expect((await fixture.store.read()).tasks[checkout.id]).toMatchObject({
      status: "queued",
      executionPreference: "cloud",
      preferredAgent: "codex",
    });
    expect(fixture.moved).toHaveLength(0);

    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect(fixture.moved).toHaveLength(1);
      expect((await fixture.store.read()).tasks[checkout.id]).toMatchObject({ status: "running" });
    });
    expect((await fixture.store.read()).tasks[auth.id]).toMatchObject({ status: "completed" });
  });

  it("keeps cloud work queued when the shared account-auth lease is busy", async () => {
    const fixture = await createFixture(1, true);
    fixture.failNextCloudMove(new CodexAuthLeaseBusyError("checkout", "another-task"));

    await fixture.orchestrator.handle([{
      type: "CREATE_TASK",
      description: "fix checkout",
      preferredAgent: "codex",
      executionPreference: "cloud",
    }], fixture.context);

    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    expect(task).toMatchObject({ status: "queued", executionPreference: "cloud" });
    expect(fixture.moved).toHaveLength(0);

    await fixture.orchestrator.drainQueue(fixture.context.conversationId);
    expect((await fixture.store.read()).tasks[task.id]).toMatchObject({ status: "running" });
    expect(fixture.moved).toHaveLength(1);
  });

  it("automatically retries a cleanup-pending cloud-start failure without restarting the daemon", async () => {
    const fixture = await createFixture(1, true);
    fixture.failNextCloudMove(new Error("sandbox stopped but auth lease release failed"), true);

    await fixture.orchestrator.handle([{
      type: "CREATE_TASK",
      description: "fix checkout",
      preferredAgent: "codex",
      executionPreference: "cloud",
    }], fixture.context);

    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    await eventually(async () => {
      expect(fixture.recoveredHandoffs.filter(({ id }) => id === task.id)).toHaveLength(1);
      expect((await fixture.store.read()).tasks[task.id]?.metadata.modalHandoffJournal)
        .toMatchObject({ phase: "failed", cleanupPending: false });
    });
    expect(fixture.codex.runs).toHaveLength(0);
  });

  it("stops an owned Modal worker and resumes the same durable task in cloud", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([{
      type: "CREATE_TASK",
      description: "fix checkout",
      preferredAgent: "codex",
      executionPreference: "cloud",
    }], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    const firstWorkerId = original.currentWorkerId!;

    const stoppedReply = await fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context);
    let state = await fixture.store.read();
    expect(stoppedReply).toContain("checkout is stopped");
    expect(state.tasks[original.id]).toMatchObject({ status: "cancelled", executionPreference: "cloud" });
    expect(state.workers[firstWorkerId]).toMatchObject({ status: "stopped", target: { kind: "modal" } });

    const resumedReply = await fixture.orchestrator.handle([
      { type: "RESUME_TASK", taskQuery: "checkout" },
    ], fixture.context);
    state = await fixture.store.read();
    expect(resumedReply).toContain("checkout is running again");
    expect(state.tasks[original.id]).toMatchObject({ status: "running", executionPreference: "cloud" });
    expect(state.tasks[original.id]!.currentWorkerId).not.toBe(firstWorkerId);
    expect(state.workers[state.tasks[original.id]!.currentWorkerId!]?.target).toMatchObject({ kind: "modal" });
    expect(fixture.codex.runs).toHaveLength(0);
    expect(fixture.moved).toHaveLength(2);
  });

  it("does not cancel a task when Modal stop loses the worker ownership fence", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([{
      type: "CREATE_TASK",
      description: "fix checkout",
      preferredAgent: "codex",
      executionPreference: "cloud",
    }], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    const workerId = original.currentWorkerId!;
    fixture.rejectNextCloudStop();

    await expect(fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context)).rejects.toThrow(/changed workers/i);

    const state = await fixture.store.read();
    expect(state.tasks[original.id]).toMatchObject({ status: "running", currentWorkerId: workerId });
    expect(state.workers[workerId]).toMatchObject({ status: "running", target: { kind: "modal" } });
  });

  it("lets an explicit stop win while cloud startup is in flight", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    const gate = fixture.pauseNextCloudMove();
    const moving = fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);
    const movingOutcome = moving.then(
      () => undefined,
      (error: unknown) => error,
    );
    await gate.started;

    const stopped = await fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context);
    gate.release();
    const movingError = await movingOutcome;
    expect(movingError).toBeInstanceOf(Error);
    expect((movingError as Error).message).toMatch(/cancelled|abort/i);

    const state = await fixture.store.read();
    expect(stopped).toContain("checkout is stopped");
    expect(state.tasks[task.id]).toMatchObject({ status: "cancelled" });
    expect(fixture.moved).toHaveLength(0);
  });

  it("resolves an implicit follow-up to the unique active task in that conversation", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;

    await fixture.orchestrator.handle([
      { type: "CHANGE_AGENT", taskQuery: "it", agent: "claude" },
    ], fixture.context);

    const state = await fixture.store.read();
    expect(Object.keys(state.tasks)).toEqual([original.id]);
    expect(state.tasks[original.id]).toMatchObject({ status: "running", preferredAgent: "claude" });
    expect(fixture.claude.runs).toHaveLength(1);
  });

  it("never resolves an implicit pronoun to another conversation's task", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);

    await expect(fixture.orchestrator.handle([
      { type: "CHANGE_AGENT", taskQuery: "it", agent: "claude" },
    ], { conversationId: "different-conversation", messageId: "different-message" }))
      .rejects.toThrow(/couldn't find a task in this conversation/i);
    expect(fixture.claude.runs).toHaveLength(0);
    expect(fixture.codex.runs).toHaveLength(1);
  });

  it("has fresh Claude review completed Codex work read-only on the same durable task", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]?.status).toBe("completed");
    });

    const reply = await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);

    const reviewing = await fixture.store.read();
    expect(Object.keys(reviewing.tasks)).toEqual([original.id]);
    expect(reviewing.tasks[original.id]).toMatchObject({ status: "running", stage: "reviewing" });
    expect(reviewing.tasks[original.id]?.workerHistory).toHaveLength(2);
    expect(reply).toContain("claude is reviewing checkout after codex");
    expect(fixture.claude.runs).toHaveLength(1);
    const options = fixture.claude.runs[0]!.options as AgentRunOptions & {
      permissionMode?: string;
      extraArgs?: readonly string[];
    };
    expect(options.permissionMode).toBe("plan");
    expect(options.extraArgs).toEqual([
      "--safe-mode",
      "--settings", '{"disableAllHooks":true}',
      "--setting-sources", "",
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--tools", "Read,Grep,Glob,Bash",
      "--disallowedTools", "Edit", "Write", "NotebookEdit", "mcp__*",
      "--no-session-persistence",
      "--no-chrome",
    ]);
    expect(options.prompt).toContain("REVIEW-ONLY");
    expect(options.prompt).toContain("Do not edit, write, patch");
    expect(options.prompt).toContain("SOURCE WORKER:\ncodex");
    expect(options.prompt).toContain("USER'S ORIGINAL REQUEST:\nfix checkout");

    const fullReview = `P1 src/checkout.ts:42 preserves the ordering guard. ${"validated context ".repeat(20)}\nP2 test/checkout.test.ts:9 covers the regression.`;
    fixture.claude.finish(0, "completed", undefined, fullReview);
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]).toMatchObject({
        status: "completed",
        stage: "done",
        latestSummary: "validated implementation",
        metadata: {
          latestReview: {
            reviewer: "claude",
            sourceAgent: "codex",
            status: "completed",
            summary: fullReview,
          },
        },
      });
    });
    const fullResult = await fixture.orchestrator.handle([{
      type: "REVIEW_RESULT",
      taskQuery: "checkout",
    }], fixture.context);
    expect(fullResult).toBe(`claude review of checkout:\n${fullReview}`);
    await expect(fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "codex",
      sourceAgent: "claude",
      taskQuery: "checkout",
    }], fixture.context)).rejects.toThrow(/couldn't find claude work/i);
  });

  it("retains a long review and returns it as bounded ordered messages", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed"));
    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);
    const longReview = `P1 src/checkout.ts:42 ordering regression\n${"detailed review evidence ".repeat(800)}`;
    const retainedReview = longReview.trim();
    fixture.claude.finish(0, "completed", undefined, longReview);
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]?.metadata.latestReview).toMatchObject({ summary: retainedReview });
    });
    await eventually(() => {
      expect(fixture.notifications.some((message) => message.startsWith("checkout review is done."))).toBe(true);
    });
    const beforeRetrieval = fixture.notifications.length;

    const reply = await fixture.orchestrator.handle([{
      type: "REVIEW_RESULT",
      taskQuery: "checkout",
    }], fixture.context);

    const chunks = fixture.notifications.slice(beforeRetrieval);
    expect(reply).toBe("");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((message) => message.length < 7_900)).toBe(true);
    expect(chunks[0]).toContain(`claude review of checkout (1/${chunks.length})`);
    expect(chunks.at(-1)).toContain(`checkout review continued (${chunks.length}/${chunks.length})`);
    expect(chunks.map((message) => message.replace(/^.*?:\n/s, "")).join(" ").replace(/\s+/g, " ").trim())
      .toBe(retainedReview.replace(/\s+/g, " ").trim());
  });

  it("caps pathological review output with a verifiable truncation marker", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed"));
    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);
    fixture.claude.finish(0, "completed", undefined, `P1 checkout regression\n${"evidence ".repeat(30_000)}`);

    await eventually(async () => {
      const review = (await fixture.store.read()).tasks[task.id]?.metadata.latestReview as { summary?: string } | undefined;
      expect(review?.summary?.length).toBeLessThanOrEqual(48_000);
      expect(review?.summary).toMatch(/Dex retained the first .*sha256 [a-f0-9]{16}/);
      expect(fixture.notifications.some((message) => message.includes("checkout review is done"))).toBe(true);
    });
    const before = fixture.notifications.length;
    await fixture.orchestrator.handle([{ type: "REVIEW_RESULT", taskQuery: "checkout" }], fixture.context);
    expect(fixture.notifications.slice(before)).toHaveLength(7);
  });

  it("does not restore review state twice when natural completion wins a stop race", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed"));
    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);
    fixture.claude.completeOnStop(0, "no material findings");

    await expect(fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context)).resolves.toBe("");

    expect((await fixture.store.read()).tasks[task.id]).toMatchObject({
      status: "completed",
      stage: "done",
      metadata: { latestReview: { status: "completed", summary: "no material findings" } },
    });
    expect(fixture.notifications.filter((message) => message.includes("review is done"))).toHaveLength(1);
  });

  it("queues a review at capacity then resumes it read-only instead of using the task's cloud preference", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]?.status).toBe("completed");
    });
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ], fixture.context);
    const auth = Object.values((await fixture.store.read()).tasks).find((task) => task.id !== original.id)!;
    await fixture.store.updateState((state) => {
      state.tasks[original.id]!.executionPreference = "cloud";
      state.tasks[original.id]!.metadata.adoptedProviderSessionId = "source-implementation-session";
    });

    const reply = await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      taskQuery: "checkout",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);

    expect(reply).toContain("queued behind the active work");
    expect(fixture.claude.runs).toHaveLength(0);
    expect((await fixture.store.read()).tasks[original.id]).toMatchObject({ status: "queued", stage: "queued" });

    fixture.codex.finish(1, "completed");
    await eventually(async () => {
      expect(fixture.claude.runs).toHaveLength(1);
      expect((await fixture.store.read()).tasks[original.id]).toMatchObject({
        status: "running",
        stage: "reviewing",
      });
    });
    const options = fixture.claude.runs[0]!.options as AgentRunOptions & { permissionMode?: string };
    expect(fixture.claude.runs[0]?.resumedFrom).toBeUndefined();
    expect(options.permissionMode).toBe("plan");
    expect(options.prompt).toContain("REVIEW-ONLY");
    expect((await fixture.store.read()).tasks[auth.id]?.status).toBe("completed");
  });

  it("restores the implementation outcome when review succeeds or exhausts recovery", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]?.status).toBe("completed");
    });

    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);
    fixture.claude.finish(0, "failed", "review provider disconnected");
    await eventually(() => {
      expect(fixture.claude.runs).toHaveLength(2);
    });
    fixture.claude.finish(1, "failed", "review provider still unavailable");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]).toMatchObject({
        status: "completed",
        stage: "done",
        latestSummary: "validated implementation",
        metadata: {
          activeWorkerPurpose: "review",
          reviewer: "claude",
          latestReview: { status: "failed" },
        },
      });
    });

    await fixture.orchestrator.handle([
      { type: "RESUME_TASK", taskQuery: "checkout" },
    ], fixture.context);

    expect(fixture.claude.runs).toHaveLength(3);
    const resumed = fixture.claude.runs[2]!.options as AgentRunOptions & { permissionMode?: string };
    expect(resumed.permissionMode).toBe("plan");
    expect(resumed.prompt).toContain("REVIEW-ONLY");
  });

  it("does not turn a failed implementation into a completed task when its review succeeds", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const original = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]?.status).toBe("completed");
    });
    await fixture.store.updateState((state) => {
      const task = state.tasks[original.id]!;
      task.status = "failed";
      task.stage = "failed";
      task.latestSummary = "implementation validation failed";
      task.blockedReason = "regression test failed";
    });

    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);
    fixture.claude.finish(0, "completed", undefined, "P1 src/checkout.ts:42 still fails the regression");

    await eventually(async () => {
      expect((await fixture.store.read()).tasks[original.id]).toMatchObject({
        status: "failed",
        stage: "failed",
        latestSummary: "implementation validation failed",
        blockedReason: "regression test failed",
        metadata: { latestReview: { status: "completed" } },
      });
    });
  });

  it("clears review-only state before moving the durable implementation to cloud", async () => {
    const fixture = await createFixture(2, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed");
    });
    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);

    await fixture.orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: "checkout",
      destination: "cloud",
      preferredAgent: "codex",
    }], fixture.context);

    expect(fixture.moved).toHaveLength(1);
    expect(fixture.moved[0]?.metadata).not.toHaveProperty("reviewBaseOutcome");
    const moved = (await fixture.store.read()).tasks[task.id]!;
    expect(moved.status).toBe("running");
    expect(moved.metadata).not.toHaveProperty("activeWorkerPurpose");
    expect(moved.metadata).not.toHaveProperty("reviewBaseOutcome");
    expect(moved.metadata).not.toHaveProperty("reviewer");
    expect(moved.metadata).not.toHaveProperty("reviewSourceAgent");
  });

  it("restarts an interrupted review without letting stale review state overwrite implementation outcome", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed", undefined, "implementation stays complete");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed");
    });
    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);

    await fixture.orchestrator.handle([{
      type: "CHANGE_AGENT",
      taskQuery: "checkout",
      agent: "claude",
    }], fixture.context);

    expect(fixture.claude.runs).toHaveLength(2);
    expect(fixture.claude.runs[1]?.resumedFrom).toBeUndefined();
    fixture.claude.finish(1, "completed", undefined, "no material findings");
    await eventually(async () => {
      const latest = (await fixture.store.read()).tasks[task.id]!;
      expect(latest).toMatchObject({
        status: "completed",
        latestSummary: "implementation stays complete",
        metadata: { latestReview: { summary: "no material findings" } },
      });
      expect(latest.metadata).not.toHaveProperty("reviewBaseOutcome");
      expect(latest.metadata).not.toHaveProperty("activeWorkerPurpose");
    });
  });

  it("never resumes a review-only provider session as an implementation worker", async () => {
    const fixture = await createFixture(2);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "investigate checkout", preferredAgent: "claude" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.claude.finish(0, "completed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed");
    });
    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "codex",
      sourceAgent: "claude",
    }], fixture.context);
    const reviewSessionId = fixture.codex.runs[0]!.handle.providerSessionId;
    fixture.codex.finish(0, "completed", undefined, "review complete");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]?.status).toBe("completed");
    });
    await fixture.store.updateState((state) => {
      const current = state.tasks[task.id]!;
      current.status = "failed";
      current.stage = "failed";
      current.preferredAgent = "codex";
      current.latestSummary = "implementation needs another pass";
    });

    await fixture.orchestrator.handle([
      { type: "RESUME_TASK", taskQuery: "checkout" },
    ], fixture.context);

    expect(fixture.codex.runs).toHaveLength(2);
    expect(fixture.codex.runs[1]?.resumedFrom).toBeUndefined();
    expect(fixture.codex.runs[1]?.resumedFrom).not.toBe(reviewSessionId);
    expect(fixture.codex.runs[1]?.options.prompt).not.toContain("REVIEW-ONLY");
  });

  it("reserves startup capacity atomically across concurrent resume requests", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      { type: "CREATE_TASK", description: "add dark mode", preferredAgent: "codex" },
    ], fixture.context);
    fixture.codex.finish(0, "completed");
    await eventually(() => expect(fixture.codex.runs).toHaveLength(2));
    fixture.codex.finish(1, "completed");
    await eventually(async () => {
      expect(Object.values((await fixture.store.read()).tasks).every((task) => task.status === "completed")).toBe(true);
    });
    await fixture.store.updateState((state) => {
      for (const task of Object.values(state.tasks)) {
        task.status = "failed";
        task.stage = "failed";
      }
    });
    const release = fixture.codex.pauseNextStart();
    const authResume = fixture.orchestrator.handle([
      { type: "RESUME_TASK", taskQuery: "auth" },
    ], fixture.context);
    await eventually(async () => {
      expect(Object.values((await fixture.store.read()).workers).some((worker) => worker.status === "starting")).toBe(true);
    });

    const darkResume = fixture.orchestrator.handle([
      { type: "RESUME_TASK", taskQuery: "dark mode" },
    ], fixture.context);
    await darkResume;
    const duringStartup = await fixture.store.read();
    expect(Object.values(duringStartup.tasks).map((task) => task.status).sort()).toEqual(["preparing", "queued"]);
    release();
    await authResume;
    expect(fixture.codex.runs).toHaveLength(3);
    expect(Object.values((await fixture.store.read()).tasks).map((task) => task.status).sort()).toEqual(["queued", "running"]);
  });

  it("never queues completed implementation work merely because capacity is full", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const checkout = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => expect((await fixture.store.read()).tasks[checkout.id]?.status).toBe("completed"));
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ], fixture.context);

    await expect(fixture.orchestrator.handle([
      { type: "RESUME_TASK", taskQuery: "checkout" },
    ], fixture.context)).rejects.toThrow(/already complete/i);

    expect((await fixture.store.read()).tasks[checkout.id]).toMatchObject({ status: "completed", stage: "done" });
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

    fixture.codex.finish(1, "completed");
    await eventually(async () => {
      const task = (await fixture.store.read()).tasks[original.id];
      expect(task?.status).toBe("completed");
      expect(task?.metadata.workerRecoveryAttempts).toBeUndefined();
    });
  });

  it("never lets automatic recovery undo an explicit stop", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    const releaseRecovery = fixture.codex.pauseNextStart();
    fixture.codex.finish(0, "failed", "provider connection closed");
    await eventually(async () => {
      expect(Object.values((await fixture.store.read()).workers)).toContainEqual(
        expect.objectContaining({ taskId: task.id, status: "starting" }),
      );
    });

    const stopped = await fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context);
    releaseRecovery();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const state = await fixture.store.read();
    expect(stopped).toContain("checkout is stopped");
    expect(state.tasks[task.id]).toMatchObject({ status: "cancelled", latestSummary: "stopped at your request" });
    expect(fixture.codex.runs).toHaveLength(1);
  });

  it("rejects resume without invalidating an in-flight automatic recovery", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    const releaseRecovery = fixture.codex.pauseNextStart();
    fixture.codex.finish(0, "failed", "provider connection closed");
    await eventually(async () => {
      expect(Object.values((await fixture.store.read()).workers)).toContainEqual(
        expect.objectContaining({ taskId: task.id, status: "starting" }),
      );
    });
    const generationBeforeResume = (await fixture.store.read()).tasks[task.id]!.metadata.lifecycleGeneration;

    await expect(fixture.orchestrator.handle([
      { type: "RESUME_TASK", taskQuery: "checkout" },
    ], fixture.context)).rejects.toThrow(/already has an active worker/i);
    expect((await fixture.store.read()).tasks[task.id]!.metadata.lifecycleGeneration)
      .toBe(generationBeforeResume);

    releaseRecovery();
    await eventually(async () => {
      expect(fixture.codex.runs).toHaveLength(2);
      expect((await fixture.store.read()).tasks[task.id]).toMatchObject({ status: "running" });
    });
  });

  it("replaces one worker that fails before returning a provider handle", async () => {
    const fixture = await createFixture(1);
    fixture.codex.failNextStart();

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);

    expect(fixture.codex.runs).toHaveLength(1);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    expect(task).toMatchObject({
      status: "running",
      metadata: { workerRecoveryAttempts: 1 },
    });
    expect(task.workerHistory).toHaveLength(2);
  });

  it("atomically queues one startup failure after both startup attempts fail", async () => {
    const fixture = await createFixture(1);
    fixture.codex.failNextStart();
    fixture.codex.failNextStart();
    fixture.failNextTransportFlush();
    fixture.failNextTransportFlush();

    await expect(fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context)).resolves.toBe("");

    const state = await fixture.store.read();
    const task = Object.values(state.tasks)[0]!;
    expect(task).toMatchObject({
      status: "failed",
      metadata: {
        localTerminalEffects: { phase: "notification_pending", kind: "startup_failed" },
      },
    });
    expect(state.pendingTransportEvents).toHaveLength(1);
    expect(fixture.notifications.filter((message) => message.includes("couldn't start"))).toHaveLength(0);

    await fixture.flushTransport();
    expect(fixture.notifications.filter((message) => message.includes("couldn't start"))).toHaveLength(1);
  });

  it("retains startup capacity when a pre-handle process cannot be proven dead", async () => {
    const fixture = await createFixture(1);
    fixture.codex.rejectNextStart(new AgentTerminationUnverifiedError(
      "startup timed out and the process group is still alive",
    ));

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);

    let state = await fixture.store.read();
    const checkout = Object.values(state.tasks)[0]!;
    expect(fixture.codex.runs).toHaveLength(0);
    expect(checkout).toMatchObject({ status: "preparing", stage: "implementing" });
    expect(state.workers[checkout.currentWorkerId!]).toMatchObject({
      status: "starting",
      lastMessage: "startup timed out and the process group is still alive",
    });

    const generation = checkout.metadata.lifecycleGeneration;
    await expect(fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context)).rejects.toThrow(/fenced starting process.*termination is unverified/i);
    state = await fixture.store.read();
    expect(state.tasks[checkout.id]).toMatchObject({
      status: "preparing",
      stage: "implementing",
      currentWorkerId: checkout.currentWorkerId,
    });
    expect(state.tasks[checkout.id]?.metadata.lifecycleGeneration).toBe(generation);
    expect(state.workers[checkout.currentWorkerId!]).toMatchObject({ status: "starting" });

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ], fixture.context);

    state = await fixture.store.read();
    expect(fixture.codex.runs).toHaveLength(0);
    expect(Object.values(state.tasks).map(({ status }) => status).sort())
      .toEqual(["preparing", "queued"]);
    expect(fixture.notifications).toContain(
      "checkout needs attention. its worker could not be proven stopped, so i'm keeping the task fenced.",
    );
  });

  it("stops a provider handle when durable activation fails after startup", async () => {
    const fixture = await createFixture(1);
    const append = fixture.events.append.bind(fixture.events);
    let rejectedActivation = false;
    vi.spyOn(fixture.events, "append").mockImplementation(async (event) => {
      if (!rejectedActivation && event.type === "worker.started") {
        rejectedActivation = true;
        throw new Error("durable worker-start event unavailable");
      }
      return append(event);
    });

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);

    expect(rejectedActivation).toBe(true);
    expect(fixture.codex.runs).toHaveLength(2);
    await expect(fixture.codex.runs[0]!.handle.result).resolves.toMatchObject({ status: "cancelled" });
    expect(Object.values((await fixture.store.read()).tasks)[0]).toMatchObject({ status: "running" });
  });

  it("fences a live provider when durable activation fails and termination is unverified", async () => {
    const fixture = await createFixture(1);
    fixture.codex.rejectNextStop();
    const append = fixture.events.append.bind(fixture.events);
    let rejectedActivation = false;
    vi.spyOn(fixture.events, "append").mockImplementation(async (event) => {
      if (!rejectedActivation && event.type === "worker.started") {
        rejectedActivation = true;
        throw new Error("durable worker-start event unavailable");
      }
      return append(event);
    });

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);

    const state = await fixture.store.read();
    const checkout = Object.values(state.tasks)[0]!;
    expect(rejectedActivation).toBe(true);
    expect(fixture.codex.runs).toHaveLength(1);
    expect(checkout).toMatchObject({ status: "running" });
    expect(state.workers[checkout.currentWorkerId!]).toMatchObject({ status: "running" });
    expect(fixture.notifications).toContain(
      "checkout needs attention. its worker could not be proven stopped, so i'm keeping the task fenced.",
    );

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ], fixture.context);
    expect(fixture.codex.runs).toHaveLength(1);
    expect(Object.values((await fixture.store.read()).tasks).map(({ status }) => status).sort())
      .toEqual(["queued", "running"]);
  });

  it.each(["event append", "state update"] as const)(
    "keeps ownership fenced when a supervision %s failure cannot stop the live worker",
    async (failurePoint) => {
      const fixture = await createFixture(1);
      await fixture.orchestrator.handle([
        { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
      ], fixture.context);
      const task = Object.values((await fixture.store.read()).tasks)[0]!;
      const workerId = task.currentWorkerId!;
      fixture.codex.rejectStop(0);

      if (failurePoint === "event append") {
        const append = fixture.events.append.bind(fixture.events);
        let rejected = false;
        vi.spyOn(fixture.events, "append").mockImplementation(async (event) => {
          if (!rejected && event.type === "worker.output") {
            rejected = true;
            throw new Error("durable event log unavailable");
          }
          return append(event);
        });
      } else {
        vi.spyOn(fixture.store, "updateState")
          .mockRejectedValueOnce(new Error("durable state unavailable"));
      }

      fixture.codex.emitMessage(0, "still implementing checkout");
      await eventually(() => {
        expect(fixture.notifications).toContain(
          "checkout needs attention. i lost durable supervision, but i'm keeping its worker fenced so nothing else can run over it.",
        );
      });

      const afterFailure = await fixture.store.read();
      expect(fixture.codex.runs).toHaveLength(1);
      expect(afterFailure.tasks[task.id]).toMatchObject({
        status: "running",
        currentWorkerId: workerId,
      });
      expect(afterFailure.workers[workerId]).toMatchObject({ status: "running" });

      await fixture.orchestrator.handle([
        { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
      ], fixture.context);
      expect(fixture.codex.runs).toHaveLength(1);
      expect(Object.values((await fixture.store.read()).tasks).map(({ status }) => status).sort())
        .toEqual(["queued", "running"]);
    },
  );

  it("atomically queues supervision failure after the provider is proven stopped", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    const append = fixture.events.append.bind(fixture.events);
    let rejected = false;
    vi.spyOn(fixture.events, "append").mockImplementation(async (event) => {
      if (!rejected && event.type === "worker.output") {
        rejected = true;
        throw new Error("durable event log unavailable");
      }
      return append(event);
    });
    fixture.failNextTransportFlush();

    fixture.codex.emitMessage(0, "still implementing checkout");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[task.id]).toMatchObject({
        status: "failed",
        metadata: {
          localTerminalEffects: { phase: "notification_pending", kind: "supervision_failed" },
        },
      });
    });
    await eventually(() => { expect(fixture.transportFlushAttempts()).toBeGreaterThanOrEqual(1); });

    expect((await fixture.store.read()).pendingTransportEvents).toHaveLength(1);
    expect(fixture.notifications.filter((message) => message.includes("checkout failed"))).toHaveLength(0);
    await fixture.flushTransport();
    await fixture.flushTransport();
    expect(fixture.notifications.filter((message) => message.includes("checkout failed"))).toHaveLength(1);
  });

  it("rejects explicit stop without releasing the slot when termination is unverified", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    const generation = task.metadata.lifecycleGeneration;
    const workerId = task.currentWorkerId!;
    fixture.codex.rejectStop(0, "TERM and KILL did not stop the process group");

    await expect(fixture.orchestrator.handle([
      { type: "STOP_TASK", taskQuery: "checkout" },
    ], fixture.context)).rejects.toThrow(/TERM and KILL did not stop/i);

    const state = await fixture.store.read();
    expect(state.tasks[task.id]).toMatchObject({
      status: "running",
      currentWorkerId: workerId,
    });
    expect(state.tasks[task.id]?.metadata.lifecycleGeneration).toBe(generation);
    expect(state.workers[workerId]).toMatchObject({ status: "running" });
    expect(fixture.codex.runs).toHaveLength(1);

    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ], fixture.context);
    expect(fixture.codex.runs).toHaveLength(1);
    expect(Object.values((await fixture.store.read()).tasks).map(({ status }) => status).sort())
      .toEqual(["queued", "running"]);
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
      current.metadata.workerRecoveryAttempts = 1;
    });

    await expect(fixture.orchestrator.recoverInterruptedTasks()).resolves.toBe(1);
    await eventually(async () => {
      expect(fixture.codex.runs).toHaveLength(2);
      expect((await fixture.store.read()).tasks[task.id]).toMatchObject({ status: "running" });
    });
    expect((await fixture.store.read()).tasks[task.id]?.metadata.interruptedByDaemonRestart).toBeUndefined();
  });

  it("queues recovery when another worker atomically wins capacity after the recovery precheck", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const checkout = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "cancelled");
    await eventually(async () => {
      expect((await fixture.store.read()).workers[checkout.currentWorkerId!]?.status).toBe("stopped");
    });
    await fixture.store.updateState((state) => {
      const task = state.tasks[checkout.id]!;
      task.status = "failed";
      task.stage = "failed";
      task.metadata.interruptedByDaemonRestart = true;
    });
    const updateState = fixture.store.updateState.bind(fixture.store);
    let injectedCompetitor = false;
    vi.spyOn(fixture.store, "updateState").mockImplementation(async (mutator) => {
      const result = await updateState(mutator);
      const current = (await fixture.store.read()).tasks[checkout.id];
      if (!injectedCompetitor && current?.metadata.workerRecoveryAttempts === 1) {
        injectedCompetitor = true;
        await fixture.orchestrator.handle([
          { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
        ], fixture.context);
      }
      return result;
    });

    await expect(fixture.orchestrator.recoverInterruptedTasks()).resolves.toBe(1);

    const state = await fixture.store.read();
    const auth = Object.values(state.tasks).find((task) => task.id !== checkout.id)!;
    expect(injectedCompetitor).toBe(true);
    expect(auth).toMatchObject({ status: "running" });
    expect(state.tasks[checkout.id]).toMatchObject({
      status: "queued",
      latestSummary: "queued to continue recovery",
      metadata: { interruptedByDaemonRestart: true },
    });
    expect(state.tasks[checkout.id]?.metadata.workerRecoveryAttempts).toBeUndefined();
    expect(fixture.codex.runs).toHaveLength(2);
  });

  it("queues an interrupted review at capacity without changing implementation ownership", async () => {
    const fixture = await createFixture(1);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const checkout = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "completed");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[checkout.id]?.status).toBe("completed");
    });
    await fixture.orchestrator.handle([{
      type: "REVIEW_TASK",
      reviewer: "claude",
      sourceAgent: "codex",
    }], fixture.context);
    fixture.claude.finish(0, "cancelled");
    await eventually(async () => {
      expect((await fixture.store.read()).tasks[checkout.id]).toMatchObject({
        status: "completed",
        metadata: { latestReview: { status: "cancelled" } },
      });
    });
    await fixture.store.updateState((state) => {
      const task = state.tasks[checkout.id]!;
      task.status = "failed";
      task.stage = "failed";
      task.metadata.interruptedByDaemonRestart = true;
      task.metadata.activeWorkerPurpose = "review";
      task.metadata.reviewer = "claude";
      task.metadata.reviewSourceAgent = "codex";
      task.metadata.reviewBaseOutcome = {
        status: "completed",
        stage: "done",
        latestSummary: "validated implementation",
      };
    });
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ], fixture.context);

    await expect(fixture.orchestrator.recoverInterruptedTasks()).resolves.toBe(0);

    const queued = (await fixture.store.read()).tasks[checkout.id]!;
    expect(queued).toMatchObject({
      status: "queued",
      preferredAgent: "codex",
      metadata: {
        activeWorkerPurpose: "review",
        reviewer: "claude",
        reviewSourceAgent: "codex",
      },
    });
    expect(queued.metadata.adoptedProvider).not.toBe("claude");
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

  it("reconciles an interrupted handoff through the mover without starting a duplicate local worker", async () => {
    const fixture = await createFixture(1, true);
    await fixture.orchestrator.handle([
      { type: "CREATE_TASK", description: "fix checkout", preferredAgent: "codex" },
    ], fixture.context);
    const task = Object.values((await fixture.store.read()).tasks)[0]!;
    fixture.codex.finish(0, "cancelled");
    await eventually(async () => {
      expect((await fixture.store.read()).workers[task.currentWorkerId!]?.status).toBe("stopped");
    });
    await fixture.tasks.transition(task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(task.id, "handoff", { stage: "handing_off" });

    await expect(fixture.orchestrator.recoverInterruptedTasks()).resolves.toBe(1);

    expect(fixture.recoveredHandoffs).toHaveLength(1);
    expect(fixture.recoveredHandoffs[0]?.id).toBe(task.id);
    expect(fixture.codex.runs).toHaveLength(1);
    expect((await fixture.store.read()).tasks[task.id]?.status).toBe("running");
  });

  it.each(["running", "cancelled", "failed"] as const)(
    "retries cleanup-pending Modal journals for a %s task in the same daemon",
    async (status) => {
      const fixture = await createFixture(1, true);
      const [task] = await fixture.tasks.createTasks([{
        description: `recover ${status} checkout`,
        project: fixture.project,
        preferredAgent: "codex",
      }]);
      await fixture.store.updateState((state) => {
        const current = state.tasks[task!.id]!;
        current.status = status;
        current.stage = status === "running" ? "implementing" : "failed";
        current.metadata.modalHandoffJournal = {
          version: 1,
          phase: status === "cancelled" ? "stopped" : "failed",
          cleanupPending: true,
        };
      });
      fixture.failNextHandoffRecovery();

      await expect(fixture.orchestrator.recoverInterruptedTasks()).resolves.toBe(0);

      await eventually(async () => {
        expect(fixture.recoveredHandoffs.filter(({ id }) => id === task!.id)).toHaveLength(2);
        expect((await fixture.store.read()).tasks[task!.id]?.metadata.modalHandoffJournal)
          .toMatchObject({ cleanupPending: false });
      });
      expect(fixture.codex.runs).toHaveLength(0);
    },
  );

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

  it("adopts an ordinal follow-up from the last bounded session list", async () => {
    const sessions: Array<{
      provider: "claude" | "codex";
      sessionId: string;
      cwd?: string;
      updatedAt: string;
      summary?: string;
      active: boolean;
      sourcePath: string;
    }> = [];
    const fixture = await createFixture(1, false, sessions);
    sessions.push(
      {
        provider: "codex",
        sessionId: "thread-auth",
        cwd: fixture.project.path,
        updatedAt: "2026-08-23T13:00:00.000Z",
        summary: "Auth implementation",
        active: false,
        sourcePath: "/private/auth.jsonl",
      },
      {
        provider: "claude",
        sessionId: "session-checkout",
        cwd: fixture.project.path,
        updatedAt: "2026-08-23T12:00:00.000Z",
        summary: "Checkout investigation",
        active: false,
        sourcePath: "/private/checkout.jsonl",
      },
    );

    await fixture.orchestrator.handle([{ type: "LIST_SESSIONS", limit: 5 }], fixture.context);
    const reply = await fixture.orchestrator.handle([
      { type: "ADOPT_LISTED_SESSION", ordinal: 2 },
    ], fixture.context);

    expect(reply).toContain("i adopted that claude session as Checkout investigation");
    expect(fixture.claude.runs).toHaveLength(1);
    expect(fixture.claude.runs[0]?.resumedFrom).toBe("session-checkout");
    const state = await fixture.store.read();
    expect(Object.values(state.tasks)).toHaveLength(1);
    expect(state.pendingSessionSelections).toEqual({});
  });

  it("revalidates an ordinal session before adoption instead of trusting stale list state", async () => {
    const sessions = [{
      provider: "codex" as const,
      sessionId: "thread-checkout",
      cwd: "",
      updatedAt: "2026-08-23T12:00:00.000Z",
      summary: "Checkout implementation",
      active: false,
      sourcePath: "/private/checkout.jsonl",
    }];
    const fixture = await createFixture(1, false, sessions);
    sessions[0]!.cwd = fixture.project.path;
    await fixture.orchestrator.handle([{ type: "LIST_SESSIONS", provider: "codex", limit: 5 }], fixture.context);
    sessions[0]!.active = true;

    await expect(fixture.orchestrator.handle([
      { type: "ADOPT_LISTED_SESSION", ordinal: 1 },
    ], fixture.context)).rejects.toThrow(/still appears active/i);
    expect(Object.values((await fixture.store.read()).tasks)).toHaveLength(0);

    sessions[0]!.active = false;
    sessions[0]!.cwd = path.join(path.dirname(fixture.project.path), "other-repo");
    await expect(fixture.orchestrator.handle([
      { type: "ADOPT_LISTED_SESSION", ordinal: 1 },
    ], fixture.context)).rejects.toThrow(/not the registered project/i);
    expect(Object.values((await fixture.store.read()).tasks)).toHaveLength(0);
  });

  it("adopts a discovered provider session as a durable task and resumes it", async () => {
    const sessions: Parameters<typeof createFixture>[2] = [];
    const fixture = await createFixture(1, false, sessions);
    sessions.push({
      provider: "codex",
      sessionId: "thread-checkout",
      summary: "Checkout webhook investigation",
      cwd: fixture.project.path,
      updatedAt: "2026-08-23T12:00:00.000Z",
      active: false,
      sourcePath: "/private/checkout.jsonl",
    });

    const reply = await fixture.orchestrator.handle([{
      type: "ADOPT_SESSION",
      provider: "codex",
      sessionId: "thread-checkout",
      summary: "Checkout webhook investigation",
      cwd: fixture.project.path,
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

  it("never assigns one provider session to two durable Dex tasks", async () => {
    const sessions: Parameters<typeof createFixture>[2] = [];
    const fixture = await createFixture(2, false, sessions);
    sessions.push({
      provider: "codex",
      sessionId: "thread-checkout",
      summary: "Checkout webhook investigation",
      cwd: fixture.project.path,
      updatedAt: "2026-08-23T12:00:00.000Z",
      active: false,
      sourcePath: "/private/checkout.jsonl",
    });
    const action = {
      type: "ADOPT_SESSION" as const,
      provider: "codex" as const,
      sessionId: "thread-checkout",
      summary: "Checkout webhook investigation",
      cwd: fixture.project.path,
      updatedAt: "2026-08-23T12:00:00.000Z",
      active: false,
    };

    const outcomes = await Promise.allSettled([
      fixture.orchestrator.handle([action], fixture.context),
      fixture.orchestrator.handle([action], fixture.context),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/already belongs to Checkout webhook investigation/i) }),
    });
    expect(Object.values((await fixture.store.read()).tasks)).toHaveLength(1);
  });

  it("refuses to concurrently adopt an active or unrelated-project session", async () => {
    const sessions: Parameters<typeof createFixture>[2] = [];
    const fixture = await createFixture(1, false, sessions);
    sessions.push(
      {
        provider: "codex",
        sessionId: "thread-active",
        cwd: fixture.project.path,
        updatedAt: "2026-08-23T12:00:00.000Z",
        active: true,
        sourcePath: "/private/active.jsonl",
      },
      {
        provider: "claude",
        sessionId: "session-other-project",
        cwd: path.join(path.dirname(fixture.project.path), "other-repo"),
        updatedAt: "2026-08-23T12:00:00.000Z",
        active: false,
        sourcePath: "/private/other.jsonl",
      },
    );
    await expect(fixture.orchestrator.handle([{
      type: "ADOPT_SESSION",
      provider: "codex",
      sessionId: "thread-active",
      cwd: fixture.project.path,
      updatedAt: "2026-08-23T12:00:00.000Z",
      active: true,
    }], fixture.context)).rejects.toThrow(/still appears active/i);
    await expect(fixture.orchestrator.handle([{
      type: "ADOPT_SESSION",
      provider: "claude",
      sessionId: "session-other-project",
      cwd: path.join(path.dirname(fixture.project.path), "other-repo"),
      updatedAt: "2026-08-23T12:00:00.000Z",
      active: false,
    }], fixture.context)).rejects.toThrow(/not the registered project/i);
    expect(Object.values((await fixture.store.read()).tasks)).toHaveLength(0);
  });
});

class ControlledAdapter implements AgentAdapter {
  readonly provider: AgentProvider;
  readonly runs: ControlledRun[] = [];
  #startupFailures = 0;
  #nextStartupError: Error | undefined;
  #nextStartBarrier: Promise<void> | undefined;
  #nextStopError: string | undefined;

  constructor(provider: AgentProvider) {
    this.provider = provider;
    adapters.push(this);
  }

  async available(): Promise<boolean> { return true; }
  async isAvailable(): Promise<boolean> { return true; }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    await this.consumeStartBarrier(options.signal);
    if (this.#nextStartupError) {
      const error = this.#nextStartupError;
      this.#nextStartupError = undefined;
      throw error;
    }
    if (this.#startupFailures > 0) {
      this.#startupFailures -= 1;
      throw new Error("provider failed before returning a handle");
    }
    return this.createRun(undefined, options);
  }

  async resume(providerSessionId: string, options: AgentRunOptions): Promise<AgentHandle> {
    await this.consumeStartBarrier(options.signal);
    return this.createRun(providerSessionId, options);
  }

  async stop(handle: AgentHandle): Promise<void> {
    await handle.stop();
  }

  finish(index: number, status: AgentTerminalStatus, error?: string, output?: string): void {
    this.runs[index]?.finish(status, error, output);
  }

  completeOnStop(index: number, output: string): void {
    this.runs[index]?.completeOnStop(output);
  }

  rejectStop(index: number, message = "process-group termination unverified"): void {
    this.runs[index]?.rejectStop(message);
  }

  rejectNextStop(message = "process-group termination unverified"): void {
    this.#nextStopError = message;
  }

  emitMessage(index: number, text: string): void {
    this.runs[index]?.emitMessage(text);
  }

  stopAll(): void {
    for (const run of this.runs) run.finish("cancelled");
  }

  failNextStart(): void {
    this.#startupFailures += 1;
  }

  rejectNextStart(error: Error): void {
    this.#nextStartupError = error;
  }

  pauseNextStart(): () => void {
    let release!: () => void;
    this.#nextStartBarrier = new Promise<void>((resolve) => { release = resolve; });
    return release;
  }

  private async consumeStartBarrier(signal?: AbortSignal): Promise<void> {
    const barrier = this.#nextStartBarrier;
    this.#nextStartBarrier = undefined;
    if (!barrier) return;
    if (signal?.aborted) throw new Error("controlled startup aborted");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("controlled startup aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await (signal ? Promise.race([barrier, aborted]) : barrier);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  private createRun(resumedFrom: string | undefined, options: AgentRunOptions): AgentHandle {
    const run = new ControlledRun(this.provider, this.runs.length + 1, options, resumedFrom);
    if (this.#nextStopError) {
      run.rejectStop(this.#nextStopError);
      this.#nextStopError = undefined;
    }
    this.runs.push(run);
    return run.handle;
  }
}

class ControlledRun {
  readonly resumedFrom: string | undefined;
  readonly options: AgentRunOptions;
  readonly handle: AgentHandle;
  #resolve!: (result: AgentResult) => void;
  #finished = false;
  #completionOnStop: string | undefined;
  #stopError: Error | undefined;
  readonly #events = new ControlledEventStream();

  constructor(provider: AgentProvider, number: number, options: AgentRunOptions, resumedFrom?: string) {
    this.resumedFrom = resumedFrom;
    this.options = options;
    const providerSessionId = `${provider}-session-${number}`;
    const workerId = `${provider}-process-${number}`;
    const startedAt = new Date().toISOString();
    const result = new Promise<AgentResult>((resolve) => { this.#resolve = resolve; });
    this.handle = {
      provider,
      workerId,
      providerSessionId,
      sessionId: providerSessionId,
      events: this.#events,
      result,
      signal: new AbortController().signal,
      stop: async () => {
        if (this.#stopError) throw this.#stopError;
        if (this.#completionOnStop !== undefined) this.finish("completed", undefined, this.#completionOnStop);
        else this.finish("cancelled");
      },
    };
    void startedAt;
  }

  finish(status: AgentTerminalStatus, error?: string, output?: string): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#events.close();
    const timestamp = new Date().toISOString();
    this.#resolve({
      provider: this.handle.provider,
      workerId: this.handle.workerId,
      providerSessionId: this.handle.providerSessionId,
      status,
      exitCode: status === "completed" ? 0 : status === "cancelled" ? null : 1,
      signal: status === "cancelled" ? "SIGTERM" : null,
      output: status === "completed" ? output ?? "validated implementation" : "",
      ...(error ? { error } : {}),
      startedAt: timestamp,
      finishedAt: timestamp,
    });
  }

  completeOnStop(output: string): void {
    this.#completionOnStop = output;
  }

  rejectStop(message: string): void {
    this.#stopError = new Error(message);
  }

  emitMessage(text: string): void {
    this.#events.push({
      provider: this.handle.provider,
      workerId: this.handle.workerId,
      timestamp: new Date().toISOString(),
      type: "message",
      role: "assistant",
      text,
      delta: false,
      raw: { type: "assistant" },
    });
  }
}

class ControlledEventStream implements AsyncIterable<AgentEvent> {
  readonly #queued: AgentEvent[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;

  push(event: AgentEvent): void {
    if (this.#closed) throw new Error("controlled event stream is closed");
    this.#queued.push(event);
    this.#waiters.shift()?.();
  }

  close(): void {
    this.#closed = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const event = this.#queued.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
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
  preparation: Partial<TaskPreparationOperations> = {},
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
  const tasks = new TaskManager(store, events, paths, preparation);
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
  const recoveredHandoffs: DexTask[] = [];
  const notifications: string[] = [];
  let nextCloudMoveGate: {
    markStarted(): void;
    released: Promise<void>;
  } | undefined;
  let nextCloudMoveError: { error: Error; cleanupPending: boolean } | undefined;
  let handoffRecoveryFailures = 0;
  let rejectCloudStop = false;
  let transportFlushFailures = 0;
  let transportFlushAttemptCount = 0;
  const pauseNextCloudMove = (): { started: Promise<void>; release(): void } => {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    nextCloudMoveGate = { markStarted, released };
    return { started, release };
  };
  const failNextCloudMove = (error: Error, cleanupPending = false): void => {
    nextCloudMoveError = { error, cleanupPending };
  };
  const rejectNextCloudStop = (): void => {
    rejectCloudStop = true;
  };
  const failNextHandoffRecovery = (): void => {
    handoffRecoveryFailures += 1;
  };
  const failNextTransportFlush = (): void => {
    transportFlushFailures += 1;
  };
  const flushTransport = async (): Promise<void> => {
    transportFlushAttemptCount += 1;
    if (transportFlushFailures > 0) {
      transportFlushFailures -= 1;
      throw new Error("simulated transport flush failure");
    }
    const state = await store.read();
    for (const event of state.pendingTransportEvents) {
      if (event.type === "message.sent" && typeof event.payload.text === "string") {
        notifications.push(event.payload.text);
      }
    }
    await store.updateState((draft) => { draft.pendingTransportEvents = []; });
  };
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
    flushTransport,
    recoveryRetryMs: 10,
    ...(cloud ? {
      mover: {
        moveToCloud: async (task: DexTask, _agent?: AgentKind, signal?: AbortSignal) => {
          const injectedError = nextCloudMoveError;
          nextCloudMoveError = undefined;
          if (injectedError) {
            if (injectedError.cleanupPending) {
              await store.updateState((state) => {
                const current = state.tasks[task.id];
                if (!current) return;
                current.metadata.modalHandoffJournal = {
                  version: 1,
                  phase: "failed",
                  cleanupPending: true,
                };
              });
            }
            throw injectedError.error;
          }
          const gate = nextCloudMoveGate;
          nextCloudMoveGate = undefined;
          if (gate) {
            gate.markStarted();
            await Promise.race([
              gate.released,
              new Promise<never>((_resolve, reject) => {
                if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
                signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
              }),
            ]);
          }
          moved.push(task);
          await tasks.transition(task.id, "checkpointing", { stage: "checkpointing" });
          await tasks.transition(task.id, "handoff", { stage: "handing_off" });
          const worker = WorkerSessionSchema.parse({
            id: `modal-${task.id}-${moved.length}`,
            taskId: task.id,
            agent: "codex",
            target: { kind: "modal", sandboxId: `sandbox-${task.id}` },
            status: "running",
            startedAt: new Date().toISOString(),
          });
          await store.updateState((state) => {
            state.workers[worker.id] = worker;
            state.tasks[task.id]!.currentWorkerId = worker.id;
            state.tasks[task.id]!.workerHistory.push(worker.id);
          });
          await tasks.transition(task.id, "running", { stage: "implementing" });
        },
        stopCloudTask: async (task: DexTask, expectedWorkerId?: string) => {
          if (rejectCloudStop) {
            rejectCloudStop = false;
            return false;
          }
          let stopped = false;
          await store.updateState((state) => {
            const current = state.tasks[task.id];
            if (!current?.currentWorkerId || (expectedWorkerId && current.currentWorkerId !== expectedWorkerId)) return;
            const worker = state.workers[current.currentWorkerId];
            if (!worker || worker.target.kind !== "modal" || !["starting", "running", "waiting"].includes(worker.status)) return;
            worker.status = "stopped";
            worker.endedAt = new Date().toISOString();
            stopped = true;
          });
          return stopped;
        },
        recoverInterruptedHandoff: async (task: DexTask) => {
          recoveredHandoffs.push(task);
          if (handoffRecoveryFailures > 0) {
            handoffRecoveryFailures -= 1;
            return false;
          }
          const current = (await store.read()).tasks[task.id];
          const journal = current?.metadata.modalHandoffJournal;
          if (journal && typeof journal === "object" && !Array.isArray(journal) &&
            (journal as Record<string, unknown>).cleanupPending === true) {
            await store.updateState((state) => {
              const latest = state.tasks[task.id];
              const latestJournal = latest?.metadata.modalHandoffJournal;
              if (!latest || !latestJournal || typeof latestJournal !== "object" || Array.isArray(latestJournal)) return;
              latest.metadata.modalHandoffJournal = {
                ...(latestJournal as Record<string, unknown>),
                cleanupPending: false,
              };
            });
            return true;
          }
          await tasks.transition(task.id, "running", {
            stage: "implementing",
            latestSummary: "cloud monitoring ownership restored",
          });
          return true;
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
    recoveredHandoffs,
    tasks,
    events,
    notifications,
    project,
    pauseNextCloudMove,
    failNextCloudMove,
    rejectNextCloudStop,
    failNextHandoffRecovery,
    failNextTransportFlush,
    flushTransport,
    transportFlushAttempts: () => transportFlushAttemptCount,
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
