import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

interface PackFile {
  path: string;
  mode: number;
}

interface PackResult {
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        DEX_HOME: path.join(options.cwd, "dex-home-must-stay-empty"),
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    throw new Error(
      [
        `${command} ${args.join(" ")} failed (${String(failure.code ?? failure.signal ?? "unknown")})`,
        failure.stdout,
        failure.stderr,
      ].filter(Boolean).join("\n"),
      { cause: error },
    );
  }
}

describe("published package install", () => {
  it("packs the built CLI and runs root/setup help from the local tarball", { timeout: 90_000 }, async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "dex-package-install-"));
    try {
      const packed = await run(
        "npm",
        ["pack", "--json", "--pack-destination", temp],
        { cwd: packageRoot, timeoutMs: 45_000 },
      );
      const results = JSON.parse(packed.stdout) as PackResult[];
      expect(results).toHaveLength(1);
      const result = results[0]!;
      const files = result.files.map((file) => file.path);

      expect(result).toMatchObject({ name: "@shahdadk/dex", version: "0.0.1" });
      expect(files).toEqual(expect.arrayContaining([
        "package.json",
        "README.md",
        "dist/cli.js",
        "dist/cli.d.ts",
        "dist/index.js",
        "dist/index.d.ts",
        ".env.example",
      ]));
      expect(files.some((file) => file.startsWith("src/"))).toBe(false);
      expect(files.some((file) => file.startsWith("test/"))).toBe(false);
      expect(files).not.toContain(".env");

      const localPackage = `./${result.filename}`;
      const rootHelp = await run(
        "npx",
        ["--yes", "--package", localPackage, "dex", "--help"],
        { cwd: temp, timeoutMs: 45_000 },
      );
      expect(rootHelp.stdout).toContain("Usage: dex [options] [command]");
      expect(rootHelp.stdout).toContain("setup [options]");

      const setupHelp = await run(
        "npx",
        ["--yes", "--package", localPackage, "dex", "setup", "--help"],
        { cwd: temp, timeoutMs: 45_000 },
      );
      expect(setupHelp.stdout).toContain("Usage: dex setup [options]");
      expect(setupHelp.stdout).toContain("--no-service");
      expect(setupHelp.stdout).toContain("--skip-modal-smoke");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
