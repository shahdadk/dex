import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("creates the named volume with argv and secures the mounted cache", async () => {
    const fixture = await authFixture();
    const commands: string[][] = [];
    const copied: string[][] = [];
    const process = { stdout: { readText: async () => "" }, stderr: { readText: async () => "" }, wait: async () => 0 };
    const sandbox = {
      exec: vi.fn(async (argv: string[]) => { commands.push(argv); return process; }),
      copyFromLocal: vi.fn(async (local: string, remote: string) => { copied.push([local, remote]); }),
      terminate: vi.fn(async () => undefined),
    };
    const modal = {
      create: vi.fn(async () => sandbox),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push([command, ...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(seedModalCodexAuth({ authPath: fixture.authPath, volumeName: "private-auth", runner, modal })).resolves.toEqual({ volumeName: "private-auth" });
    expect(commands).toContainEqual(["modal", "volume", "create", "private-auth"]);
    expect(commands).toContainEqual(["chmod", "700", "/codex-home"]);
    expect(commands).toContainEqual(["chmod", "600", "/codex-home/auth.json"]);
    expect(commands).toContainEqual(["codex", "login", "status"]);
    expect(copied).toEqual([[fixture.authPath, "/codex-home/auth.json"]]);
    expect(JSON.stringify({ commands, copied: copied.map(([, remote]) => remote) })).not.toContain("secret");
  });

  it("serializes workers with a durable owner-checked lease", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    await acquireCodexAuthLease(leasePath, "task-one");
    await expect(acquireCodexAuthLease(leasePath, "task-two")).rejects.toThrow("holds the shared account-auth lease");
    await expect(releaseCodexAuthLease(leasePath, "task-two")).rejects.toThrow("owned by another task");
    await releaseCodexAuthLease(leasePath, "task-one");
    expect(JSON.parse(await readFile(path.join(fixture.directory, "auth.json"), "utf8"))).toMatchObject({ auth_mode: "chatgpt" });
  });
});
