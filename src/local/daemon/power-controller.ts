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
    await this.#enableKeepAwake(untilTasksComplete, true);
    if (untilTasksComplete) await this.maybeSleepWhenReady();
  }

  async requestSleep(when: "now" | "tasks_complete", conversationId: string): Promise<void> {
    await this.#options.store.updateState((state) => {
      state.pendingMachineActions = state.pendingMachineActions.filter(
        (item) => item.type !== "sleep" && item.type !== "restore",
      );
      state.pendingMachineActions.push({
        type: "sleep",
        trigger: when === "now" ? "now" : "all_tasks_complete",
        requestedAt: new Date().toISOString(),
        conversationId,
      });
    });
    if (when === "tasks_complete") await this.#enableKeepAwake(true, false);
    await this.maybeSleepWhenReady();
  }

  async maybeSleepWhenReady(): Promise<boolean> {
    const state = await this.#options.store.read();
    const pending = state.pendingMachineActions.find((item) => item.type === "sleep");
    if (!pending || !readyForSleep(state, pending.trigger)) {
      return this.#maybeRestoreWhenReady(state);
    }
    const conversationId = pending.conversationId;
    const activeCloud = Object.values(state.tasks).filter((task) => ACTIVE.has(task.status) && currentTarget(state, task) === "modal");
    const message = activeCloud.length > 0
      ? `${activeCloud.map((task) => task.title).join(" and ")} ${activeCloud.length === 1 ? "is" : "are"} running in the cloud. cloud ownership is confirmed, so i'm requesting sleep on this mac now.`
      : "everything is safely finished. i'm requesting sleep on this mac now.";
    const sleepPreventionWasActive = this.#machine.sleepPreventionActive;
    if (conversationId) {
      // This must be durably accepted by the cloud transport before pmset can
      // suspend the local relay. The wording reports intent rather than
      // falsely claiming that macOS has already slept.
      await this.#options.notify(conversationId, message);
    }
    try {
      const result = await this.#machine.requestSleep(async () => {
        const latest = await this.#options.store.read();
        return latest.pendingMachineActions.some(
          (item) => item.type === "sleep" && item.requestedAt === pending.requestedAt,
        ) && readyForSleep(latest, pending.trigger);
      });
      if (!result.sleepRequested) {
        if (conversationId) {
          await this.#options.notify(conversationId, "the task state changed before sleep, so i kept this mac awake.").catch(() => undefined);
        }
        return false;
      }
    } catch (error) {
      await this.#options.store.updateState((draft) => {
        if (draft.machine) {
          draft.machine.sleepPreventionActive = this.#machine.sleepPreventionActive;
          draft.machine.updatedAt = new Date().toISOString();
        }
      });
      if (conversationId) {
        await this.#options.notify(conversationId, "macOS rejected the sleep request, so this mac is still awake.").catch(() => undefined);
      }
      throw error;
    }
    await this.#options.store.updateState((draft) => {
      draft.pendingMachineActions = draft.pendingMachineActions.filter(
        (item) => !(item.type === "sleep" && item.requestedAt === pending.requestedAt),
      );
      if (draft.machine) {
        draft.machine.sleepPreventionActive = this.#machine.sleepPreventionActive;
        draft.machine.updatedAt = new Date().toISOString();
      }
    });
    await this.#options.events.append({
      type: "power.sleep_requested",
      payload: { trigger: pending.trigger, cloudTasks: activeCloud.map((task) => task.id) },
    });
    if (sleepPreventionWasActive) {
      await this.#options.events.append({ type: "power.keep_awake_disabled", payload: { reason: "sleep_requested" } });
    }
    return true;
  }

  async restore(): Promise<void> {
    const recordedActive = (await this.#options.store.read()).machine?.sleepPreventionActive === true;
    const restored = await this.#machine.restore();
    await this.#options.store.updateState((state) => {
      state.pendingMachineActions = [];
      if (state.machine) {
        state.machine.sleepPreventionActive = false;
        state.machine.updatedAt = new Date().toISOString();
      }
    });
    if (restored || recordedActive) {
      await this.#options.events.append({ type: "power.keep_awake_disabled", payload: { reason: "restore" } });
    }
  }

  async releaseForShutdown(): Promise<void> {
    await this.#machine.restore();
    await this.#options.store.updateState((state) => {
      if (state.machine) {
        state.machine.sleepPreventionActive = false;
        state.machine.updatedAt = new Date().toISOString();
      }
    });
  }

  async reconcileStartup(): Promise<void> {
    const state = await this.#options.store.read();
    const activeTasks = Object.values(state.tasks).some((task) => ACTIVE.has(task.status));
    const durableKeepAwake = state.pendingMachineActions.some((action) =>
      action.type === "restore" || (action.type === "sleep" && action.trigger === "all_tasks_complete"),
    );
    let pid: number | undefined;
    if (durableKeepAwake && activeTasks) {
      pid = await this.#machine.preventIdleSleep();
    } else {
      await this.#machine.restore();
    }
    await this.#options.store.updateState((draft) => {
      if (!activeTasks) {
        draft.pendingMachineActions = draft.pendingMachineActions.filter((action) => action.type !== "restore");
      }
      if (draft.machine) {
        draft.machine.sleepPreventionActive = this.#machine.sleepPreventionActive;
        draft.machine.updatedAt = new Date().toISOString();
      }
    });
    if (pid !== undefined && !state.machine?.sleepPreventionActive) {
      await this.#options.events.append({
        type: "power.keep_awake_enabled",
        payload: { pid, untilTasksComplete: true, reason: "startup_reconcile" },
      });
    }
  }

  async #enableKeepAwake(untilTasksComplete: boolean, persistRestore: boolean): Promise<void> {
    const pid = await this.#machine.preventIdleSleep();
    try {
      await this.#options.store.updateState((state) => {
        if (state.machine) {
          state.machine.sleepPreventionActive = true;
          state.machine.updatedAt = new Date().toISOString();
        }
        if (untilTasksComplete && persistRestore) {
          state.pendingMachineActions = state.pendingMachineActions.filter((action) => action.type !== "restore");
          state.pendingMachineActions.push({
            type: "restore",
            trigger: "all_tasks_complete",
            requestedAt: new Date().toISOString(),
          });
        }
      });
    } catch (error) {
      await this.#machine.restore().catch(() => undefined);
      throw error;
    }
    await this.#options.events.append({
      type: "power.keep_awake_enabled",
      payload: { pid, untilTasksComplete },
    });
  }

  async #maybeRestoreWhenReady(state: DexState): Promise<boolean> {
    const pending = state.pendingMachineActions.find((item) => item.type === "restore");
    if (!pending || Object.values(state.tasks).some((task) => ACTIVE.has(task.status))) return false;
    const restored = await this.#machine.restore();
    await this.#options.store.updateState((draft) => {
      draft.pendingMachineActions = draft.pendingMachineActions.filter(
        (item) => !(item.type === "restore" && item.requestedAt === pending.requestedAt),
      );
      if (draft.machine) {
        draft.machine.sleepPreventionActive = this.#machine.sleepPreventionActive;
        draft.machine.updatedAt = new Date().toISOString();
      }
    });
    if (restored || state.machine?.sleepPreventionActive) {
      await this.#options.events.append({
        type: "power.keep_awake_disabled",
        payload: { reason: "tasks_complete" },
      });
    }
    return true;
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
