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
}

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
    return { branch, path: worktreePath };
  }

  const existingBranch = await execFile("git", ["-C", repository.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const args = existingBranch.exitCode === 0
    ? ["-C", repository.root, "worktree", "add", worktreePath, branch]
    : ["-C", repository.root, "worktree", "add", "-b", branch, worktreePath, "HEAD"];
  const result = await execFile("git", args);
  if (result.exitCode !== 0) throw new Error(`Could not create worktree: ${result.stderr || result.stdout}`);
  return { branch, path: worktreePath };
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

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
