import { describe, expect, it } from "vitest";
import { markInterruptedLocalWorkers } from "../src/daemon.js";
import { DexTaskSchema, WorkerSessionSchema, emptyState } from "../src/state/schemas.js";

describe("daemon restart reconciliation", () => {
  it("marks only interrupted local work recoverable and leaves Modal work untouched", () => {
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

    expect(markInterruptedLocalWorkers(state, now)).toEqual(["local-task"]);
    expect(state.tasks["local-task"]).toMatchObject({
      status: "failed",
      metadata: { interruptedByDaemonRestart: true },
    });
    expect(state.workers["worker-local-task"]?.status).toBe("stopped");
    expect(state.tasks["cloud-task"]?.status).toBe("running");
    expect(state.workers["worker-cloud-task"]?.status).toBe("running");
  });
});
