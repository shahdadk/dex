import type { PowerController } from "../../dex/orchestrator.js";
import type { EventLog } from "../../state/events.js";
import type { DexState, DexTask } from "../../state/schemas.js";
import type { DexStateStore } from "../../state/store.js";
import { eventId } from "../../utils/ids.js";
import { MacMachineController } from "../machine/mac-machine.js";
import type { DrainedTransportResult } from "./cloud-bridge.js";

const ACTIVE = new Set(["queued", "preparing", "running", "waiting_user", "checkpointing", "handoff"]);

type PendingSleepAction = Extract<
  DexState["pendingMachineActions"][number],
  { type: "sleep" }
>;

type SleepAttemptOutcome =
  | { kind: "requested" }
  | { kind: "not_ready" }
  | { kind: "failed"; error: unknown };

export interface DexPowerControllerOptions {
  store: DexStateStore;
  events: EventLog;
  machine?: MacMachineController;
  notify(conversationId: string, text: string, stableEventId?: string): Promise<void>;
  transportBarrier?<T>(effect: () => Promise<T>): Promise<DrainedTransportResult<T>>;
  durabilityGate?(state: DexState): boolean;
}

export class DexPowerController implements PowerController {
  readonly #options: DexPowerControllerOptions;
  readonly #machine: MacMachineController;
  #sleepTail: Promise<unknown> = Promise.resolve();

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
        notificationEventId: eventId(),
        phase: "notification_pending",
      });
    });
    if (when === "tasks_complete") await this.#enableKeepAwake(true, false);
    await this.maybeSleepWhenReady();
  }

  async maybeSleepWhenReady(): Promise<boolean> {
    const result = this.#sleepTail.then(
      () => this.#maybeSleepWhenReady(),
      () => this.#maybeSleepWhenReady(),
    );
    this.#sleepTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #maybeSleepWhenReady(): Promise<boolean> {
    let state = await this.#options.store.read();
    let pending = state.pendingMachineActions.find((item) => item.type === "sleep");
    if (!pending || !readyForSleep(state, pending.trigger, this.#options.durabilityGate)) {
      return this.#maybeRestoreWhenReady(state);
    }
    pending = await this.#prepareSleepJournal(pending);
    if (!pending || pending.phase === "sleep_claimed") return false;
    state = await this.#options.store.read();
    if (!readyForSleep(state, pending.trigger, this.#options.durabilityGate)) return false;
    const conversationId = pending.conversationId;
    const activeCloud = Object.values(state.tasks).filter((task) => ACTIVE.has(task.status) && currentTarget(state, task) === "modal");
    const message = activeCloud.length > 0
      ? `${activeCloud.map((task) => task.title).join(" and ")} ${activeCloud.length === 1 ? "is" : "are"} running in the cloud. cloud ownership is confirmed, so i'm requesting sleep on this mac now.`
      : "everything is safely finished. i'm requesting sleep on this mac now.";
    const sleepPreventionWasActive = this.#machine.sleepPreventionActive;
    if (conversationId && pending.phase === "notification_pending") {
      // This must be durably accepted by the cloud transport before pmset can
      // suspend the local relay. The wording reports intent rather than
      // falsely claiming that macOS has already slept.
      await this.#options.notify(conversationId, message, pending.notificationEventId);
      const accepted = await this.#acceptSleepNotification(pending);
      if (!accepted) return false;
      pending = accepted;
    } else if (!conversationId && pending.phase === "notification_pending") {
      const accepted = await this.#acceptSleepNotification(pending);
      if (!accepted) return false;
      pending = accepted;
    }
    const attempt = () => this.#requestSleepOnce(
      pending,
      activeCloud.map((task) => task.id),
      sleepPreventionWasActive,
    );
    const barrierResult = this.#options.transportBarrier
      ? await this.#options.transportBarrier(attempt)
      : await this.#withoutTransportBarrier(attempt);
    if (!barrierResult.drained) return false;

    const outcome = barrierResult.value;
    if (outcome.kind === "not_ready") {
      if (conversationId) {
        await this.#options.notify(conversationId, "the task state changed before sleep, so i kept this mac awake.").catch(() => undefined);
      }
      return false;
    }
    if (outcome.kind === "failed") {
      if (conversationId) {
        await this.#options.notify(conversationId, "macOS rejected the sleep request, so this mac is still awake.").catch(() => undefined);
      }
      throw outcome.error;
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

  async #prepareSleepJournal(
    pending: PendingSleepAction,
  ): Promise<PendingSleepAction | undefined> {
    const generatedEventId = eventId();
    let prepared: PendingSleepAction | undefined;
    await this.#options.store.updateState((state) => {
      const current = state.pendingMachineActions.find(
        (item): item is PendingSleepAction =>
          item.type === "sleep" && item.requestedAt === pending.requestedAt,
      );
      if (!current) return;
      current.notificationEventId ??= generatedEventId;
      current.phase ??= "notification_pending";
      prepared = structuredClone(current);
    });
    return prepared;
  }

  async #acceptSleepNotification(
    pending: PendingSleepAction,
  ): Promise<PendingSleepAction | undefined> {
    let accepted: PendingSleepAction | undefined;
    await this.#options.store.updateState((state) => {
      const current = state.pendingMachineActions.find(
        (item): item is PendingSleepAction =>
          item.type === "sleep" &&
          item.requestedAt === pending.requestedAt &&
          item.notificationEventId === pending.notificationEventId,
      );
      if (!current || current.phase === "sleep_claimed") return;
      if (current.phase === "notification_accepted") {
        accepted = structuredClone(current);
        return;
      }
      const eventId = current.notificationEventId;
      if (
        !eventId ||
        state.pendingTransportEvents.some((event) => event.id === eventId) ||
        state.quarantinedTransportEvents.some((event) => event.id === eventId)
      ) {
        return;
      }
      current.phase = "notification_accepted";
      accepted = structuredClone(current);
    });
    return accepted;
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

  async #withoutTransportBarrier<T>(
    effect: () => Promise<T>,
  ): Promise<DrainedTransportResult<T>> {
    const state = await this.#options.store.read();
    if (!transportIsDrained(state)) return { drained: false };
    return { drained: true, value: await effect() };
  }

  async #requestSleepOnce(
    pending: PendingSleepAction,
    cloudTaskIds: string[],
    sleepPreventionWasActive: boolean,
  ): Promise<SleepAttemptOutcome> {
    let claimed = false;
    await this.#options.store.updateState((state) => {
      const stillPending = state.pendingMachineActions.some(
        (item) => item.type === "sleep" &&
          item.requestedAt === pending.requestedAt &&
          item.notificationEventId === pending.notificationEventId &&
          item.phase === "notification_accepted",
      );
      if (
        !stillPending ||
        !transportIsDrained(state) ||
        !readyForSleep(state, pending.trigger, this.#options.durabilityGate)
      ) {
        return;
      }
      // This durable phase transition is the at-most-once claim for the external power
      // effect. If the process dies after pmset succeeds, startup sees no
      // replayable request and therefore cannot put a newly-awake Mac to sleep a
      // second time. A crash before pmset intentionally fails safe by losing
      // the request rather than risking replay.
      const current = state.pendingMachineActions.find(
        (item): item is PendingSleepAction => item.type === "sleep" &&
          item.requestedAt === pending.requestedAt &&
          item.notificationEventId === pending.notificationEventId,
      );
      if (!current) return;
      current.phase = "sleep_claimed";
      claimed = true;
    });
    if (!claimed) return { kind: "not_ready" };

    try {
      const result = await this.#machine.requestSleep(async () => {
        const latest = await this.#options.store.read();
        return transportIsDrained(latest) && readyForSleep(
          latest,
          pending.trigger,
          this.#options.durabilityGate,
        );
      });
      if (!result.sleepRequested) {
        await this.#removeClaimedSleepAction(pending);
        return { kind: "not_ready" };
      }
    } catch (error) {
      // Command failure can be ambiguous after dispatch, so never make the
      // consumed claim replayable again. The user can issue a fresh request
      // after Dex reports that this Mac is still awake.
      await this.#options.store.updateState((state) => {
        state.pendingMachineActions = state.pendingMachineActions.filter(
          (item) => !(item.type === "sleep" &&
            item.requestedAt === pending.requestedAt &&
            item.notificationEventId === pending.notificationEventId &&
            item.phase === "sleep_claimed"),
        );
        if (state.machine) {
          state.machine.sleepPreventionActive = this.#machine.sleepPreventionActive;
          state.machine.updatedAt = new Date().toISOString();
        }
      });
      return { kind: "failed", error };
    }

    // The external effect has succeeded and must never be made replayable
    // again. Any failure in this diagnostic bookkeeping propagates while the
    // already-consumed sleep claim remains absent.
    await this.#options.store.updateState((state) => {
      state.pendingMachineActions = state.pendingMachineActions.filter(
        (item) => !(item.type === "sleep" &&
          item.requestedAt === pending.requestedAt &&
          item.notificationEventId === pending.notificationEventId &&
          item.phase === "sleep_claimed"),
      );
      if (state.machine) {
        state.machine.sleepPreventionActive = this.#machine.sleepPreventionActive;
        state.machine.updatedAt = new Date().toISOString();
      }
    });
    await this.#options.events.append({
      type: "power.sleep_requested",
      payload: { trigger: pending.trigger, cloudTasks: cloudTaskIds },
    });
    if (sleepPreventionWasActive) {
      await this.#options.events.append({ type: "power.keep_awake_disabled", payload: { reason: "sleep_requested" } });
    }
    return { kind: "requested" };
  }

  async #removeClaimedSleepAction(pending: PendingSleepAction): Promise<void> {
    await this.#options.store.updateState((state) => {
      state.pendingMachineActions = state.pendingMachineActions.filter(
        (item) => !(item.type === "sleep" &&
          item.requestedAt === pending.requestedAt &&
          item.notificationEventId === pending.notificationEventId &&
          item.phase === "sleep_claimed"),
      );
    });
  }
}

