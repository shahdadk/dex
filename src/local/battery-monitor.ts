import { randomUUID } from "node:crypto";
import os from "node:os";
import type { EventLog } from "../state/events.js";
import type { DexStateStore } from "../state/store.js";
import type { BatteryReading } from "./power/battery.js";
import { MacMachineController } from "./machine/mac-machine.js";

const THRESHOLDS = [20, 10, 5] as const;
const DEFAULT_PROMPT_TTL_MS = 15 * 60_000;
const ACTIVE_TASK_STATUSES = new Set([
  "preparing",
  "running",
  "waiting_user",
  "checkpointing",
  "handoff",
]);

export interface BatteryMonitorOptions {
  store: DexStateStore;
  events: EventLog;
  machine?: Pick<MacMachineController, "readBattery">;
  deviceId?: string;
  conversationId?: string;
  pollMs?: number;
  promptTtlMs?: number;
  now?: () => Date;
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
    let activeTaskIds: string[] = [];
    const now = this.#options.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const promptTtlMs = this.#options.promptTtlMs ?? DEFAULT_PROMPT_TTL_MS;
    if (!Number.isFinite(promptTtlMs) || promptTtlMs <= 0) {
      throw new RangeError("promptTtlMs must be positive");
    }
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
        batteryReadingSimulated: reading.simulated,
        charging: reading.charging,
        powerSource: reading.powerSource === "ac" ? "ac" : "battery",
        sleepPreventionActive: previous?.sleepPreventionActive ?? false,
        aggressiveLidModeActive: false,
        batteryAlertThresholds: alerts,
        updatedAt: nowIso,
      };
      const activeLocalTasks = Object.values(state.tasks)
        .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
        .filter((task) => {
          const worker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
          return worker?.target.kind === "local";
        });
      activeTitles = activeLocalTasks.map((task) => task.title);
      activeTaskIds = activeLocalTasks.map((task) => task.id);
      shouldAlert = crossed !== undefined && activeTitles.length > 0;
      state.pendingConversationPrompts = state.pendingConversationPrompts.filter(
        (prompt) => Date.parse(prompt.expiresAt) > now.getTime(),
      );
      if (shouldAlert && this.#options.conversationId) {
        state.pendingConversationPrompts = state.pendingConversationPrompts.filter(
          (prompt) => !(prompt.type === "battery.low" && prompt.conversationId === this.#options.conversationId),
        );
        state.pendingConversationPrompts.push({
          id: randomUUID(),
          type: "battery.low",
          conversationId: this.#options.conversationId,
          taskIds: activeTaskIds,
          createdAt: nowIso,
          expiresAt: new Date(now.getTime() + promptTtlMs).toISOString(),
        });
      }
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
        `your mac is at ${reading.batteryPercent}%${reading.simulated ? " (demo reading)" : ""}. ${taskText} ${activeTitles.length === 1 ? "is" : "are"} still running locally. move ${activeTitles.length === 1 ? "it" : "them"} to Codex in Modal? reply yes to move ${activeTitles.length === 1 ? "it" : "them"}, or no to leave ${activeTitles.length === 1 ? "it" : "them"} local.`,
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
