import { z } from "zod";
import { execFile, type ExecResult } from "../../utils/exec.js";

export const DexStoredDeviceKeySchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("ed25519"),
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  pairedConversationId: z.string().min(1).optional(),
  cursor: z.string().optional(),
  nextSequence: z.number().int().positive().optional(),
}).strict();

export type DexStoredDeviceKey = z.infer<typeof DexStoredDeviceKeySchema>;

export interface DexDeviceKeychain {
  load(): Promise<DexStoredDeviceKey | null>;
  save(value: DexStoredDeviceKey): Promise<void>;
}

export type DexKeychainCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<ExecResult>;

export interface MacOSDexKeychainOptions {
  service?: string;
  account?: string;
  runner?: DexKeychainCommandRunner;
  platform?: NodeJS.Platform;
}

/**
 * Stores the device credential as one generic-password item. Commands are
 * always executable-plus-argv calls; no key material is interpolated into a
 * shell command or included in errors.
 */
export class MacOSDexKeychain implements DexDeviceKeychain {
  readonly #service: string;
  readonly #account: string;
  readonly #runner: DexKeychainCommandRunner;
  readonly #platform: NodeJS.Platform;

  constructor(options: MacOSDexKeychainOptions = {}) {
    this.#service = options.service ?? "com.dex.device.ed25519";
    this.#account = options.account ?? "device";
    this.#runner = options.runner ?? execFile;
    this.#platform = options.platform ?? process.platform;
    if (!this.#service || !this.#account) throw new TypeError("Dex Keychain service and account are required");
  }

  async load(): Promise<DexStoredDeviceKey | null> {
    this.#assertMacOS();
    const result = await this.#runner("/usr/bin/security", [
      "find-generic-password",
      "-s",
      this.#service,
      "-a",
      this.#account,
      "-w",
    ]);
    // security(1) uses 44 when the requested item does not exist.
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw new Error("Could not read the Dex device key from macOS Keychain");
    try {
      return DexStoredDeviceKeySchema.parse(JSON.parse(result.stdout) as unknown);
    } catch (error) {
      throw new Error("The Dex device key in macOS Keychain is invalid", { cause: error });
    }
  }

  async save(value: DexStoredDeviceKey): Promise<void> {
    this.#assertMacOS();
    const serialized = JSON.stringify(DexStoredDeviceKeySchema.parse(value));
    const result = await this.#runner("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-s",
      this.#service,
      "-a",
      this.#account,
      "-w",
      serialized,
    ]);
    if (result.exitCode !== 0) throw new Error("Could not save the Dex device key to macOS Keychain");
  }

  #assertMacOS(): void {
    if (this.#platform !== "darwin") throw new Error("Dex device keys require macOS Keychain");
  }
}

export const MacKeychain = MacOSDexKeychain;
export const MacOSKeychain = MacOSDexKeychain;
