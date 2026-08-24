import os from "node:os";
import { commandExists, execFile } from "../utils/exec.js";
import type { DexConfig } from "../config/config.js";
import { resolveDexPaths } from "../config/paths.js";
import { discoverClaudeMem } from "../memory/claude-mem.js";
import type { DexState, SignedTransportHealth } from "../state/schemas.js";
import { DexStateStore } from "../state/store.js";

export const SIGNED_SYNC_FRESHNESS_MS = 90_000;
export const SIGNED_SYNC_STARTUP_TIMEOUT_MS = 45_000;
export const SIGNED_SYNC_STARTUP_POLL_MS = 250;

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export async function runDoctor(
  config: DexConfig,
  options: DexCloudDoctorOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    name: "Node",
    status: nodeMajor >= 22 ? "pass" : "fail",
    detail: `Node ${process.versions.node}`,
    ...(nodeMajor >= 22 ? {} : { fix: "Install Node 22 or newer." }),
  });
  checks.push({
    name: "macOS",
    status: process.platform === "darwin" ? "pass" : "fail",
    detail: `${os.type()} ${os.release()}`,
    ...(process.platform === "darwin" ? {} : { fix: "Dex local execution currently requires macOS." }),
  });

  for (const command of ["git", "claude", "codex", "pmset", "caffeinate"] as const) {
    const available = await commandExists(command);
    checks.push({
      name: command,
      status: available ? "pass" : "fail",
      detail: available ? await commandVersion(command) : "not found",
      ...(available ? {} : { fix: `Install ${command} and ensure it is on PATH.` }),
    });
  }

  if (await commandExists("codex")) {
    const help = await execFile("codex", ["exec", "--help"]);
    const required = ["--json", "--ignore-user-config"];
    const missing = required.filter((flag) => !help.stdout.includes(flag));
    checks.push({
      name: "Codex non-interactive mode",
      status: missing.length === 0 ? "pass" : "fail",
      detail: missing.length === 0 ? "JSONL execution available" : `missing ${missing.join(", ")}`,
      ...(missing.length === 0 ? {} : { fix: "Update Codex CLI." }),
    });
    const auth = await execFile("codex", ["login", "status"]);
    checks.push({
      name: "Codex authentication",
      status: auth.exitCode === 0 ? "pass" : "fail",
      detail: auth.exitCode === 0 ? "authenticated" : "not authenticated",
      ...(auth.exitCode === 0 ? {} : { fix: "Run codex login." }),
    });
  }
  if (await commandExists("claude")) {
    const auth = await execFile("claude", ["auth", "status"]);
    checks.push({
      name: "Claude authentication",
      status: auth.exitCode === 0 ? "pass" : "fail",
      detail: auth.exitCode === 0 ? "authenticated" : "not authenticated",
      ...(auth.exitCode === 0 ? {} : { fix: "Run claude auth login." }),
    });
  }

  checks.push(await claudeMemCheck());
  checks.push(...await dexCloudChecks(config, options));
  checks.push(await modalCheck());
  return checks;
}

async function modalCheck(): Promise<DoctorCheck> {
  const tokenId = Boolean(process.env.MODAL_TOKEN_ID);
  const tokenSecret = Boolean(process.env.MODAL_TOKEN_SECRET);
  if (tokenId !== tokenSecret) {
    return {
      name: "Modal",
      status: "fail",
      detail: "only one Modal environment credential is configured",
      fix: "Set both MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or unset both and use an authenticated Modal profile.",
    };
  }
  if (tokenId && tokenSecret) {
    return { name: "Modal", status: "pass", detail: "environment credentials available" };
  }
  if (await commandExists("modal")) {
    const token = await execFile("modal", ["token", "info"]);
    if (token.exitCode === 0) {
      return { name: "Modal", status: "pass", detail: "authenticated CLI profile available" };
    }
  }
  return {
    name: "Modal",
    status: "warn",
    detail: "no authenticated environment or CLI profile found",
    fix: "Run `modal token new --verify`, or set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
  };
}

