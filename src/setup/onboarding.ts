import { randomInt } from "node:crypto";
import { hostname } from "node:os";
import type { DexConfig } from "../config/config.js";
import { execFile } from "../utils/exec.js";
import { DexPairingService, MacOSDexKeychain, type DexPairingIdentity } from "../local/pairing/index.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { validateLocalCodexAuth } from "./modal-auth.js";

export const PAIRING_CODE_LENGTH = 6;

export interface PairMacOptions {
  config: DexConfig;
  pairingCode?: string;
  deviceName?: string;
  timeoutMs?: number;
  pollMs?: number;
  print?(line: string): void;
  preflight?(config: DexConfig): Promise<void>;
}

export interface SetupPreflightOptions {
  env?: NodeJS.ProcessEnv;
  doctor?(config: DexConfig): Promise<DoctorCheck[]>;
  validateCodexAuth?(): Promise<void>;
}

export async function detectMacName(): Promise<string> {
  if (process.platform === "darwin") {
    const result = await execFile("/usr/sbin/scutil", ["--get", "ComputerName"]);
    if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return hostname();
}

export function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: PAIRING_CODE_LENGTH },
    () => alphabet[randomInt(alphabet.length)],
  ).join("");
}

export async function runSetupPreflight(
  config: DexConfig,
  options: SetupPreflightOptions = {},
): Promise<DoctorCheck[]> {
  assertPairingConfig(config);
  const env = options.env ?? process.env;
  const missingEnvironment = ["DEX_HANDOFF_SIGNING_KEY", "GEMINI_API_KEY"]
    .filter((name) => !env[name]);
  if (missingEnvironment.length > 0) {
    throw new Error(`Setup requires ${missingEnvironment.join(" and ")} before phone pairing`);
  }

  const [checks] = await Promise.all([
    (options.doctor ?? runDoctor)(config),
    (options.validateCodexAuth ?? (() => validateLocalCodexAuth()))(),
  ]);
  const failures = checks.filter((check) => check.status === "fail");
  if (failures.length > 0) {
    throw new Error(`Setup preflight failed: ${failures.map((check) => check.name).join(", ")}`);
  }
  const modal = checks.find((check) => check.name === "Modal");
  if (modal?.status !== "pass") {
    throw new Error("Setup preflight requires an authenticated Modal environment or CLI profile");
  }
  return checks;
}

export async function pairMac(options: PairMacOptions): Promise<DexPairingIdentity> {
  assertPairingConfig(options.config);
  const cloudUrl = options.config.cloudUrl;
  await (options.preflight ?? runSetupPreflight)(options.config);
  const print = options.print ?? console.log;
  const deviceName = options.deviceName ?? await detectMacName();
  const keychain = new MacOSDexKeychain();
  const pairing = new DexPairingService({
    baseUrl: cloudUrl,
    keychain,
    pinnedServerKeys: options.config.serverKeys,
  });
  const existing = await pairing.loadIdentity();
  if (existing) return existing;

  const code = (options.pairingCode ?? generatePairingCode()).toUpperCase();
  print("");
  print("Pair your phone:");
  print("");
  print(`Text this number:\n${options.config.sendblueLine}`);
  print("");
  print(`Message:\nPAIR ${code}`);
  print("");
  print("Waiting for the verified phone message...");
  const deadline = Date.now() + (options.timeoutMs ?? 2 * 60_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await pairing.pair({ pairingCode: code, deviceName });
    } catch (error) {
      lastError = error;
      await delay(options.pollMs ?? 2_000);
    }
  }
  throw new Error("Phone pairing timed out. Confirm the number and text the shown PAIR code, then rerun setup.", {
    cause: lastError,
  });
}

function assertPairingConfig(
  config: DexConfig,
): asserts config is DexConfig & { cloudUrl: string; sendblueLine: string } {
  if (!config.cloudUrl) throw new Error("DEX_CLOUD_URL is required for setup");
  if (!config.sendblueLine) {
    throw new Error("DEX_SENDBLUE_LINE or SENDBLUE_NUMBER is required so setup can show the Dex number");
  }
  if (config.serverKeys.length === 0) {
    throw new Error("DEX_CLOUD_SERVER_KEYS_JSON must contain at least one pinned Dex Cloud key");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
