import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { execFile } from "../utils/exec.js";
import { sha256Hex } from "./integrity.js";
import { scanForSecrets } from "./redaction.js";

export interface ArgvCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ArgvRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) => Promise<CommandResult>;

export interface GitBundleInfo {
  path: string;
  bytes: number;
  sha256: string;
  refs: string[];
}

export interface GitCheckpoint {
  baseCommit: string;
  headCommit: string;
  branch: string;
  dirtyBeforeCheckpoint: boolean;
  bundle: GitBundleInfo;
}

export interface TrackedTextFile {
  path: string;
  content: string;
  bytes: number;
}

export interface GitCheckpointOptions {
  repositoryPath: string;
  bundlePath: string;
  baseCommit?: string;
  branch?: string;
  commitDirty?: boolean;
  commitMessage?: string;
  runner?: ArgvRunner;
}

export class GitCommandError extends Error {
  readonly command: ArgvCommand;
  readonly exitCode: number;

  constructor(command: ArgvCommand, result: CommandResult) {
    super(
      `git ${command.args[0] ?? "command"} failed with exit code ${result.exitCode}: ${
        result.stderr.trim() || result.stdout.trim() || "no output"
      }`,
    );
    this.name = "GitCommandError";
    this.command = command;
    this.exitCode = result.exitCode;
  }
}

const SAFE_GIT_CONFIGURATION = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.attributesFile=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "credential.helper=",
  "-c", "core.sshCommand=/usr/bin/false",
  "-c", "user.name=Dex Checkpoint",
  "-c", "user.email=dex-checkpoint@localhost",
] as const;

const UNSAFE_LOCAL_GIT_CONFIG = /^(?:include(?:if\..+)?\.path|core\.(?:hookspath|fsmonitor|worktree|sshcommand|pager|editor|gitproxy)|filter\..+|credential\..+|diff\.external|diff\..+\.command|difftool\..+\.cmd|merge\..+\.driver|mergetool\..+\.cmd|gpg\..+|user\.signingkey|commit\.gpgsign|tag\.gpgsign|pager\..+|sequence\.editor)$/i;

const MAX_CHECKPOINT_REACHABLE_OBJECTS = 250_000;
const MAX_CHECKPOINT_HISTORY_ENTRIES = 500_000;
const MAX_CHECKPOINT_BLOBS = 100_000;
const MAX_CHECKPOINT_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_HISTORY_BLOB_BYTES = 512 * 1024 * 1024;
const MAX_CHECKPOINT_PATH_BYTES = 4_096;
const SAFE_ENV_TEMPLATE = /^\.env\.(?:example|sample|template|defaults?)$/i;
const SECRET_BEARING_BASENAME = /^(?:\.env(?:\..+)?|\.envrc|\.git-credentials|\.netrc|\.npmrc|\.pgpass|\.pypirc|auth\.json|credentials?(?:\.(?:json|ya?ml|toml|ini|conf|config))?|secrets?(?:\.(?:json|ya?ml|toml|ini|conf|config))|service[-_.]?account(?:[-_.].*)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:key|pem|p12|pfx|jks|keystore|kdbx))$/i;
const STRUCTURED_SECRET_ASSIGNMENT = /(?:^|\r?\n)\s*(?:export\s+)?(?:[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|credential|cookie|session[_-]?token))\s*[:=]\s*(?!\[(?:REDACTED|REDACTED_[A-Z_]+)\](?:\s|$))(?:(?:"[^"\r\n]+")|(?:'[^'\r\n]+')|(?:[^\s#;,]{4,}))/gim;
const UNSAFE_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\uFFFD]/u;

const defaultRunner: ArgvRunner = (_command, args, options) =>
  execFile("/usr/bin/git", args, options);

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

function hardenedGitArgs(args: readonly string[]): string[] {
  return [...SAFE_GIT_CONFIGURATION, ...args];
}

