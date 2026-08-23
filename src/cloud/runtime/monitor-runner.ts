import {
  MonitorJobOutbox,
  type MonitorJobRecord,
} from "../control-plane/index.js";
import {
  ModalMonitor,
  type ModalMonitorOutcome,
  type ModalMonitorOnce,
} from "../modal-monitor/index.js";
import type { ModalAdapter } from "../modal/index.js";
import type { DurableDexCloudRepository } from "../persistence/index.js";

export interface DeterministicMonitorRunnerOptions {
  repository: DurableDexCloudRepository;
  modal: Pick<ModalAdapter, "fromId">;
  once: ModalMonitorOnce;
  onTerminal(input: unknown): Promise<void>;
  now?: () => number;
  leaseMs?: number;
}

export interface MonitorDrainResult {
  initialAttempted: number;
  initialCompleted: number;
  scheduledAttempted: number;
  scheduledCompleted: number;
  outcomes: ModalMonitorOutcome[];
}

export class DeterministicMonitorRunner {
  readonly #repository: DurableDexCloudRepository;
  readonly #monitor: ModalMonitor;
  readonly #now: () => number;
  readonly #leaseMs: number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: DeterministicMonitorRunnerOptions) {
    const leaseMs = options.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
      throw new RangeError("Monitor runner lease must be between one second and ten minutes");
    }
    this.#repository = options.repository;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = leaseMs;
    this.#monitor = new ModalMonitor({
      modal: options.modal,
      once: options.once,
      now: this.#now,
      schedule: async (schedule) => {
        await this.#repository.enqueueScheduledMonitor(
          schedule,
          new Date(this.#now()).toISOString(),
        );
      },
      onTerminal: options.onTerminal,
    });
  }

  drain(limit = 25): Promise<MonitorDrainResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Monitor drain limit must be between one and 100");
    }
    const operation = this.#tail.then(() => this.#drain(limit));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async #drain(limit: number): Promise<MonitorDrainResult> {
    const outcomes: ModalMonitorOutcome[] = [];
    const initial = new MonitorJobOutbox({
      repository: this.#repository,
      dispatcher: {
        dispatch: async (job: MonitorJobRecord) => {
          outcomes.push(await this.#monitor.run(job.request));
        },
      },
      now: this.#now,
      leaseMs: this.#leaseMs,
    });
    const initialResult = await initial.dispatchPending(limit);

    const claimedAt = new Date(this.#now()).toISOString();
    const claims = await this.#repository.claimScheduledMonitors(
      limit,
      claimedAt,
      this.#leaseMs,
    );
    let completed = 0;
    for (let index = 0; index < claims.length; index += 1) {
      const claim = claims[index]!;
      try {
        outcomes.push(await this.#monitor.run(claim.job.request));
        if (await this.#repository.settleScheduledMonitor(
          claim.job.id,
          claim.claimToken,
          new Date(this.#now()).toISOString(),
        )) completed += 1;
      } catch (error) {
        await Promise.all(claims.slice(index).map((pending) =>
          this.#repository.releaseScheduledMonitor(pending.job.id, pending.claimToken)));
        throw error;
      }
    }
    return {
      initialAttempted: initialResult.attempted,
      initialCompleted: initialResult.dispatched,
      scheduledAttempted: claims.length,
      scheduledCompleted: completed,
      outcomes,
    };
  }
}
