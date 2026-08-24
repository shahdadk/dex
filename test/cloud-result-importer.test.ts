import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotFoundError as ModalNotFoundError } from "modal";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudResultImportError,
  CloudResultImporter,
  type CloudResultArgvRunner,
  type CloudResultModal,
  type CloudResultSandbox,
} from "../src/local/cloud-result/index.js";
import { execFile } from "../src/utils/exec.js";

const HANDOFF_SHA256 = "a".repeat(64);
const temporaryDirectories: string[] = [];

interface GitFixture {
  directory: string;
  repositoryPath: string;
  worktreePath: string;
  cloudRepositoryPath: string;
  bundlePath: string;
  tempRoot: string;
  baseCommit: string;
  resultCommit: string;
  bundleSha256: string;
  bundleBytes: number;
  task: {
    id: string;
    repositoryPath: string;
    baseBranch: string;
    dexBranch: string;
    worktreePath: string;
    metadata: Record<string, unknown>;
  };
  completion: Record<string, unknown>;
}

interface ModalHarness {
  modal: CloudResultModal;
  calls: string[];
  copiedTo?: string;
  copiedDirectoryMode?: number;
  copiedFileMode?: number;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function mustGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed`);
  }
  return result.stdout.trim();
}

async function createGitFixture(
  remoteBundlePath = "/dex/result.bundle",
): Promise<GitFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-cloud-import-test-"));
  temporaryDirectories.push(directory);
  const repositoryPath = path.join(directory, "original");
  const worktreePath = path.join(directory, "task-worktree");
  const cloudRepositoryPath = path.join(directory, "cloud-worker");
  const bundlePath = path.join(directory, "result.bundle");
  const tempRoot = path.join(directory, "private-results");
  await mkdir(repositoryPath);
  await mustGit(["init", "-b", "main"], repositoryPath);
  await mustGit(["config", "user.name", "Dex Test"], repositoryPath);
  await mustGit(["config", "user.email", "dex@example.test"], repositoryPath);
  await writeFile(path.join(repositoryPath, "README.md"), "base\n", "utf8");
  await mustGit(["add", "README.md"], repositoryPath);
  await mustGit(["commit", "-m", "base"], repositoryPath);
  const baseCommit = await mustGit(["rev-parse", "HEAD"], repositoryPath);
  await mustGit(
    ["worktree", "add", "-b", "dex/task-result", worktreePath, "HEAD"],
    repositoryPath,
  );

  await mustGit(["clone", repositoryPath, cloudRepositoryPath], directory);
  await mustGit(
    ["checkout", "-b", "dex/task-result", "origin/dex/task-result"],
    cloudRepositoryPath,
  );
  await mustGit(["config", "user.name", "Dex Cloud"], cloudRepositoryPath);
  await mustGit(["config", "user.email", "dex-cloud@example.test"], cloudRepositoryPath);
  await writeFile(path.join(cloudRepositoryPath, "result.txt"), "retrieved\n", "utf8");
  await mustGit(["add", "result.txt"], cloudRepositoryPath);
  await mustGit(["commit", "-m", "cloud result"], cloudRepositoryPath);
  const resultCommit = await mustGit(["rev-parse", "HEAD"], cloudRepositoryPath);
  await mustGit(
    ["bundle", "create", bundlePath, "dex/task-result"],
    cloudRepositoryPath,
  );
  const bundle = await readFile(bundlePath);
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const bundleBytes = bundle.byteLength;
  const task = {
    id: "task-result",
    repositoryPath,
    baseBranch: "main",
    dexBranch: "dex/task-result",
    worktreePath,
    metadata: {
      handoffHash: HANDOFF_SHA256,
      sandboxId: "sandbox-result-1",
    },
  };
  const git = {
    branch: task.dexBranch,
    commit: resultCommit,
    bundlePath: remoteBundlePath,
    bundleSha256,
  };
  const completion = {
    taskId: task.id,
    status: "succeeded",
    sandboxId: "sandbox-result-1",
    sandbox: {
      id: "sandbox-result-1",
      resultPath: "/dex/result.json",
    },
    handoffSha256: HANDOFF_SHA256,
    bundle: {
      path: remoteBundlePath,
      sha256: bundleSha256,
      bytes: bundleBytes,
    },
    result: {
      taskId: task.id,
      handoffSha256: HANDOFF_SHA256,
      status: "succeeded",
      summary: "Cloud result is ready.",
      validation: { commands: ["[\"npm\",\"test\"]"], passed: true },
      git,
    },
  };
  return {
    directory,
    repositoryPath,
    worktreePath,
    cloudRepositoryPath,
    bundlePath,
    tempRoot,
    baseCommit,
    resultCommit,
    bundleSha256,
    bundleBytes,
    task,
    completion,
  };
}

function createModalHarness(
  fixture: GitFixture,
  options: {
    copyError?: Error;
    terminateError?: Error;
    pollResult?: number | null;
    pollError?: Error;
  } = {},
): ModalHarness {
  const harness: ModalHarness = { calls: [], modal: undefined as never };
  const sandbox: CloudResultSandbox = {
    sandboxId: "sandbox-result-1",
    async copyToLocal(remotePath, localPath) {
      harness.calls.push(`copy:${remotePath}`);
      harness.copiedTo = localPath;
      if (options.copyError) throw options.copyError;
      await copyFile(fixture.bundlePath, localPath);
    },
    async detach() {
      harness.calls.push("detach");
      if (harness.copiedTo) {
        const [directory, file] = await Promise.all([
          stat(path.dirname(harness.copiedTo)),
          stat(harness.copiedTo),
        ]);
        harness.copiedDirectoryMode = directory.mode & 0o777;
        harness.copiedFileMode = file.mode & 0o777;
      }
    },
    async terminate() {
      harness.calls.push("terminate");
      if (harness.copiedTo) {
        const [directory, file] = await Promise.all([
          stat(path.dirname(harness.copiedTo)),
          stat(harness.copiedTo),
        ]);
        harness.copiedDirectoryMode = directory.mode & 0o777;
        harness.copiedFileMode = file.mode & 0o777;
      }
      if (options.terminateError) throw options.terminateError;
    },
    async poll() {
      harness.calls.push("poll");
      if (options.pollError) throw options.pollError;
      return options.pollResult ?? null;
    },
  };
  harness.modal = {
    async fromId(sandboxId) {
      harness.calls.push(`fromId:${sandboxId}`);
      return sandbox;
    },
  };
  return harness;
}

async function runImporterGit(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; bundleFd?: number },
) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.bundleFd === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", options.bundleFd],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

describe("CloudResultImporter", () => {
  it("retrieves a real bundle privately and fast-forwards only the Dex task branch", async () => {
    const remoteBundlePath = "/dex/result.bundle; touch should-not-exist";
    const fixture = await createGitFixture(remoteBundlePath);
    const harness = createModalHarness(fixture);
    const argvCalls: Array<{
      command: string;
      args: readonly string[];
      bundleFd?: number;
      env: NodeJS.ProcessEnv;
    }> = [];
    const runner: CloudResultArgvRunner = async (command, args, options) => {
      argvCalls.push({
        command,
        args: [...args],
        env: options.env,
        ...(options.bundleFd === undefined ? {} : { bundleFd: options.bundleFd }),
      });
      return runImporterGit(command, args, options);
    };
    const importer = new CloudResultImporter({
      modal: harness.modal,
      runner,
      tempRoot: fixture.tempRoot,
    });

    const result = await importer.import({
      task: fixture.task,
      completion: fixture.completion,
    });

    expect(result).toEqual({
      taskId: fixture.task.id,
      sandboxId: "sandbox-result-1",
      branch: fixture.task.dexBranch,
      commit: fixture.resultCommit,
      bundleSha256: fixture.bundleSha256,
      bundleBytes: fixture.bundleBytes,
      sandboxTerminated: false,
    });
    expect(harness.calls).toEqual([
      "fromId:sandbox-result-1",
      `copy:${remoteBundlePath}`,
      "detach",
    ]);
    expect(harness.copiedTo).toContain("dex-cloud-result-task-result-");
    expect(harness.copiedDirectoryMode).toBe(0o700);
    expect(harness.copiedFileMode).toBe(0o600);
    expect(await readdir(fixture.tempRoot)).toEqual([]);

    expect(await mustGit(["rev-parse", "HEAD"], fixture.worktreePath)).toBe(
      fixture.resultCommit,
    );
    expect(await readFile(path.join(fixture.worktreePath, "result.txt"), "utf8")).toBe(
      "retrieved\n",
    );
    expect(await mustGit(["rev-parse", "refs/heads/main"], fixture.repositoryPath)).toBe(
      fixture.baseCommit,
    );
    expect(await mustGit(["branch", "--show-current"], fixture.repositoryPath)).toBe("main");
    expect(argvCalls.every(({ command }) => command === "git")).toBe(true);
    expect(argvCalls.some(({ args }) =>
      args.includes("merge") && args.includes(fixture.resultCommit)
    )).toBe(true);
    const bundleCalls = argvCalls.filter(({ args }) => args.includes("bundle"));
    expect(bundleCalls).toHaveLength(3);
    expect(bundleCalls.every(({ args, bundleFd }) =>
      args.includes("/dev/fd/3") && typeof bundleFd === "number"
    )).toBe(true);
    expect(argvCalls.every(({ env }) =>
      env.OPENAI_API_KEY === undefined
      && env.CODEX_API_KEY === undefined
      && env.DEX_HANDOFF_SIGNING_KEY === undefined
      && env.HOME === undefined
      && env.GIT_CONFIG_GLOBAL === "/dev/null"
    )).toBe(true);
    expect(argvCalls.some(({ env }) => env.GIT_CONFIG === "/dev/null")).toBe(true);
    expect(argvCalls.some(({ env }) => env.GIT_CONFIG === undefined)).toBe(true);
    await expect(stat(path.join(fixture.directory, "should-not-exist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("revalidates durable ownership immediately before advancing the task branch", async () => {
    const fixture = await createGitFixture();
    const harness = createModalHarness(fixture);
    const argvCalls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: CloudResultArgvRunner = async (command, args, options) => {
      argvCalls.push({ command, args: [...args] });
      return runImporterGit(command, args, options);
    };
    const importer = new CloudResultImporter({
      modal: harness.modal,
      runner,
      tempRoot: fixture.tempRoot,
    });
    const ownershipChanged = new Error("durable ownership changed");
    const beforeApply = vi.fn(async () => { throw ownershipChanged; });

    await expect(importer.import({
      task: fixture.task,
      completion: fixture.completion,
      beforeApply,
    })).rejects.toBe(ownershipChanged);

    expect(beforeApply).toHaveBeenCalledOnce();
    expect(argvCalls.some(({ args }) => args.includes("unbundle"))).toBe(true);
    expect(argvCalls.some(({ args }) => args.includes("merge"))).toBe(false);
    expect(await mustGit(["rev-parse", "HEAD"], fixture.worktreePath)).toBe(
      fixture.baseCommit,
    );
    expect(harness.calls).toEqual([
      "fromId:sandbox-result-1",
      "copy:/dex/result.bundle",
      "detach",
    ]);
  });

  it("preserves and detaches the sandbox when bundle integrity verification fails", async () => {
    const fixture = await createGitFixture();
    const harness = createModalHarness(fixture);
    const wrongSha256 = "b".repeat(64);
    const completion = structuredClone(fixture.completion) as {
      bundle: { sha256: string };
      result: { git: { bundleSha256: string } };
    };
    completion.bundle.sha256 = wrongSha256;
    completion.result.git.bundleSha256 = wrongSha256;
    const importer = new CloudResultImporter({
      modal: harness.modal,
      tempRoot: fixture.tempRoot,
    });

    await expect(importer.import({ task: fixture.task, completion })).rejects.toMatchObject({
      name: "CloudResultImportError",
      code: "integrity_failed",
      recoverable: true,
      message: "Cloud result bundle SHA-256 does not match metadata.",
    });
    expect(harness.calls).toEqual([
      "fromId:sandbox-result-1",
      "copy:/dex/result.bundle",
      "detach",
    ]);
    expect(await mustGit(["rev-parse", "HEAD"], fixture.worktreePath)).toBe(
      fixture.baseCommit,
    );
    expect(await readdir(fixture.tempRoot)).toEqual([]);
  });

  it("rejects symbolic-link and hard-link retrieval artifacts before Git can inspect them", async () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const fixture = await createGitFixture();
      const calls: string[] = [];
      const sandbox: CloudResultSandbox = {
        sandboxId: "sandbox-result-1",
        async copyToLocal(_remotePath, localPath) {
          calls.push("copy");
          if (kind === "symlink") await symlink(fixture.bundlePath, localPath);
          else await link(fixture.bundlePath, localPath);
        },
        async detach() { calls.push("detach"); },
        async terminate() { calls.push("terminate"); },
      };
      const importer = new CloudResultImporter({
        modal: { fromId: async () => sandbox },
        tempRoot: fixture.tempRoot,
      });

      await expect(importer.import({
        task: fixture.task,
        completion: fixture.completion,
      })).rejects.toMatchObject({
        code: "integrity_failed",
        recoverable: true,
        message: kind === "symlink"
          ? "Retrieved cloud result must not be a symbolic link."
          : "Retrieved cloud result must not be hard-linked.",
      });
      expect(calls).toEqual(["copy", "detach"]);
      expect(await readFile(fixture.bundlePath)).toHaveLength(fixture.bundleBytes);
      expect(await readdir(fixture.tempRoot)).toEqual([]);
    }
  });

  it("keeps Git on an unlinked descriptor when an attacker swaps the retrieval pathname", async () => {
    const fixture = await createGitFixture();
    const harness = createModalHarness(fixture);
    const bundleCalls: Array<{ path: string; bundleFd?: number }> = [];
    let swapped = false;
    const runner: CloudResultArgvRunner = async (command, args, options) => {
      if (!swapped && args.includes("bundle")) {
        swapped = true;
        const copiedTo = harness.copiedTo!;
        await rm(copiedTo, { force: true });
        await writeFile(copiedTo, "attacker replacement\n");
      }
      if (args.includes("bundle")) {
        bundleCalls.push({
          path: args[args.indexOf("bundle") + 2] ?? "",
          ...(options.bundleFd === undefined ? {} : { bundleFd: options.bundleFd }),
        });
      }
      return runImporterGit(command, args, options);
    };
    const importer = new CloudResultImporter({
      modal: harness.modal,
      runner,
      tempRoot: fixture.tempRoot,
    });

    await expect(importer.import({
      task: fixture.task,
      completion: fixture.completion,
    })).resolves.toMatchObject({
      commit: fixture.resultCommit,
      bundleSha256: fixture.bundleSha256,
    });
    expect(swapped).toBe(true);
    expect(bundleCalls).toHaveLength(3);
    expect(bundleCalls.every(({ path: bundlePath, bundleFd }) =>
      bundlePath === "/dev/fd/3" && typeof bundleFd === "number"
    )).toBe(true);
    expect(await mustGit(["rev-parse", "HEAD"], fixture.worktreePath)).toBe(
      fixture.resultCommit,
    );
  });

  it("rejects local Git filter helpers before importing a cloud bundle", async () => {
    const fixture = await createGitFixture();
    const marker = path.join(fixture.directory, "filter-helper-ran");
    const helper = path.join(fixture.worktreePath, "filter-helper");
    await writeFile(helper, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ncat\n`);
    await chmod(helper, 0o755);
    await mustGit(["config", "--local", "filter.exfil.smudge", helper], fixture.worktreePath);
    const harness = createModalHarness(fixture);
    const importer = new CloudResultImporter({
      modal: harness.modal,
      tempRoot: fixture.tempRoot,
    });

    await expect(importer.import({
      task: fixture.task,
      completion: fixture.completion,
    })).rejects.toMatchObject({
      code: "repository_mismatch",
      recoverable: false,
      message: "Dex task Git configuration contains an unsafe external helper.",
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.calls).toEqual([]);
  });

  it("redacts retrieval failures and never terminates the retained sandbox", async () => {
    const fixture = await createGitFixture();
    const secret = "modal-super-secret";
    const harness = createModalHarness(fixture, {
      copyError: new Error(`Authorization: Bearer ${secret} at ${fixture.bundlePath}`),
    });
    const importer = new CloudResultImporter({
      modal: harness.modal,
      tempRoot: fixture.tempRoot,
    });

    let thrown: unknown;
    try {
      await importer.import({ task: fixture.task, completion: fixture.completion });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CloudResultImportError);
    expect(thrown).toMatchObject({
      code: "retrieval_failed",
      recoverable: true,
      message: "Could not retrieve the cloud result bundle.",
    });
    expect(String(thrown)).not.toContain(secret);
    expect(String(thrown)).not.toContain(fixture.bundlePath);
    expect(harness.calls).toEqual([
      "fromId:sandbox-result-1",
      "copy:/dex/result.bundle",
      "detach",
    ]);
  });

  it("rejects conflicting completion metadata before reconnecting", async () => {
    const fixture = await createGitFixture();
    const harness = createModalHarness(fixture);
    const completion = structuredClone(fixture.completion) as {
      sandbox: { id: string };
    };
    completion.sandbox.id = "different-sandbox";
    const importer = new CloudResultImporter({
      modal: harness.modal,
      tempRoot: fixture.tempRoot,
    });

    await expect(importer.import({ task: fixture.task, completion })).rejects.toMatchObject({
      code: "metadata_mismatch",
      recoverable: false,
      message: "Cloud result sandbox ID metadata does not match.",
    });
    expect(harness.calls).toEqual([]);
  });

  it("requires one continuous result-bundle hash before reconnecting", async () => {
    const fixture = await createGitFixture();
    const harness = createModalHarness(fixture);
    const completion = structuredClone(fixture.completion) as {
      bundle: { sha256?: string };
      result: { git: { bundleSha256?: string } };
    };
    delete completion.bundle.sha256;
    delete completion.result.git.bundleSha256;
    const importer = new CloudResultImporter({
      modal: harness.modal,
      tempRoot: fixture.tempRoot,
    });

    await expect(importer.import({ task: fixture.task, completion })).rejects.toMatchObject({
      code: "invalid_input",
      recoverable: false,
      message: "Cloud result bundle SHA-256 metadata is missing.",
    });
    expect(harness.calls).toEqual([]);
  });

  it("leaves successful sandbox termination to the caller's durable effect journal", async () => {
    const fixture = await createGitFixture();
    const harness = createModalHarness(fixture, {
      terminateError: new Error("Bearer retained-sandbox-token"),
    });
    const importer = new CloudResultImporter({
      modal: harness.modal,
      tempRoot: fixture.tempRoot,
    });

    const result = await importer.import({
      task: fixture.task,
      completion: fixture.completion,
    });

    expect(result.sandboxTerminated).toBe(false);
    expect(result.commit).toBe(fixture.resultCommit);
    expect(harness.calls).toEqual([
      "fromId:sandbox-result-1",
      "copy:/dex/result.bundle",
      "detach",
    ]);
  });

  it("reports retained-sandbox cleanup evidence only after wait termination succeeds", async () => {
    const fixture = await createGitFixture();
    const successful = createModalHarness(fixture);
    const failed = createModalHarness(fixture, {
      terminateError: new Error("snapshot unavailable"),
    });

    await expect(new CloudResultImporter({
      modal: successful.modal,
      tempRoot: fixture.tempRoot,
    }).terminateRetainedSandbox("sandbox-result-1")).resolves.toBe(true);
    expect(successful.calls).toEqual(["fromId:sandbox-result-1", "terminate"]);

    await expect(new CloudResultImporter({
      modal: failed.modal,
      tempRoot: fixture.tempRoot,
    }).terminateRetainedSandbox("sandbox-result-1")).resolves.toBe(false);
    expect(failed.calls).toEqual(["fromId:sandbox-result-1", "terminate", "poll", "detach"]);

    const absentError = new ModalNotFoundError("Sandbox not found");
    await expect(new CloudResultImporter({
      modal: { fromId: async () => { throw absentError; } },
      tempRoot: fixture.tempRoot,
    }).terminateRetainedSandbox("sandbox-result-1")).resolves.toBe(true);

    const dependencyError = new Error("mounted volume does not exist") as NodeJS.ErrnoException;
    dependencyError.code = "ENOENT";
    const ambiguous = createModalHarness(fixture, { terminateError: dependencyError });
    await expect(new CloudResultImporter({
      modal: ambiguous.modal,
      tempRoot: fixture.tempRoot,
    }).terminateRetainedSandbox("sandbox-result-1")).resolves.toBe(false);
    expect(ambiguous.calls).toEqual(["fromId:sandbox-result-1", "terminate", "poll", "detach"]);

    const absentAfterCrash = createModalHarness(fixture, {
      terminateError: new Error("already ended"),
      pollError: new ModalNotFoundError("Sandbox not found"),
    });
    await expect(new CloudResultImporter({
      modal: absentAfterCrash.modal,
      tempRoot: fixture.tempRoot,
    }).terminateRetainedSandbox("sandbox-result-1")).resolves.toBe(true);
    expect(absentAfterCrash.calls).toEqual(["fromId:sandbox-result-1", "terminate", "poll"]);
  });
});
