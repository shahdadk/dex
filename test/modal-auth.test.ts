import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCodexAuthLease,
  isCodexAuthLeaseBusyError,
  MODAL_CODEX_HOME,
  releaseCodexAuthLease,
  seedModalCodexAuth,
  validateLocalCodexAuth,
} from "../src/setup/modal-auth.js";
import type { ModalAdapter } from "../src/cloud/modal/adapter.js";
import { execFile } from "../src/utils/exec.js";

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

  it("rejects a local auth symlink without changing or reading through its target", async () => {
    const fixture = await authFixture();
    const target = path.join(fixture.directory, "target.json");
    const link = path.join(fixture.directory, "linked-auth.json");
    await writeFile(target, "not an auth cache\n", { mode: 0o644 });
    await symlink(target, link);

    await expect(validateLocalCodexAuth(link)).rejects.toThrow("not a symbolic link");
    expect(await readFile(target, "utf8")).toBe("not an auth cache\n");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it("seeds a missing named-volume cache and secures the mounted cache", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const lifecycle: string[] = [];
    const runnerCommands: string[][] = [];
    const executions: Array<{ argv: string[]; params?: Record<string, unknown> }> = [];
    const process = { stdout: { readText: async () => "" }, stderr: { readText: async () => "" }, wait: async () => 0 };
    const sandbox = {
      sandboxId: "sb-auth-seed",
      exec: vi.fn(async (argv: string[], params?: Record<string, unknown>) => {
        executions.push({ argv, ...(params ? { params } : {}) });
        return process;
      }),
      copyFromLocal: vi.fn(async () => undefined),
      terminate: vi.fn(async (options: { wait: boolean }) => {
        expect(options).toEqual({ wait: true });
        await expect(access(leasePath)).resolves.toBeUndefined();
        lifecycle.push("terminate-wait");
      }),
    };
    const modal = {
      create: vi.fn(async () => sandbox),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      await expect(access(leasePath)).resolves.toBeUndefined();
      lifecycle.push(`runner:${args[1]}`);
      runnerCommands.push([command, ...args]);
      if (args[1] === "ls") {
        return {
          stdout: "",
          stderr: 'path "/auth.json" does not exist',
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      operationToken: "1".repeat(64),
      runner,
      modal,
    })).resolves.toEqual({ volumeName: "private-auth" });
    expect(runnerCommands).toEqual([
      ["modal", "volume", "create", "--version=2", "private-auth"],
      ["modal", "volume", "ls", "--json", "private-auth", "auth.json"],
      ["modal", "volume", "put", "private-auth", fixture.authPath, "auth.json"],
    ]);
    const remoteValidation = executions.find(({ argv }) =>
      argv[0] === "node" && argv[1] === "-e" && argv[3] === "/codex-home"
    );
    expect(remoteValidation?.argv[2]).toContain("O_NOFOLLOW");
    expect(remoteValidation?.argv[2]).toContain("fstatSync");
    expect(remoteValidation?.argv[2]).toContain("fchmodSync");
    expect(executions).toContainEqual({
      argv: ["node", "-e", "if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(1)"],
      params: { env: { CODEX_HOME: "/codex-home", OPENAI_API_KEY: "", CODEX_API_KEY: "" } },
    });
    expect(executions).toContainEqual({
      argv: ["codex", "login", "status"],
      params: { env: { CODEX_HOME: "/codex-home", OPENAI_API_KEY: "", CODEX_API_KEY: "" } },
    });
    expect(executions).toContainEqual({
      argv: ["sync", "/codex-home"],
      params: { env: { CODEX_HOME: "/codex-home", OPENAI_API_KEY: "", CODEX_API_KEY: "" } },
    });
    expect(sandbox.copyFromLocal).not.toHaveBeenCalled();
    expect(sandbox.terminate).toHaveBeenCalledWith({ wait: true });
    expect(lifecycle.at(-1)).toBe("terminate-wait");
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify({ runnerCommands, executions })).not.toContain("secret");
  });

  it("preserves the refreshed account credential already stored in Modal", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const runnerCommands: string[][] = [];
    const process = { stdout: { readText: async () => "" }, stderr: { readText: async () => "" }, wait: async () => 0 };
    const sandbox = {
      sandboxId: "sb-auth-reuse",
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

    await seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      operationToken: "2".repeat(64),
      runner,
      modal,
    });

    expect(runnerCommands).toEqual([
      ["modal", "volume", "create", "--version=2", "private-auth"],
      ["modal", "volume", "ls", "--json", "private-auth", "auth.json"],
    ]);
    expect(runnerCommands.some((argv) => argv.includes("put"))).toBe(false);
    expect(sandbox.terminate).toHaveBeenCalledWith({ wait: true });
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed and reports an incompatible legacy Volume when explicit v2 sync fails", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const sandbox = {
      sandboxId: "sb-auth-v1",
      exec: vi.fn(async (argv: string[]) => ({
        stdout: { readText: async () => "" },
        stderr: { readText: async () => "" },
        wait: async () => argv[0] === "sync" ? 64 : 0,
      })),
      terminate: vi.fn(async () => undefined),
    };
    const modal = {
      create: vi.fn(async () => sandbox),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "create") {
        return { stdout: "", stderr: "Volume already exists", exitCode: 1 };
      }
      if (args[1] === "ls") {
        return {
          stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "legacy-auth",
      leasePath,
      operationToken: "3".repeat(64),
      runner,
      modal,
    })).rejects.toThrow("not v2-compatible or explicit sync failed");

    expect(runner).toHaveBeenCalledWith("modal", [
      "volume", "create", "--version=2", "legacy-auth",
    ]);
    expect(sandbox.exec).toHaveBeenCalledWith(
      ["sync", MODAL_CODEX_HOME],
      expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: MODAL_CODEX_HOME }) }),
    );
    expect(sandbox.terminate).toHaveBeenCalledWith({ wait: true });
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a remote auth symlink using descriptor metadata without touching its target", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const remoteHome = path.join(fixture.directory, "remote-codex-home");
    const remoteTarget = path.join(fixture.directory, "remote-target.json");
    await mkdir(remoteHome);
    await writeFile(remoteTarget, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "a", refresh_token: "r", id_token: "i" },
    }), { mode: 0o644 });
    await symlink(remoteTarget, path.join(remoteHome, "auth.json"));
    const sandbox = {
      sandboxId: "sb-auth-symlink",
      exec: vi.fn(async (argv: string[]) => {
        let exitCode = 0;
        if (argv[0] === "node" && argv[1] === "-e" && argv[3] === MODAL_CODEX_HOME) {
          exitCode = (await execFile(process.execPath, ["-e", argv[2]!, remoteHome])).exitCode;
        }
        return {
          stdout: { readText: async () => "" },
          stderr: { readText: async () => "" },
          wait: async () => exitCode,
        };
      }),
      terminate: vi.fn(async () => undefined),
    };
    const modal = {
      create: vi.fn(async () => sandbox),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => args[1] === "ls"
      ? { stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]), stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      operationToken: "8".repeat(64),
      runner,
      modal,
    })).rejects.toThrow("not a ChatGPT account login");
    expect((await stat(remoteTarget)).mode & 0o777).toBe(0o644);
    expect(JSON.parse(await readFile(remoteTarget, "utf8"))).toMatchObject({ auth_mode: "chatgpt" });
    expect(sandbox.terminate).toHaveBeenCalledWith({ wait: true });
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an exact operation-tagged setup sandbox after an ambiguous create and releases its lease", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const journalPath = path.join(fixture.directory, "setup-operation.json");
    const oldToken = "6".repeat(64);
    const newToken = "7".repeat(64);
    const lifecycle: string[] = [];
    let createCalls = 0;
    let listCalls = 0;
    const processResult = {
      stdout: { readText: async () => "" },
      stderr: { readText: async () => "" },
      wait: async () => 0,
    };
    const orphan = {
      sandboxId: "sb-ambiguous-setup",
      exec: vi.fn(async () => processResult),
      terminate: vi.fn(async ({ wait }: { wait: boolean }) => {
        expect(wait).toBe(true);
        lifecycle.push("terminate-old");
      }),
    };
    const replacement = {
      sandboxId: "sb-replacement-setup",
      exec: vi.fn(async () => processResult),
      terminate: vi.fn(async ({ wait }: { wait: boolean }) => {
        expect(wait).toBe(true);
        lifecycle.push("terminate-new");
      }),
    };
    const listedTags: Record<string, string>[] = [];
    const modal = {
      create: vi.fn(async (options: { params?: { tags?: Record<string, string> } }) => {
        createCalls += 1;
        lifecycle.push(`create-${createCalls}`);
        if (createCalls === 1) throw new Error("ambiguous Modal create response");
        expect(options.params?.tags?.operation).toBe(newToken);
        return replacement;
      }),
      fromId: vi.fn(async (sandboxId: string) => {
        expect(sandboxId).toBe(orphan.sandboxId);
        lifecycle.push("adopt-old");
        return orphan;
      }),
      client: vi.fn(async () => ({
        sandboxes: {
          list: async function* ({ tags }: { tags: Record<string, string> }) {
            listedTags.push(tags);
            listCalls += 1;
            if (listCalls >= 2) {
              yield {
                sandboxId: orphan.sandboxId,
                getTags: async () => ({ ...tags }),
              };
            }
          },
        },
      })),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => args[1] === "ls"
      ? { stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]), stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: oldToken,
      runner,
      modal,
    })).rejects.toThrow("ambiguous Modal create response");
    await expect(access(leasePath)).resolves.toBeUndefined();
    await expect(access(journalPath)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
      phase: "create_started",
      operationToken: oldToken,
    });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: newToken,
      runner,
      modal,
    })).resolves.toEqual({ volumeName: "private-auth" });

    expect(listedTags.every((tags) => tags.operation === oldToken)).toBe(true);
    expect(lifecycle).toEqual([
      "create-1",
      "adopt-old",
      "terminate-old",
      "create-2",
      "terminate-new",
    ]);
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a crash after durable prepared-journal publication before creating a sandbox", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const journalPath = path.join(fixture.directory, "setup-operation.json");
    const interruptedToken = "e".repeat(64);
    const successorToken = "f".repeat(64);
    const lifecycle: string[] = [];
    const processResult = {
      stdout: { readText: async () => "" },
      stderr: { readText: async () => "" },
      wait: async () => 0,
    };
    const replacement = {
      sandboxId: "sb-after-prepared-recovery",
      exec: vi.fn(async () => processResult),
      terminate: vi.fn(async () => { lifecycle.push("terminate-successor"); }),
    };
    const listedTags: Record<string, string>[] = [];
    const modal = {
      create: vi.fn(async () => {
        lifecycle.push("create-successor");
        expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({
          operationToken: successorToken,
        });
        return replacement;
      }),
      client: vi.fn(async () => ({
        sandboxes: {
          list: async function* ({ tags }: { tags: Record<string, string> }) {
            listedTags.push(tags);
            lifecycle.push("list-interrupted-operation");
          },
        },
      })),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => args[1] === "ls"
      ? { stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]), stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: interruptedToken,
      runner,
      modal,
      afterJournalPublished: async () => {
        expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
          phase: "prepared",
          operationToken: interruptedToken,
        });
        await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
        throw new Error("simulated power loss after durable journal publication");
      },
    })).rejects.toThrow("simulated power loss after durable journal publication");

    await expect(access(journalPath)).resolves.toBeUndefined();
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: successorToken,
      runner,
      modal,
    })).resolves.toEqual({ volumeName: "private-auth" });

    expect(listedTags).toEqual([{
      product: "dex",
      purpose: "codex-auth-setup",
      volume: "private-auth",
      operation: interruptedToken,
    }]);
    expect(lifecycle).toEqual([
      "list-interrupted-operation",
      "create-successor",
      "terminate-successor",
    ]);
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates an exact-tagged survivor before releasing a prepared-phase lease to a successor", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const journalPath = path.join(fixture.directory, "setup-operation.json");
    const interruptedToken = "a".repeat(64);
    const successorToken = "b".repeat(64);
    const lifecycle: string[] = [];
    const processResult = {
      stdout: { readText: async () => "" },
      stderr: { readText: async () => "" },
      wait: async () => 0,
    };
    const survivor = {
      sandboxId: "sb-prepared-survivor",
      terminate: vi.fn(async ({ wait }: { wait: boolean }) => {
        expect(wait).toBe(true);
        lifecycle.push("terminate-survivor");
      }),
    };
    const replacement = {
      sandboxId: "sb-prepared-successor",
      exec: vi.fn(async () => processResult),
      terminate: vi.fn(async () => { lifecycle.push("terminate-successor"); }),
    };
    const modal = {
      create: vi.fn(async () => {
        expect(lifecycle).toContain("terminate-survivor");
        expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({
          operationToken: successorToken,
        });
        lifecycle.push("create-successor");
        return replacement;
      }),
      fromId: vi.fn(async (sandboxId: string) => {
        expect(sandboxId).toBe(survivor.sandboxId);
        lifecycle.push("attach-survivor");
        return survivor;
      }),
      client: vi.fn(async () => ({
        sandboxes: {
          list: async function* ({ tags }: { tags: Record<string, string> }) {
            lifecycle.push("list-exact-operation");
            yield {
              sandboxId: survivor.sandboxId,
              getTags: async () => ({ ...tags }),
            };
          },
        },
      })),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => args[1] === "ls"
      ? { stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]), stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: interruptedToken,
      runner,
      modal,
      afterJournalPublished: () => { throw new Error("simulated lost journal phase update"); },
    })).rejects.toThrow("simulated lost journal phase update");

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: successorToken,
      runner,
      modal,
    })).resolves.toEqual({ volumeName: "private-auth" });

    expect(lifecycle).toEqual([
      "list-exact-operation",
      "attach-survivor",
      "terminate-survivor",
      "create-successor",
      "terminate-successor",
    ]);
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the prepared-phase lease when Modal cannot prove exact operation-tag ownership", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const journalPath = path.join(fixture.directory, "setup-operation.json");
    const interruptedToken = "c".repeat(64);
    const modal = {
      create: vi.fn(),
      fromId: vi.fn(),
      client: vi.fn(async () => ({
        sandboxes: {
          list: async function* ({ tags }: { tags: Record<string, string> }) {
            yield {
              sandboxId: "sb-wrong-operation",
              getTags: async () => ({ ...tags, operation: "d".repeat(64) }),
            };
          },
        },
      })),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: interruptedToken,
      runner,
      modal,
      afterJournalPublished: () => { throw new Error("simulated power loss"); },
    })).rejects.toThrow("simulated power loss");

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: "e".repeat(64),
      runner,
      modal,
    })).rejects.toThrow("does not own the exact auth setup operation tags");

    expect(modal.fromId).not.toHaveBeenCalled();
    expect(modal.create).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({
      taskId: "setup:private-auth",
      operationToken: interruptedToken,
    });
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
      phase: "prepared",
      operationToken: interruptedToken,
    });
  });

  it("retains the prepared-phase lease when an exact-tagged survivor cannot be attached", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const journalPath = path.join(fixture.directory, "setup-operation.json");
    const interruptedToken = "d".repeat(64);
    const modal = {
      create: vi.fn(),
      fromId: vi.fn(async () => { throw new Error("temporary Modal attach failure"); }),
      client: vi.fn(async () => ({
        sandboxes: {
          list: async function* ({ tags }: { tags: Record<string, string> }) {
            yield {
              sandboxId: "sb-unreachable-survivor",
              getTags: async () => ({ ...tags }),
            };
          },
        },
      })),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: interruptedToken,
      runner,
      modal,
      afterJournalPublished: () => { throw new Error("simulated power loss"); },
    })).rejects.toThrow("simulated power loss");

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      journalPath,
      operationToken: "e".repeat(64),
      runner,
      modal,
    })).rejects.toThrow("could not be proven terminal");

    expect(modal.fromId).toHaveBeenCalledWith("sb-unreachable-survivor");
    expect(modal.create).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({
      operationToken: interruptedToken,
    });
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
      phase: "prepared",
      operationToken: interruptedToken,
    });
  });

  it("fails before inspecting Modal when the shared local auth lease is busy", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    await acquireCodexAuthLease(leasePath, "active-cloud-task", {
      workerId: "worker-active",
      operationToken: "3".repeat(64),
    });
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const modal = {
      create: vi.fn(),
      close: vi.fn(),
    } as unknown as ModalAdapter;

    const error = await seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      operationToken: "4".repeat(64),
      runner,
      modal,
    }).catch((caught) => caught);

    expect(isCodexAuthLeaseBusyError(error)).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(modal.create).not.toHaveBeenCalled();
    expect(modal.close).toHaveBeenCalledOnce();
    await expect(access(leasePath)).resolves.toBeUndefined();
  });

  it("retains the lease when terminate wait cannot confirm Volume persistence", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const process = { stdout: { readText: async () => "" }, stderr: { readText: async () => "" }, wait: async () => 0 };
    const sandbox = {
      sandboxId: "sb-auth-uncertain",
      exec: vi.fn(async () => process),
      terminate: vi.fn(async (options: { wait: boolean }) => {
        expect(options).toEqual({ wait: true });
        throw new Error("persistence acknowledgement unavailable");
      }),
    };
    const modal = {
      create: vi.fn(async () => sandbox),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => args[1] === "ls"
      ? { stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]), stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 });

    await expect(seedModalCodexAuth({
      authPath: fixture.authPath,
      volumeName: "private-auth",
      leasePath,
      operationToken: "5".repeat(64),
      runner,
      modal,
    })).rejects.toThrow("persistence acknowledgement unavailable");
    await expect(access(leasePath)).resolves.toBeUndefined();
  });

  it("never publishes an empty or partial lease when acquisition crashes before publication", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const operationToken = "9".repeat(64);
    let preparedContents = "";

    await expect(acquireCodexAuthLease(leasePath, "task-crash", {
      workerId: "worker-crash",
      operationToken,
      beforePublish: async (preparedPath) => {
        preparedContents = await readFile(preparedPath, "utf8");
        await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
        throw new Error("simulated crash before atomic publication");
      },
    })).rejects.toThrow("simulated crash before atomic publication");

    expect(JSON.parse(preparedContents)).toEqual({
      version: 1,
      taskId: "task-crash",
      workerId: "worker-crash",
      operationToken,
    });
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fixture.directory)).filter((entry) => entry.startsWith("account.lease.prepare."))).toEqual([]);

    await expect(acquireCodexAuthLease(leasePath, "task-retry", {
      workerId: "worker-retry",
      operationToken: "b".repeat(64),
    })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({
      taskId: "task-retry",
      workerId: "worker-retry",
    });
  });

  it("fences concurrent release retries and preserves a successor lease against a stale releaser", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const firstToken = "c".repeat(64);
    const successorToken = "d".repeat(64);
    await acquireCodexAuthLease(leasePath, "task-first", {
      workerId: "worker-first",
      operationToken: firstToken,
    });

    let capturedResolve!: () => void;
    let continueResolve!: () => void;
    const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
    const continueRelease = new Promise<void>((resolve) => { continueResolve = resolve; });
    const firstRelease = releaseCodexAuthLease(leasePath, "task-first", {
      kind: "terminate-wait",
      sandboxId: "sb-first",
      volumePersisted: true,
      operationToken: firstToken,
    }, {
      afterCapture: async () => {
        capturedResolve();
        await continueRelease;
      },
    });
    await captured;

    const concurrentRelease = await releaseCodexAuthLease(leasePath, "task-first", {
      kind: "terminate-wait",
      sandboxId: "sb-first-retry",
      volumePersisted: true,
      operationToken: firstToken,
    }).catch((error) => error);
    expect(isCodexAuthLeaseBusyError(concurrentRelease)).toBe(true);
    const concurrentAcquire = await acquireCodexAuthLease(leasePath, "task-successor", {
      workerId: "worker-successor",
      operationToken: successorToken,
    }).catch((error) => error);
    expect(isCodexAuthLeaseBusyError(concurrentAcquire)).toBe(true);

    continueResolve();
    await expect(firstRelease).resolves.toBe(true);
    await acquireCodexAuthLease(leasePath, "task-successor", {
      workerId: "worker-successor",
      operationToken: successorToken,
    });
    const successorContents = await readFile(leasePath, "utf8");

    await expect(releaseCodexAuthLease(leasePath, "task-first", {
      kind: "terminate-wait",
      sandboxId: "sb-stale-retry",
      volumePersisted: true,
      operationToken: firstToken,
    })).rejects.toThrow("owned by another task");
    expect(await readFile(leasePath, "utf8")).toBe(successorContents);
    await expect(acquireCodexAuthLease(leasePath, "task-successor", {
      workerId: "worker-successor",
      operationToken: successorToken,
      adoptExisting: true,
    })).resolves.toBeUndefined();
    expect((await readdir(fixture.directory)).filter((entry) => entry.startsWith("account.lease.release."))).toEqual([]);
  });

  it("surfaces lease contention as typed queueable capacity and requires terminal evidence to release", async () => {
    const fixture = await authFixture();
    const leasePath = path.join(fixture.directory, "account.lease");
    const operationToken = "a".repeat(64);
    await acquireCodexAuthLease(leasePath, "task-one", {
      workerId: "worker-one",
      operationToken,
    });
    expect((await stat(leasePath)).mode & 0o777).toBe(0o600);
    const busy = await acquireCodexAuthLease(leasePath, "task-two").catch((error) => error);
    expect(isCodexAuthLeaseBusyError(busy)).toBe(true);
    expect(busy).toMatchObject({
      code: "CODEX_AUTH_LEASE_BUSY",
      taskId: "task-two",
      ownerTaskId: "task-one",
    });
    await expect(releaseCodexAuthLease(leasePath, "task-two", {
      kind: "terminal-poll",
      sandboxId: "sb-other",
      exitCode: 0,
      operationToken,
    })).rejects.toThrow("owned by another task");

    // A result callback has no terminal evidence while the retained Sandbox
    // is alive, so the shared ChatGPT cache must remain leased.
    await expect(releaseCodexAuthLease(leasePath, "task-one")).resolves.toBe(false);
    await expect(access(leasePath)).resolves.toBeUndefined();
    await expect(releaseCodexAuthLease(leasePath, "task-one", {
      kind: "terminate-wait",
      sandboxId: "sb-one",
      volumePersisted: true,
      operationToken,
    })).resolves.toBe(true);
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(fixture.directory, "auth.json"), "utf8"))).toMatchObject({ auth_mode: "chatgpt" });
  });
});
