import { describe, expect, it } from "vitest";
import {
  markInterruptedLocalWorkers,
  runWithDaemonCleanup,
  terminateRestartedLocalWorkerProcesses,
} from "../src/daemon.js";
import { DexTaskSchema, WorkerSessionSchema, emptyState } from "../src/state/schemas.js";

describe("daemon restart reconciliation", () => {
  it("preserves the primary runtime failure when cleanup also fails", async () => {
    const primary = new Error("runtime failed");
    const shutdownFailure = new Error("runtime shutdown failed");
    const lockFailure = new Error("lock release failed");

    const failure = await runWithDaemonCleanup(
      async () => {
        throw primary;
      },
      async () => [shutdownFailure, lockFailure],
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      primary,
      shutdownFailure,
      lockFailure,
    ]);
    expect((failure as Error).cause).toBe(primary);
  });

  it("stops only surviving local work before marking it recoverable and leaves Modal work untouched", async () => {
    const now = "2026-08-23T20:00:00.000Z";
    const state = emptyState();
    for (const [id, target] of [
      ["local-task", { kind: "local" as const, machineId: "mac-1" }],
      ["cloud-task", { kind: "modal" as const, sandboxId: "sb-1" }],
    ] as const) {
      const workerId = `worker-${id}`;
      state.tasks[id] = DexTaskSchema.parse({
        id,
        projectId: "project-1",
        title: id,
        originalRequest: `work on ${id}`,
        repositoryPath: "/repo",
        baseBranch: "main",
        dexBranch: `dex/${id}`,
        worktreePath: `/worktrees/${id}`,
        status: "running",
        stage: "implementing",
        currentWorkerId: workerId,
        createdAt: now,
        updatedAt: now,
      });
      state.workers[workerId] = WorkerSessionSchema.parse({
        id: workerId,
        taskId: id,
        agent: "codex",
        target,
        status: "running",
        providerSessionId: `${id}-session`,
        startedAt: now,
      });
    }

    await expect(terminateRestartedLocalWorkerProcesses(state)).resolves.toEqual([{
      workerId: "worker-local-task",
      taskId: "local-task",
      status: "not_running",
    }]);
    expect(markInterruptedLocalWorkers(state, now)).toEqual(["local-task"]);
    expect(state.tasks["local-task"]).toMatchObject({
      status: "failed",
      metadata: { interruptedByDaemonRestart: true },
    });
    expect(state.workers["worker-local-task"]?.status).toBe("stopped");
    expect(state.tasks["cloud-task"]?.status).toBe("running");
    expect(state.workers["worker-cloud-task"]?.status).toBe("running");
  });

  it("reconciles waiting workers and nonterminal tasks orphaned without a live worker", () => {
    const now = "2026-08-23T20:00:00.000Z";
    const state = emptyState();
    state.tasks["waiting-task"] = DexTaskSchema.parse({
      id: "waiting-task",
      projectId: "project-1",
      title: "waiting task",
      originalRequest: "finish waiting task",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/waiting-task",
      worktreePath: "/worktrees/waiting-task",
      status: "waiting_user",
      stage: "waiting",
      currentWorkerId: "worker-waiting-task",
      createdAt: now,
      updatedAt: now,
    });
    state.workers["worker-waiting-task"] = WorkerSessionSchema.parse({
      id: "worker-waiting-task",
      taskId: "waiting-task",
      agent: "claude",
      target: { kind: "local", machineId: "mac-1" },
      status: "waiting",
      startedAt: now,
    });
    state.tasks["orphan-task"] = DexTaskSchema.parse({
      id: "orphan-task",
      projectId: "project-1",
      title: "orphan task",
      originalRequest: "finish orphan task",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/orphan-task",
      worktreePath: "/worktrees/orphan-task",
      status: "running",
      stage: "implementing",
      createdAt: now,
      updatedAt: now,
    });

    expect(markInterruptedLocalWorkers(state, now).sort()).toEqual(["orphan-task", "waiting-task"]);
    expect(state.tasks["waiting-task"]).toMatchObject({
      status: "failed",
      metadata: { interruptedByDaemonRestart: true },
    });
    expect(state.tasks["orphan-task"]).toMatchObject({
      status: "failed",
      metadata: { interruptedByDaemonRestart: true },
    });
  });

  it("does not infer local ownership during the Modal handoff persistence window", () => {
    const now = "2026-08-23T20:00:00.000Z";
    const state = emptyState();
    state.tasks["handoff-task"] = DexTaskSchema.parse({
      id: "handoff-task",
      projectId: "project-1",
      title: "handoff task",
      originalRequest: "move checkout to cloud",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/handoff-task",
      worktreePath: "/worktrees/handoff-task",
      status: "handoff",
      stage: "handing_off",
      currentWorkerId: "worker-local-source",
      createdAt: now,
      updatedAt: now,
    });
    state.workers["worker-local-source"] = WorkerSessionSchema.parse({
      id: "worker-local-source",
      taskId: "handoff-task",
      agent: "claude",
      target: { kind: "local", machineId: "mac-1" },
      status: "stopped",
      startedAt: now,
      endedAt: now,
    });

    expect(markInterruptedLocalWorkers(state, now)).toEqual([]);
    expect(state.tasks["handoff-task"]).toMatchObject({ status: "handoff", stage: "handing_off" });
  });
});
