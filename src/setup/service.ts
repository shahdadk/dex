import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DexPaths } from "../config/paths.js";
import { execFile } from "../utils/exec.js";

export async function installRuntime(paths: DexPaths, version: string): Promise<string> {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const target = path.join(paths.runtime, version);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const item of ["dist", "package.json", "README.md", "docs"] as const) {
    await cp(path.join(sourceRoot, item), path.join(target, item), { recursive: true, force: true });
  }
  const install = await execFile("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: target });
  if (install.exitCode !== 0) throw new Error(`Could not install Dex runtime dependencies: ${install.stderr}`);
  return target;
}

export async function installLaunchAgent(runtimeRoot: string, paths: DexPaths): Promise<string> {
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
  return plist;
}

function launchAgentPlist(input: {
  label: string;
  node: string;
  cli: string;
  log: string;
  dexHome: string;
  executablePath: string;
}): string {
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
  </dict>
  <key>StandardOutPath</key><string>${xml(input.log)}</string>
  <key>StandardErrorPath</key><string>${xml(input.log)}</string>
</dict></plist>
`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
