import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { DexConfig } from "../config/config.js";
import { execFile } from "../utils/exec.js";
import { DexPairingService, MacOSDexKeychain, type DexPairingIdentity } from "../local/pairing/index.js";

export interface PairMacOptions {
  config: DexConfig;
  pairingCode?: string;
  deviceName?: string;
  timeoutMs?: number;
  pollMs?: number;
  print?(line: string): void;
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
  const bytes = randomBytes(20);
  return [...bytes].map((byte) => alphabet[byte! % alphabet.length]).join("");
}

export async function pairMac(options: PairMacOptions): Promise<DexPairingIdentity> {
  if (!options.config.cloudUrl) throw new Error("DEX_CLOUD_URL is required for setup");
  if (!options.config.sendblueLine) {
    throw new Error("DEX_SENDBLUE_LINE or SENDBLUE_NUMBER is required so setup can show the Dex number");
  }
  if (options.config.serverKeys.length === 0) {
    throw new Error("DEX_CLOUD_SERVER_KEYS_JSON must contain at least one pinned Dex Cloud key");
  }
  const print = options.print ?? console.log;
  const deviceName = options.deviceName ?? await detectMacName();
  const keychain = new MacOSDexKeychain();
  const pairing = new DexPairingService({
    baseUrl: options.config.cloudUrl,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
