import { canonicalJsonBytes } from "./canonical.js";
import { verifyDexSignature, type DexPinnedServerKey } from "./crypto.js";
import {
  DexSignedCommandSchema,
  type DexSignedCommand,
} from "./schemas.js";

export interface DexVerifiedCommand {
  id: string;
  issuedAt: string;
  expiresAt?: string;
  command: {
    type: string;
    payload: Record<string, unknown>;
  };
  authority: {
    kind: "verified_owner";
    ownerId: string;
    conversationId?: string;
    verified: true;
  };
  verified: true;
  signingKeyId: string;
}

export interface DexCommandVerifierOptions {
  pinnedServerKeys: readonly DexPinnedServerKey[];
  ownerId?: string;
  now?: () => number;
  maxFutureSkewMs?: number;
}

export class DexCommandVerificationError extends Error {
  readonly commandId?: string;

  constructor(message: string, commandId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DexCommandVerificationError";
    if (commandId !== undefined) this.commandId = commandId;
  }
}

export class DexCommandVerifier {
  readonly #keys: ReadonlyMap<string, DexPinnedServerKey>;
  readonly #ownerId: string | undefined;
  readonly #now: () => number;
  readonly #maxFutureSkewMs: number;

  constructor(options: DexCommandVerifierOptions) {
    const keys = new Map<string, DexPinnedServerKey>();
    for (const key of options.pinnedServerKeys) {
      if (key.algorithm !== "ed25519" || !key.keyId || !key.publicKey) {
        throw new TypeError("Invalid pinned Dex server key");
      }
      if (keys.has(key.keyId)) throw new TypeError(`Duplicate pinned Dex server key: ${key.keyId}`);
      keys.set(key.keyId, key);
    }
    this.#keys = keys;
    this.#ownerId = options.ownerId;
    this.#now = options.now ?? Date.now;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60_000;
  }

  verify(input: unknown): DexVerifiedCommand {
    let command: DexSignedCommand;
    try {
      command = DexSignedCommandSchema.parse(input);
    } catch (error) {
      throw new DexCommandVerificationError(
        "Dex command schema validation failed",
        undefined,
        { cause: error },
      );
    }

    const key = this.#keys.get(command.signature.keyId);
    if (!key) {
      throw new DexCommandVerificationError("Dex command was not signed by a pinned server key", command.id);
    }

    const { signature, ...unsigned } = command;
    if (!verifyDexSignature(canonicalJsonBytes(unsigned), signature.value, key.publicKey)) {
      throw new DexCommandVerificationError("Dex command signature verification failed", command.id);
    }
    if (!command.authority.verified || command.authority.kind !== "verified_owner") {
      throw new DexCommandVerificationError("Dex command does not carry verified-owner authority", command.id);
    }
    if (this.#ownerId !== undefined && command.authority.ownerId !== this.#ownerId) {
      throw new DexCommandVerificationError("Dex command authority does not match the paired owner", command.id);
    }

    const now = this.#now();
    if (Date.parse(command.issuedAt) > now + this.#maxFutureSkewMs) {
      throw new DexCommandVerificationError("Dex command issue time is in the future", command.id);
    }
    if (command.expiresAt !== undefined && Date.parse(command.expiresAt) <= now) {
      throw new DexCommandVerificationError("Dex command has expired", command.id);
    }

    return {
      id: command.id,
      issuedAt: command.issuedAt,
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
      command: {
        type: command.command.type,
        payload: command.command.payload,
      },
      authority: {
        kind: "verified_owner",
        ownerId: command.authority.ownerId,
        ...(command.authority.conversationId === undefined
          ? {}
          : { conversationId: command.authority.conversationId }),
        verified: true,
      },
      verified: true,
      signingKeyId: signature.keyId,
    };
  }

  verifyAll(commands: readonly unknown[]): DexVerifiedCommand[] {
    return commands.map((command) => this.verify(command));
  }
}

export function verifyDexCommand(
  command: unknown,
  options: DexCommandVerifierOptions,
): DexVerifiedCommand {
  return new DexCommandVerifier(options).verify(command);
}