function currentTarget(state: DexState, task: DexTask): "local" | "modal" | undefined {
  if (!task.currentWorkerId) return undefined;
  return state.workers[task.currentWorkerId]?.target.kind;
}

function readyForSleep(
  state: DexState,
  trigger: "now" | "all_tasks_complete",
  durabilityGate?: (state: DexState) => boolean,
): boolean {
  if (!(durabilityGate ?? cloudCompletionEffectsAreDurable)(state)) return false;
  const active = Object.values(state.tasks).filter((task) => ACTIVE.has(task.status));
  if (trigger === "all_tasks_complete") return active.length === 0;
  if (active.some((task) => currentTarget(state, task) !== "modal")) return false;
  return active.every((task) => task.metadata.cloudMonitorAcknowledged === true);
}

function transportIsDrained(state: DexState): boolean {
  return state.pendingTransportEvents.length === 0 && state.pendingTransportReceipts.length === 0;
}

function cloudCompletionEffectsAreDurable(state: DexState): boolean {
  const required = [
    "sandboxTerminated",
    "eventAppended",
    "leaseReleased",
    "queueDrained",
    "receiptQueued",
    "receiptAccepted",
  ] as const;
  for (const task of Object.values(state.tasks)) {
    const raw = task.metadata.cloudCompletionEffects;
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const journal = raw as Record<string, unknown>;
    if (journal.phase !== "pending" && journal.phase !== "complete") return false;
    const effects = journal.effects;
    if (!effects || typeof effects !== "object" || Array.isArray(effects)) return false;
    const record = effects as Record<string, unknown>;
    if (required.some((name) => record[name] !== true)) return false;
    if (typeof record.powerChecked !== "boolean") return false;
  }
  return true;
}
