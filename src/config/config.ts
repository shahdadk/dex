import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { DexPaths } from "./paths.js";

export const DexConfigSchema = z.object({
  version: z.literal(1).default(1),
  cloudUrl: z.string().url().optional(),
  deviceId: z.string().min(1).optional(),
  deviceName: z.string().min(1).optional(),
  deviceKeyId: z.string().min(1).optional(),
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
  maxConcurrency: z.number().int().min(1).max(3).default(2),
  models: z.object({
    fastLane: z.literal("gemini-3.5-flash-lite").default("gemini-3.5-flash-lite"),
    brain: z.literal("gemini-3.7-flash").default("gemini-3.7-flash"),
  }).default({ fastLane: "gemini-3.5-flash-lite", brain: "gemini-3.7-flash" }),
});

export type DexConfig = z.infer<typeof DexConfigSchema>;

export async function loadConfig(paths: DexPaths): Promise<DexConfig> {
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
    ...(process.env.DEX_SENDBLUE_LINE || process.env.SENDBLUE_NUMBER
      ? { sendblueLine: process.env.DEX_SENDBLUE_LINE ?? process.env.SENDBLUE_NUMBER }
      : {}),
    ...(environmentServerKeys === undefined ? {} : { serverKeys: environmentServerKeys }),
    ...(process.env.DEX_DEFAULT_REPOSITORY
      ? { defaultRepository: process.env.DEX_DEFAULT_REPOSITORY }
      : {}),
  };
  return DexConfigSchema.parse(merged);
}
