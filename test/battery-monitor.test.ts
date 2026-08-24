import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatteryMonitor } from "../src/local/battery-monitor.js";
import { simulatedBatteryReading, type BatteryPowerSource } from "../src/local/power/battery.js";
import { EventLog } from "../src/state/events.js";
import { DexTaskSchema, WorkerSessionSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";

const NOW = "2026-08-24T12:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-battery-monitor-"));
  directories.push(directory);
  const eventPath = path.join(directory, "events.jsonl");
  const store = new DexStateStore(path.join(directory, "state.json"));
  const events = new EventLog(eventPath);
  const task = DexTaskSchema.parse({
    id: "checkout-task",
    projectId: "project-1",
    title: "checkout",
    originalRequest: "fix checkout",
    repositoryPath: "/repo",
    baseBranch: "main",
    dexBranch: "dex/checkout-task",
    worktreePath: "/worktrees/checkout-task",
    status: "running",
    stage: "implementing",
    createdAt: NOW,
    updatedAt: NOW,
    currentWorkerId: "checkout-worker",
  });
  const worker = WorkerSessionSchema.parse({
    id: "checkout-worker",
    taskId: task.id,
    agent: "codex",
    target: { kind: "local", machineId: "device-1" },
    status: "running",
    startedAt: NOW,
  });
  await store.updateState((state) => {
    state.tasks[task.id] = task;
    state.workers[worker.id] = worker;
  });
  const notify = vi.fn(async () => undefined);
  const monitor = new BatteryMonitor({
    store,
    events,
    deviceId: "device-1",
    conversationId: "conversation-1",
    now: () => new Date(NOW),
    notify,
  });
  return { eventPath, monitor, notify, store };
}

function reading(
  batteryPercent: number,
  options: { charging?: boolean; powerSource?: BatteryPowerSource } = {},
) {
  return simulatedBatteryReading({
    batteryPercent,
    charging: options.charging ?? false,
    powerSource: options.powerSource ?? "battery",
    remainingMinutes: null,
  });
}

async function batteryEvents(eventPath: string): Promise<Array<{ payload: { threshold: number } }>> {
  let contents: string;
  try {
    contents = await readFile(eventPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; payload: { threshold: number } })
    .filter((event) => event.type === "battery.low");
}

describe("BatteryMonitor low-battery policy", () => {
  it("does not alert for a low reading while charging", async () => {
    const { eventPath, monitor, notify, store } = await fixture();

    await expect(monitor.handleBatteryReading(reading(8, { charging: true }))).resolves.toBe(false);

    expect(notify).not.toHaveBeenCalled();
    expect(await batteryEvents(eventPath)).toEqual([]);
    expect((await store.read()).machine).toMatchObject({
      batteryPercent: 8,
      charging: true,
      batteryAlertThresholds: [],
    });
  });

  it("does not alert for a low reading on AC power", async () => {
    const { eventPath, monitor, notify, store } = await fixture();

    await expect(monitor.handleBatteryReading(reading(4, { powerSource: "ac" }))).resolves.toBe(false);

    expect(notify).not.toHaveBeenCalled();
    expect(await batteryEvents(eventPath)).toEqual([]);
    expect((await store.read()).machine).toMatchObject({
      batteryPercent: 4,
      powerSource: "ac",
      batteryAlertThresholds: [],
    });
  });

  it("alerts only once for repeated identical 8% readings", async () => {
    const { eventPath, monitor, notify, store } = await fixture();

    await expect(monitor.handleBatteryReading(reading(8))).resolves.toBe(true);
    await expect(monitor.handleBatteryReading(reading(8))).resolves.toBe(false);
    await expect(monitor.handleBatteryReading(reading(8))).resolves.toBe(false);

    expect(notify).toHaveBeenCalledTimes(1);
    expect((await batteryEvents(eventPath)).map((event) => event.payload.threshold)).toEqual([10]);
    expect((await store.read()).machine?.batteryAlertThresholds).toEqual([20, 10]);
  });

  it("emits the most severe crossed threshold and consumes every crossed threshold", async () => {
    const { eventPath, monitor, notify, store } = await fixture();

    await expect(monitor.handleBatteryReading(reading(4))).resolves.toBe(true);
    await expect(monitor.handleBatteryReading(reading(4))).resolves.toBe(false);

    expect(notify).toHaveBeenCalledTimes(1);
    expect((await batteryEvents(eventPath)).map((event) => event.payload.threshold)).toEqual([5]);
    expect((await store.read()).machine?.batteryAlertThresholds).toEqual([20, 10, 5]);
  });

  it("re-arms while charging and alerts once after the Mac is unplugged", async () => {
    const { eventPath, monitor, notify, store } = await fixture();

    await expect(monitor.handleBatteryReading(reading(15))).resolves.toBe(true);
    await expect(monitor.handleBatteryReading(reading(8, { charging: true, powerSource: "ac" }))).resolves.toBe(false);
    await expect(monitor.handleBatteryReading(reading(8, { charging: true, powerSource: "ac" }))).resolves.toBe(false);
    expect((await store.read()).machine?.batteryAlertThresholds).toEqual([]);

    await expect(monitor.handleBatteryReading(reading(8))).resolves.toBe(true);
    await expect(monitor.handleBatteryReading(reading(8))).resolves.toBe(false);

    expect(notify).toHaveBeenCalledTimes(2);
    expect((await batteryEvents(eventPath)).map((event) => event.payload.threshold)).toEqual([20, 10]);
    expect((await store.read()).machine?.batteryAlertThresholds).toEqual([20, 10]);
  });
});
