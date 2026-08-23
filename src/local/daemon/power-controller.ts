import type { PowerController } from "../../dex/orchestrator.js";
import type { EventLog } from "../../state/events.js";
import type { DexState, DexTask } from "../../state/schemas.js";
import type { DexStateStore } from "../../state/store.js";
import { MacMachineController } from "../machine/mac-machine.js";

const ACTIVE = new Set(["queued", "preparing", "running", "waiting_user", "checkpointing", "handoff"]);

export interface DexPowerControllerOptions {
  store: DexStateStore;
  events: EventLog;
  machine?: MacMachineController;
  notify(conversationId: string, text: string): Promise<void>;
}

export class DexPowerController implements PowerController {
  readonly #options: DexPowerControllerOptions;
  readonly #machine: MacMachineController;

  constructor(options: DexPowerControllerOptions) {
    this.#options = options;
    this.#machine = options.machine ?? new MacMachineController();
  }

  async keepAwake(untilTasksComplete: boolean): Promise<void> {
    const pid = await this.#machine.preventIdleSleep();
    await this.#options.store.updateState((state) => {
      if (state.machine) {
        state.machine.sleepPreventionActive = true;
        state.machine.updatedAt = new Date().toISOString();
      }
      if (untilTasksComplete && !state.pendingMachineActions.some((action) => action.trigger === "all_tasks_complete")) {
        // The pending sleep action is intentionally not implied by keep-awake.
      }
    });
    await this.#options.events.append({
      type: "power.keep_awake_enabled",
      payload: { pid, untilTasksComplete },
    });
  }

  async requestSleep(when: "now" | "tasks_complete", conversationId: string): Promise<void> {
    await this.#options.store.updateState((state) => {
      state.pendingMachineActions = state.pendingMachineActions.filter((item) => item.type !== "sleep");
      state.pendingMachineActions.push({
        type: "sleep",
        trigger: when === "now" ? "now" : "all_tasks_complete",
        requestedAt: new Date().toISOString(),
        conversationId,
      });
    });
    if (when === "tasks_complete") await this.keepAwake(true);
    await this.maybeSleepWhenReady();
  }

  async maybeSleepWhenReady(): Promise<boolean> {
    const state = await this.#options.store.read();
    const pending = state.pendingMachineActions.find((item) => item.type === "sleep");
    if (!pending || !readyForSleep(state, pending.trigger)) return false;
    const conversationId = pending.conversationId;
    if (!conversationId) return false;
    const activeCloud = Object.values(state.tasks).filter((task) => ACTIVE.has(task.status) && currentTarget(state, task) === "modal");
    const message = activeCloud.length > 0
      ? `${activeCloud.map((task) => task.title).join(" and ")} ${activeCloud.length === 1 ? "is" : "are"} running in the cloud. sleeping this mac now.`
      : "everything is safely finished. sleeping this mac now.";
    // This acknowledgement is flushed by the caller before the local relay is
    // allowed to disappear.
    await this.#options.notify(conversationId, message);
    await this.#options.events.append({
      type: "power.sleep_requested",
      payload: { trigger: pending.trigger, cloudTasks: activeCloud.map((task) => task.id) },
    });
    // Flush local state before pmset; after a successful request the process
    // may stop running before another write can complete.
    await this.#options.store.updateState((draft) => {
      draft.pendingMachineActions = draft.pendingMachineActions.filter(
        (item) => !(item.type === "sleep" && item.requestedAt === pending.requestedAt),
      );
      if (draft.machine) {
        draft.machine.sleepPreventionActive = false;
        draft.machine.updatedAt = new Date().toISOString();
      }
    });
    await this.#options.events.append({ type: "power.keep_awake_disabled", payload: { reason: "sleep_requested" } });
    try {
      const result = await this.#machine.requestSleep(async () => {
        const latest = await this.#options.store.read();
        return readyForSleep(latest, pending.trigger);
      });
      if (!result.sleepRequested) throw new Error("Sleep safety gate changed before pmset");
    } catch (error) {
      await this.#options.store.updateState((draft) => {
        if (!draft.pendingMachineActions.some((item) => item.type === "sleep")) {
          draft.pendingMachineActions.push(pending);
        }
        if (draft.machine) {
          draft.machine.sleepPreventionActive = this.#machine.sleepPreventionActive;
          draft.machine.updatedAt = new Date().toISOString();
        }
      });
      throw error;
    }
    return true;
  }

  async restore(): Promise<void> {
    const restored = await this.#machine.restore();
    await this.#options.store.updateState((state) => {
      state.pendingMachineActions = [];
      if (state.machine) {
        state.machine.sleepPreventionActive = false;
        state.machine.updatedAt = new Date().toISOString();
      }
    });
    if (restored) await this.#options.events.append({ type: "power.keep_awake_disabled", payload: { reason: "restore" } });
  }
}

function currentTarget(state: DexState, task: DexTask): "local" | "modal" | undefined {
  if (!task.currentWorkerId) return undefined;
  return state.workers[task.currentWorkerId]?.target.kind;
}

function readyForSleep(state: DexState, trigger: "now" | "all_tasks_complete"): boolean {
  const active = Object.values(state.tasks).filter((task) => ACTIVE.has(task.status));
  if (trigger === "all_tasks_complete") return active.length === 0;
  if (active.some((task) => currentTarget(state, task) !== "modal")) return false;
  return active.every((task) => task.metadata.cloudMonitorAcknowledged === true);
}
