import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDexPaths } from "../src/config/paths.js";
import { EventLog } from "../src/state/events.js";
import { DexProjectSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { TaskManager } from "../src/tasks/task-manager.js";
import { createWorktree } from "../src/tasks/worktree.js";
import { execFile } from "../src/utils/exec.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  })));
});

describe("atomic Dex task acceptance and preparation", () => {
  it("rolls back the first worktree and branch when the second preparation fails, then retries without duplicate tasks", async () => {
    const fixture = await createFixture();
    let preparationCount = 0;
    const tasks = new TaskManager(fixture.store, fixture.events, fixture.paths, {
      createWorktree: async (repository, worktreesRoot, taskId) => {
        preparationCount += 1;
        if (preparationCount === 2) throw new Error("simulated second-worktree failure");
        return createWorktree(repository, worktreesRoot, taskId);
      },
    });
    const inputs = [
      { description: "fix auth", project: fixture.project, preferredAgent: "codex" as const, dedupeKey: "message-1:0" },
      { description: "investigate checkout", project: fixture.project, preferredAgent: "claude" as const, dedupeKey: "message-1:1" },
    ];
    const accepted = await tasks.acceptTasks(inputs);

    await expect(tasks.prepareTasks(accepted.map(({ id }) => id)))
      .rejects.toThrow("simulated second-worktree failure");

    await expect(access(accepted[0]!.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(branchExists(fixture.repository, accepted[0]!.dexBranch)).resolves.toBe(false);
    const afterFailure = await fixture.store.read();
    expect(Object.keys(afterFailure.tasks)).toHaveLength(2);
    expect(Object.values(afterFailure.tasks).every((task) => task.metadata.preparationStatus === "pending")).toBe(true);

    const retry = new TaskManager(fixture.store, fixture.events, fixture.paths);
    const acceptedAgain = await retry.acceptTasks(inputs);
    expect(acceptedAgain.map(({ id }) => id)).toEqual(accepted.map(({ id }) => id));
    const prepared = await retry.prepareTasks(acceptedAgain.map(({ id }) => id));

    expect(prepared.every((task) => task.metadata.preparationStatus === "ready")).toBe(true);
    expect(Object.keys((await fixture.store.read()).tasks)).toHaveLength(2);
    await expect(retry.prepareTasks(prepared.map(({ id }) => id))).resolves.toHaveLength(2);
  });

  it("rolls back every prepared worktree when the atomic ready-state write fails", async () => {
    const fixture = await createFixture();
    const tasks = new TaskManager(fixture.store, fixture.events, fixture.paths);
    const accepted = await tasks.acceptTasks([
      { description: "fix auth", project: fixture.project, dedupeKey: "message-2:0" },
      { description: "fix checkout", project: fixture.project, dedupeKey: "message-2:1" },
    ]);
    const write = vi.spyOn(fixture.store, "updateState").mockImplementationOnce(async () => {
      throw new Error("simulated ready-state write failure");
    });

    await expect(tasks.prepareTasks(accepted.map(({ id }) => id)))
      .rejects.toThrow("simulated ready-state write failure");
    write.mockRestore();

    for (const task of accepted) {
      await expect(access(task.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(branchExists(fixture.repository, task.dexBranch)).resolves.toBe(false);
    }
    expect(Object.values((await fixture.store.read()).tasks).every((task) =>
      task.metadata.preparationStatus === "pending")).toBe(true);

    // A retry transitions the same accepted identities; it does not insert a
    // second set of durable tasks.
    await expect(tasks.prepareTasks(accepted.map(({ id }) => id))).resolves.toHaveLength(2);
    expect(Object.keys((await fixture.store.read()).tasks)).toHaveLength(2);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dex-task-creation-"));
  roots.push(root);
  const repository = path.join(root, "repo");
  await execFile("git", ["init", "-b", "main", repository]);
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await execFile("git", ["-C", repository, "add", "README.md"]);
  await execFile("git", [
    "-C", repository,
    "-c", "user.name=Dex Tests",
    "-c", "user.email=dex@example.test",
    "commit", "-m", "fixture",
  ]);
  const paths = resolveDexPaths(path.join(root, "dex-home"));
  const store = new DexStateStore(paths.state);
  const events = new EventLog(paths.events);
  const project = DexProjectSchema.parse({
    id: "project-task-creation",
    name: "fixture",
    path: repository,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  });
  return { root, repository, paths, store, events, project };
}

async function branchExists(repository: string, branch: string): Promise<boolean> {
  const result = await execFile("git", [
    "-C", repository,
    "show-ref", "--verify", "--quiet", `refs/heads/${branch}`,
  ]);
  return result.exitCode === 0;
}
