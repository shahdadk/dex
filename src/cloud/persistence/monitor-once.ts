import { sha256Hex } from "../messaging/index.js";
import type { ModalMonitorOnce } from "../modal-monitor/index.js";
import type { DexCloudStateBackend } from "./backend.js";

export interface DurableModalMonitorOnceOptions {
  backend: DexCloudStateBackend;
  workerId: string;
  now?: () => number;
  leaseMs?: number;
}

/** Durable lease around idempotent monitor effects (schedule and terminal callback). */
export class DurableModalMonitorOnce implements ModalMonitorOnce {
  readonly #backend: DexCloudStateBackend;
  readonly #workerId: string;
  readonly #now: () => number;
  readonly #leaseMs: number;

  constructor(options: DurableModalMonitorOnceOptions) {
    const leaseMs = options.leaseMs ?? 60_000;
    if (!options.workerId || options.workerId.length > 512) {
      throw new TypeError("A bounded monitor worker ID is required");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
      throw new RangeError("Monitor effect lease must be between one second and ten minutes");
    }
    this.#backend = options.backend;
    this.#workerId = options.workerId;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = leaseMs;
  }

  async runOnce(key: string, effect: () => Promise<void>): Promise<boolean> {
    const startedAtMs = this.#now();
    const startedAt = new Date(startedAtMs).toISOString();
    const claimToken = `monitor_effect_${sha256Hex(
      `${key}:${this.#workerId}:${startedAt}`,
    ).slice(0, 32)}`;
    const claimed = await this.#backend.mutate((state) => {
      const existing = state.monitorEffects[key];
      if (existing?.state === "completed") return false;
      if (
        existing?.state === "running" &&
        Date.parse(existing.claimExpiresAt) > startedAtMs
      ) return false;
      state.monitorEffects[key] = {
        state: "running",
        claimToken,
        claimedAt: startedAt,
        claimExpiresAt: new Date(startedAtMs + this.#leaseMs).toISOString(),
      };
      return true;
    });
    if (!claimed) return false;

    try {
      await effect();
      const completedAt = new Date(this.#now()).toISOString();
      await this.#backend.mutate((state) => {
        const current = state.monitorEffects[key];
        if (current?.claimToken !== claimToken) return;
        state.monitorEffects[key] = {
          ...current,
          state: "completed",
          completedAt,
        };
      });
      return true;
    } catch (error) {
      await this.#backend.mutate((state) => {
        if (state.monitorEffects[key]?.claimToken === claimToken) {
          delete state.monitorEffects[key];
        }
      }).catch(() => undefined);
      throw error;
    }
  }
}
