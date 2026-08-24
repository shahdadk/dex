import { randomBytes } from "node:crypto";
import { canonicalJsonBytes } from "./canonical.js";
import { DEX_SIGNATURE_ALGORITHM, signDexBytes } from "./crypto.js";

export interface DexRequestMetadata {
  sequence: number;
  nonce: string;
  timestamp: number;
}

export interface DexRequestSequencerOptions {
  initialSequence?: number;
  now?: () => number;
  nonce?: (sequence: number) => string;
}

/**
 * Produces process-local monotonic request metadata. A server-provided sequence
 * floor lets a restarted device recover without maintaining a second store.
 */
export class DexRequestSequencer {
  #lastSequence: number;
  #lastTimestamp = 0;
  readonly #now: () => number;
  readonly #nonce: (sequence: number) => string;
  readonly #recentNonces = new Set<string>();

  constructor(options: DexRequestSequencerOptions = {}) {
    const initialSequence = options.initialSequence ?? 0;
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new RangeError("Initial Dex request sequence must be a non-negative safe integer");
    }
    this.#lastSequence = initialSequence;
    this.#now = options.now ?? Date.now;
    this.#nonce = options.nonce ?? ((sequence) =>
      `${sequence.toString(36)}.${randomBytes(18).toString("base64url")}`);
  }

  next(): DexRequestMetadata {
    if (this.#lastSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Dex request sequence exhausted");
    }
    const sequence = ++this.#lastSequence;
    const timestamp = Math.max(Math.trunc(this.#now()), this.#lastTimestamp + 1);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new RangeError("Dex request timestamp must be a positive safe integer");
    }
    this.#lastTimestamp = timestamp;

    const nonce = this.#nonce(sequence);
    if (!nonce || nonce.length > 512 || this.#recentNonces.has(nonce)) {
      throw new Error("Dex request nonce generator produced an invalid or repeated nonce");
    }
    this.#recentNonces.add(nonce);
    if (this.#recentNonces.size > 2048) {
      const oldest = this.#recentNonces.values().next().value;
      if (oldest !== undefined) this.#recentNonces.delete(oldest);
    }
    return { sequence, nonce, timestamp };
  }

  /** Ensure the next generated sequence is at least the supplied server floor. */
  setNextSequenceFloor(nextSequence: number): void {
    if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) return;
    this.#lastSequence = Math.max(this.#lastSequence, nextSequence - 1);
  }

  /**
   * Resynchronize to the exact sequence expected by the paired control plane.
   *
   * A process-local counter can be ahead after a request was signed but never
   * committed by the cloud (for example, a timeout or a rolled-back durable
   * transaction). A floor-only update can never recover from that state. This
   * method is intentionally used only for an explicit stale_sequence response
   * from the configured HTTPS control-plane endpoint.
   */
  resynchronizeNextSequence(nextSequence: number): void {
    if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) return;
    this.#lastSequence = nextSequence - 1;
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }
}

export interface DexRequestSignatureInput extends DexRequestMetadata {
  method: "POST";
  path: "/v1/device/pair" | "/v1/device/sync";
  keyId: string;
  deviceId?: string;
  contentSha256: string;
}

export function dexRequestSigningBytes(input: DexRequestSignatureInput): Uint8Array {
  return canonicalJsonBytes({
    version: 1,
    algorithm: DEX_SIGNATURE_ALGORITHM,
    method: input.method,
    path: input.path,
    keyId: input.keyId,
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    sequence: input.sequence,
    nonce: input.nonce,
    timestamp: input.timestamp,
    contentSha256: input.contentSha256,
  });
}

export function signDexRequest(
  input: DexRequestSignatureInput,
  privateKey: string,
): string {
  return signDexBytes(dexRequestSigningBytes(input), privateKey);
}
