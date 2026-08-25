import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexVerifiedCommand } from "../src/cloud/messaging/index.js";
import { DexTerminalOutcomeQueuedError, type DexOrchestrator } from "../src/dex/orchestrator.js";
import type { MessageRouter } from "../src/dex/router.js";
import { resolveDexPaths } from "../src/config/paths.js";
import { BatteryMonitor } from "../src/local/battery-monitor.js";
import type { DexCloudBridge } from "../src/local/daemon/cloud-bridge.js";
import { DexPowerController } from "../src/local/daemon/power-controller.js";
import { DexDaemonRuntime, terminalEffectsAreReadyForPower } from "../src/local/daemon/runtime.js";
import { MacMachineController, type SleepInhibitor } from "../src/local/machine/index.js";
import { simulatedBatteryReading } from "../src/local/power/index.js";
import { EventLog } from "../src/state/events.js";
import { DexTaskSchema, WorkerSessionSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { TaskManager } from "../src/tasks/task-manager.js";

const directories: string[] = [];
const NOW = "2026-08-23T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-power-followup-"));
  directories.push(directory);
  const store = new DexStateStore(path.join(directory, "state.json"));
  const events = new EventLog(path.join(directory, "events.jsonl"));
  await store.updateState((state) => {
    state.machine = {
      id: "device-1",
      hostname: "test-mac",
      sleepPreventionActive: false,
      aggressiveLidModeActive: false,
      batteryAlertThresholds: [],
      updatedAt: NOW,
    };
  });
  return { directory, store, events };
}

async function addTask(
  store: DexStateStore,
  id: string,
  options: { title?: string; target?: "local" | "modal"; status?: "running" | "completed" } = {},
): Promise<void> {
  const workerId = `worker-${id}`;
  const status = options.status ?? "running";
  const target = options.target ?? "local";
  const task = DexTaskSchema.parse({
    id,
    projectId: "project-1",
    title: options.title ?? id,
    originalRequest: `work on ${id}`,
    repositoryPath: "/repo",
    baseBranch: "main",
    dexBranch: `dex/${id}`,
    worktreePath: `/worktrees/${id}`,
    status,
    stage: status === "completed" ? "done" : "implementing",
    createdAt: NOW,
    updatedAt: NOW,
    currentWorkerId: workerId,
  });
  const worker = WorkerSessionSchema.parse({
    id: workerId,
    taskId: id,
    agent: "codex",
    target: target === "local" ? { kind: "local", machineId: "device-1" } : { kind: "modal", sandboxId: `sandbox-${id}` },
    status: status === "completed" ? "completed" : "running",
    startedAt: NOW,
  });
  await store.updateState((state) => {
    state.tasks[id] = task;
    state.workers[workerId] = worker;
  });
}

function messageCommand(text: string, conversationId = "chat-1"): DexVerifiedCommand {
  return {
    id: `command-${text}-${conversationId}`,
    issuedAt: NOW,
    command: { type: "message.received", payload: { text, conversationId, messageId: `message-${text}-${conversationId}` } },
    authority: { kind: "verified_owner", ownerId: "owner-1", conversationId, verified: true },
    verified: true,
    signingKeyId: "server-1",
  };
}

