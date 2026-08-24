import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NotFoundError as ModalNotFoundError } from "modal";
import { z } from "zod";
import { ModalAdapter } from "../../cloud/modal/adapter.js";
import type { DexTask } from "../../state/schemas.js";
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
  "-c",
  "core.pager=cat",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "credential.helper=",
  "-c",
  "core.sshCommand=/usr/bin/false",
] as const;
const BUNDLE_DESCRIPTOR_PATH = "/dev/fd/3";
const UNSAFE_LOCAL_GIT_CONFIG = /^(?:include(?:if\..+)?\.path|core\.(?:hookspath|fsmonitor|worktree|sshcommand|pager|editor|gitproxy)|filter\..+|credential\..+|diff\.external|diff\..+\.command|difftool\..+\.cmd|merge\..+\.driver|mergetool\..+\.cmd|gpg\..+|user\.signingkey|commit\.gpgsign|tag\.gpgsign|pager\..+|sequence\.editor)$/i;

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
  poll?(): Promise<number | null>;
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
  options: { cwd: string; env: NodeJS.ProcessEnv; bundleFd?: number },
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
  /**
   * Revalidates durable task/worker ownership immediately before the task
   * branch is advanced. Retrieval and bundle verification may take long
   * enough for a replacement worker to take ownership in the meantime.
   */
  beforeApply?: () => Promise<void>;
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
  bundleSha256: string;
  bundleBytes?: number;
}

interface VerifiedWorktree {
  worktreePath: string;
  baseRef: string;
  baseCommit: string;
}

interface TrustedBundle {
  handle: FileHandle;
  directory: string;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
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
  ], "bundle SHA-256")!;
  if (!/^[a-f0-9]{64}$/.test(bundleSha256)) {
    throw importError(
      "invalid_input",
      "Cloud result bundle SHA-256 metadata is invalid.",
      false,
    );
  }

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
      bundleSha256,
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

function parseBundleHeads(output: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) heads.set(match[2], match[1]);
  }
  return heads;
}

function safeGitEnvironment(readLocalConfiguration = false): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "/usr/bin/true",
    GIT_SEQUENCE_EDITOR: "/usr/bin/true",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  if (!readLocalConfiguration) environment.GIT_CONFIG = "/dev/null";
  if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
  return environment;
}

const defaultRunner: CloudResultArgvRunner = (_command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.bundleFd === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", options.bundleFd],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr!.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
    child.once("error", reject);
    child.once("close", (code) => resolve({
      stdout,
      stderr,
      exitCode: code ?? 1,
    }));
  });

function assertCurrentOwner(metadata: Stats, label: string): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw importError("integrity_failed", `${label} is not owned by Dex.`, true);
  }
}

