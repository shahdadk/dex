import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  MacMachineController,
  type SleepInhibitor,
} from "../src/local/machine/index.js";
import {
  CaffeinateController,
  DEFAULT_POWER_POLICY,
  DEFAULT_POWER_THRESHOLDS,
  createPowerPolicy,
  isLowBattery,
  parsePmsetBattery,
  readBattery,
  simulatedBatteryReading,
  type BatteryReading,
  type CaffeinateProcess,
} from "../src/local/power/index.js";

class FakeProcess extends EventEmitter implements CaffeinateProcess {
  readonly pid: number;
  exitCode: number | null = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  spawn(): void {
    this.emit("spawn");
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.exitCode = 0;
    this.emit("exit", 0, signal === "SIGTERM" ? "SIGTERM" : null);
    return true;
  }
}

const battery = (overrides: Partial<BatteryReading> = {}): BatteryReading => ({
  batteryPercent: 50,
  charging: false,
  powerSource: "battery",
  remainingMinutes: null,
  simulated: false,
  ...overrides,
});

describe("pmset battery parsing", () => {
  it("parses battery power, whitespace, CRLF, and multi-hour estimates", () => {
    const output =
      "Now drawing from 'Battery Power'\r\n" +
      " -InternalBattery-0 (id=123)\t 8% ; discharging; 12:07 remaining present: true\r\n";

    expect(parsePmsetBattery(output)).toEqual({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 727,
      simulated: false,
    });
  });

  it("parses charged/no-estimate output without treating charged as charging", () => {
    const output =
      "Now drawing from 'AC Power'\n" +
      " -InternalBattery-0 (id=123) 100%; charged; (no estimate) present: true";

    expect(parsePmsetBattery(output)).toEqual({
      batteryPercent: 100,
      charging: false,
      powerSource: "ac",
      remainingMinutes: null,
      simulated: false,
    });
  });

  it("handles not-charging text and can infer a missing source header", () => {
    const output = "-InternalBattery-0 79%; AC attached; not charging; no estimate";
    expect(parsePmsetBattery(output)).toMatchObject({
      batteryPercent: 79,
      charging: false,
      powerSource: "ac",
    });
  });

  it("rejects missing or impossible percentages", () => {
    expect(() => parsePmsetBattery("Now drawing from 'AC Power'")).toThrow(
      "did not contain a battery percentage",
    );
    expect(() => parsePmsetBattery("InternalBattery-0 101%; charged")).toThrow(
      "invalid battery percentage",
    );
  });

  it("marks only explicitly simulated readings as simulated", () => {
    expect(
      simulatedBatteryReading({
        batteryPercent: 7,
        charging: false,
        powerSource: "battery",
        remainingMinutes: 20,
      }),
    ).toEqual({
      batteryPercent: 7,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 20,
      simulated: true,
    });
    expect(parsePmsetBattery("InternalBattery-0 7%; discharging", { simulated: true }).simulated)
      .toBe(true);
  });

  it("queries pmset without sudo and marks real command output as non-simulated", async () => {
    const executor = vi.fn(async () => ({
      stdout:
        "Now drawing from 'AC Power'\n" +
        " -InternalBattery-0 (id=123) 100%; finishing charge; 0:12 remaining",
      stderr: "",
      exitCode: 0,
    }));

    await expect(readBattery(executor)).resolves.toMatchObject({
      batteryPercent: 100,
      charging: true,
      powerSource: "ac",
      remainingMinutes: 12,
      simulated: false,
    });
    expect(executor).toHaveBeenCalledWith("/usr/bin/pmset", ["-g", "batt"]);
  });
});

