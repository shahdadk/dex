import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { DexPaths } from "./paths.js";

const LEGACY_GLOBAL_MODAL_CODEX_AUTH_VOLUME = "dex-codex-auth";
export const ModalCodexAuthVolumeNameSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9._-]{0,62})$/,
  "Modal Codex auth Volume name must be 1-63 lowercase letters, numbers, dots, underscores, or hyphens",
);

/** A stable, non-secret, per-device namespace for the refreshable Codex login. */
export function modalCodexAuthVolumeForDevice(deviceId: string): string {
  const normalized = z.string().trim().min(1).max(512).parse(deviceId);
  const suffix = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 20);
  return ModalCodexAuthVolumeNameSchema.parse(`dex-codex-auth-${suffix}`);
}

export const DexConfigSchema = z.object({
  version: z.literal(1).default(1),
  cloudUrl: z.string().url().optional(),
  deviceId: z.string().min(1).optional(),
  deviceName: z.string().min(1).optional(),
  deviceKeyId: z.string().min(1).optional(),
  modalCodexAuthVolume: ModalCodexAuthVolumeNameSchema.optional(),
  ownerId: z.string().min(1).optional(),
  pairedConversationId: z.string().min(1).optional(),
  sendblueLine: z.string().min(1).optional(),
  serverKeys: z.array(z.object({
    algorithm: z.literal("ed25519"),
    keyId: z.string().min(1),
    publicKey: z.string().min(1),
  }).strict()).default([]),
  defaultProjectId: z.string().min(1).optional(),
  defaultRepository: z.string().min(1).optional(),
  maxConcurrency: z.number().int().min(1).max(3).default(3),
  models: z.object({
    fastLane: z.literal("gemini-3.5-flash-lite").default("gemini-3.5-flash-lite"),
    brain: z.literal("gemini-3.7-flash").default("gemini-3.7-flash"),
  }).default({ fastLane: "gemini-3.5-flash-lite", brain: "gemini-3.7-flash" }),
});

export type DexConfig = z.infer<typeof DexConfigSchema>;

export interface LoadConfigOptions {
  /** Setup may migrate a paired legacy config to its deterministic device Volume. */
  allowLegacyPairedModalAuthVolume?: boolean;
}

export async function loadConfig(paths: DexPaths, options: LoadConfigOptions = {}): Promise<DexConfig> {
  let disk: unknown = {};
  try {
    disk = JSON.parse(await readFile(paths.config, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let environmentServerKeys: unknown;
  if (process.env.DEX_CLOUD_SERVER_KEYS_JSON) {
    try {
      environmentServerKeys = JSON.parse(process.env.DEX_CLOUD_SERVER_KEYS_JSON);
    } catch (error) {
      throw new Error("DEX_CLOUD_SERVER_KEYS_JSON is not valid JSON", { cause: error });
    }
  }
  const merged = {
    ...(typeof disk === "object" && disk !== null ? disk : {}),
    ...(process.env.DEX_CLOUD_URL ? { cloudUrl: process.env.DEX_CLOUD_URL } : {}),
    ...(process.env.DEX_DEVICE_ID ? { deviceId: process.env.DEX_DEVICE_ID } : {}),
    ...(process.env.DEX_DEVICE_KEY_ID ? { deviceKeyId: process.env.DEX_DEVICE_KEY_ID } : {}),
    ...(process.env.DEX_MODAL_CODEX_AUTH_VOLUME
      ? { modalCodexAuthVolume: process.env.DEX_MODAL_CODEX_AUTH_VOLUME }
      : {}),
    ...(process.env.DEX_SENDBLUE_LINE || process.env.SENDBLUE_NUMBER
      ? { sendblueLine: process.env.DEX_SENDBLUE_LINE ?? process.env.SENDBLUE_NUMBER }
      : {}),
    ...(environmentServerKeys === undefined ? {} : { serverKeys: environmentServerKeys }),
    ...(process.env.DEX_DEFAULT_REPOSITORY
      ? { defaultRepository: process.env.DEX_DEFAULT_REPOSITORY }
      : {}),
  };
  let config = DexConfigSchema.parse(merged);
  if (!config.deviceId) return config;

  const expectedVolume = modalCodexAuthVolumeForDevice(config.deviceId);
  const configuredVolume = config.modalCodexAuthVolume;
  if (configuredVolume !== expectedVolume) {
    const isLegacy = configuredVolume === undefined || configuredVolume === LEGACY_GLOBAL_MODAL_CODEX_AUTH_VOLUME;
    if (!options.allowLegacyPairedModalAuthVolume) {
      throw new Error(
        isLegacy
          ? "This paired Dex config predates per-device Codex auth isolation; run dex setup to migrate it safely"
          : "DEX_MODAL_CODEX_AUTH_VOLUME does not match this paired device; run dex setup to repair it safely",
      );
    }
    config = DexConfigSchema.parse({ ...config, modalCodexAuthVolume: expectedVolume });
  }

  // The existing daemon/mover boundary consumes this exact environment name.
  // Setup also persists it in Keychain and the LaunchAgent after provisioning.
  process.env.DEX_MODAL_CODEX_AUTH_VOLUME = expectedVolume;
  return config;
}
