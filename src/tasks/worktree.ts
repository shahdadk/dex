import path from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { execFile } from "../utils/exec.js";

export interface RepositoryInfo {
  root: string;
  branch: string;
  remote?: string;
}

export interface WorktreeResult {
  branch: string;
  path: string;
  /** True only when this invocation attached the worktree. */
  createdWorktree: boolean;
  /** True only when this invocation created the branch. */
  createdBranch: boolean;
}

const WORKTREE_CLEANUP_TIMEOUT_MS = 10_000;
const WORKTREE_CLEANUP_ATTEMPTS = 2;

export async function inspectRepository(repositoryPath: string): Promise<RepositoryInfo> {
  const root = await git(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const branch = await git(repositoryPath, ["branch", "--show-current"]);
  const remoteResult = await execFile("git", ["-C", root, "remote", "get-url", "origin"]);
  return {
    root,
    branch: branch || "HEAD",
    ...(remoteResult.exitCode === 0 && remoteResult.stdout.trim()
      ? { remote: remoteResult.stdout.trim() }
      : {}),
  };
}

export async function createWorktree(
  repository: RepositoryInfo,
  worktreesRoot: string,
  taskId: string,
): Promise<WorktreeResult> {
  const branch = `dex/${taskId}`;
  const worktreePath = path.join(worktreesRoot, taskId);
  await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
  if (await exists(worktreePath)) {
    const actualBranch = await git(worktreePath, ["branch", "--show-current"]);
    if (actualBranch !== branch) {
      throw new Error(`Refusing to reuse ${worktreePath}: expected ${branch}, found ${actualBranch}`);
    }
    return { branch, path: worktreePath, createdWorktree: false, createdBranch: false };
  }

  const existingBranch = await execFile("git", ["-C", repository.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const createdBranch = existingBranch.exitCode !== 0;
  const args = existingBranch.exitCode === 0
    ? ["-C", repository.root, "worktree", "add", worktreePath, branch]
    : ["-C", repository.root, "worktree", "add", "-b", branch, worktreePath, "HEAD"];
  const result = await execFile("git", args);
  if (result.exitCode !== 0) {
    const partial = { branch, path: worktreePath, createdWorktree: await exists(worktreePath), createdBranch };
    const cleanupError = await rollbackCreatedWorktree(repository.root, partial).then(
      () => undefined,
      (error: unknown) => error,
    );
    const creationError = new Error(`Could not create worktree: ${result.stderr || result.stdout}`);
    if (cleanupError) {
      throw new AggregateError([creationError, cleanupError], `Could not create or fully roll back worktree ${worktreePath}`);
    }
    throw creationError;
  }
  return { branch, path: worktreePath, createdWorktree: true, createdBranch };
}

/**
 * Removes only resources created by the matching preparation attempt. The
 * exact path and the `dex/` branch namespace are validated before any Git
 * mutation, and every command has a short bounded timeout.
 */
export async function rollbackCreatedWorktree(
  repositoryRoot: string,
  worktree: WorktreeResult,
): Promise<void> {
  const resolvedRepository = path.resolve(repositoryRoot);
  const resolvedWorktree = path.resolve(worktree.path);
  if (!worktree.branch.startsWith("dex/") || worktree.branch.length <= "dex/".length) {
    throw new Error(`Refusing to roll back non-Dex branch ${worktree.branch}`);
  }
  if (resolvedWorktree === path.parse(resolvedWorktree).root || resolvedWorktree === resolvedRepository) {
    throw new Error(`Refusing unsafe worktree rollback target ${resolvedWorktree}`);
  }

  if (worktree.createdWorktree && await exists(resolvedWorktree)) {
    await boundedGitCleanup(
      resolvedRepository,
      ["worktree", "remove", "--force", resolvedWorktree],
      `remove worktree ${resolvedWorktree}`,
    );
    if (await exists(resolvedWorktree)) {
      throw new Error(`Git reported success but worktree still exists: ${resolvedWorktree}`);
    }
  }

  if (worktree.createdBranch) {
    const existsResult = await execFile("git", [
      "-C", resolvedRepository,
      "show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`,
    ], { timeout: WORKTREE_CLEANUP_TIMEOUT_MS });
    if (existsResult.exitCode === 0) {
      await boundedGitCleanup(
        resolvedRepository,
        ["branch", "-D", worktree.branch],
        `delete branch ${worktree.branch}`,
      );
    }
  }
}

export async function changedFiles(worktreePath: string): Promise<string[]> {
  const output = await git(worktreePath, ["status", "--porcelain=v1"]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function boundedGitCleanup(repositoryRoot: string, args: string[], description: string): Promise<void> {
  let failure = "unknown Git cleanup failure";
  for (let attempt = 0; attempt < WORKTREE_CLEANUP_ATTEMPTS; attempt += 1) {
    const result = await execFile("git", ["-C", repositoryRoot, ...args], {
      timeout: WORKTREE_CLEANUP_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return;
    failure = result.stderr || result.stdout || failure;
  }
  throw new Error(`Could not ${description} after ${WORKTREE_CLEANUP_ATTEMPTS} attempts: ${failure}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