async function assertSafeRepositoryConfiguration(
  runner: ArgvRunner,
  cwd: string,
): Promise<void> {
  const command: ArgvCommand = {
    command: "git",
    args: ["config", "--local", "--no-includes", "--name-only", "--null", "--list"],
    cwd,
  };
  const result = await runner(command.command, command.args, {
    cwd,
    env: safeGitEnvironment(true),
  });
  if (result.exitCode !== 0) throw new GitCommandError(command, result);
  const unsafe = result.stdout
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .find((name) => UNSAFE_LOCAL_GIT_CONFIG.test(name));
  if (unsafe) {
    throw new Error(`Repository Git configuration is unsafe for checkpointing: ${unsafe}`);
  }
}

async function runGit(
  runner: ArgvRunner,
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<CommandResult> {
  const command: ArgvCommand = { command: "git", args: hardenedGitArgs(args), cwd };
  const result = await runner(command.command, command.args, {
    cwd: command.cwd,
    env: safeGitEnvironment(),
    ...(input === undefined ? {} : { input }),
  });
  if (result.exitCode !== 0) throw new GitCommandError(command, result);
  return result;
}

interface ReachableBlob {
  bytes: number;
  paths: Set<string>;
}

interface GitObjectMetadata {
  type: string;
  bytes: number;
}

function assertSafeCheckpointPath(trackedPath: string): void {
  const normalized = path.posix.normalize(trackedPath);
  if (
    !trackedPath ||
    Buffer.byteLength(trackedPath, "utf8") > MAX_CHECKPOINT_PATH_BYTES ||
    UNSAFE_PATH_CHARACTERS.test(trackedPath) ||
    path.posix.isAbsolute(trackedPath) ||
    normalized !== trackedPath ||
    trackedPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Git checkpoint contains an unsafe tracked path");
  }
}

function isSecretBearingFilename(trackedPath: string): boolean {
  const basename = path.posix.basename(trackedPath);
  return !SAFE_ENV_TEMPLATE.test(basename) && SECRET_BEARING_BASENAME.test(basename);
}

function secretKindsInBlob(trackedPaths: readonly string[], content: string): string[] {
  const kinds = new Set(scanForSecrets(content).map(({ kind }) => kind));
  STRUCTURED_SECRET_ASSIGNMENT.lastIndex = 0;
  if (STRUCTURED_SECRET_ASSIGNMENT.test(content)) kinds.add("secret-assignment");
  STRUCTURED_SECRET_ASSIGNMENT.lastIndex = 0;

  if (trackedPaths.some((trackedPath) => path.posix.extname(trackedPath).toLowerCase() === ".json")) {
    try {
      for (const finding of scanForSecrets(JSON.parse(content) as unknown)) {
        kinds.add(finding.kind);
      }
    } catch {
      // Non-JSON text with a .json suffix is still covered by the raw-text
      // patterns. JSON validity is outside the checkpoint security boundary.
    }
  }
  return [...kinds].sort();
}

async function reachableObjectMetadata(
  runner: ArgvRunner,
  repositoryPath: string,
  objectIds: readonly string[],
): Promise<Map<string, GitObjectMetadata>> {
  const metadata = new Map<string, GitObjectMetadata>();
  if (runner === defaultRunner) {
    const result = await runGit(
      runner,
      repositoryPath,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      `${objectIds.join("\n")}\n`,
    );
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const parsed = /^([a-f0-9]{40,64}) ([a-z]+) ([0-9]+)$/.exec(line);
      if (!parsed) throw new Error("Git returned invalid reachable-object metadata");
      const [, objectId, type, rawBytes] = parsed;
      const bytes = Number(rawBytes);
      if (!objectId || !type || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("Git returned invalid reachable-object metadata");
      }
      metadata.set(objectId, { type, bytes });
    }
  } else {
    // Custom runners used by callers and tests may not implement stdin. Keep
    // their existing contract functional while production uses one batch
    // metadata query for the full reachable closure.
    for (const objectId of objectIds) {
      const type = (await runGit(runner, repositoryPath, ["cat-file", "-t", objectId]))
        .stdout.trim();
      const bytes = Number(
        (await runGit(runner, repositoryPath, ["cat-file", "-s", objectId])).stdout.trim(),
      );
      if (!type || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error("Git returned invalid reachable-object metadata");
      }
      metadata.set(objectId, { type, bytes });
    }
  }
  if (metadata.size !== objectIds.length) {
    throw new Error("Git did not describe every reachable checkpoint object");
  }
  return metadata;
}

