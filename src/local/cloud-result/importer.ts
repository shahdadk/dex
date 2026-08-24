import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ModalAdapter } from "../../cloud/modal/adapter.js";
import type { DexTask } from "../../state/schemas.js";
import { execFile } from "../../utils/exec.js";
import {
  CloudResultCompletionSchema,
  type CloudResultCompletion,
} from "./schemas.js";

const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const GIT_CONFIG_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

const ImportTaskSchema = z.object({
  id: z.string().min(1).max(512),
  repositoryPath: z.string().min(1),
  baseBranch: z.string().min(1),
  dexBranch: z.string().min(1),
  worktreePath: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const GitObjectIdSchema = z.string().regex(
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/,
  "Expected a full Git object ID",
);

export type CloudResultImportErrorCode =
  | "invalid_input"
  | "not_importable"
  | "metadata_mismatch"
  | "repository_mismatch"
  | "worktree_dirty"
  | "sandbox_unavailable"
  | "retrieval_failed"
  | "integrity_failed"
  | "git_import_failed";

/** An intentionally detail-free error safe to persist or return to a caller. */
export class CloudResultImportError extends Error {
  readonly code: CloudResultImportErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: CloudResultImportErrorCode,
    message: string,
    recoverable: boolean,
  ) {
    super(message);
    this.name = "CloudResultImportError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface CloudResultSandbox {
  readonly sandboxId: string;
  copyToLocal(remotePath: string, localPath: string): Promise<void>;
  detach(): void | Promise<void>;
  terminate(params?: { wait?: boolean }): Promise<void | number>;
}

export interface CloudResultModal {
  fromId(sandboxId: string): Promise<CloudResultSandbox>;
}

export interface CloudResultCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CloudResultArgvRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<CloudResultCommandResult>;

export interface CloudResultImporterOptions {
  modal?: CloudResultModal;
  runner?: CloudResultArgvRunner;
  tempRoot?: string;
  maxBundleBytes?: number;
}

export interface ImportCloudResultInput {
  task: Pick<
    DexTask,
    | "id"
    | "repositoryPath"
    | "baseBranch"
    | "dexBranch"
    | "worktreePath"
    | "metadata"
  >;
  completion: unknown;
}

/** The small set of values a caller needs to persist after a successful import. */
export interface CloudResultImportResult {
  taskId: string;
  sandboxId: string;
  branch: string;
  commit: string;
  bundleSha256: string;
  bundleBytes: number;
  sandboxTerminated: boolean;
}

interface ExpectedResult {
  taskId: string;
  sandboxId: string;
  branch: string;
  commit: string;
  remoteBundlePath: string;
  bundleSha256?: string;
  bundleBytes?: number;
}

interface VerifiedWorktree {
  worktreePath: string;
  baseRef: string;
  baseCommit: string;
}

type ImportTask = z.output<typeof ImportTaskSchema>;

function importError(
  code: CloudResultImportErrorCode,
  message: string,
  recoverable: boolean,
): CloudResultImportError {
  return new CloudResultImportError(code, message, recoverable);
}

function oneMetadataValue(
  values: readonly (string | undefined)[],
  label: string,
  required = true,
): string | undefined {
  const supplied = values.filter((value): value is string => value !== undefined);
  const unique = new Set(supplied);
  if (unique.size > 1) {
    throw importError(
      "metadata_mismatch",
      `Cloud result ${label} metadata does not match.`,
      false,
    );
  }
  const value = supplied[0];
  if (required && value === undefined) {
    throw importError(
      "invalid_input",
      `Cloud result ${label} metadata is missing.`,
      false,
    );
  }
  return value;
}

function optionalTaskMetadata(
  metadata: Record<string, unknown>,
  key: "handoffHash" | "sandboxId",
): string | undefined {
  const value = metadata[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw importError(
      "invalid_input",
      `Task ${key} metadata is invalid.`,
      false,
    );
  }
  return value;
}

function resolveExpectedResult(
  taskInput: ImportCloudResultInput["task"],
  completionInput: unknown,
): { task: ImportTask; completion: CloudResultCompletion; expected: ExpectedResult } {
  let task: ImportTask;
  let completion: CloudResultCompletion;
  try {
    task = ImportTaskSchema.parse(taskInput);
    completion = CloudResultCompletionSchema.parse(completionInput);
  } catch {
    throw importError(
      "invalid_input",
      "Cloud result import input is invalid.",
      false,
    );
  }

  if (completion.status !== "succeeded" || completion.result?.status !== "succeeded") {
    throw importError(
      "not_importable",
      "Only a successful validated cloud result can be imported.",
      false,
    );
  }
  if (completion.taskId !== task.id || completion.result.taskId !== task.id) {
    throw importError(
      "metadata_mismatch",
      "Cloud result task metadata does not match.",
      false,
    );
  }
  if (!completion.result.validation.passed) {
    throw importError(
      "not_importable",
      "Cloud validation did not pass.",
      false,
    );
  }

  const taskSandboxId = optionalTaskMetadata(task.metadata, "sandboxId");
  const sandboxId = oneMetadataValue([
    completion.sandboxId,
    completion.sandbox?.id,
    taskSandboxId,
  ], "sandbox ID")!;

  oneMetadataValue([
    completion.handoffSha256,
    completion.result.handoffSha256,
    optionalTaskMetadata(task.metadata, "handoffHash"),
  ], "handoff hash");

  const remoteBundlePath = oneMetadataValue([
    completion.bundle?.path,
    completion.result.git.bundlePath,
  ], "bundle path")!;
  const bundleSha256 = oneMetadataValue([
    completion.bundle?.sha256,
    completion.result.git.bundleSha256,
  ], "bundle SHA-256", false);

  let commit: string;
  try {
    commit = GitObjectIdSchema.parse(completion.result.git.commit);
  } catch {
    throw importError(
      "invalid_input",
      "Cloud result commit metadata is invalid.",
      false,
    );
  }
  if (completion.result.git.branch !== task.dexBranch) {
    throw importError(
      "metadata_mismatch",
      "Cloud result branch does not match the Dex task branch.",
      false,
    );
  }

  return {
    task,
    completion,
    expected: {
      taskId: task.id,
      sandboxId,
      branch: task.dexBranch,
      commit,
      remoteBundlePath,
      ...(bundleSha256 === undefined ? {} : { bundleSha256 }),
      ...(completion.bundle?.bytes === undefined
        ? {}
        : { bundleBytes: completion.bundle.bytes }),
    },
  };
}

function safeTaskSegment(taskId: string): string {
  const readable = taskId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "task";
  const digest = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function parseBundleHeads(output: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) heads.set(match[2], match[1]);
  }
  return heads;
}

const defaultRunner: CloudResultArgvRunner = (command, args, options) =>
  execFile(command, args, options);

/**
 * Retrieves and imports a completed Modal bundle without mutating state. The
 * caller persists the returned result only after this transaction succeeds.
 */
export class CloudResultImporter {
  readonly #modal: CloudResultModal;
  readonly #runner: CloudResultArgvRunner;
  readonly #tempRoot: string;
  readonly #maxBundleBytes: number;

  constructor(options: CloudResultImporterOptions = {}) {
    this.#modal = options.modal ?? new ModalAdapter();
    this.#runner = options.runner ?? defaultRunner;
    this.#tempRoot = path.resolve(options.tempRoot ?? tmpdir());
    this.#maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
    if (!Number.isSafeInteger(this.#maxBundleBytes) || this.#maxBundleBytes <= 0) {
      throw new TypeError("maxBundleBytes must be a positive safe integer");
    }
  }

  async import(input: ImportCloudResultInput): Promise<CloudResultImportResult> {
    const { task, expected } = resolveExpectedResult(input.task, input.completion);
    if (expected.bundleBytes !== undefined && expected.bundleBytes > this.#maxBundleBytes) {
      throw importError(
        "integrity_failed",
        "Cloud result bundle exceeds the allowed size.",
        false,
      );
    }

    const worktree = await this.#verifyWorktree(task);
    let directory: string | undefined;
    let sandbox: CloudResultSandbox | undefined;
    let importSucceeded = false;
    let stage: "attach" | "temporary_path" | "copy" | "verify" | "import" = "attach";

    try {
      sandbox = await this.#modal.fromId(expected.sandboxId);
      if (sandbox.sandboxId !== expected.sandboxId) {
        throw importError(
          "metadata_mismatch",
          "The reconnected sandbox ID does not match.",
          false,
        );
      }

      stage = "temporary_path";
      await mkdir(this.#tempRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(
        this.#tempRoot,
        `dex-cloud-result-${safeTaskSegment(expected.taskId)}-`,
      ));
      await chmod(directory, 0o700);
      const localBundlePath = path.join(directory, "result.bundle");

      stage = "copy";
      await sandbox.copyToLocal(expected.remoteBundlePath, localBundlePath);
      const bundleStat = await lstat(localBundlePath);
      if (!bundleStat.isFile() || bundleStat.isSymbolicLink()) {
        throw importError(
          "integrity_failed",
          "Retrieved cloud result is not a regular file.",
          true,
        );
      }
      await chmod(localBundlePath, 0o600);
      if (bundleStat.size > this.#maxBundleBytes) {
        throw importError(
          "integrity_failed",
          "Cloud result bundle exceeds the allowed size.",
          true,
        );
      }
      if (expected.bundleBytes !== undefined && bundleStat.size !== expected.bundleBytes) {
        throw importError(
          "integrity_failed",
          "Cloud result bundle size does not match metadata.",
          true,
        );
      }

      stage = "verify";
      const bundleSha256 = await sha256File(localBundlePath);
      if (expected.bundleSha256 !== undefined && bundleSha256 !== expected.bundleSha256) {
        throw importError(
          "integrity_failed",
          "Cloud result bundle SHA-256 does not match metadata.",
          true,
        );
      }
      await this.#requireGit(
        worktree.worktreePath,
        ["bundle", "verify", localBundlePath],
        "integrity_failed",
        "Git rejected the cloud result bundle.",
        true,
      );
      const listed = await this.#requireGit(
        worktree.worktreePath,
        ["bundle", "list-heads", localBundlePath, `refs/heads/${expected.branch}`],
        "integrity_failed",
        "Git could not inspect the cloud result bundle.",
        true,
      );
      const advertisedCommit = parseBundleHeads(listed.stdout).get(
        `refs/heads/${expected.branch}`,
      );
      if (advertisedCommit !== expected.commit) {
        throw importError(
          "integrity_failed",
          "Cloud result bundle commit does not match metadata.",
          true,
        );
      }

      stage = "import";
      await this.#requireGit(
        worktree.worktreePath,
        ["bundle", "unbundle", localBundlePath],
        "git_import_failed",
        "Git could not import the cloud result bundle.",
        true,
      );
      await this.#requireGit(
        worktree.worktreePath,
        ["cat-file", "-e", `${expected.commit}^{commit}`],
        "integrity_failed",
        "The expected cloud result commit is unavailable.",
        true,
      );
      await this.#requireGit(
        worktree.worktreePath,
        ["merge-base", "--is-ancestor", "HEAD", expected.commit],
        "git_import_failed",
        "Cloud result does not fast-forward the Dex task branch.",
        true,
      );
      await this.#requireGit(
        worktree.worktreePath,
        ["merge", "--ff-only", "--no-edit", expected.commit],
        "git_import_failed",
        "Git could not fast-forward the Dex task branch.",
        true,
      );
      await this.#verifyImportedState(worktree, expected);
      importSucceeded = true;

      let sandboxTerminated = false;
      try {
        await sandbox.terminate({ wait: true });
        sandboxTerminated = true;
      } catch {
        await Promise.resolve(sandbox.detach()).catch(() => undefined);
      }

      return {
        taskId: expected.taskId,
        sandboxId: expected.sandboxId,
        branch: expected.branch,
        commit: expected.commit,
        bundleSha256,
        bundleBytes: bundleStat.size,
        sandboxTerminated,
      };
    } catch (error) {
      if (sandbox && !importSucceeded) {
        await Promise.resolve(sandbox.detach()).catch(() => undefined);
      }
      if (error instanceof CloudResultImportError) throw error;
      if (stage === "attach") {
        throw importError(
          "sandbox_unavailable",
          "Could not reconnect to the retained cloud sandbox.",
          true,
        );
      }
      if (stage === "copy" || stage === "temporary_path") {
        throw importError(
          "retrieval_failed",
          "Could not retrieve the cloud result bundle.",
          true,
        );
      }
      if (stage === "verify") {
        throw importError(
          "integrity_failed",
          "Could not verify the cloud result bundle.",
          true,
        );
      }
      throw importError(
        "git_import_failed",
        "Could not import the cloud result into the Dex task branch.",
        true,
      );
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #git(cwd: string, args: readonly string[]): Promise<CloudResultCommandResult> {
    try {
      return await this.#runner(
        "git",
        [...GIT_CONFIG_ARGS, ...args],
        { cwd },
      );
    } catch {
      throw importError(
        "git_import_failed",
        "Git could not inspect or update the Dex task worktree.",
        true,
      );
    }
  }

  async #requireGit(
    cwd: string,
    args: readonly string[],
    code: CloudResultImportErrorCode,
    message: string,
    recoverable: boolean,
  ): Promise<CloudResultCommandResult> {
    const result = await this.#git(cwd, args);
    if (result.exitCode !== 0) throw importError(code, message, recoverable);
    return result;
  }

  async #verifyWorktree(task: ImportTask): Promise<VerifiedWorktree> {
    if (task.dexBranch === task.baseBranch) {
      throw importError(
        "repository_mismatch",
        "Dex task branch must be separate from the original branch.",
        false,
      );
    }

    let repositoryPath: string;
    let worktreePath: string;
    try {
      [repositoryPath, worktreePath] = await Promise.all([
        realpath(path.resolve(task.repositoryPath)),
        realpath(path.resolve(task.worktreePath)),
      ]);
    } catch {
      throw importError(
        "repository_mismatch",
        "Dex task repository or worktree is unavailable.",
        true,
      );
    }
    if (repositoryPath === worktreePath) {
      throw importError(
        "repository_mismatch",
        "Cloud results require a separate Dex task worktree.",
        false,
      );
    }

    const [repositoryRoot, worktreeRoot, repositoryCommon, worktreeCommon] =
      await Promise.all([
        this.#requireGit(
          repositoryPath,
          ["rev-parse", "--show-toplevel"],
          "repository_mismatch",
          "Original repository metadata is invalid.",
          true,
        ),
        this.#requireGit(
          worktreePath,
          ["rev-parse", "--show-toplevel"],
          "repository_mismatch",
          "Dex task worktree metadata is invalid.",
          true,
        ),
        this.#requireGit(
          repositoryPath,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          "repository_mismatch",
          "Original repository metadata is invalid.",
          true,
        ),
        this.#requireGit(
          worktreePath,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          "repository_mismatch",
          "Dex task worktree metadata is invalid.",
          true,
        ),
      ]);

    let resolvedRepositoryRoot: string;
    let resolvedWorktreeRoot: string;
    let resolvedRepositoryCommon: string;
    let resolvedWorktreeCommon: string;
    try {
      [
        resolvedRepositoryRoot,
        resolvedWorktreeRoot,
        resolvedRepositoryCommon,
        resolvedWorktreeCommon,
      ] = await Promise.all([
        realpath(repositoryRoot.stdout.trim()),
        realpath(worktreeRoot.stdout.trim()),
        realpath(repositoryCommon.stdout.trim()),
        realpath(worktreeCommon.stdout.trim()),
      ]);
    } catch {
      throw importError(
        "repository_mismatch",
        "Dex task Git paths could not be verified.",
        true,
      );
    }
    if (
      resolvedRepositoryRoot !== repositoryPath
      || resolvedWorktreeRoot !== worktreePath
      || resolvedRepositoryCommon !== resolvedWorktreeCommon
    ) {
      throw importError(
        "repository_mismatch",
        "Dex task worktree does not belong to the expected repository.",
        false,
      );
    }

    const branch = await this.#requireGit(
      worktreePath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "repository_mismatch",
      "Dex task worktree is not on a branch.",
      true,
    );
    if (branch.stdout.trim() !== task.dexBranch) {
      throw importError(
        "repository_mismatch",
        "Dex task worktree is on the wrong branch.",
        false,
      );
    }

    const status = await this.#requireGit(
      worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "repository_mismatch",
      "Dex task worktree status could not be read.",
      true,
    );
    if (status.stdout.trim()) {
      throw importError(
        "worktree_dirty",
        "Dex task worktree has local changes; the retained sandbox was preserved.",
        true,
      );
    }

    const baseRef = `refs/heads/${task.baseBranch}`;
    const base = await this.#requireGit(
      repositoryPath,
      ["rev-parse", "--verify", `${baseRef}^{commit}`],
      "repository_mismatch",
      "Original branch ref could not be verified.",
      true,
    );
    return { worktreePath, baseRef, baseCommit: base.stdout.trim() };
  }

  async #verifyImportedState(
    worktree: VerifiedWorktree,
    expected: ExpectedResult,
  ): Promise<void> {
    const [head, branch, base, status] = await Promise.all([
      this.#requireGit(
        worktree.worktreePath,
        ["rev-parse", "HEAD"],
        "git_import_failed",
        "Imported cloud result HEAD could not be verified.",
        true,
      ),
      this.#requireGit(
        worktree.worktreePath,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        "repository_mismatch",
        "Dex task branch changed during import.",
        false,
      ),
      this.#requireGit(
        worktree.worktreePath,
        ["rev-parse", "--verify", `${worktree.baseRef}^{commit}`],
        "repository_mismatch",
        "Original branch ref could not be verified after import.",
        false,
      ),
      this.#requireGit(
        worktree.worktreePath,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        "git_import_failed",
        "Imported Dex task worktree status could not be read.",
        true,
      ),
    ]);

    if (head.stdout.trim() !== expected.commit) {
      throw importError(
        "git_import_failed",
        "Dex task branch did not reach the expected cloud result commit.",
        true,
      );
    }
    if (branch.stdout.trim() !== expected.branch) {
      throw importError(
        "repository_mismatch",
        "Dex task branch changed during import.",
        false,
      );
    }
    if (base.stdout.trim() !== worktree.baseCommit) {
      throw importError(
        "repository_mismatch",
        "Original branch changed during cloud result import.",
        false,
      );
    }
    if (status.stdout.trim()) {
      throw importError(
        "git_import_failed",
        "Imported Dex task worktree is not clean.",
        true,
      );
    }
  }
}

export function createCloudResultImporter(
  options?: CloudResultImporterOptions,
): CloudResultImporter {
  return new CloudResultImporter(options);
}

export async function importCloudResult(
  input: ImportCloudResultInput,
  options?: CloudResultImporterOptions,
): Promise<CloudResultImportResult> {
  return new CloudResultImporter(options).import(input);
}
