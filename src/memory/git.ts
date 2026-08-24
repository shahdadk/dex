import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "../utils/exec.js";
import { sha256Hex } from "./integrity.js";

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
  options: { cwd: string; env: NodeJS.ProcessEnv },
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
): Promise<CommandResult> {
  const command: ArgvCommand = { command: "git", args: hardenedGitArgs(args), cwd };
  const result = await runner(command.command, command.args, {
    cwd: command.cwd,
    env: safeGitEnvironment(),
  });
  if (result.exitCode !== 0) throw new GitCommandError(command, result);
  return result;
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
  const detectedBranch = (
    await runGit(runner, repositoryPath, ["rev-parse", "--abbrev-ref", "HEAD"])
  ).stdout.trim();
  const branch = options.branch ?? (detectedBranch === "HEAD" ? headCommit : detectedBranch);
  const bundle = await createGitBundle({
    repositoryPath,
    bundlePath: options.bundlePath,
    refs: [branch],
    runner,
  });
  return {
    baseCommit: options.baseCommit ?? initialHead,
    headCommit,
    branch,
    dirtyBeforeCheckpoint,
    bundle,
  };
}

export const checkpointGit = createGitCheckpoint;