function recordHistoricalBlob(
  blobs: Map<string, ReachableBlob>,
  reachableObjects: ReadonlyMap<string, GitObjectMetadata>,
  mode: string,
  objectId: string,
  trackedPath: string,
): void {
  if (/^0+$/.test(objectId) || mode === "000000") return;
  if (!/^100(?:644|755)$/.test(mode)) {
    throw new Error(`Git checkpoint history contains a non-regular blob: ${trackedPath}`);
  }
  const metadata = reachableObjects.get(objectId);
  if (metadata?.type !== "blob") {
    throw new Error("Git checkpoint history references an invalid regular blob");
  }
  const blob = blobs.get(objectId);
  if (!blob) {
    throw new Error("Git checkpoint history contains an unenumerated blob");
  }
  blob.paths.add(trackedPath);
}

/**
 * Fails closed over every blob reachable from the exact commit before it can
 * become an uploadable bundle. Content is deduplicated by immutable object ID;
 * historical paths are retained separately so deleted secret-bearing files are
 * still rejected. Raw bytes that cannot be represented as canonical UTF-8 are
 * intentionally rejected because silently skipping binary blobs would leave an
 * unscanned data channel into the bundle.
 */
async function assertSafeCheckpointHistory(
  runner: ArgvRunner,
  repositoryPath: string,
  revision: string,
): Promise<void> {
  const reachable = await runGit(runner, repositoryPath, [
    "rev-list",
    "--objects",
    "--no-object-names",
    revision,
  ]);
  const objectIds = [...new Set(reachable.stdout.split("\n").filter(Boolean))];
  if (
    objectIds.length === 0 ||
    objectIds.some((objectId) => !/^[a-f0-9]{40,64}$/.test(objectId))
  ) {
    throw new Error("Git returned an invalid reachable checkpoint object list");
  }
  if (objectIds.length > MAX_CHECKPOINT_REACHABLE_OBJECTS) {
    throw new Error(
      `Git checkpoint exceeds the ${MAX_CHECKPOINT_REACHABLE_OBJECTS}-object safety limit`,
    );
  }

  const metadata = await reachableObjectMetadata(runner, repositoryPath, objectIds);
  const blobs = new Map<string, ReachableBlob>();
  let totalBytes = 0;
  for (const [objectId, object] of metadata) {
    if (object.type !== "blob") continue;
    if (object.bytes > MAX_CHECKPOINT_BLOB_BYTES) {
      throw new Error("Git checkpoint history contains an unsafe-size blob");
    }
    totalBytes += object.bytes;
    if (totalBytes > MAX_CHECKPOINT_HISTORY_BLOB_BYTES) {
      throw new Error(
        `Git checkpoint exceeds the ${MAX_CHECKPOINT_HISTORY_BLOB_BYTES}-byte blob safety limit`,
      );
    }
    blobs.set(objectId, { bytes: object.bytes, paths: new Set() });
  }
  if (blobs.size > MAX_CHECKPOINT_BLOBS) {
    throw new Error(`Git checkpoint exceeds the ${MAX_CHECKPOINT_BLOBS}-blob safety limit`);
  }

  const history = await runGit(runner, repositoryPath, [
    "log",
    "--raw",
    "-z",
    "-m",
    "--root",
    "--no-renames",
    "--no-abbrev",
    "--format=",
    revision,
  ]);
  const historyParts = history.stdout.split("\0");
  let historyEntries = 0;
  for (let index = 0; index < historyParts.length; index += 1) {
    const header = historyParts[index];
    if (!header) continue;
    const trackedPath = historyParts[index + 1];
    if (trackedPath === undefined || !trackedPath) {
      throw new Error("Git returned an invalid checkpoint history entry");
    }
    index += 1;
    historyEntries += 1;
    if (historyEntries > MAX_CHECKPOINT_HISTORY_ENTRIES) {
      throw new Error(
        `Git checkpoint exceeds the ${MAX_CHECKPOINT_HISTORY_ENTRIES}-history-entry safety limit`,
      );
    }
    const parsed = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([A-Z][0-9]*)$/.exec(
      header,
    );
    if (!parsed) throw new Error("Git returned an invalid checkpoint history entry");
    assertSafeCheckpointPath(trackedPath);
    if (isSecretBearingFilename(trackedPath)) {
      throw new Error(`Git checkpoint secret scan rejected filename: ${trackedPath}`);
    }
    const [, oldMode, newMode, oldObjectId, newObjectId] = parsed;
    recordHistoricalBlob(blobs, metadata, oldMode!, oldObjectId!, trackedPath);
    recordHistoricalBlob(blobs, metadata, newMode!, newObjectId!, trackedPath);
  }

  for (const [objectId, blob] of blobs) {
    const trackedPaths = [...blob.paths].sort();
    if (trackedPaths.length === 0) {
      throw new Error("Git checkpoint contains a reachable blob without a safe historical path");
    }
    let result: CommandResult;
    try {
      result = await runGit(runner, repositoryPath, ["cat-file", "blob", objectId]);
    } catch {
      // A failed reader can return partial blob bytes. Do not propagate the
      // command's stdout/stderr through GitCommandError and risk logging them.
      throw new Error(`Git checkpoint blob inspection failed: ${trackedPaths[0]}`);
    }
    const decodedBytes = Buffer.byteLength(result.stdout, "utf8");
    if (
      decodedBytes > blob.bytes ||
      blob.bytes - decodedBytes > 2 ||
      result.stdout.includes("\0") ||
      result.stdout.includes("\uFFFD")
    ) {
      throw new Error(`Git checkpoint contains an unsafe binary blob: ${trackedPaths[0]}`);
    }
    const secretKinds = secretKindsInBlob(trackedPaths, result.stdout);
    if (secretKinds.length > 0) {
      throw new Error(
        `Git checkpoint secret scan rejected content in ${trackedPaths[0]} (${secretKinds.join(", ")})`,
      );
    }
  }
}

