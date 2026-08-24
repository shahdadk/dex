import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DexPaths } from "../config/paths.js";
import { execFile } from "../utils/exec.js";

const LAUNCH_AGENT_ENVIRONMENT_NAMES = [
  "DEX_DEVICE_KEY_ID",
  "DEX_MODAL_CODEX_AUTH_VOLUME",
  "DEX_MODAL_SECRET_NAME",
  "CLAUDE_MEM_URL",
  "CLAUDE_MEM_WORKER_URL",
  "CLAUDE_MEM_WORKER_HOST",
  "CLAUDE_MEM_WORKER_PORT",
  "CLAUDE_MEM_DATA_DIR",
] as const;

export interface InstallLaunchAgentOptions {
  environment?: NodeJS.ProcessEnv;
  codexAuthVolumeName?: string;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  probeControlSocket?(socketPath: string): Promise<void>;
  wait?(ms: number): Promise<void>;
}

export async function installRuntime(paths: DexPaths, version: string): Promise<string> {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const target = path.join(paths.runtime, version);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const item of ["dist", "package.json", "README.md", "docs", ".env.example"] as const) {
    await cp(path.join(sourceRoot, item), path.join(target, item), { recursive: true, force: true });
  }
  const install = await execFile("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: target });
  if (install.exitCode !== 0) throw new Error(`Could not install Dex runtime dependencies: ${install.stderr}`);
  return target;
}

export async function installLaunchAgent(
  runtimeRoot: string,
  paths: DexPaths,
  options: InstallLaunchAgentOptions = {},
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installation requires macOS");
  const label = "com.dex.daemon";
  const agents = path.join(os.homedir(), "Library", "LaunchAgents");
  const plist = path.join(agents, `${label}.plist`);
  await mkdir(agents, { recursive: true });
  const body = launchAgentPlist({
    label,
    node: process.execPath,
    cli: path.join(runtimeRoot, "dist", "cli.js"),
    log: paths.daemonLog,
    dexHome: paths.home,
    executablePath: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    environment: launchAgentEnvironment({
      ...(options.environment ?? process.env),
      ...(options.codexAuthVolumeName
        ? { DEX_MODAL_CODEX_AUTH_VOLUME: options.codexAuthVolumeName }
        : {}),
    }),
  });
  const existing = await readFile(plist, "utf8").catch(() => "");
  if (existing !== body) await writeFile(plist, body, { mode: 0o600 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await execFile("launchctl", ["bootout", domain, plist]);
  const loaded = await execFile("launchctl", ["bootstrap", domain, plist]);
  if (loaded.exitCode !== 0) throw new Error(`Could not start Dex background service: ${loaded.stderr}`);
  const kicked = await execFile("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
  if (kicked.exitCode !== 0) {
    throw new Error(`Dex background service was installed but did not start: ${kicked.stderr}`);
  }
  try {
    await waitForDaemonControlSocket(paths.controlSocket, options);
  } catch (cause) {
    throw new Error(
      `Dex background service started but its control socket did not become ready at ${paths.controlSocket}`,
      { cause },
    );
  }
  return plist;
}

export async function waitForDaemonControlSocket(
  socketPath: string,
  options: InstallLaunchAgentOptions = {},
): Promise<void> {
  const timeoutMs = options.readinessTimeoutMs ?? 10_000;
  const pollMs = options.readinessPollMs ?? 100;
  const probe = options.probeControlSocket ?? probeControlSocket;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  do {
    try {
      await probe(socketPath);
      return;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(pollMs, remaining));
  } while (Date.now() <= deadline);

  throw new Error("Dex daemon control socket is unavailable", { cause: lastError });
}

function probeControlSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Dex daemon control socket connection timed out"));
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function launchAgentEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(LAUNCH_AGENT_ENVIRONMENT_NAMES.flatMap((name) => {
    const value = environment[name];
    return value ? [[name, value] as const] : [];
  }));
}

function launchAgentPlist(input: {
  label: string;
  node: string;
  cli: string;
  log: string;
  dexHome: string;
  executablePath: string;
  environment: Record<string, string>;
}): string {
  const environment = Object.entries(input.environment)
    .map(([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(input.label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(input.node)}</string><string>${xml(input.cli)}</string><string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(input.executablePath)}</string>
    <key>DEX_HOME</key><string>${xml(input.dexHome)}</string>
${environment}
  </dict>
  <key>StandardOutPath</key><string>${xml(input.log)}</string>
  <key>StandardErrorPath</key><string>${xml(input.log)}</string>
</dict></plist>
`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
