import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexVerifiedCommand } from "../src/cloud/messaging/index.js";
import type { DexOrchestrator } from "../src/dex/orchestrator.js";
import type { MessageRouter } from "../src/dex/router.js";
import { BatteryMonitor } from "../src/local/battery-monitor.js";
import type { DexCloudBridge } from "../src/local/daemon/cloud-bridge.js";
import { DexPowerController } from "../src/local/daemon/power-controller.js";
import { DexDaemonRuntime } from "../src/local/daemon/runtime.js";
import { MacMachineController, type SleepInhibitor } from "../src/local/machine/index.js";
import { simulatedBatteryReading } from "../src/local/power/index.js";
import { EventLog } from "../src/state/events.js";
import { DexTaskSchema, WorkerSessionSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";

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
  it("persists simulated provenance, expiry, and the exact active local task IDs", async () => {
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

    const handle = vi.fn(async (actions: Array<{ taskQuery?: string }>) => `moving ${actions[0]?.taskQuery}`);
    const notify = vi.fn(async () => undefined);
    const receipt = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: { notify, receipt, syncOnce: vi.fn(async () => []) } as unknown as DexCloudBridge,
      router: { route: vi.fn(async () => { throw new Error("plain yes should not be routed"); }) } as unknown as MessageRouter,
      orchestrator: { handle } as unknown as DexOrchestrator,
      store,
      events,
      battery,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes"));

    expect(handle.mock.calls.map(([actions]) => actions)).toEqual([
      [{ type: "MOVE_TASK", taskQuery: "captured-one", destination: "cloud", preferredAgent: "codex" }],
      [{ type: "MOVE_TASK", taskQuery: "captured-two", destination: "cloud", preferredAgent: "codex" }],
    ]);
    expect(handle.mock.calls.flatMap(([actions]) => actions).some((action) => action.taskQuery === "later-task")).toBe(false);
    expect((await store.read()).pendingConversationPrompts).toEqual([]);
    expect(notify).toHaveBeenCalledWith("chat-1", expect.stringContaining("moving captured-one"));
    expect(receipt).toHaveBeenCalledWith(expect.stringContaining("command-yes-chat-1"), "processed");
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
    expect(notify).toHaveBeenCalledWith("chat-1", expect.stringContaining("left the captured tasks running locally"));
  });

  it("does not resolve a battery prompt from another conversation", async () => {
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
    const route = vi.fn(async () => ({ actions: [{ type: "STATUS" as const }], source: "deterministic" as const }));
    const handle = vi.fn(async () => "normal routed reply");
    const runtime = new DexDaemonRuntime({
      bridge: { notify: vi.fn(async () => undefined), receipt: vi.fn(async () => undefined), syncOnce: vi.fn(async () => []) } as unknown as DexCloudBridge,
      router: { route } as unknown as MessageRouter,
      orchestrator: { handle } as unknown as DexOrchestrator,
      store,
      events,
      battery: { start: vi.fn(), stop: vi.fn() } as unknown as BatteryMonitor,
      power: new DexPowerController({ store, events, notify: async () => undefined }),
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(messageCommand("yes", "chat-2"));

    expect(route).toHaveBeenCalledWith("yes");
    expect(handle).toHaveBeenCalledWith([{ type: "STATUS" }], expect.objectContaining({ conversationId: "chat-2" }));
    expect((await store.read()).pendingConversationPrompts).toHaveLength(1);
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
    expect(notify).toHaveBeenCalledWith("chat-1", expect.stringContaining("prompt expired"));
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

  it("keeps the request pending and corrects the user when pmset fails", async () => {
    const { store, events } = await fixture();
    let active = true;
    const inhibitor: SleepInhibitor = {
      get active() { return active; },
      start: vi.fn(async () => { active = true; return 9001; }),
      restore: vi.fn(async () => { const changed = active; active = false; return changed; }),
    };
    const notify = vi.fn(async () => undefined);
    const power = new DexPowerController({
      store,
      events,
      machine: new MacMachineController({
        caffeinate: inhibitor,
        commandExecutor: async () => ({ stdout: "", stderr: "denied", exitCode: 1 }),
      }),
      notify,
    });

    await expect(power.requestSleep("now", "chat-1")).rejects.toThrow("pmset sleepnow failed: denied");
    expect(notify).toHaveBeenNthCalledWith(1, "chat-1", expect.stringContaining("requesting sleep"));
    expect(notify).toHaveBeenNthCalledWith(2, "chat-1", expect.stringContaining("still awake"));
    expect((await store.read()).pendingMachineActions).toEqual([expect.objectContaining({ type: "sleep" })]);
    expect((await store.read()).machine?.sleepPreventionActive).toBe(true);
    expect(inhibitor.start).toHaveBeenCalledOnce();
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
        expect(duringCommand.pendingMachineActions).toEqual([expect.objectContaining({ type: "sleep" })]);
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
});
