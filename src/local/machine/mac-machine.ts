import { execFile, type ExecResult } from "../../utils/exec.js";
import {
  CaffeinateController,
  DEFAULT_POWER_POLICY,
  isLowBattery,
  readBattery,
  type BatteryReading,
  type PowerCommandExecutor,
  type PowerPolicy,
} from "../power/index.js";

export type SleepGate = () => boolean | Promise<boolean>;

export type SleepRequestResult =
  | { confirmed: false; sleepRequested: false }
  | { confirmed: true; sleepRequested: true };

export interface SleepInhibitor {
  readonly active: boolean;
  start(): Promise<number>;
  restore(): Promise<boolean>;
}

export interface MacMachineControllerOptions {
  commandExecutor?: PowerCommandExecutor;
  caffeinate?: SleepInhibitor;
  policy?: Readonly<PowerPolicy>;
}

export class MachineCommandError extends Error {
  readonly result: ExecResult;

  constructor(command: string, result: ExecResult) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    super(`${command} failed: ${detail}`);
    this.name = "MachineCommandError";
    this.result = result;
  }
}

export class MacMachineController {
  readonly #commandExecutor: PowerCommandExecutor;
  readonly #caffeinate: SleepInhibitor;
  readonly #policy: Readonly<PowerPolicy>;

  constructor(options: MacMachineControllerOptions = {}) {
    this.#commandExecutor = options.commandExecutor ?? execFile;
    this.#caffeinate = options.caffeinate ?? new CaffeinateController();
    this.#policy = options.policy ?? DEFAULT_POWER_POLICY;
  }

  get sleepPreventionActive(): boolean {
    return this.#caffeinate.active;
  }

  readBattery(): Promise<BatteryReading> {
    return readBattery(this.#commandExecutor);
  }

  batteryIsLow(reading: BatteryReading): boolean {
    return isLowBattery(reading, this.#policy);
  }

  preventIdleSleep(): Promise<number> {
    return this.#caffeinate.start();
  }

  restore(): Promise<boolean> {
    return this.#caffeinate.restore();
  }

  async requestSleep(confirm: SleepGate): Promise<SleepRequestResult> {
    // Confirmation is intentionally evaluated immediately before any local
    // power state changes. A rejected or failed gate leaves the Mac untouched.
    if ((await confirm()) !== true) {
      return { confirmed: false, sleepRequested: false };
    }

    const restoreInhibitorOnFailure = this.#caffeinate.active;
    await this.restore();

    try {
      const result = await this.#commandExecutor("/usr/bin/pmset", ["sleepnow"]);
      if (result.exitCode !== 0) {
        throw new MachineCommandError("pmset sleepnow", result);
      }
    } catch (error) {
      if (restoreInhibitorOnFailure) {
        try {
          await this.#caffeinate.start();
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "sleep failed and the prior sleep inhibitor could not be restored",
          );
        }
      }
      throw error;
    }

    return { confirmed: true, sleepRequested: true };
  }
}
