import os from "node:os";
import { commandExists, execFile } from "../utils/exec.js";
import type { DexConfig } from "../config/config.js";
import { discoverClaudeMem } from "../memory/claude-mem.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export async function runDoctor(config: DexConfig): Promise<DoctorCheck[]> {
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
  checks.push(await dexCloudCheck(config));
  checks.push({
    name: "Modal",
    status: process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "pass" : "warn",
    detail: process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "credentials available" : "credentials not visible locally",
    ...(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET
      ? {}
      : { fix: "Configure Modal credentials through Dex Cloud or local environment." }),
  });
  return checks;
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

async function dexCloudCheck(config: DexConfig): Promise<DoctorCheck> {
  if (!config.cloudUrl || !config.deviceId || config.serverKeys.length === 0) {
    return {
      name: "Dex Cloud",
      status: "warn",
      detail: "not paired yet",
      fix: "Run dex setup to pair this Mac and phone.",
    };
  }
  try {
    const health = new URL("/healthz", config.cloudUrl);
    const response = await fetch(health, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      name: "Dex Cloud",
      status: "pass",
      detail: `${config.deviceId} paired; cloud messaging survives host sleep`,
    };
  } catch {
    return {
      name: "Dex Cloud",
      status: "fail",
      detail: "paired configuration exists but cloud health check failed",
      fix: "Verify DEX_CLOUD_URL and the Dex Cloud service, then run dex doctor.",
    };
  }
}

export function formatDoctor(checks: DoctorCheck[], title = "Dex Doctor"): string {
  const icon = { pass: "✓", warn: "!", fail: "✗" } satisfies Record<CheckStatus, string>;
  const lines = [title, ""];
  for (const check of checks) {
    lines.push(`${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.status === "fail" && check.fix) lines.push(`  ${check.fix}`);
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  lines.push("", failures === 0 ? "Ready." : `${failures} required check${failures === 1 ? "" : "s"} failed.`);
  return lines.join("\n");
}