describe("shared power policy", () => {
  it("uses one shared default threshold and permits validated overrides", () => {
    expect(DEFAULT_POWER_POLICY.thresholds).toBe(DEFAULT_POWER_THRESHOLDS);
    expect(isLowBattery(battery({ batteryPercent: 10 }))).toBe(true);
    expect(isLowBattery(battery({ batteryPercent: 11 }))).toBe(false);
    expect(isLowBattery(battery({ batteryPercent: 30 }), createPowerPolicy({
      lowBatteryPercent: 30,
    }))).toBe(true);
    expect(() => createPowerPolicy({ lowBatteryPercent: 101 })).toThrow(RangeError);
  });

  it("does not flag AC or charging readings as low battery", () => {
    expect(isLowBattery(battery({ batteryPercent: 1, powerSource: "ac" }))).toBe(false);
    expect(isLowBattery(battery({ batteryPercent: 1, charging: true }))).toBe(false);
  });
});

describe("caffeinate lifecycle", () => {
  it("uses a parent-bound, non-aggressive assertion and stops only its child", async () => {
    const child = new FakeProcess(456);
    const spawnProcess = vi.fn(() => child);
    const caffeine = new CaffeinateController({ spawnProcess, parentPid: 123 });

    const started = caffeine.start();
    child.spawn();
    await expect(started).resolves.toBe(456);
    await expect(caffeine.start()).resolves.toBe(456);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-w", "123"]);

    await expect(caffeine.restore()).resolves.toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(caffeine.active).toBe(false);
  });

  it("refuses to signal a child whose PID identity changed", async () => {
    const child = new FakeProcess(456);
    const caffeine = new CaffeinateController({ spawnProcess: () => child });
    const started = caffeine.start();
    child.spawn();
    await started;
    Object.defineProperty(child, "pid", { value: 999 });

    await expect(caffeine.stop()).rejects.toThrow("PID identity changed");
    expect(child.signals).toEqual([]);
  });
});

describe("Mac sleep gate", () => {
  it("does not restore or run pmset when confirmation is denied", async () => {
    const caffeine = {
      active: true,
      restore: vi.fn(async () => true),
      start: vi.fn(async () => 1),
    } satisfies SleepInhibitor;
    const commandExecutor = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const machine = new MacMachineController({ caffeinate: caffeine, commandExecutor });

    await expect(machine.requestSleep(async () => false)).resolves.toEqual({
      confirmed: false,
      sleepRequested: false,
    });
    expect(caffeine.restore).not.toHaveBeenCalled();
    expect(commandExecutor).not.toHaveBeenCalled();
  });

  it("runs bare pmset sleepnow only after confirmation and restore", async () => {
    const calls: string[] = [];
    const caffeine = {
      active: true,
      restore: vi.fn(async () => {
        calls.push("restore");
        return true;
      }),
      start: vi.fn(async () => 1),
    } satisfies SleepInhibitor;
    const commandExecutor = vi.fn(async (command: string, args: readonly string[]) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const machine = new MacMachineController({ caffeinate: caffeine, commandExecutor });

    await expect(
      machine.requestSleep(async () => {
        calls.push("confirmed");
        return true;
      }),
    ).resolves.toEqual({ confirmed: true, sleepRequested: true });
    expect(calls).toEqual(["confirmed", "restore", "/usr/bin/pmset sleepnow"]);
  });

  it("restores a prior inhibitor when pmset fails", async () => {
    const caffeine = {
      active: true,
      restore: vi.fn(async () => true),
      start: vi.fn(async () => 789),
    } satisfies SleepInhibitor;
    const machine = new MacMachineController({
      caffeinate: caffeine,
      commandExecutor: async () => ({ stdout: "", stderr: "denied", exitCode: 1 }),
    });

    await expect(machine.requestSleep(() => true)).rejects.toThrow("pmset sleepnow failed: denied");
    expect(caffeine.start).toHaveBeenCalledOnce();
  });

  it("restores a prior inhibitor when command execution throws", async () => {
    const caffeine = {
      active: true,
      restore: vi.fn(async () => true),
      start: vi.fn(async () => 789),
    } satisfies SleepInhibitor;
    const machine = new MacMachineController({
      caffeinate: caffeine,
      commandExecutor: async () => {
        throw new Error("spawn failed");
      },
    });

    await expect(machine.requestSleep(() => true)).rejects.toThrow("spawn failed");
    expect(caffeine.start).toHaveBeenCalledOnce();
  });
});
