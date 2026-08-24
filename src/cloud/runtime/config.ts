import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  dexKeyId,
  dexPrivateKeyObject,
  dexPublicKeyObject,
  type DexDeviceKeyPair,
} from "../messaging/index.js";
import type { ConfiguredOwnerAssociation } from "./association.js";

const E164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/);
const IdentifierSchema = z.string().trim().min(1).max(512);
const AssociationSchema = z.object({
  ownerId: IdentifierSchema,
  conversationId: IdentifierSchema,
  phoneE164: E164Schema,
  sendblueNumber: E164Schema.optional(),
  providerConversationId: IdentifierSchema.optional(),
}).strict();

export interface DexCloudConfig {
  environment: "production" | "development" | "test";
  persistence:
    | { kind: "postgres"; databaseUrl: string; ssl?: boolean | { rejectUnauthorized: boolean } }
    | {
        kind: "cloud-sql";
        instanceConnectionName: string;
        database: string;
        user: string;
        ipType: "PUBLIC" | "PRIVATE";
      }
    | { kind: "file"; filePath: string };
  signingKey: DexDeviceKeyPair;
  ownerAssociations: ConfiguredOwnerAssociation[];
  sendblue: {
    apiKeyId: string;
    apiSecretKey: string;
    line: string;
    webhookSecret: string;
    statusCallback?: string;
  };
  internalSecret: string;
  host: string;
  port: number;
  workerId: string;
  pollIntervalMs: number;
  cloudTasks?: {
    project: string;
    location: string;
    queue: string;
    serviceUrl: string;
    audience: string;
    serviceAccountEmail: string;
  };
}

function required(env: NodeJS.ProcessEnv, name: string, minimum = 1): string {
  const value = env[name];
  if (value === undefined || value.length < minimum || /[\u0000\r]/.test(value)) {
    throw new TypeError(`${name} is required and invalid`);
  }
  return value;
}

function requiredOneOf(env: NodeJS.ProcessEnv, names: string[], minimum = 1): string {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) return required(env, name, minimum);
  }
  throw new TypeError(`${names.join(" or ")} is required and invalid`);
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizedPem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

async function loadSigningKey(env: NodeJS.ProcessEnv): Promise<DexDeviceKeyPair> {
  const inline = env.DEX_SERVER_SIGNING_PRIVATE_KEY;
  const file = env.DEX_SERVER_SIGNING_PRIVATE_KEY_FILE;
  if ((inline === undefined) === (file === undefined)) {
    throw new TypeError(
      "Set exactly one of DEX_SERVER_SIGNING_PRIVATE_KEY or DEX_SERVER_SIGNING_PRIVATE_KEY_FILE",
    );
  }
  let supplied: string;
  try {
    supplied = inline === undefined
      ? await readFile(path.resolve(file!), "utf8")
      : normalizedPem(inline);
    const privateKey = dexPrivateKeyObject(supplied);
    const publicKeyObject = createPublicKey(privateKey);
    const publicKey = publicKeyObject.export({ format: "pem", type: "spki" }).toString();
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const keyId = dexKeyId(publicKeyObject);
    const configuredPublic = env.DEX_SERVER_SIGNING_PUBLIC_KEY;
    if (
      configuredPublic !== undefined &&
      dexKeyId(dexPublicKeyObject(normalizedPem(configuredPublic))) !== keyId
    ) {
      throw new TypeError("Configured server signing public key does not match the private key");
    }
    if (env.DEX_SERVER_SIGNING_KEY_ID !== undefined && env.DEX_SERVER_SIGNING_KEY_ID !== keyId) {
      throw new TypeError("Configured server signing key ID does not match the key material");
    }
    return { algorithm: "ed25519", keyId, publicKey, privateKey: privateKeyPem };
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Configured server")) throw error;
    throw new TypeError("Dex server signing key could not be loaded");
  }
}

function parseAssociations(env: NodeJS.ProcessEnv): ConfiguredOwnerAssociation[] {
  let raw: unknown;
  try {
    raw = JSON.parse(required(env, "DEX_OWNER_ALLOWLIST_JSON")) as unknown;
  } catch {
    throw new TypeError("DEX_OWNER_ALLOWLIST_JSON must be valid JSON");
  }
  const parsed = z.array(AssociationSchema).min(1).max(1_000).safeParse(raw);
  if (!parsed.success) throw new TypeError("DEX_OWNER_ALLOWLIST_JSON is invalid");
  return parsed.data.map((association) => ({
    ownerId: association.ownerId,
    conversationId: association.conversationId,
    phoneE164: association.phoneE164,
    ...(association.sendblueNumber === undefined
      ? {}
      : { sendblueNumber: association.sendblueNumber }),
    ...(association.providerConversationId === undefined
      ? {}
      : { providerConversationId: association.providerConversationId }),
  }));
}