async function commandVersion(command: string): Promise<string> {
  const args = command === "pmset" || command === "caffeinate" ? ["-h"] : ["--version"];
  const result = await execFile(command, args);
  return (result.stdout || result.stderr).split("\n")[0]?.trim() || "available";
}

async function claudeMemCheck(): Promise<DoctorCheck> {
  const discovery = await discoverClaudeMem({
    ...(process.env.CLAUDE_MEM_URL ? { baseUrl: process.env.CLAUDE_MEM_URL } : {}),
    timeoutMs: 1_500,
  });
  return discovery.available
    ? { name: "Claude-Mem", status: "pass", detail: `healthy at ${discovery.baseUrl}` }
    : {
        name: "Claude-Mem",
        status: "warn",
        detail: "worker unavailable",
        fix: "Start Claude-Mem; Dex will retain durable TaskKnowledge as a fallback.",
      };
}

export interface DexCloudDoctorOptions {
  now?: () => number;
  loadState?: () => Promise<DexState>;
  fetch?: typeof globalThis.fetch;
  signedTransportMode?: "required" | "preinstall";
}

export interface WaitForHealthySignedTransportOptions {
  loadState?: () => Promise<DexState>;
  afterRevision: number;
  notBefore: string;
  previousLastSuccessAt?: string;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

type HealthySignedTransportHealth = Extract<SignedTransportHealth, { status: "healthy" }>;

export async function dexCloudChecks(
  config: DexConfig,
  options: DexCloudDoctorOptions = {},
): Promise<DoctorCheck[]> {
  const signedTransport = await dexCloudCheck(config, options);
  if (!isPaired(config)) return [signedTransport];
  return [signedTransport, await dexCloudReadinessCheck(config, options)];
}

export async function dexCloudCheck(
  config: DexConfig,
  options: DexCloudDoctorOptions = {},
): Promise<DoctorCheck> {
  if (!config.cloudUrl || !config.deviceId || config.serverKeys.length === 0) {
    return {
      name: "Dex Cloud",
      status: "warn",
      detail: "not paired yet",
      fix: "Run dex setup to pair this Mac and phone.",
    };
  }
  if (options.signedTransportMode === "preinstall") {
    return {
      name: "Dex Cloud",
      status: "warn",
      detail: `${config.deviceId} paired; signed daemon transport is pending service installation or restart`,
      fix: "Setup will verify a new signed daemon sync after installing the background service.",
    };
  }

  let state: DexState;
  try {
    const loadState = options.loadState ?? (() =>
      new DexStateStore(resolveDexPaths().state).read());
    state = await loadState();
  } catch {
    return {
      name: "Dex Cloud",
      status: "fail",
      detail: "paired configuration exists but signed daemon-sync health is unreadable",
      fix: "Check the Dex state file and background daemon, then run dex doctor.",
    };
  }

  const health = state.signedTransportHealth;
  if (!health) {
    return {
      name: "Dex Cloud",
      status: "warn",
      detail: `${config.deviceId} is paired, but no signed daemon sync has completed; the daemon may be unavailable or not started yet`,
      fix: "Start the Dex background daemon and run dex doctor again.",
    };
  }
  if (health.status === "degraded") {
    return {
      name: "Dex Cloud",
      status: "fail",
      detail: `signed daemon sync is degraded after ${health.consecutiveFailures} consecutive failure${health.consecutiveFailures === 1 ? "" : "s"} (${health.lastError})`,
      fix: "Check the Dex daemon log and signed cloud pairing, then run dex doctor again.",
    };
  }

  const now = options.now?.() ?? Date.now();
  const ageMs = now - Date.parse(health.lastSuccessAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SIGNED_SYNC_FRESHNESS_MS) {
    return {
      name: "Dex Cloud",
      status: "fail",
      detail: "last successful signed daemon sync is stale; the daemon may be unavailable",
      fix: "Start or restart the Dex background daemon and run dex doctor again.",
    };
  }
  return {
    name: "Dex Cloud",
    status: "pass",
    detail: `${config.deviceId} paired; signed daemon sync succeeded ${formatAge(ageMs)} ago`,
  };
}

export async function waitForHealthySignedTransport(
  options: WaitForHealthySignedTransportOptions,
): Promise<HealthySignedTransportHealth> {
  const timeoutMs = options.timeoutMs ?? SIGNED_SYNC_STARTUP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? SIGNED_SYNC_STARTUP_POLL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Signed transport startup timeout must be a non-negative number");
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError("Signed transport startup poll interval must be positive");
  }
  const notBeforeMs = Date.parse(options.notBefore);
  if (!Number.isFinite(notBeforeMs)) throw new TypeError("Signed transport start time is invalid");

  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const loadState = options.loadState ?? (() =>
    new DexStateStore(resolveDexPaths().state).read());
  const deadline = now() + timeoutMs;
  let lastObservation = "no signed sync recorded";

