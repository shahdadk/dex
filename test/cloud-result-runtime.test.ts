import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexVerifiedCommand } from "../src/cloud/messaging/index.js";
import { DexDaemonRuntime } from "../src/local/daemon/runtime.js";
import { EventLog } from "../src/state/events.js";
import { DexTaskSchema, WorkerSessionSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";

const directories: string[] = [];
const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-cloud-runtime-"));
  directories.push(directory);
  const store = new DexStateStore(path.join(directory, "state.json"));
  const events = new EventLog(path.join(directory, "events.jsonl"));
  const now = "2026-08-23T12:00:00.000Z";
  const task = DexTaskSchema.parse({
    id: "cloud-task",
    projectId: "project-1",
    title: "checkout ordering",
    originalRequest: "fix checkout ordering",
    repositoryPath: "/repo",
    baseBranch: "main",
    dexBranch: "dex/cloud-task",
    worktreePath: "/worktree",
    status: "running",
    stage: "implementing",
    createdAt: now,
    updatedAt: now,
    currentWorkerId: "worker-modal",
    metadata: {
      conversationId: "conversation-1",
      sandboxId: "sandbox-1",
      handoffHash: HASH,
    },
  });
  const worker = WorkerSessionSchema.parse({
    id: "worker-modal",
    taskId: task.id,
    agent: "codex",
    target: { kind: "modal", sandboxId: "sandbox-1" },
    status: "running",
    startedAt: now,
  });
  await store.updateState((state) => {
    state.tasks[task.id] = task;
    state.workers[worker.id] = worker;
  });
  return { directory, store, events, task };
}

function completionCommand(): DexVerifiedCommand {
  return {
    id: "command-cloud-complete",
    issuedAt: "2026-08-23T12:05:00.000Z",
    command: {
      type: "task.cloud.completed",
      payload: {
        taskId: "cloud-task",
        workerId: "worker-modal",
        status: "succeeded",
        summary: "checkout is fixed and validated",
        sandboxId: "sandbox-1",
        handoffSha256: HASH,
        bundle: { path: "/dex/result.bundle", sha256: "c".repeat(64), bytes: 123 },
        result: {
          taskId: "cloud-task",
          handoffSha256: HASH,
          status: "succeeded",
          summary: "checkout is fixed and validated",
          validation: { commands: ["npm test"], passed: true },
          git: {
            branch: "dex/cloud-task",
            commit: COMMIT,
            bundlePath: "/dex/result.bundle",
            bundleSha256: "c".repeat(64),
          },
        },
      },
    },
    authority: {
      kind: "verified_owner",
      ownerId: "owner-1",
      conversationId: "conversation-1",
      verified: true,
    },
    verified: true,
    signingKeyId: "server-key-1",
  };
}

describe("cloud result completion in the daemon", () => {
  it("imports the retained bundle before completing the task and drains queued work", async () => {
    const { directory, store, events, task } = await fixture();
    const resultImporter = { import: vi.fn(async () => ({
      taskId: task.id,
      sandboxId: "sandbox-1",
      branch: task.dexBranch,
      commit: COMMIT,
      bundleSha256: "c".repeat(64),
      bundleBytes: 123,
      sandboxTerminated: true,
    })) };
    const drainQueue = vi.fn(async () => undefined);
    const maybeSleepWhenReady = vi.fn(async () => false);
    const receipt = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: { receipt, syncOnce: vi.fn(async () => []), notify: vi.fn(async () => undefined) } as never,
      router: {} as never,
      orchestrator: { drainQueue } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady } as never,
      resultImporter,
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(completionCommand());

    expect(resultImporter.import).toHaveBeenCalledWith({
      task: expect.objectContaining({ id: task.id, dexBranch: task.dexBranch }),
      completion: expect.objectContaining({ taskId: task.id, status: "succeeded" }),
    });
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "completed",
      stage: "done",
      metadata: {
        resultImport: {
          status: "completed",
          commit: COMMIT,
          sandboxTerminated: true,
        },
      },
    });
    expect(drainQueue).toHaveBeenCalledOnce();
    expect(maybeSleepWhenReady).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledWith("command-cloud-complete", "processed");
  });

  it("preserves a recoverable import failure without lying about local synchronization", async () => {
    const { directory, store, events, task } = await fixture();
    const notify = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: { receipt: vi.fn(async () => undefined), syncOnce: vi.fn(async () => []), notify } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter: { import: vi.fn(async () => { throw new Error("Bearer should-not-leak"); }) },
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(completionCommand());

    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "completed",
      metadata: { resultImport: { status: "failed", code: "retrieval_failed", recoverable: true } },
    });
    expect(JSON.stringify((await store.read()).tasks[task.id]?.metadata)).not.toContain("should-not-leak");
    expect(notify).toHaveBeenCalledWith(
      "conversation-1",
      expect.stringContaining("cloud sandbox is preserved"),
    );
  });
});