function persistence(
  env: NodeJS.ProcessEnv,
  environment: DexCloudConfig["environment"],
): DexCloudConfig["persistence"] {
  const databaseUrl = env.DEX_DATABASE_URL;
  const cloudSqlInstance = env.DEX_CLOUD_SQL_INSTANCE;
  if (databaseUrl && cloudSqlInstance) {
    throw new TypeError("Set only one of DEX_DATABASE_URL or DEX_CLOUD_SQL_INSTANCE");
  }
  if (databaseUrl) {
    const sslMode = env.DEX_DATABASE_SSL_MODE ?? "disable";
    if (!(["disable", "require", "verify-full"] as const).includes(
      sslMode as "disable" | "require" | "verify-full",
    )) {
      throw new TypeError("DEX_DATABASE_SSL_MODE must be disable, require, or verify-full");
    }
    return {
      kind: "postgres",
      databaseUrl,
      ...(sslMode === "disable"
        ? {}
        : { ssl: sslMode === "verify-full" ? true : { rejectUnauthorized: false } }),
    };
  }
  if (cloudSqlInstance) {
    const ipType = env.DEX_CLOUD_SQL_IP_TYPE ?? "PUBLIC";
    if (ipType !== "PUBLIC" && ipType !== "PRIVATE") {
      throw new TypeError("DEX_CLOUD_SQL_IP_TYPE must be PUBLIC or PRIVATE");
    }
    return {
      kind: "cloud-sql",
      instanceConnectionName: required(env, "DEX_CLOUD_SQL_INSTANCE"),
      database: required(env, "DEX_CLOUD_SQL_DATABASE"),
      user: required(env, "DEX_CLOUD_SQL_IAM_USER"),
      ipType,
    };
  }
  if (environment === "production") {
    throw new TypeError(
      "DEX_DATABASE_URL or DEX_CLOUD_SQL_INSTANCE is required in production",
    );
  }
  return {
    kind: "file",
    filePath: path.resolve(env.DEX_CLOUD_STATE_FILE ?? ".dex/cloud-state.json"),
  };
}

export async function loadDexCloudConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DexCloudConfig> {
  const nodeEnvironment = env.NODE_ENV ?? "development";
  const environment = nodeEnvironment === "production"
    ? "production"
    : nodeEnvironment === "test" ? "test" : "development";
  const line = requiredOneOf(env, ["DEX_SENDBLUE_LINE", "SENDBLUE_NUMBER"]);
  if (!E164Schema.safeParse(line).success) {
    throw new TypeError("DEX_SENDBLUE_LINE or SENDBLUE_NUMBER is invalid");
  }
  const statusCallback = env.DEX_SENDBLUE_STATUS_CALLBACK;
  if (statusCallback !== undefined) {
    try {
      const url = new URL(statusCallback);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch {
      throw new TypeError("DEX_SENDBLUE_STATUS_CALLBACK must be an HTTPS URL");
    }
  }
  const host = env.DEX_CLOUD_HOST ?? (environment === "production" ? "0.0.0.0" : "127.0.0.1");
  if (!host || /[\u0000\r\n]/.test(host)) throw new TypeError("DEX_CLOUD_HOST is invalid");
  const workerId = env.DEX_CLOUD_WORKER_ID ?? `dex-cloud-${process.pid}`;
  if (!IdentifierSchema.safeParse(workerId).success) throw new TypeError("DEX_CLOUD_WORKER_ID is invalid");
  const configuredPersistence = persistence(env, environment);
  const cloudTasksProject = env.DEX_CLOUD_TASKS_PROJECT;
  const cloudTaskNames = [
    "DEX_CLOUD_TASKS_PROJECT", "DEX_CLOUD_TASKS_LOCATION", "DEX_CLOUD_TASKS_QUEUE",
    "DEX_CLOUD_TASKS_SERVICE_URL", "DEX_CLOUD_TASKS_AUDIENCE",
    "DEX_CLOUD_TASKS_SERVICE_ACCOUNT",
  ];
  if (cloudTasksProject === undefined && cloudTaskNames.some((name) => env[name] !== undefined)) {
    throw new TypeError("DEX_CLOUD_TASKS_PROJECT is required when Cloud Tasks is configured");
  }
  let cloudTasks: DexCloudConfig["cloudTasks"];
  if (cloudTasksProject !== undefined) {
    const serviceUrl = required(env, "DEX_CLOUD_TASKS_SERVICE_URL");
    const audience = required(env, "DEX_CLOUD_TASKS_AUDIENCE");
    for (const [name, value] of [
      ["DEX_CLOUD_TASKS_SERVICE_URL", serviceUrl],
      ["DEX_CLOUD_TASKS_AUDIENCE", audience],
    ] as const) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) throw new TypeError(`${name} must be an HTTPS URL`);
    }
    cloudTasks = {
      project: required(env, "DEX_CLOUD_TASKS_PROJECT"),
      location: required(env, "DEX_CLOUD_TASKS_LOCATION"),
      queue: required(env, "DEX_CLOUD_TASKS_QUEUE"),
      serviceUrl,
      audience,
      serviceAccountEmail: required(env, "DEX_CLOUD_TASKS_SERVICE_ACCOUNT"),
    };
  }
  if (environment === "production" && cloudTasks === undefined) {
    throw new TypeError(
      "Cloud Tasks configuration is required in production for Modal continuity",
    );
  }
  return {
    environment,
    persistence: configuredPersistence,
    signingKey: await loadSigningKey(env),
    ownerAssociations: parseAssociations(env),
    sendblue: {
      apiKeyId: required(env, "SENDBLUE_API_KEY_ID"),
      apiSecretKey: requiredOneOf(env, ["SENDBLUE_API_SECRET_KEY", "SENDBLUE_API_SECRET"]),
      line,
      webhookSecret: requiredOneOf(env, ["DEX_SENDBLUE_WEBHOOK_SECRET", "SENDBLUE_WEBHOOK_SECRET"]),
      ...(statusCallback === undefined ? {} : { statusCallback }),
    },
    internalSecret: required(env, "DEX_INTERNAL_SECRET", 16),
    host,
    port: integer(env, "DEX_CLOUD_PORT", 8080, 1, 65_535),
    workerId,
    pollIntervalMs: integer(env, "DEX_CLOUD_POLL_INTERVAL_MS", 1_000, 250, 60_000),
    ...(cloudTasks === undefined ? {} : { cloudTasks }),
  };
}