describe("low-battery conversation follow-up", () => {
  it("persists simulated provenance, expiry, and exact active local worker snapshots", async () => {
    const { store, events } = await fixture();
    await addTask(store, "task-local", { title: "local fix" });
    await addTask(store, "task-cloud", { target: "modal" });
    await addTask(store, "task-done", { status: "completed" });
    const notify = vi.fn(async () => undefined);
    const battery = new BatteryMonitor({
      store,
      events,
      deviceId: "device-1",
      conversationId: "chat-1",
      now: () => new Date(NOW),
      promptTtlMs: 60_000,
      notify,
    });

    await expect(battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 20,
    }))).resolves.toBe(true);

    const state = await store.read();
    expect(state.machine).toMatchObject({ batteryPercent: 8, batteryReadingSimulated: true });
    expect(state.pendingConversationPrompts).toEqual([expect.objectContaining({
      type: "battery.low",
      conversationId: "chat-1",
      taskIds: ["task-local"],
      taskSnapshots: [{
        taskId: "task-local",
        workerId: "worker-task-local",
        lifecycleGeneration: 0,
      }],
      createdAt: NOW,
      expiresAt: "2026-08-23T12:01:00.000Z",
    })]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("reply yes to move it, or no to leave it local"));
  });

  it("uses a same-conversation yes to move only captured tasks through Codex/Modal", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "captured-one");
    await addTask(store, "captured-two");
    const battery = new BatteryMonitor({
      store,
      events,
      conversationId: "chat-1",
      notify: async () => undefined,
    });
    await battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 20,
    }));
    await addTask(store, "later-task");

    const moveCapturedLocalTaskToCloud = vi.fn(async (captured: { taskId: string }) => ({
      status: "started" as const,
      title: captured.taskId,
    }));
    const notify = vi.fn(async () => undefined);
    const receipt = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: { notify, receipt, syncOnce: vi.fn(async () => []) } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain yes should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { moveCapturedLocalTaskToCloud } as unknown as DexOrchestrator,
      store,
      events,
      battery,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(moveCapturedLocalTaskToCloud.mock.calls.map(([captured]) => captured)).toEqual([
      { taskId: "captured-one", workerId: "worker-captured-one", lifecycleGeneration: 0 },
      { taskId: "captured-two", workerId: "worker-captured-two", lifecycleGeneration: 0 },
    ]);
    expect(moveCapturedLocalTaskToCloud.mock.calls.some(([captured]) => captured.taskId === "later-task")).toBe(false);
    expect((await store.read()).pendingConversationPrompts).toEqual([]);
    expect(notify).toHaveBeenCalledWith("chat-1", expect.stringContaining("captured-one is being handed"), false);
    expect(receipt).toHaveBeenCalledWith(expect.stringContaining("command-yes-chat-1"), "processed");
  });

  it("does not let a stale prompt claim a replacement worker before yes arrives", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "replaced-task");
    const battery = new BatteryMonitor({
      store,
      events,
      conversationId: "chat-1",
      notify: async () => undefined,
    });
    await battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 20,
    }));
    await store.updateState((state) => {
      const originalWorker = state.workers["worker-replaced-task"]!;
      originalWorker.status = "stopped";
      originalWorker.endedAt = new Date().toISOString();
      const replacementWorker = WorkerSessionSchema.parse({
        id: "worker-replacement",
        taskId: "replaced-task",
        agent: "codex",
        target: { kind: "local", machineId: "device-1" },
        status: "running",
        startedAt: new Date().toISOString(),
      });
      state.workers[replacementWorker.id] = replacementWorker;
      const task = state.tasks["replaced-task"]!;
      task.currentWorkerId = replacementWorker.id;
      task.workerHistory.push(replacementWorker.id);
      task.metadata.lifecycleGeneration = 1;
      task.updatedAt = new Date().toISOString();
    });

    const tasks = new TaskManager(store, events, resolveDexPaths(directory));
    let cloudStarts = 0;
    const moveCapturedLocalTaskToCloud = vi.fn(async (captured: {
      taskId: string;
      workerId: string;
      lifecycleGeneration: number;
    }) => {
      const claim = await tasks.claimLocalWorkerForCloudHandoff(
        captured.taskId,
        captured.workerId,
        captured.lifecycleGeneration,
      );
      if (claim.status === "claimed") {
        cloudStarts += 1;
        return { status: "started" as const, title: claim.task.title };
      }
      return { status: claim.status, title: claim.task.title };
    });
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: {
        notify,
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
      } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain yes should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { moveCapturedLocalTaskToCloud } as unknown as DexOrchestrator,
      store,
      events,
      battery,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(moveCapturedLocalTaskToCloud).toHaveBeenCalledWith(
      { taskId: "replaced-task", workerId: "worker-replaced-task", lifecycleGeneration: 0 },
      expect.objectContaining({ conversationId: "chat-1" }),
    );
    expect(cloudStarts).toBe(0);
    const state = await store.read();
    expect(state.tasks["replaced-task"]).toMatchObject({
      status: "running",
      currentWorkerId: "worker-replacement",
      metadata: { lifecycleGeneration: 1 },
    });
    expect(state.workers["worker-replacement"]?.status).toBe("running");
    expect(state.pendingConversationPrompts).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "replaced-task changed workers before i could claim it, so i left the current work alone.",
      false,
    );
  });

  it("loads legacy task-ID-only prompts but fails closed on yes", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "legacy-task");
    await store.updateState((state) => {
      state.pendingConversationPrompts.push({
        id: "prompt-legacy",
        type: "battery.low",
        conversationId: "chat-1",
        taskIds: ["legacy-task"],
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const moveCapturedLocalTaskToCloud = vi.fn();
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: {
        notify,
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
      } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain yes should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { moveCapturedLocalTaskToCloud } as unknown as DexOrchestrator,
      store,
      events,
      battery: { start: vi.fn(), stop: vi.fn() } as unknown as BatteryMonitor,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(moveCapturedLocalTaskToCloud).not.toHaveBeenCalled();
    const state = await store.read();
    expect(state.pendingConversationPrompts).toEqual([]);
    expect(state.tasks["legacy-task"]).toMatchObject({
      status: "running",
      currentWorkerId: "worker-legacy-task",
    });
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "that battery prompt predates worker fencing, so i left the captured tasks running locally.",
      false,
    );
  });

  it("does not move or rerun a captured task that finishes locally before yes arrives", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "fast-local");
    const battery = new BatteryMonitor({
      store,
      events,
      conversationId: "chat-1",
      notify: async () => undefined,
    });
    await battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 20,
    }));
    await store.updateState((state) => {
      const task = state.tasks["fast-local"]!;
      const worker = state.workers["worker-fast-local"]!;
      task.status = "completed";
      task.stage = "done";
      task.updatedAt = new Date().toISOString();
      worker.status = "completed";
      worker.endedAt = new Date().toISOString();
      worker.exitCode = 0;
    });

    const moveCapturedLocalTaskToCloud = vi.fn(async () => ({ status: "started" as const, title: "fast-local" }));
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: {
        notify,
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
      } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain yes should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { moveCapturedLocalTaskToCloud } as unknown as DexOrchestrator,
      store,
      events,
      battery,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(moveCapturedLocalTaskToCloud).not.toHaveBeenCalled();
    const state = await store.read();
    expect(state.pendingConversationPrompts).toEqual([]);
    expect(state.tasks["fast-local"]?.status).toBe("completed");
    expect(state.workers["worker-fast-local"]).toMatchObject({
      status: "completed",
      target: { kind: "local", machineId: "device-1" },
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "fast-local already finished locally, so i didn't move or rerun it.",
      false,
    );
  });

  it("lets local completion win atomically after the daemon read but before its handoff claim", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "finish-at-claim");
    const battery = new BatteryMonitor({
      store,
      events,
      conversationId: "chat-1",
      notify: async () => undefined,
    });
    await battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 20,
    }));
    const tasks = new TaskManager(store, events, resolveDexPaths(directory));
    let cloudStarts = 0;
    const moveCapturedLocalTaskToCloud = vi.fn(async (captured: {
      taskId: string;
      workerId: string;
      lifecycleGeneration: number;
    }) => {
      // This callback begins only after runtime has read an active local task.
      // Commit completion before the atomic handoff CAS to reproduce the
      // original read/dispatch race deterministically.
      await tasks.completeIfCurrentWorkerAndGenerationWithNotification(
        captured.taskId,
        captured.workerId,
        captured.lifecycleGeneration,
        "finished during battery reply",
        "chat-1",
        "finish-at-claim is done",
      );
      const claim = await tasks.claimLocalWorkerForCloudHandoff(
        captured.taskId,
        captured.workerId,
        captured.lifecycleGeneration,
      );
      if (claim.status === "claimed") cloudStarts += 1;
      return { status: claim.status, title: claim.task.title };
    });
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: {
        notify,
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
      } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain yes should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { moveCapturedLocalTaskToCloud } as unknown as DexOrchestrator,
      store,
      events,
      battery,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(moveCapturedLocalTaskToCloud).toHaveBeenCalledOnce();
    expect(cloudStarts).toBe(0);
    const state = await store.read();
    expect(state.tasks["finish-at-claim"]).toMatchObject({
      status: "completed",
      currentWorkerId: "worker-finish-at-claim",
    });
    expect(state.pendingConversationPrompts).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "finish-at-claim already finished locally, so i didn't move or rerun it.",
      false,
    );
  });

  it("moves only active tasks when captured tasks finish locally at different times", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "still-active");
    await addTask(store, "already-done");
    const battery = new BatteryMonitor({
      store,
      events,
      conversationId: "chat-1",
      notify: async () => undefined,
    });
    await battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 20,
    }));
    await store.updateState((state) => {
      const task = state.tasks["already-done"]!;
      const worker = state.workers["worker-already-done"]!;
      task.status = "completed";
      task.stage = "done";
      task.updatedAt = new Date().toISOString();
      worker.status = "completed";
      worker.endedAt = new Date().toISOString();
      worker.exitCode = 0;
    });

    const moveCapturedLocalTaskToCloud = vi.fn(async (captured: { taskId: string }) => ({
      status: "started" as const,
      title: captured.taskId,
    }));
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: {
        notify,
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
      } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain yes should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { moveCapturedLocalTaskToCloud } as unknown as DexOrchestrator,
      store,
      events,
      battery,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(moveCapturedLocalTaskToCloud).toHaveBeenCalledOnce();
    expect(moveCapturedLocalTaskToCloud).toHaveBeenCalledWith(
      { taskId: "still-active", workerId: "worker-still-active", lifecycleGeneration: 0 },
      {
        conversationId: "chat-1",
        messageId: "message-yes-chat-1",
        sourceMessageId: "message-yes-chat-1",
      },
    );
    expect(moveCapturedLocalTaskToCloud.mock.calls.some(([captured]) => captured.taskId === "already-done")).toBe(false);
    expect((await store.read()).pendingConversationPrompts).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "still-active is being handed to codex in the cloud.\n\nalready-done already finished locally, so i didn't move or rerun it.",
      false,
    );
  });

  it("uses no to clear the prompt without moving or changing local tasks", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "stay-local");
    await store.updateState((state) => {
      state.pendingConversationPrompts.push({
        id: "prompt-1",
        type: "battery.low",
        conversationId: "chat-1",
        taskIds: ["stay-local"],
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const handle = vi.fn(async () => "unexpected");
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: { notify, receipt: vi.fn(async () => undefined), syncOnce: vi.fn(async () => []) } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain no should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { handle } as unknown as DexOrchestrator,
      store,
      events,
      battery: { start: vi.fn(), stop: vi.fn() } as unknown as BatteryMonitor,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("no"));

    expect(handle).not.toHaveBeenCalled();
    expect((await store.read()).pendingConversationPrompts).toEqual([]);
    expect((await store.read()).workers["worker-stay-local"]?.target).toEqual({ kind: "local", machineId: "device-1" });
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("left the captured tasks running locally"),
      false,
    );
  });

  it("does not resolve or reroute a battery answer from another conversation", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "conversation-bound");
    await store.updateState((state) => {
      state.pendingConversationPrompts.push({
        id: "prompt-bound",
        type: "battery.low",
        conversationId: "chat-1",
        taskIds: ["conversation-bound"],
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    const route = vi.fn(async () => { throw new Error("bare yes must stay contextual"); });
    const handle = vi.fn(async () => "unexpected routed reply");
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: { notify, receipt: vi.fn(async () => undefined), syncOnce: vi.fn(async () => []) } as unknown as DexCloudBridge,
      router: { route } as unknown as MessageRouter,
      orchestrator: { handle } as unknown as DexOrchestrator,
      store,
      events,
      battery: { start: vi.fn(), stop: vi.fn() } as unknown as BatteryMonitor,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes", "chat-2"));

    expect(route).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "chat-2",
      "nothing is waiting for a yes or no right now",
      false,
    );
    expect((await store.read()).pendingConversationPrompts).toHaveLength(1);
  });

  it.each(["yes", "no"])("never turns a bare %s into an engineering task", async (answer) => {
    const { directory, store, events } = await fixture();
    const route = vi.fn(async () => { throw new Error("bare confirmation must not be routed"); });
    const handle = vi.fn(async () => "unexpected routed reply");
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: {
        notify,
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
      } as unknown as DexCloudBridge,
      router: { route } as unknown as MessageRouter,
      orchestrator: { handle } as unknown as DexOrchestrator,
      store,
      events,
      battery: { start: vi.fn(), stop: vi.fn() } as unknown as BatteryMonitor,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand(answer));

    expect(route).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "chat-1",
      "nothing is waiting for a yes or no right now",
      false,
    );
    expect(Object.values((await store.read()).tasks)).toEqual([]);
  });

  it("expires a prompt without moving its captured tasks", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "expired-task");
    await store.updateState((state) => {
      state.pendingConversationPrompts.push({
        id: "prompt-expired",
        type: "battery.low",
        conversationId: "chat-1",
        taskIds: ["expired-task"],
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
    });
    const handle = vi.fn(async () => "unexpected");
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: { notify, receipt: vi.fn(async () => undefined), syncOnce: vi.fn(async () => []) } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("expired follow-up should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { handle } as unknown as DexOrchestrator,
      store,
      events,
      battery: { start: vi.fn(), stop: vi.fn() } as unknown as BatteryMonitor,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(handle).not.toHaveBeenCalled();
    expect((await store.read()).pendingConversationPrompts).toEqual([]);
    expect(notify).toHaveBeenCalledWith("chat-1", expect.stringContaining("prompt expired"), false);
  });

  it("accepts an atomically queued terminal outcome without sending a second failure", async () => {
    const { directory, store, events } = await fixture();
    const notify = vi.fn(async () => undefined);
    const receipt = vi.fn(async () => undefined);
    const syncOnce = vi.fn(async () => []);
    const runtime = new DexDaemonRuntime({
      bridge: { notify, receipt, syncOnce } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => ({ actions: [{ type: "STATUS" }], source: "deterministic" })) } as unknown as MessageRouter,
      orchestrator: {
        handle: vi.fn(async () => {
          throw new DexTerminalOutcomeQueuedError("task-1", "terminal notification already queued");
        }),
      } as unknown as DexOrchestrator,
      store,
      events,
      battery: { start: vi.fn(), stop: vi.fn() } as unknown as BatteryMonitor,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("fix checkout"));

    expect(receipt).toHaveBeenCalledWith(expect.stringContaining("command-fix checkout"), "processed");
    expect(notify).not.toHaveBeenCalled();
    expect(syncOnce).toHaveBeenCalled();
  });
});

