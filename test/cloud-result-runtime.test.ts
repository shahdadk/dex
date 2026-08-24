import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexVerifiedCommand } from "../src/cloud/messaging/index.js";
import { CloudResultImportError } from "../src/local/cloud-result/index.js";
import { DexDaemonRuntime } from "../src/local/daemon/runtime.js";
import { EventLog } from "../src/state/events.js";
import { DexTaskSchema, WorkerSessionSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { acquireCodexAuthLease } from "../src/setup/modal-auth.js";

const directories: string[] = [];
const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);
const OPERATION_TOKEN = "d".repeat(64);

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
    blockedReason: "an earlier cloud attempt failed",
    metadata: {
      conversationId: "conversation-1",
      sandboxId: "sandbox-1",
      handoffHash: HASH,
      modalHandoffJournal: { operationToken: OPERATION_TOKEN, handoffSha256: HASH },
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

function completionCommand(options: { authVolumePersisted?: boolean } = {}): DexVerifiedCommand {
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
          ...(options.authVolumePersisted ? {
            authVolumePersisted: {
              version: 1,
              method: "modal-volume-v2-sync",
              mountPath: "/codex-home",
              taskId: "cloud-task",
              handoffSha256: HASH,
              authSha256: "e".repeat(64),
              persistedAt: "2026-08-23T12:04:59.000Z",
            },
          } : {}),
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
  it("releases the auth lease on signed v2 sync evidence while retaining result artifacts", async () => {
    const { directory, store, events, task } = await fixture();
    const leasePath = path.join(directory, "lease");
    await acquireCodexAuthLease(leasePath, task.id, {
      workerId: "worker-modal",
      operationToken: OPERATION_TOKEN,
    });
    const terminateRetainedSandbox = vi.fn(async () => true);
    const runtime = new DexDaemonRuntime({
      bridge: {
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
        notify: vi.fn(async () => undefined),
      } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter: {
        import: vi.fn(async () => ({
          taskId: task.id,
          sandboxId: "sandbox-1",
          branch: task.dexBranch,
          commit: COMMIT,
          bundleSha256: "c".repeat(64),
          bundleBytes: 123,
          sandboxTerminated: false,
        })),
        terminateRetainedSandbox,
      },
      codexAuthLeasePath: leasePath,
    });

    await runtime.handleCommand(completionCommand({ authVolumePersisted: true }));

    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(terminateRetainedSandbox).not.toHaveBeenCalled();
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      leaseReleaseEvidence: {
        kind: "auth-volume-sync",
        sandboxId: "sandbox-1",
        handoffSha256: HASH,
        authSha256: "e".repeat(64),
      },
      effects: { sandboxTerminated: true, leaseReleased: true },
    });

    await expect(acquireCodexAuthLease(leasePath, "successor-task", {
      workerId: "successor-worker",
      operationToken: "f".repeat(64),
    })).resolves.toBeUndefined();
    await expect(access(leasePath)).resolves.toBeUndefined();
  });

  it("rejects mismatched auth persistence evidence and retains the serialized lease", async () => {
    const { directory, store, events, task } = await fixture();
    const leasePath = path.join(directory, "lease");
    await acquireCodexAuthLease(leasePath, task.id, {
      workerId: "worker-modal",
      operationToken: OPERATION_TOKEN,
    });
    const receipt = vi.fn(async () => undefined);
    const importer = vi.fn(async () => { throw new Error("forged evidence must not import"); });
    const runtime = new DexDaemonRuntime({
      bridge: { receipt, syncOnce: vi.fn(async () => []), notify: vi.fn(async () => undefined) } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter: { import: importer },
      codexAuthLeasePath: leasePath,
    });
    const command = completionCommand({ authVolumePersisted: true });
    const result = command.command.payload.result as Record<string, unknown>;
    result.authVolumePersisted = {
      ...(result.authVolumePersisted as Record<string, unknown>),
      taskId: "forged-task",
    };

    await runtime.handleCommand(command);

    await expect(access(leasePath)).resolves.toBeUndefined();
    expect(importer).not.toHaveBeenCalled();
    expect(receipt).toHaveBeenCalledWith(
      command.id,
      "rejected",
      expect.stringContaining("Auth persistence evidence"),
    );
  });

  it("imports the retained bundle before completing the task and drains queued work", async () => {
    const { directory, store, events, task } = await fixture();
    const leasePath = path.join(directory, "lease");
    await acquireCodexAuthLease(leasePath, task.id, {
      workerId: "worker-modal",
      operationToken: OPERATION_TOKEN,
    });
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
      codexAuthLeasePath: leasePath,
    });

    await runtime.handleCommand(completionCommand());

    expect(resultImporter.import).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: task.id, dexBranch: task.dexBranch }),
      completion: expect.objectContaining({ taskId: task.id, status: "succeeded" }),
      beforeApply: expect.any(Function),
    }));
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
    expect((await store.read()).tasks[task.id]?.blockedReason).toBeUndefined();
    expect(drainQueue).toHaveBeenCalledOnce();
    expect(maybeSleepWhenReady).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledWith("command-cloud-complete", "processed");
    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never evaluates power until Dex Cloud accepts the durable completion receipt", async () => {
    const { directory, store, events, task } = await fixture();
    let acceptReceipts = false;
    let abortAfterSync = false;
    const runAbort = new AbortController();
    const receipt = vi.fn(async (
      commandId: string,
      status: "processed" | "rejected" | "failed" | "duplicate",
    ) => {
      await store.updateState((state) => {
        const existing = state.pendingTransportReceipts.find((item) => item.commandId === commandId);
        if (existing) {
          existing.status = status;
          return;
        }
        state.pendingTransportReceipts.push({
          commandId,
          status,
          occurredAt: new Date().toISOString(),
        });
      });
    });
    const syncOnce = vi.fn(async () => {
      if (acceptReceipts) {
        await store.updateState((state) => {
          state.pendingTransportReceipts = [];
        });
      }
      if (abortAfterSync) runAbort.abort();
      return [];
    });
    const maybeSleepWhenReady = vi.fn(async () => false);
    const battery = { start: vi.fn(), stop: vi.fn() };
    const runtime = new DexDaemonRuntime({
      bridge: { receipt, syncOnce, notify: vi.fn(async () => undefined) } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: battery as never,
      power: {
        reconcileStartup: vi.fn(async () => undefined),
        maybeSleepWhenReady,
      } as never,
      resultImporter: { import: vi.fn(async () => ({
        taskId: task.id,
        sandboxId: "sandbox-1",
        branch: task.dexBranch,
        commit: COMMIT,
        bundleSha256: "c".repeat(64),
        bundleBytes: 123,
        sandboxTerminated: true,
      })) },
      codexAuthLeasePath: path.join(directory, "lease"),
      releaseCodexAuthLease: vi.fn(async () => false),
    });

    // A successful sync call with an empty acknowledgement set leaves the
    // receipt pending and therefore cannot authorize sleep.
    await runtime.handleCommand(completionCommand());
    expect(maybeSleepWhenReady).not.toHaveBeenCalled();
    expect((await store.read()).pendingTransportReceipts).toHaveLength(1);
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      phase: "pending",
      effects: { receiptQueued: true, receiptAccepted: false, powerChecked: false },
    });

    // The ordinary daemon power tick must honor the same receipt gate; it may
    // not bypass the journal just because cloud sync returned successfully.
    abortAfterSync = true;
    await runtime.run(runAbort.signal);
    expect(maybeSleepWhenReady).not.toHaveBeenCalled();
    expect(battery.start).toHaveBeenCalledOnce();
    expect(battery.stop).toHaveBeenCalledOnce();

    acceptReceipts = true;
    await runtime.handleCommand(completionCommand());

    expect((await store.read()).pendingTransportReceipts).toEqual([]);
    expect(maybeSleepWhenReady).toHaveBeenCalledOnce();
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      phase: "complete",
      effects: { receiptAccepted: true, powerChecked: true },
    });
  });

  it("retains the account-auth lease until missing terminal evidence is recreated durably", async () => {
    const { directory, store, events, task } = await fixture();
    const leasePath = path.join(directory, "lease");
    await acquireCodexAuthLease(leasePath, task.id, {
      workerId: "worker-modal",
      operationToken: OPERATION_TOKEN,
    });
    let cleanupReady = false;
    const terminateRetainedSandbox = vi.fn(async () => cleanupReady);
    const runtime = new DexDaemonRuntime({
      bridge: {
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
        notify: vi.fn(async () => undefined),
      } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter: {
        import: vi.fn(async () => { throw new Error("must not import a failed result"); }),
        terminateRetainedSandbox,
      },
      codexAuthLeasePath: leasePath,
    });
    const command = completionCommand();
    command.command.payload = {
      taskId: task.id,
      workerId: "worker-modal",
      status: "failed",
      summary: "cloud worker failed before publishing a result",
      sandboxId: "sandbox-1",
      handoffSha256: HASH,
    };

    await runtime.handleCommand(command);

    await expect(access(leasePath)).resolves.toBeUndefined();
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "failed",
      metadata: {
        cloudCompletionEffects: {
          phase: "pending",
          effects: { sandboxTerminated: false, leaseReleased: false },
        },
      },
    });

    cleanupReady = true;
    await runtime.retryPendingCloudCompletionEffects({ includePower: false });

    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(terminateRetainedSandbox).toHaveBeenCalled();
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      effects: { sandboxTerminated: true, leaseReleased: true },
    });
  });

  it("recreates a processed receipt after crashing between terminal commit and receipt persistence", async () => {
    const { directory, store, events, task } = await fixture();
    const importer = { import: vi.fn(async () => ({
      taskId: task.id,
      sandboxId: "sandbox-1",
      branch: task.dexBranch,
      commit: COMMIT,
      bundleSha256: "c".repeat(64),
      bundleBytes: 123,
      sandboxTerminated: true,
    })) };
    const first = new DexDaemonRuntime({
      bridge: {
        receipt: vi.fn(async () => { throw new Error("simulated crash before receipt persistence"); }),
        syncOnce: vi.fn(async () => []),
        notify: vi.fn(async () => undefined),
      } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter: importer,
      codexAuthLeasePath: path.join(directory, "lease"),
      releaseCodexAuthLease: vi.fn(async () => false),
    });

    await expect(first.handleCommand(completionCommand()))
      .rejects.toThrow("simulated crash before receipt persistence");
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      commandId: "command-cloud-complete",
      effects: { receiptQueued: false, receiptAccepted: false, powerChecked: false },
    });

    const abort = new AbortController();
    const receipt = vi.fn(async (commandId: string) => {
      await store.updateState((state) => {
        state.pendingTransportReceipts = [{
          commandId,
          status: "processed",
          occurredAt: new Date().toISOString(),
        }];
      });
    });
    const syncOnce = vi.fn(async () => {
      await store.updateState((state) => {
        state.pendingTransportReceipts = [];
      });
      abort.abort();
      return [];
    });
    const maybeSleepWhenReady = vi.fn(async () => false);
    const battery = { start: vi.fn(), stop: vi.fn() };
    const restarted = new DexDaemonRuntime({
      bridge: { receipt, syncOnce, notify: vi.fn(async () => undefined) } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: battery as never,
      power: {
        reconcileStartup: vi.fn(async () => undefined),
        maybeSleepWhenReady,
      } as never,
      resultImporter: importer,
      codexAuthLeasePath: path.join(directory, "lease"),
      releaseCodexAuthLease: vi.fn(async () => false),
    });

    await restarted.run(abort.signal);

    expect(receipt).toHaveBeenCalledWith("command-cloud-complete", "processed");
    expect(maybeSleepWhenReady).toHaveBeenCalled();
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      phase: "complete",
      effects: { receiptQueued: true, receiptAccepted: true, powerChecked: true },
    });
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
      status: "running",
      stage: "waiting",
      metadata: {
        resultImport: { status: "pending", code: "retrieval_failed", recoverable: true },
        pendingCloudResultImport: {
          version: 1,
          attempts: 1,
          completion: { taskId: task.id, workerId: "worker-modal" },
        },
      },
    });
    expect(JSON.stringify((await store.read()).tasks[task.id]?.metadata)).not.toContain("should-not-leak");
    expect(notify).toHaveBeenCalledWith(
      "conversation-1",
      expect.stringContaining("safely syncing the result"),
    );
  });

  it("durably retries a recoverable import and completes only after local synchronization", async () => {
    const { directory, store, events, task } = await fixture();
    const imported = {
      taskId: task.id,
      sandboxId: "sandbox-1",
      branch: task.dexBranch,
      commit: COMMIT,
      bundleSha256: "c".repeat(64),
      bundleBytes: 123,
      sandboxTerminated: true,
    };
    const resultImporter = {
      import: vi.fn()
        .mockRejectedValueOnce(new Error("temporary Modal outage"))
        .mockResolvedValueOnce(imported),
    };
    const drainQueue = vi.fn(async () => undefined);
    const maybeSleepWhenReady = vi.fn(async () => false);
    const runtime = new DexDaemonRuntime({
      bridge: {
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
        notify: vi.fn(async () => undefined),
      } as never,
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
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "running",
      metadata: { pendingCloudResultImport: { attempts: 1 } },
    });
    expect(drainQueue).not.toHaveBeenCalled();
    expect(maybeSleepWhenReady).not.toHaveBeenCalled();

    await expect(runtime.retryPendingCloudResultImports({ force: true })).resolves.toBe(1);

    expect(resultImporter.import).toHaveBeenCalledTimes(2);
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "completed",
      stage: "done",
      metadata: { resultImport: { status: "completed", commit: COMMIT } },
    });
    expect((await store.read()).tasks[task.id]?.metadata.pendingCloudResultImport).toBeUndefined();
    expect(drainQueue).toHaveBeenCalledOnce();
    expect(maybeSleepWhenReady).not.toHaveBeenCalled();

    // A redelivered terminal command queues and flushes the durable receipt;
    // only then may the replay journal evaluate power.
    await runtime.handleCommand(completionCommand());
    expect(maybeSleepWhenReady).toHaveBeenCalledOnce();
  });

  it("retains ownership until a non-retryable result can be durably cleaned up", async () => {
    const { directory, store, events, task } = await fixture();
    const resultImporter = {
      import: vi.fn(async () => {
        throw new CloudResultImportError(
          "metadata_mismatch",
          "Cloud result metadata does not match.",
          false,
        );
      }),
      terminateRetainedSandbox: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    };
    const runtime = new DexDaemonRuntime({
      bridge: {
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => []),
        notify: vi.fn(async () => undefined),
      } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter,
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(completionCommand());
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "failed",
      metadata: {
        resultImport: { status: "failed", code: "metadata_mismatch" },
        cloudCompletionEffects: {
          phase: "pending",
          effects: { sandboxTerminated: false, leaseReleased: false },
        },
      },
    });

    await runtime.retryPendingCloudResultImports({ force: true });

    expect(resultImporter.import).toHaveBeenCalledOnce();
    await runtime.retryPendingCloudCompletionEffects({ includePower: false });

    expect(resultImporter.terminateRetainedSandbox).toHaveBeenCalledTimes(3);
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "failed",
      stage: "failed",
      metadata: {
        resultImport: { status: "failed", code: "metadata_mismatch", recoverable: false },
      },
    });
    expect((await store.read()).tasks[task.id]?.metadata.pendingCloudResultImport).toBeUndefined();
  });

  it("rechecks ownership inside the importer before any branch is applied", async () => {
    const { directory, store, events, task } = await fixture();
    const receipt = vi.fn(async () => undefined);
    const resultImporter = {
      import: vi.fn(async (input: { beforeApply?: () => Promise<void> }) => {
        await store.updateState((state) => {
          state.workers["worker-replacement"] = WorkerSessionSchema.parse({
            id: "worker-replacement",
            taskId: task.id,
            agent: "codex",
            target: { kind: "modal", sandboxId: "sandbox-2" },
            status: "running",
            startedAt: "2026-08-23T12:06:00.000Z",
          });
          state.tasks[task.id]!.currentWorkerId = "worker-replacement";
          state.tasks[task.id]!.metadata.sandboxId = "sandbox-2";
        });
        await input.beforeApply?.();
        throw new Error("unreachable");
      }),
    };
    const runtime = new DexDaemonRuntime({
      bridge: { receipt, syncOnce: vi.fn(async () => []), notify: vi.fn(async () => undefined) } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter,
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(completionCommand());

    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "running",
      currentWorkerId: "worker-replacement",
    });
    expect(receipt).toHaveBeenCalledWith(
      "command-cloud-complete",
      "rejected",
      expect.stringContaining("Stale cloud completion"),
    );
  });

  it("rejects a stale cloud completion without overwriting a replacement worker", async () => {
    const { directory, store, events, task } = await fixture();
    await store.updateState((state) => {
      state.workers["worker-replacement"] = WorkerSessionSchema.parse({
        id: "worker-replacement",
        taskId: task.id,
        agent: "codex",
        target: { kind: "modal", sandboxId: "sandbox-2" },
        status: "running",
        startedAt: "2026-08-23T12:06:00.000Z",
      });
      state.tasks[task.id]!.currentWorkerId = "worker-replacement";
      state.tasks[task.id]!.metadata.sandboxId = "sandbox-2";
    });
    const receipt = vi.fn(async () => undefined);
    const importer = { import: vi.fn(async () => { throw new Error("must not import"); }) };
    const runtime = new DexDaemonRuntime({
      bridge: { receipt, syncOnce: vi.fn(async () => []), notify: vi.fn(async () => undefined) } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter: importer,
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(completionCommand());

    expect(importer.import).not.toHaveBeenCalled();
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "running",
      currentWorkerId: "worker-replacement",
    });
    expect((await store.read()).tasks[task.id]?.latestSummary).toBeUndefined();
    expect(receipt).toHaveBeenCalledWith(
      "command-cloud-complete",
      "rejected",
      expect.stringContaining("Stale cloud completion"),
    );
  });

  it("rejects a late monitor callback after the user stopped the cloud task", async () => {
    const { directory, store, events, task } = await fixture();
    await store.updateState((state) => {
      state.tasks[task.id]!.status = "cancelled";
      state.tasks[task.id]!.stage = "failed";
      state.tasks[task.id]!.latestSummary = "stopped at your request";
      state.workers["worker-modal"]!.status = "stopped";
      state.workers["worker-modal"]!.endedAt = "2026-08-23T12:04:00.000Z";
    });
    const receipt = vi.fn(async () => undefined);
    const importer = { import: vi.fn(async () => { throw new Error("must not import"); }) };
    const runtime = new DexDaemonRuntime({
      bridge: { receipt, syncOnce: vi.fn(async () => []), notify: vi.fn(async () => undefined) } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: {} as never,
      power: { maybeSleepWhenReady: vi.fn(async () => false) } as never,
      resultImporter: importer,
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.handleCommand(completionCommand());

    expect(importer.import).not.toHaveBeenCalled();
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "cancelled",
      latestSummary: "stopped at your request",
    });
    expect(receipt).toHaveBeenCalledWith(
      "command-cloud-complete",
      "rejected",
      expect.stringContaining("terminal Dex task"),
    );
  });

  it("durably replays every post-commit effect and accepts an identical terminal callback", async () => {
    const { directory, store, task } = await fixture();
    let eventFails = true;
    let leaseFails = true;
    let drainFails = true;
    let powerFails = true;
    const appendedEvents: Array<{ id?: string }> = [];
    const append = vi.fn(async (input: { id?: string }) => {
      appendedEvents.push(input);
      if (eventFails) throw new Error("event device unavailable");
      return input;
    });
    const releaseLease = vi.fn(async () => {
      if (leaseFails) throw new Error("lease filesystem unavailable");
      return false;
    });
    const drainQueue = vi.fn(async () => {
      if (drainFails) throw new Error("queue unavailable");
    });
    const maybeSleepWhenReady = vi.fn(async () => {
      if (powerFails) throw new Error("power service unavailable");
      return false;
    });
    const receipt = vi.fn(async () => undefined);
    const importer = vi.fn(async () => ({
      taskId: task.id,
      sandboxId: "sandbox-1",
      branch: task.dexBranch,
      commit: COMMIT,
      bundleSha256: "c".repeat(64),
      bundleBytes: 123,
      sandboxTerminated: true,
    }));
    const runtime = new DexDaemonRuntime({
      bridge: {
        receipt,
        syncOnce: vi.fn(async () => []),
        notify: vi.fn(async () => undefined),
      } as never,
      router: {} as never,
      orchestrator: { drainQueue } as never,
      store,
      events: { append } as never,
      battery: {} as never,
      power: { maybeSleepWhenReady } as never,
      resultImporter: { import: importer },
      codexAuthLeasePath: path.join(directory, "lease"),
      releaseCodexAuthLease: releaseLease,
    });

    // Terminal state and its effect journal commit even though the first
    // diagnostic event cannot be appended.
    await runtime.handleCommand(completionCommand());
    expect(receipt).toHaveBeenCalledWith("command-cloud-complete", "processed");
    expect((await store.read()).tasks[task.id]).toMatchObject({
      status: "completed",
      metadata: {
        cloudCompletionEffects: {
          phase: "pending",
          effects: {
            eventAppended: false,
            leaseReleased: false,
            queueDrained: false,
            powerChecked: false,
          },
        },
      },
    });

    // Even though the processed receipt has been accepted, the ordinary
    // daemon power tick must not bypass the still-failing diagnostic, lease,
    // or queue effects in this pending journal.
    const replayAbort = new AbortController();
    const replayPower = vi.fn(async () => false);
    const replay = new DexDaemonRuntime({
      bridge: {
        receipt: vi.fn(async () => undefined),
        syncOnce: vi.fn(async () => {
          replayAbort.abort();
          return [];
        }),
        notify: vi.fn(async () => undefined),
      } as never,
      router: {} as never,
      orchestrator: { drainQueue } as never,
      store,
      events: { append } as never,
      battery: { start: vi.fn(), stop: vi.fn() } as never,
      power: {
        reconcileStartup: vi.fn(async () => undefined),
        maybeSleepWhenReady: replayPower,
      } as never,
      resultImporter: { import: importer },
      codexAuthLeasePath: path.join(directory, "lease"),
      releaseCodexAuthLease: releaseLease,
    });
    await replay.run(replayAbort.signal);
    expect(replayPower).not.toHaveBeenCalled();

    eventFails = false;
    await expect(runtime.retryPendingCloudCompletionEffects({ includePower: false }))
      .rejects.toThrow("lease filesystem unavailable");
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      effects: { eventAppended: true, leaseReleased: false },
    });

    leaseFails = false;
    await expect(runtime.retryPendingCloudCompletionEffects({ includePower: false }))
      .rejects.toThrow("queue unavailable");
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      effects: { leaseReleased: true, queueDrained: false },
    });

    drainFails = false;
    await expect(runtime.retryPendingCloudCompletionEffects({ includePower: true }))
      .rejects.toThrow("power service unavailable");
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      effects: { queueDrained: true, powerChecked: false },
    });

    powerFails = false;
    await expect(runtime.retryPendingCloudCompletionEffects({ includePower: true })).resolves.toBe(1);
    expect((await store.read()).tasks[task.id]?.metadata.cloudCompletionEffects).toMatchObject({
      phase: "complete",
      effects: {
        eventAppended: true,
        leaseReleased: true,
        queueDrained: true,
        powerChecked: true,
      },
    });
    expect(new Set(appendedEvents.map((event) => event.id)).size).toBe(1);

    const callsBeforeDuplicate = append.mock.calls.length;
    await runtime.handleCommand(completionCommand());
    expect(importer).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledTimes(callsBeforeDuplicate);
    expect(receipt).toHaveBeenLastCalledWith("command-cloud-complete", "processed");
  });

  it("continues polling unrelated cloud commands when one effect journal is broken", async () => {
    const { directory, store, events, task } = await fixture();
    await store.updateState((state) => {
      state.tasks[task.id]!.metadata.cloudCompletionEffects = { version: 999 };
    });
    const abort = new AbortController();
    const syncOnce = vi.fn(async () => {
      abort.abort();
      return [];
    });
    const battery = { start: vi.fn(), stop: vi.fn() };
    const power = {
      reconcileStartup: vi.fn(async () => undefined),
      maybeSleepWhenReady: vi.fn(async () => false),
    };
    const runtime = new DexDaemonRuntime({
      bridge: { syncOnce, receipt: vi.fn(), notify: vi.fn() } as never,
      router: {} as never,
      orchestrator: { drainQueue: vi.fn(async () => undefined) } as never,
      store,
      events,
      battery: battery as never,
      power: power as never,
      codexAuthLeasePath: path.join(directory, "lease"),
    });

    await runtime.run(abort.signal);

    expect(syncOnce).toHaveBeenCalled();
    expect(power.maybeSleepWhenReady).not.toHaveBeenCalled();
    expect(battery.start).toHaveBeenCalledOnce();
    expect(battery.stop).toHaveBeenCalledOnce();
  });
});