  for (;;) {
    try {
      const state = await loadState();
      const health = state.signedTransportHealth;
      if (!health) {
        lastObservation = "no signed sync recorded";
      } else if (health.status === "degraded") {
        lastObservation = `degraded after ${health.consecutiveFailures} failure${health.consecutiveFailures === 1 ? "" : "s"} (${health.lastError})`;
      } else {
        const successAt = Date.parse(health.lastSuccessAt);
        const observedAt = now();
        const isNewStateRevision = state.revision > options.afterRevision;
        const isNewSuccess = health.lastSuccessAt !== options.previousLastSuccessAt;
        const isFromInstalledDaemon = successAt >= notBeforeMs;
        const isFresh = successAt <= observedAt && observedAt - successAt <= SIGNED_SYNC_FRESHNESS_MS;
        if (isNewStateRevision && isNewSuccess && isFromInstalledDaemon && isFresh) return health;
        lastObservation = "only stale or pre-install signed sync evidence is available";
      }
    } catch {
      lastObservation = "signed transport state is unreadable";
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(
        `Dex background service did not record a new healthy signed cloud sync within ${Math.ceil(timeoutMs / 1_000)}s (${lastObservation})`,
      );
    }
    await wait(Math.min(pollMs, remainingMs));
  }
}

export async function dexCloudReadinessCheck(
  config: DexConfig,
  options: DexCloudDoctorOptions = {},
): Promise<DoctorCheck> {
  try {
    const health = new URL("/readyz", config.cloudUrl!);
    // Readiness remains useful supporting evidence, but it cannot prove that
    // this paired Mac can authenticate or exchange signed commands.
    const request = options.fetch ?? globalThis.fetch;
    const response = await request(health, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      name: "Dex Cloud readiness",
      status: "pass",
      detail: "/readyz is reachable (supporting check only)",
    };
  } catch {
    return {
      name: "Dex Cloud readiness",
      status: "fail",
      detail: "cloud /readyz check failed",
      fix: "Verify DEX_CLOUD_URL and the Dex Cloud service, then run dex doctor.",
    };
  }
}

function isPaired(config: DexConfig): boolean {
  return Boolean(config.cloudUrl && config.deviceId && config.serverKeys.length > 0);
}

function formatAge(ageMs: number): string {
  if (ageMs < 1_000) return "less than a second";
  return `${Math.floor(ageMs / 1_000)}s`;
}

export function formatDoctor(
  checks: DoctorCheck[],
  title = "Dex Doctor",
  successText = "Ready.",
): string {
  const icon = { pass: "✓", warn: "!", fail: "✗" } satisfies Record<CheckStatus, string>;
  const lines = [title, ""];
  for (const check of checks) {
    lines.push(`${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.status === "fail" && check.fix) lines.push(`  ${check.fix}`);
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  lines.push("", failures === 0 ? successText : `${failures} required check${failures === 1 ? "" : "s"} failed.`);
  return lines.join("\n");
}