function assertSingleLinkRegularFile(metadata: Stats, label: string): void {
  if (!metadata.isFile()) {
    throw importError("integrity_failed", `${label} is not a regular file.`, true);
  }
  if (metadata.nlink !== 1) {
    throw importError("integrity_failed", `${label} must not be hard-linked.`, true);
  }
  assertCurrentOwner(metadata, label);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function materializeTrustedBundle(
  incomingPath: string,
  trustedPath: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<TrustedBundle> {
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  let trustedPathCreated = false;
  try {
    try {
      source = await open(incomingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw importError(
          "integrity_failed",
          "Retrieved cloud result must not be a symbolic link.",
          true,
        );
      }
      throw error;
    }
    const initialSource = await source.stat();
    assertSingleLinkRegularFile(initialSource, "Retrieved cloud result");
    await source.chmod(0o600);
    const sourceBefore = await source.stat();
    assertSingleLinkRegularFile(sourceBefore, "Retrieved cloud result");
    if (sourceBefore.size > maxBytes) {
      throw importError(
        "integrity_failed",
        "Cloud result bundle exceeds the allowed size.",
        true,
      );
    }
    if (expectedBytes !== undefined && sourceBefore.size !== expectedBytes) {
      throw importError(
        "integrity_failed",
        "Cloud result bundle size does not match metadata.",
        true,
      );
    }
    try {
      destination = await open(
        trustedPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      trustedPathCreated = true;
    } catch (error) {
      throw importError(
        "integrity_failed",
        "Could not create a private trusted result bundle.",
        true,
      );
    }

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (position + bytesRead > maxBytes) {
        throw importError(
          "integrity_failed",
          "Cloud result bundle exceeds the allowed size.",
          true,
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0) {
          throw importError(
            "integrity_failed",
            "Trusted result copy made no forward progress.",
            true,
          );
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.sync();
    await destination.chmod(0o400);

    const [sourceAfter, trustedBeforeUnlink] = await Promise.all([
      source.stat(),
      destination.stat(),
    ]);
    assertSingleLinkRegularFile(sourceAfter, "Retrieved cloud result");
    assertSingleLinkRegularFile(trustedBeforeUnlink, "Trusted cloud result");
    if (!sameFile(sourceBefore, sourceAfter) || position !== sourceBefore.size) {
      throw importError(
        "integrity_failed",
        "Retrieved cloud result changed while being copied.",
        true,
      );
    }
    if (trustedBeforeUnlink.size !== position) {
      throw importError(
        "integrity_failed",
        "Trusted cloud result copy is incomplete.",
        true,
      );
    }

    await unlink(trustedPath);
    trustedPathCreated = false;
    const trustedAfterUnlink = await destination.stat();
    if (
      trustedAfterUnlink.dev !== trustedBeforeUnlink.dev
      || trustedAfterUnlink.ino !== trustedBeforeUnlink.ino
      || trustedAfterUnlink.size !== trustedBeforeUnlink.size
      || trustedAfterUnlink.nlink !== 0
    ) {
      throw importError(
        "integrity_failed",
        "Trusted cloud result descriptor continuity was lost.",
        true,
      );
    }
    await source.close();
    source = undefined;
    const trusted = {
      handle: destination,
      directory: path.dirname(trustedPath),
      dev: trustedAfterUnlink.dev,
      ino: trustedAfterUnlink.ino,
      size: trustedAfterUnlink.size,
      sha256: digest.digest("hex"),
    };
    destination = undefined;
    return trusted;
  } finally {
    await Promise.all([
      source?.close().catch(() => undefined),
      destination?.close().catch(() => undefined),
    ]);
    if (trustedPathCreated) await unlink(trustedPath).catch(() => undefined);
  }
}

async function assertTrustedBundleContinuity(bundle: TrustedBundle): Promise<void> {
  const metadata = await bundle.handle.stat();
  if (
    !metadata.isFile()
    || metadata.dev !== bundle.dev
    || metadata.ino !== bundle.ino
    || metadata.size !== bundle.size
    || metadata.nlink !== 0
    || (metadata.mode & 0o777) !== 0o400
  ) {
    throw importError(
      "integrity_failed",
      "Trusted cloud result descriptor continuity was lost.",
      true,
    );
  }
  assertCurrentOwner(metadata, "Trusted cloud result");
}

async function createSingleUseBundleDescriptor(bundle: TrustedBundle): Promise<FileHandle> {
  await assertTrustedBundleContinuity(bundle);
  const transientPath = path.join(bundle.directory, `git-bundle-${randomUUID()}`);
  let transient: FileHandle | undefined;
  let transientPathCreated = false;
  try {
    transient = await open(
      transientPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    transientPathCreated = true;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < bundle.size) {
      const requested = Math.min(buffer.length, bundle.size - position);
      const { bytesRead } = await bundle.handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        throw importError(
          "integrity_failed",
          "Trusted cloud result descriptor ended unexpectedly.",
          true,
        );
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await transient.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0) {
          throw importError(
            "integrity_failed",
            "Single-use Git bundle copy made no forward progress.",
            true,
          );
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await transient.sync();
    await transient.chmod(0o400);
    const metadata = await transient.stat();
    assertSingleLinkRegularFile(metadata, "Single-use Git bundle");
    if (metadata.size !== bundle.size) {
      throw importError(
        "integrity_failed",
        "Single-use Git bundle copy is incomplete.",
        true,
      );
    }
    await unlink(transientPath);
    transientPathCreated = false;
    const unlinked = await transient.stat();
    if (unlinked.dev !== metadata.dev || unlinked.ino !== metadata.ino || unlinked.nlink !== 0) {
      throw importError(
        "integrity_failed",
        "Single-use Git bundle descriptor continuity was lost.",
        true,
      );
    }
    await assertTrustedBundleContinuity(bundle);
    const result = transient;
    transient = undefined;
    return result;
  } finally {
    await transient?.close().catch(() => undefined);
    if (transientPathCreated) await unlink(transientPath).catch(() => undefined);
  }
}

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
    let trustedBundle: TrustedBundle | undefined;
    let importSucceeded = false;
    let stage: "attach" | "temporary_path" | "copy" | "verify" | "import" | "ownership" = "attach";

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
      const incomingBundlePath = path.join(directory, "incoming.bundle");
      const trustedBundlePath = path.join(directory, "trusted.bundle");

      stage = "copy";
      await sandbox.copyToLocal(expected.remoteBundlePath, incomingBundlePath);

      stage = "verify";
      trustedBundle = await materializeTrustedBundle(
        incomingBundlePath,
        trustedBundlePath,
        this.#maxBundleBytes,
        expected.bundleBytes,
      );
      const bundleBytes = trustedBundle.size;
      const bundleSha256 = trustedBundle.sha256;
      if (expected.bundleSha256 !== undefined && bundleSha256 !== expected.bundleSha256) {
        throw importError(
          "integrity_failed",
          "Cloud result bundle SHA-256 does not match metadata.",
          true,
        );
      }
      await this.#requireBundleGit(
        trustedBundle,
        worktree.worktreePath,
        ["bundle", "verify", BUNDLE_DESCRIPTOR_PATH],
        "integrity_failed",
        "Git rejected the cloud result bundle.",
        true,
      );
      const listed = await this.#requireBundleGit(
        trustedBundle,
        worktree.worktreePath,
        [
          "bundle",
          "list-heads",
          BUNDLE_DESCRIPTOR_PATH,
          `refs/heads/${expected.branch}`,
        ],
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
      await this.#requireBundleGit(
        trustedBundle,
        worktree.worktreePath,
        ["bundle", "unbundle", BUNDLE_DESCRIPTOR_PATH],
        "git_import_failed",
        "Git could not import the cloud result bundle.",
        true,
      );
      await trustedBundle.handle.close();
      trustedBundle = undefined;
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
      stage = "ownership";
      await input.beforeApply?.();
      stage = "import";
      await this.#requireGit(
        worktree.worktreePath,
        ["merge", "--ff-only", "--no-edit", expected.commit],
        "git_import_failed",
        "Git could not fast-forward the Dex task branch.",
        true,
      );
      await this.#verifyImportedState(worktree, expected);
      importSucceeded = true;
      // Termination is a separate durable runtime effect. Returning only
      // after terminate(wait=true) created a crash window where the branch was
      // already applied and the sandbox was gone, but no replay journal had
      // yet been committed. Detach here and let the caller journal cleanup
      // before ending the sandbox.
      await Promise.resolve(sandbox.detach()).catch(() => undefined);

      return {
        taskId: expected.taskId,
        sandboxId: expected.sandboxId,
        branch: expected.branch,
        commit: expected.commit,
        bundleSha256,
        bundleBytes,
        sandboxTerminated: false,
      };
    } catch (error) {
      if (sandbox && !importSucceeded) {
        await Promise.resolve(sandbox.detach()).catch(() => undefined);
      }
      if (error instanceof CloudResultImportError) throw error;
      // Ownership failures belong to the durable caller. Preserve their type
      // so a stale result cannot be misclassified as a retryable Git failure.
      if (stage === "ownership") throw error;
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
      await trustedBundle?.handle.close().catch(() => undefined);
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Ends a retained result sandbox when a non-retryable import validation
   * failure means its branch can never be applied. A false result deliberately
   * keeps the durable auth lease owned so startup recovery can retry cleanup.
   */
  async terminateRetainedSandbox(sandboxId: string): Promise<boolean> {
    let sandbox: CloudResultSandbox | undefined;
    try {
      sandbox = await this.#modal.fromId(sandboxId);
    } catch (error) {
      // Only Modal's typed not-found result from the exact sandbox lookup is
      // evidence that this durable sandbox ID no longer exists. Filesystem
      // ENOENT and generic dependency errors are not terminal evidence.
      if (modalSandboxNotFound(error)) return true;
      return false;
    }
    if (sandbox.sandboxId !== sandboxId) return false;
    try {
      await sandbox.terminate({ wait: true });
      return true;
    } catch {
      // A terminate failure can refer to a mounted volume, transport, or other
      // dependency. Never reinterpret it as sandbox absence. Poll the exact
      // sandbox instead and accept only a terminal exit or Modal's typed
      // not-found response from that sandbox-specific operation.
      if (sandbox.poll) {
        try {
          if (await sandbox.poll() !== null) return true;
        } catch (pollError) {
          if (modalSandboxNotFound(pollError)) return true;
        }
      }
      await Promise.resolve(sandbox.detach()).catch(() => undefined);
      return false;
    }
  }

  async #git(cwd: string, args: readonly string[]): Promise<CloudResultCommandResult> {
    return this.#gitWithDescriptor(cwd, args);
  }

  async #gitWithDescriptor(
    cwd: string,
    args: readonly string[],
    bundleFd?: number,
    readLocalConfiguration = false,
  ): Promise<CloudResultCommandResult> {
    try {
      return await this.#runner(
        "git",
        [...GIT_CONFIG_ARGS, ...args],
        {
          cwd,
          env: safeGitEnvironment(readLocalConfiguration),
          ...(bundleFd === undefined ? {} : { bundleFd }),
        },
      );
    } catch {
      throw importError(
        "git_import_failed",
        "Git could not inspect or update the Dex task worktree.",
        true,
      );
    }
  }

  async #requireBundleGit(
    bundle: TrustedBundle,
    cwd: string,
    args: readonly string[],
    code: CloudResultImportErrorCode,
    message: string,
    recoverable: boolean,
  ): Promise<CloudResultCommandResult> {
    await assertTrustedBundleContinuity(bundle);
    const duplicate = await createSingleUseBundleDescriptor(bundle);
    try {
      const duplicateMetadata = await duplicate.stat();
      if (
        !duplicateMetadata.isFile()
        || duplicateMetadata.size !== bundle.size
        || duplicateMetadata.nlink !== 0
        || (duplicateMetadata.mode & 0o777) !== 0o400
      ) {
        throw importError(
          "integrity_failed",
          "Trusted cloud result descriptor continuity was lost.",
          true,
        );
      }
      assertCurrentOwner(duplicateMetadata, "Single-use Git bundle");
      const result = await this.#gitWithDescriptor(cwd, args, duplicate.fd);
      if (result.exitCode !== 0) throw importError(code, message, recoverable);
      await assertTrustedBundleContinuity(bundle);
      return result;
    } finally {
      await duplicate.close();
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

  async #assertSafeGitConfiguration(cwd: string): Promise<void> {
    const result = await this.#gitWithDescriptor(cwd, [
      "config",
      "--local",
      "--no-includes",
      "--name-only",
      "--null",
      "--list",
    ], undefined, true);
    if (result.exitCode !== 0) {
      throw importError(
        "repository_mismatch",
        "Dex task Git configuration could not be inspected safely.",
        true,
      );
    }
    const unsafe = result.stdout
      .split("\0")
      .map((value) => value.trim())
      .filter(Boolean)
      .find((name) => UNSAFE_LOCAL_GIT_CONFIG.test(name));
    if (unsafe) {
      throw importError(
        "repository_mismatch",
        "Dex task Git configuration contains an unsafe external helper.",
        false,
      );
    }
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

    await Promise.all([
      this.#assertSafeGitConfiguration(repositoryPath),
      this.#assertSafeGitConfiguration(worktreePath),
    ]);

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

function modalSandboxNotFound(error: unknown): boolean {
  return error instanceof ModalNotFoundError;
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