describe("durable power intent", () => {
  it("automatically restores keep-awake when all tasks complete", async () => {
    const { store, events } = await fixture();
    await addTask(store, "task-1");
    let active = false;
    const inhibitor: SleepInhibitor = {
      get active() { return active; },
      start: vi.fn(async () => { active = true; return 4242; }),
      restore: vi.fn(async () => { const changed = active; active = false; return changed; }),
    };
    const machine = new MacMachineController({
      caffeinate: inhibitor,
      commandExecutor: async () => { throw new Error("pmset must not run"); },
    });
    const power = new DexPowerController({ store, events, machine, notify: async () => undefined });

    await power.keepAwake(true);
    expect((await store.read()).pendingMachineActions).toEqual([expect.objectContaining({
      type: "restore",
      trigger: "all_tasks_complete",
    })]);
    await store.updateState((state) => {
      state.tasks["task-1"]!.status = "completed";
      state.tasks["task-1"]!.stage = "done";
    });

    await expect(power.maybeSleepWhenReady()).resolves.toBe(true);
    expect(inhibitor.restore).toHaveBeenCalled();
    expect((await store.read()).pendingMachineActions).toEqual([]);
    expect((await store.read()).machine?.sleepPreventionActive).toBe(false);
  });

  it("reconciles stale recorded caffeinate state and re-establishes durable intent", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.machine!.sleepPreventionActive = true;
    });
    let active = false;
    const inhibitor: SleepInhibitor = {
      get active() { return active; },
      start: vi.fn(async () => { active = true; return 1234; }),
      restore: vi.fn(async () => false),
    };
    const power = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ caffeinate: inhibitor }),
      notify: async () => undefined,
    });

    await power.reconcileStartup();
    expect((await store.read()).machine?.sleepPreventionActive).toBe(false);

    await addTask(store, "durable-task");
    await store.updateState((state) => {
      state.pendingMachineActions.push({
        type: "restore",
        trigger: "all_tasks_complete",
        requestedAt: NOW,
      });
    });
    await power.reconcileStartup();
    expect(inhibitor.start).toHaveBeenCalledOnce();
    expect((await store.read()).machine?.sleepPreventionActive).toBe(true);
  });

  it("consumes the at-most-once request and corrects the user when pmset fails", async () => {
    const { store, events } = await fixture();
    let active = true;
    const inhibitor: SleepInhibitor = {
      get active() { return active; },
      start: vi.fn(async () => { active = true; return 9001; }),
      restore: vi.fn(async () => { const changed = active; active = false; return changed; }),
    };
    const notify = vi.fn(async () => undefined);
    const executor = vi.fn(async () => ({ stdout: "", stderr: "denied", exitCode: 1 }));
    const power = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({
        caffeinate: inhibitor,
        commandExecutor: executor,
      }),
      notify,
    });

    await expect(power.requestSleep("now", "chat-1")).rejects.toThrow("pmset sleepnow failed: denied");
    expect(notify).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.stringContaining("requesting sleep"),
      expect.stringMatching(/^evt_/),
    );
    expect(notify).toHaveBeenNthCalledWith(2, "chat-1", expect.stringContaining("still awake"));
    expect((await store.read()).pendingMachineActions).toEqual([]);
    expect((await store.read()).machine?.sleepPreventionActive).toBe(true);
    expect(inhibitor.start).toHaveBeenCalledOnce();
    await expect(power.maybeSleepWhenReady()).resolves.toBe(false);
    expect(executor).toHaveBeenCalledOnce();
  });

  it("flushes the final cloud-safe notification before pmset succeeds", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.machine!.sleepPreventionActive = true;
    });
    const calls: string[] = [];
    let active = true;
    const inhibitor: SleepInhibitor = {
      get active() { return active; },
      start: vi.fn(async () => { active = true; calls.push("start"); return 77; }),
      restore: vi.fn(async () => { const changed = active; active = false; calls.push("restore"); return changed; }),
    };
    const notify = vi.fn(async () => { calls.push("notify"); });
    const machine = new MacMachineController({
      caffeinate: inhibitor,
      commandExecutor: async () => {
        calls.push("pmset");
        const duringCommand = await store.read();
        // The external effect is claimed durably before pmset so a restart
        // cannot replay a successful request.
        expect(duringCommand.pendingMachineActions).toEqual([
          expect.objectContaining({ type: "sleep", phase: "sleep_claimed" }),
        ]);
        expect(duringCommand.machine?.sleepPreventionActive).toBe(true);
        expect(notify).toHaveBeenCalledOnce();
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const power = new DexPowerController({ store, events, machine, notify });

    await power.requestSleep("now", "chat-1");

    expect(calls).toEqual(["notify", "restore", "pmset"]);
    expect((await store.read()).pendingMachineActions).toEqual([]);
    expect((await store.read()).machine?.sleepPreventionActive).toBe(false);
  });

  it.each(["event", "receipt"] as const)(
    "does not run pmset while a durable transport %s is pending",
    async (pendingKind) => {
      const { store, events } = await fixture();
      await store.updateState((state) => {
        if (pendingKind === "event") {
          state.pendingTransportEvents.push({
            id: "event-pending",
            timestamp: NOW,
            type: "message.sent",
            payload: { conversationId: "chat-1", text: "not accepted" },
          });
        } else {
          state.pendingTransportReceipts.push({
            commandId: "receipt-pending",
            status: "processed",
            occurredAt: NOW,
          });
        }
      });
      const executor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      const power = new DexPowerController({
        store,
        events,
        machine: new MacMachineController({ commandExecutor: executor }),
        notify: async () => undefined,
      });

      await expect(power.requestSleep("now", "chat-1")).resolves.toBeUndefined();

      expect(executor).not.toHaveBeenCalled();
      expect((await store.read()).pendingMachineActions).toEqual([
        expect.objectContaining({ type: "sleep" }),
      ]);
    },
  );

  it.each([
    ["malformed", { version: 1, phase: "notification_pending" }],
    ["recovery pending", {
      version: 1,
      phase: "recovery_pending",
      reason: "recovery is being evaluated",
      updatedAt: NOW,
    }],
  ] as const)("fails closed for a %s local terminal journal", async (_label, journal) => {
    const { store, events } = await fixture();
    await addTask(store, "task-local", { status: "completed" });
    await store.updateState((state) => {
      state.tasks["task-local"]!.metadata.localTerminalEffects = journal;
      state.pendingMachineActions.push({
        type: "sleep",
        trigger: "all_tasks_complete",
        requestedAt: NOW,
      });
    });
    const executor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const power = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ commandExecutor: executor }),
      notify: async () => undefined,
      durabilityGate: terminalEffectsAreReadyForPower,
    });

    await expect(power.maybeSleepWhenReady()).resolves.toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it("does not replay sleep after pmset succeeded but post-effect bookkeeping crashed", async () => {
    const { store, events } = await fixture();
    const executor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const originalUpdateState = store.updateState.bind(store);
    let failNextUpdate = false;
    vi.spyOn(store, "updateState").mockImplementation(async (mutator) => {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error("simulated crash after pmset");
      }
      return originalUpdateState(mutator);
    });
    const first = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({
        commandExecutor: async (...args) => {
          const result = await executor(...args);
          failNextUpdate = true;
          return result;
        },
      }),
      notify: async () => undefined,
    });

    await expect(first.requestSleep("now", "chat-1"))
      .rejects.toThrow("simulated crash after pmset");
    expect(executor).toHaveBeenCalledOnce();
    expect((await store.read()).pendingMachineActions).toEqual([
      expect.objectContaining({ type: "sleep", phase: "sleep_claimed" }),
    ]);

    const restarted = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ commandExecutor: executor }),
      notify: async () => undefined,
    });
    await expect(restarted.maybeSleepWhenReady()).resolves.toBe(false);
    expect(executor).toHaveBeenCalledOnce();
  });

  it("serializes concurrent sleep evaluations behind one notification and one pmset claim", async () => {
    const { store, events } = await fixture();
    let notificationStarted!: () => void;
    const notificationReady = new Promise<void>((resolve) => { notificationStarted = resolve; });
    let releaseNotification!: () => void;
    const notificationBlocked = new Promise<void>((resolve) => { releaseNotification = resolve; });
    const notify = vi.fn(async () => {
      notificationStarted();
      await notificationBlocked;
    });
    const executor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const power = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ commandExecutor: executor }),
      notify,
    });

    const requested = power.requestSleep("now", "chat-1");
    await notificationReady;
    const concurrent = [power.maybeSleepWhenReady(), power.maybeSleepWhenReady()];
    releaseNotification();
    await expect(Promise.all([requested, ...concurrent])).resolves.toEqual([undefined, false, false]);

    expect(notify).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledOnce();
    expect((await store.read()).pendingMachineActions).toEqual([]);
  });

  it("does not claim sleep until the stable notification event leaves the transport outbox", async () => {
    const { store, events } = await fixture();
    const notificationIds: string[] = [];
    const notify = vi.fn(async (_conversationId: string, _text: string, stableEventId?: string) => {
      expect(stableEventId).toEqual(expect.stringMatching(/^evt_/));
      notificationIds.push(stableEventId!);
      if (notificationIds.length === 1) {
        await store.updateState((state) => {
          state.pendingTransportEvents.push({
            id: stableEventId!,
            timestamp: NOW,
            type: "message.sent",
            payload: { conversationId: "chat-1", text: "requesting sleep" },
          });
        });
      }
    });
    const executor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const power = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ commandExecutor: executor }),
      notify,
    });

    await power.requestSleep("now", "chat-1");
    expect(executor).not.toHaveBeenCalled();
    expect((await store.read()).pendingMachineActions[0]).toMatchObject({
      phase: "notification_pending",
      notificationEventId: notificationIds[0],
    });

    await store.updateState((state) => {
      state.pendingTransportEvents = state.pendingTransportEvents.filter(
        ({ id }) => id !== notificationIds[0],
      );
    });
    await expect(power.maybeSleepWhenReady()).resolves.toBe(true);

    expect(notificationIds).toEqual([notificationIds[0], notificationIds[0]]);
    expect(executor).toHaveBeenCalledOnce();
  });

  it("resumes after a crash following notification acceptance without notifying twice", async () => {
    const { store, events } = await fixture();
    const notify = vi.fn(async () => undefined);
    const executor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const first = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ commandExecutor: executor }),
      notify,
      transportBarrier: async () => { throw new Error("simulated crash after notification"); },
    });

    await expect(first.requestSleep("now", "chat-1"))
      .rejects.toThrow("simulated crash after notification");
    expect(notify).toHaveBeenCalledOnce();
    expect(executor).not.toHaveBeenCalled();
    const journal = (await store.read()).pendingMachineActions[0];
    expect(journal).toMatchObject({
      type: "sleep",
      phase: "notification_accepted",
      notificationEventId: expect.stringMatching(/^evt_/),
    });

    const restarted = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ commandExecutor: executor }),
      notify,
    });
    await expect(restarted.maybeSleepWhenReady()).resolves.toBe(true);

    expect(notify).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledOnce();
    expect((await store.read()).pendingMachineActions).toEqual([]);
  });

  it("blocks sleep through terminal enqueue and transport acceptance, then delivers exactly once", async () => {
    const { directory, store, events } = await fixture();
    await addTask(store, "task-local", { title: "checkout" });
    await store.updateState((state) => {
      state.pendingMachineActions.push({
        type: "sleep",
        trigger: "all_tasks_complete",
        requestedAt: NOW,
        conversationId: "chat-1",
      });
    });
    const tasks = new TaskManager(store, events, resolveDexPaths(directory));
    await tasks.markRecoveryPendingIfCurrentWorker(
      "task-local",
      "worker-task-local",
      { stage: "failed", latestSummary: "worker failed" },
      "recovery is still being evaluated",
    );
    const executor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const power = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({ commandExecutor: executor }),
      notify: async () => undefined,
      durabilityGate: terminalEffectsAreReadyForPower,
    });

    const sleepDuringRecovery = power.maybeSleepWhenReady();
    await expect(sleepDuringRecovery).resolves.toBe(false);
    expect(executor).not.toHaveBeenCalled();

    const terminalInput = {
      status: "failed" as const,
      stage: "failed" as const,
      summary: "recovery exhausted",
      blockedReason: "worker failed",
      conversationId: "chat-1",
      text: "checkout failed. recovery exhausted",
      kind: "work_failed" as const,
      dedupeKey: "work-failed:worker-task-local",
    };
    await Promise.all([
      tasks.finalizeIfCurrentWorkerWithNotification("task-local", "worker-task-local", terminalInput),
      power.maybeSleepWhenReady(),
    ]);
    expect(executor).not.toHaveBeenCalled();

    const delivered: string[] = [];
    await store.updateState((state) => {
      for (const event of state.pendingTransportEvents) {
        if (event.type === "message.sent" && typeof event.payload.text === "string") {
          delivered.push(event.payload.text);
        }
      }
      state.pendingTransportEvents = [];
    });
    await expect(power.maybeSleepWhenReady()).resolves.toBe(false);
    expect(executor).not.toHaveBeenCalled();

    await tasks.confirmAcceptedLocalTerminalNotifications();
    await expect(power.maybeSleepWhenReady()).resolves.toBe(true);
    expect(executor).toHaveBeenCalledOnce();
    expect(delivered).toEqual(["checkout failed. recovery exhausted"]);
  });
});
