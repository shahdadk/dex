import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireCodexAuthLease, releaseCodexAuthLease, seedModalCodexAuth, validateLocalCodexAuth } from "../src/setup/modal-auth.js";
import type { ModalAdapter } from "../src/cloud/modal/adapter.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function authFixture(mode = 0o600): Promise<{ directory: string; authPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-modal-auth-"));
  directories.push(directory);
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "access-secret", refresh_token: "refresh-secret", id_token: "id-secret" },
  }), { mode });
  await chmod(authPath, mode);
  return { directory, authPath };
}

describe("Modal Codex account auth", () => {
  it("validates ChatGPT structure and rejects broad local permissions without exposing values", async () => {
    const fixture = await authFixture(0o644);
    await expect(validateLocalCodexAuth(fixture.authPath)).rejects.toThrow("permissions are too broad");
    await chmod(fixture.authPath, 0o600);
    await expect(validateLocalCodexAuth(fixture.authPath)).resolves.toBeUndefined();
  });

  it("seeds a missing named-volume cache and secures the mounted cache", async () => {
    const fixture = await authFixture();
    const runnerCommands: string[][] = [];
    const executions: Array<{ argv: string[]; params?: Record<string, unknown> }> = [];
    const process = { stdout: { readText: async () => "" }, stderr: { readText: async () => "" }, wait: async () => 0 };
    const sandbox = {
      exec: vi.fn(async (argv: string[], params?: Record<string, unknown>) => {
        executions.push({ argv, ...(params ? { params } : {}) });
        return process;
      }),
      copyFromLocal: vi.fn(async () => undefined),
      terminate: vi.fn(async () => undefined),
    };
    const modal = {
      create: vi.fn(async () => sandbox),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      runnerCommands.push([command, ...args]);
      if (args[1] === "ls") {
        return { stdout: "", stderr: "No such file or directory", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(seedModalCodexAuth({ authPath: fixture.authPath, volumeName: "private-auth", runner, modal })).resolves.toEqual({ volumeName: "private-auth" });
    expect(runnerCommands).toEqual([
      ["modal", "volume", "create", "private-auth"],
      ["modal", "volume", "ls", "--json", "private-auth", "auth.json"],
      ["modal", "volume", "put", "private-auth", fixture.authPath, "auth.json"],
    ]);
    expect(executions).toContainEqual({ argv: ["chmod", "700", "/codex-home"] });
    expect(executions).toContainEqual({ argv: ["chmod", "600", "/codex-home/auth.json"] });
    expect(executions).toContainEqual({
      argv: ["node", "-e", "if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(1)"],
      params: { env: { CODEX_HOME: "/codex-home", OPENAI_API_KEY: "", CODEX_API_KEY: "" } },
    });
    expect(executions).toContainEqual({
      argv: ["codex", "login", "status"],
      params: { env: { CODEX_HOME: "/codex-home", OPENAI_API_KEY: "", CODEX_API_KEY: "" } },
    });
    expect(sandbox.copyFromLocal).not.toHaveBeenCalled();
    expect(sandbox.terminate).toHaveBeenCalledWith({ wait: true });
    expect(JSON.stringify({ runnerCommands, executions })).not.toContain("secret");
  });

  it("preserves the refreshed account credential already stored in Modal", async () => {
    const fixture = await authFixture();
    const runnerCommands: string[][] = [];
    const process = { stdout: { readText: async () => "" }, stderr: { readText: async () => "" }, wait: async () => 0 };
    const sandbox = {
      exec: vi.fn(async () => process),
      terminate: vi.fn(async () => undefined),
    };
    const modal = {
      create: vi.fn(async () => sandbox),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      runnerCommands.push([command, ...args]);
      if (args[1] === "ls") {
        return {
          stdout: JSON.stringify([{ filename: "auth.json", type: "file", size: "4.0 KiB" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await seedModalCodexAuth({ authPath: fixture.authPath, volumeName: "private-auth", runner, modal });

    expect(runnerCommands).toEqual([
      ["modal", "volume", "create", "private-auth"],
      ["modal", "volume", "ls", "--json", "private-auth", "auth.json"],
    ]);
    expect(runnerCommands.some((argv) => argv.includes("put"))).toBe(false);
    expect(sandbox.terminate).toHaveBeenCalledWith({ wait: true });
  });

  it("serializes workers with a durable owner-checked lease", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    await acquireCodexAuthLease(leasePath, "task-one");
    expect((await stat(leasePath)).mode & 0o777).toBe(0o600);
    await expect(acquireCodexAuthLease(leasePath, "task-two")).rejects.toThrow("holds the shared account-auth lease");
    await expect(releaseCodexAuthLease(leasePath, "task-two")).rejects.toThrow("owned by another task");
    await Promise.all([
      releaseCodexAuthLease(leasePath, "task-one"),
      releaseCodexAuthLease(leasePath, "task-one"),
    ]);
    await expect(releaseCodexAuthLease(leasePath, "task-one")).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path.join(fixture.directory, "auth.json"), "utf8"))).toMatchObject({ auth_mode: "chatgpt" });
  });
});
