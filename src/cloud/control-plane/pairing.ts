import { createHmac } from "node:crypto";
import { ControlPlaneError } from "./errors.js";
import type {
  PairingChallengeRecord,
  VerifiedConversationAssociation,
} from "./models.js";

const SETUP_CODE_PATTERN = /^[A-Z0-9_-]{16,128}$/;

export interface SetupCodePairingChallengeOptions {
  /** Server-side pepper; never persisted with challenge rows. */
  secret: string;
  ttlMs?: number;
  maxAttempts?: number;
}

export interface IdentifiedPairingCode {
  challengeId: string;
  codeDigest: string;
}

function validateSetupCode(code: string): void {
  if (!SETUP_CODE_PATTERN.test(code)) {
    throw new ControlPlaneError(401, "invalid_pairing_code", "Invalid pairing code");
  }
}

/** Converts a locally generated setup code into a server-peppered durable challenge. */
export class SetupCodePairingChallengeService {
  readonly #secret: string;
  readonly #ttlMs: number;
  readonly #maxAttempts: number;

  constructor(options: SetupCodePairingChallengeOptions) {
    if (options.secret.length < 16) {
      throw new TypeError("Pairing challenge HMAC secret must contain at least 16 characters");
    }
    this.#secret = options.secret;
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > 60 * 60_000) {
      throw new RangeError("Pairing challenge TTL must be between one second and one hour");
    }
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 20) {
      throw new RangeError("Pairing challenge attempts must be between one and twenty");
    }
  }

  identify(code: string): IdentifiedPairingCode {
    validateSetupCode(code);
    const codeDigest = createHmac("sha256", this.#secret)
      .update("dex-pairing-code-v1\0", "utf8")
      .update(code, "utf8")
      .digest("hex");
    return {
      challengeId: `pair_${codeDigest.slice(0, 24)}`,
      codeDigest,
    };
  }

  issue(
    setupCode: string,
    association: VerifiedConversationAssociation,
    sourceMessageId: string,
    issuedAtMs: number,
  ): PairingChallengeRecord {
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) {
      throw new RangeError("Pairing challenge time must be a positive safe integer");
    }
    const identified = this.identify(setupCode);
    return {
      id: identified.challengeId,
      codeDigest: identified.codeDigest,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + this.#ttlMs).toISOString(),
      ownerId: association.ownerId,
      conversationId: association.conversationId,
      phoneE164: association.phoneE164,
      sourceMessageId,
      attempts: 0,
      maxAttempts: this.#maxAttempts,
    };
  }
}