/** Pure command builder used by tests and callers that need to audit argv. */
export function buildGitCheckpointCommands(options: {
  repositoryPath: string;
  bundlePath: string;
  refs?: readonly string[];
  dirty?: boolean;
  commitDirty?: boolean;
  commitMessage?: string;
}): ArgvCommand[] {
  const commands: ArgvCommand[] = [
    {
      command: "git",
      args: ["config", "--local", "--no-includes", "--name-only", "--null", "--list"],
      cwd: options.repositoryPath,
    },
    {
      command: "git",
      args: hardenedGitArgs(["status", "--porcelain=v1", "--untracked-files=all"]),
      cwd: options.repositoryPath,
    },
  ];
  if (options.dirty && options.commitDirty) {
    commands.push(
      {
        command: "git",
        args: hardenedGitArgs(["add", "--all"]),
        cwd: options.repositoryPath,
      },
      {
        command: "git",
        args: hardenedGitArgs([
          "commit",
          "-m",
          options.commitMessage ?? "dex: checkpoint for cloud handoff",
        ]),
        cwd: options.repositoryPath,
      },
    );
  }
  commands.push(
    {
      command: "git",
      args: hardenedGitArgs(["rev-parse", "HEAD"]),
      cwd: options.repositoryPath,
    },
    {
      command: "git",
      args: hardenedGitArgs([
        "bundle",
        "create",
        path.resolve(options.bundlePath),
        ...(options.refs ?? ["HEAD"]),
      ]),
      cwd: options.repositoryPath,
    },
    {
      command: "git",
      args: hardenedGitArgs(["bundle", "verify", path.resolve(options.bundlePath)]),
      cwd: options.repositoryPath,
    },
  );
  return commands;
}

