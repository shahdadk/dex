import os from "node:os";
import type { EventLog } from "../state/events.js";
import type { DexStateStore } from "../state/store.js";
import type { BatteryReading } from "./power/battery.js";
import { MacMachineController } from "./machine/mac-machine.js";

const THRESHOLDS = [20, 10, 5] as const;

export interface BatteryMonitorOptions {
  store: DexStateStore;
  events: EventLog;
  machine?: Pick<MacMachineController, "readBattery">;
  deviceId?: string;
  pollMs?: number;
  notify(text: string): Promise<void>;
}

export class BatteryMonitor {
  readonly #options: BatteryMonitorOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: BatteryMonitorOptions) {
    this.#options = options;
  }

  async handleBatteryReading(reading: BatteryReading): Promise<boolean> {
    let shouldAlert = false;
    let crossed: number | undefined;
    let activeTitles: string[] = [];
    await this.#options.store.updateState((state) => {
      const previous = state.machine;
      const alerts = reading.charging || reading.powerSource !== "battery"
        ? []
        : previous?.batteryAlertThresholds ?? [];
      crossed = THRESHOLDS.find(
        (threshold) => reading.batteryPercent <= threshold && !alerts.includes(threshold),
      );
      if (crossed !== undefined) alerts.push(crossed);
      state.machine = {
        id: previous?.id ?? this.#options.deviceId ?? "local-mac",
        hostname: previous?.hostname ?? os.hostname(),
        batteryPercent: reading.batteryPercent,
        charging: reading.charging,
        powerSource: reading.powerSource === "ac" ? "ac" : "battery",
        sleepPreventionActive: previous?.sleepPreventionActive ?? false,
        aggressiveLidModeActive: false,
        batteryAlertThresholds: alerts,
        updatedAt: new Date().toISOString(),
      };
      activeTitles = Object.values(state.tasks)
        .filter((task) => ["preparing", "running", "waiting_user", "checkpointing", "handoff"].includes(task.status))
        .filter((task) => {
          const worker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
          return worker?.target.kind === "local";
        })
        .map((task) => task.title);
      shouldAlert = crossed !== undefined && activeTitles.length > 0;
    });
    if (crossed !== undefined) {
      await this.#options.events.append({
        type: "battery.low",
        payload: {
          percent: reading.batteryPercent,
          charging: reading.charging,
          powerSource: reading.powerSource,
          simulated: reading.simulated,
          threshold: crossed,
          activeLocalTasks: activeTitles,
        },
      });
    }
    if (shouldAlert) {
      const taskText = activeTitles.length === 1 ? activeTitles[0] : `${activeTitles.length} tasks`;
      await this.#options.notify(
        `your mac is at ${reading.batteryPercent}%${reading.simulated ? " (demo reading)" : ""}. ${taskText} ${activeTitles.length === 1 ? "is" : "are"} still running locally. want me to keep the mac awake or move the work to the cloud?`,
      );
    }
    return shouldAlert;
  }

  start(): void {
    if (this.#timer) return;
    const machine = this.#options.machine ?? new MacMachineController();
    const poll = async () => {
      try {
        await this.handleBatteryReading(await machine.readBattery());
      } catch {
        // Doctor reports telemetry health; one failed poll must not stop Dex.
      }
    };
    void poll();
    this.#timer = setInterval(() => void poll(), this.#options.pollMs ?? 25_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
