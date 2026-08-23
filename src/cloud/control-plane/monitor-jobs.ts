import type { MonitorJobRecord } from "./models.js";
import type { DurableMonitorJobRepository } from "./repository.js";

/** A Cloud Tasks adapter should use idempotencyKey as its provider task name. */
export interface MonitorJobDispatcher {
  dispatch(job: MonitorJobRecord): Promise<void>;
}

export interface MonitorJobOutboxOptions {
  repository: DurableMonitorJobRepository;
  dispatcher: MonitorJobDispatcher;
  now?: () => number;
  leaseMs?: number;
}

export class MonitorJobOutbox {
  readonly #repository: DurableMonitorJobRepository;
  readonly #dispatcher: MonitorJobDispatcher;
  readonly #now: () => number;
  readonly #leaseMs: number;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: MonitorJobOutboxOptions) {
    this.#repository = options.repository;
    this.#dispatcher = options.dispatcher;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000 || this.#leaseMs > 10 * 60_000) {
      throw new RangeError("Monitor dispatch lease must be between one second and ten minutes");
    }
  }

  dispatchPending(limit = 100): Promise<{ attempted: number; dispatched: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Monitor dispatch limit must be between one and 500");
    }
    const operation = this.#tail.then(async () => {
      const jobs = await this.#repository.claimPendingMonitorJobs(
        limit,
        new Date(this.#now()).toISOString(),
        this.#leaseMs,
      );
      let dispatched = 0;
      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index]!;
        try {
          await this.#dispatcher.dispatch(job);
          if (await this.#repository.markMonitorJobDispatched(
            job.id,
            new Date(this.#now()).toISOString(),
          )) {
            dispatched += 1;
          }
        } catch (error) {
          await Promise.all(jobs.slice(index).map((pending) =>
            this.#repository.releaseMonitorJob(pending.id)));
          throw error;
        }
      }
      return { attempted: jobs.length, dispatched };
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

export function createMonitorJobOutbox(options: MonitorJobOutboxOptions): MonitorJobOutbox {
  return new MonitorJobOutbox(options);
}