export async function createGitBundle(options: {
  repositoryPath: string;
  bundlePath: string;
  refs?: readonly string[];
  runner?: ArgvRunner;
}): Promise<GitBundleInfo> {
  const runner = options.runner ?? defaultRunner;
  const bundlePath = path.resolve(options.bundlePath);
  const refs = [...(options.refs ?? ["HEAD"])];
  if (refs.length === 0 || refs.some((ref) => !ref.trim())) {
    throw new TypeError("Git bundle creation requires at least one non-empty ref");
  }
  await assertSafeRepositoryConfiguration(runner, options.repositoryPath);
  await mkdir(path.dirname(bundlePath), { recursive: true, mode: 0o700 });
  await runGit(runner, options.repositoryPath, ["bundle", "create", bundlePath, ...refs]);
  await runGit(runner, options.repositoryPath, ["bundle", "verify", bundlePath]);
  const [content, metadata] = await Promise.all([readFile(bundlePath), stat(bundlePath)]);
  return {
    path: bundlePath,
    bytes: metadata.size,
    sha256: sha256Hex(content),
    refs,
  };
}

/** Lists tracked paths without allowing repository Git helpers to execute. */
export async function listTrackedFiles(options: {
  repositoryPath: string;
  pathspecs: readonly string[];
  runner?: ArgvRunner;
}): Promise<string[]> {
  if (
    options.pathspecs.length === 0 ||
    options.pathspecs.some((pathspec) => !pathspec || pathspec.includes("\0"))
  ) {
    throw new TypeError("Tracked-file discovery requires safe non-empty pathspecs");
  }
  const runner = options.runner ?? defaultRunner;
  const repositoryPath = path.resolve(options.repositoryPath);
  await assertSafeRepositoryConfiguration(runner, repositoryPath);
  const result = await runGit(runner, repositoryPath, [
    "ls-files",
    "-z",
    "--",
    ...options.pathspecs,
  ]);
  return [...new Set(result.stdout.split("\0").filter(Boolean))];
}

/** Resolves a commit through the same no-helper Git boundary used for checkpoints. */
export async function resolveGitRevision(options: {
  repositoryPath: string;
  revision: string;
  runner?: ArgvRunner;
}): Promise<string> {
  const revision = options.revision.trim();
  if (!revision || revision.startsWith("-") || revision.includes("\0")) {
    throw new TypeError("Git revision must be a safe non-empty value");
  }
  const runner = options.runner ?? defaultRunner;
  const repositoryPath = path.resolve(options.repositoryPath);
  await assertSafeRepositoryConfiguration(runner, repositoryPath);
  const result = await runGit(runner, repositoryPath, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  return result.stdout.trim();
}

/** Reads regular text blobs from one immutable commit without consulting the worktree. */
export async function readTrackedTextFilesAtRevision(options: {
  repositoryPath: string;
  revision: string;
  pathspecs: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  runner?: ArgvRunner;
}): Promise<TrackedTextFile[]> {
  const revision = options.revision.trim();
  if (!revision || revision.startsWith("-") || revision.includes("\0")) {
    throw new TypeError("Git revision must be a safe non-empty value");
  }
  if (
    options.pathspecs.length === 0 ||
    options.pathspecs.some((pathspec) => !/^[A-Za-z0-9._-]+$/.test(pathspec)) ||
    !Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1 ||
    !Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1 ||
    !Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < 1
  ) {
    throw new TypeError("Tracked text-file limits and basenames must be valid");
  }

  const runner = options.runner ?? defaultRunner;
  const repositoryPath = path.resolve(options.repositoryPath);
  await assertSafeRepositoryConfiguration(runner, repositoryPath);
  const listing = await runGit(runner, repositoryPath, [
    "ls-tree",
    "-r",
    "-z",
    revision,
  ]);
  // `git ls-tree` does not support the `:(glob)` pathspec magic accepted by
  // `git ls-files`. Read the immutable tree once and select exact basenames in
  // memory so nested AGENTS.md files cannot be lost or replaced by a later
  // worktree mutation.
  const selectedBasenames = new Set(options.pathspecs);
  const entries = listing.stdout.split("\0").filter(Boolean);

  const files: TrackedTextFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    if (separator < 1) throw new Error("Git returned an invalid tree entry");
    const [mode, type, objectId] = entry.slice(0, separator).split(" ");
    const trackedPath = entry.slice(separator + 1);
    if (!selectedBasenames.has(path.posix.basename(trackedPath))) continue;
    if (files.length >= options.maxFiles) {
      throw new Error(`Immutable repository file selection exceeds ${options.maxFiles} files`);
    }
    if (
      !mode || !/^100(?:644|755)$/.test(mode) || type !== "blob" ||
      !objectId || !/^[a-f0-9]{40,64}$/.test(objectId) ||
      !trackedPath || /[\0\r\n\t]/.test(trackedPath)
    ) {
      throw new Error("Repository instructions must be regular tracked text blobs");
    }
    const normalized = path.posix.normalize(trackedPath);
    if (
      normalized === "." ||
      path.posix.isAbsolute(normalized) ||
      normalized.split("/").includes("..") ||
      normalized !== trackedPath
    ) {
      throw new Error("Git returned an unsafe tracked text-file path");
    }

    const sizeResult = await runGit(runner, repositoryPath, ["cat-file", "-s", objectId]);
    const bytes = Number(sizeResult.stdout.trim());
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > options.maxFileBytes) {
      throw new Error(`Tracked text file is too large: ${trackedPath}`);
    }
    totalBytes += bytes;
    if (totalBytes > options.maxTotalBytes) {
      throw new Error("Tracked text files exceed the aggregate size limit");
    }
    const blob = await runGit(runner, repositoryPath, ["cat-file", "blob", objectId]);
    const decodedBytes = Buffer.byteLength(blob.stdout, "utf8");
    if (
      decodedBytes > bytes || bytes - decodedBytes > 2 ||
      blob.stdout.includes("\uFFFD") || blob.stdout.includes("\0")
    ) {
      throw new Error(`Tracked text file is not canonical UTF-8: ${trackedPath}`);
    }
    files.push({ path: trackedPath, content: blob.stdout, bytes });
  }
  return files;
}

