import {
  DexCloudMessagingClient,
  createDexPairingPayload,
  generateDexDeviceKeyPair,
  type DexCloudMessagingClientOptions,
  type DexFetch,
  type DexPairingResponse,
  type DexPinnedServerKey,
} from "../../cloud/messaging/index.js";
import {
  MacOSDexKeychain,
  type DexDeviceKeychain,
  type DexStoredDeviceKey,
} from "./keychain.js";

export interface DexPairingServiceOptions {
  baseUrl: string;
  keychain?: DexDeviceKeychain;
  pinnedServerKeys: readonly DexPinnedServerKey[];
  fetch?: DexFetch;
  now?: () => number;
  nonce?: (sequence: number) => string;
}

export interface DexPairingInput {
  pairingCode: string;
  deviceName: string;
}

export interface DexPairingIdentity {
  deviceId: string;
  keyId: string;
  ownerId: string;
  pairedConversationId?: string;
  cursor?: string;
}

function publicIdentity(value: DexStoredDeviceKey): DexPairingIdentity {
  if (!value.deviceId || !value.ownerId) throw new Error("Dex device is not paired");
  return {
    deviceId: value.deviceId,
    keyId: value.keyId,
    ownerId: value.ownerId,
    ...(value.pairedConversationId === undefined
      ? {}
      : { pairedConversationId: value.pairedConversationId }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
  };
}

export class DexPairingService {
  readonly #options: DexPairingServiceOptions;
  readonly #keychain: DexDeviceKeychain;

  constructor(options: DexPairingServiceOptions) {
    if (options.pinnedServerKeys.length === 0) {
      throw new TypeError("Dex pairing requires at least one pinned server key");
    }
    this.#options = options;
    this.#keychain = options.keychain ?? new MacOSDexKeychain();
  }

  async pair(input: DexPairingInput): Promise<DexPairingIdentity> {
    let stored = await this.#keychain.load();
    if (!stored) {
      const generated = generateDexDeviceKeyPair();
      stored = { version: 1, ...generated };
      // Save before making a request so retrying setup retains one identity.
      await this.#keychain.save(stored);
    }

    const client = this.#client(stored);
    const response = await client.pair(createDexPairingPayload({
      pairingCode: input.pairingCode,
      deviceName: input.deviceName,
      keyId: stored.keyId,
      publicKey: stored.publicKey,
    }));
    this.#assertPairingResponse(response, stored);

    const paired: DexStoredDeviceKey = {
      ...stored,
      deviceId: response.deviceId,
      ownerId: response.ownerId,
      ...(response.pairedConversationId === undefined
        ? {}
        : { pairedConversationId: response.pairedConversationId }),
      ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
      ...(response.nextSequence === undefined
        ? {}
        : { nextSequence: response.nextSequence }),
    };
    await this.#keychain.save(paired);
    return publicIdentity(paired);
  }

  async loadIdentity(): Promise<DexPairingIdentity | null> {
    const stored = await this.#keychain.load();
    if (!stored || !stored.deviceId || !stored.ownerId) return null;
    return publicIdentity(stored);
  }

  async createClient(): Promise<DexCloudMessagingClient> {
    const stored = await this.#keychain.load();
    if (!stored || !stored.deviceId || !stored.ownerId) throw new Error("Dex device is not paired");
    return this.#client(stored);
  }

  #client(stored: DexStoredDeviceKey): DexCloudMessagingClient {
    const options: DexCloudMessagingClientOptions = {
      baseUrl: this.#options.baseUrl,
      keyPair: stored,
      pinnedServerKeys: this.#options.pinnedServerKeys,
      ...(stored.deviceId === undefined ? {} : { deviceId: stored.deviceId }),
      ...(stored.ownerId === undefined ? {} : { ownerId: stored.ownerId }),
      ...(stored.nextSequence === undefined
        ? {}
        : { initialSequence: stored.nextSequence - 1 }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      ...(this.#options.nonce === undefined ? {} : { nonce: this.#options.nonce }),
    };
    return new DexCloudMessagingClient(options);
  }

  #assertPairingResponse(response: DexPairingResponse, stored: DexStoredDeviceKey): void {
    if (response.keyId !== stored.keyId) {
      throw new Error("Dex pairing response references a different device key");
    }
  }
}

export const DexDevicePairing = DexPairingService;