export async function createGitCheckpoint(options: GitCheckpointOptions): Promise<GitCheckpoint> {
  const runner = options.runner ?? defaultRunner;
  const repositoryPath = path.resolve(options.repositoryPath);
  await assertSafeRepositoryConfiguration(runner, repositoryPath);
  const initialHead = (await runGit(runner, repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
  const status = await runGit(runner, repositoryPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const dirtyBeforeCheckpoint = status.stdout.trim().length > 0;
  if (dirtyBeforeCheckpoint && options.commitDirty !== true) {
    throw new Error(
      "Repository has uncommitted changes; set commitDirty to create a reconstructable checkpoint",
    );
  }
  if (dirtyBeforeCheckpoint) {
    await runGit(runner, repositoryPath, ["add", "--all"]);
    await runGit(runner, repositoryPath, [
      "commit",
      "-m",
      options.commitMessage ?? "dex: checkpoint for cloud handoff",
    ]);
  }

  const headCommit = (await runGit(runner, repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
  await assertSafeCheckpointHistory(runner, repositoryPath, headCommit);
  const detectedBranch = (
    await runGit(runner, repositoryPath, ["rev-parse", "--abbrev-ref", "HEAD"])
  ).stdout.trim();
  const branch = options.branch ?? (detectedBranch === "HEAD" ? headCommit : detectedBranch);
  const branchCommit = (
    await runGit(runner, repositoryPath, ["rev-parse", "--verify", `${branch}^{commit}`])
  ).stdout.trim();
  if (branchCommit !== headCommit) {
    throw new Error("Git checkpoint branch does not reference the scanned immutable commit");
  }
  const bundle = await createGitBundle({
    repositoryPath,
    bundlePath: options.bundlePath,
    refs: [branch],
    runner,
  });
  const bundledHeads = await runGit(runner, repositoryPath, [
    "bundle",
    "list-heads",
    bundle.path,
  ]);
  const expectedRef = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  const exportedHead = bundledHeads.stdout
    .split("\n")
    .map((line) => /^([a-f0-9]{40,64})\s+(\S+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .find((match) => match[2] === expectedRef);
  if (exportedHead?.[1] !== headCommit) {
    await unlink(bundle.path).catch(() => undefined);
    throw new Error("Git bundle branch does not reference the scanned immutable commit");
  }
  return {
    baseCommit: options.baseCommit ?? initialHead,
    headCommit,
    branch,
    dirtyBeforeCheckpoint,
    bundle,
  };
}

export const checkpointGit = createGitCheckpoint;
