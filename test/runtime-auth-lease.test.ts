import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexVerifiedCommand } from "../src/cloud/messaging/index.js";
import { DexDaemonRuntime } from "../src/local/daemon/runtime.js";
import { acquireCodexAuthLease } from "../src/setup/modal-auth.js";
import { DexTaskSchema, WorkerSessionSchema, emptyState } from "../src/state/schemas.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("cloud Codex auth lease lifecycle", () => {
  it("preserves the owner lease until terminal evidence and its replay journal are both durable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-runtime-auth-lease-"));
    temporaryDirectories.push(directory);
    const leasePath = path.join(directory, "codex-auth.lease");
    const operationToken = "a".repeat(64);
    const handoffSha256 = "b".repeat(64);
    await acquireCodexAuthLease(leasePath, "task-terminal", {
      workerId: "worker-terminal",
      operationToken,
    });
    const state = emptyState();
    state.tasks["task-terminal"] = DexTaskSchema.parse({
      id: "task-terminal",
      projectId: "project-1",
      title: "terminal task",
      originalRequest: "finish terminal task",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/task-terminal",
      worktreePath: "/worktree",
      status: "running",
      stage: "implementing",
      currentWorkerId: "worker-terminal",
      createdAt: "2026-08-23T12:00:00.000Z",
      updatedAt: "2026-08-23T12:00:00.000Z",
      metadata: {
        handoffHash: handoffSha256,
        modalHandoffJournal: { operationToken, handoffSha256 },
      },
    });
    state.workers["worker-terminal"] = WorkerSessionSchema.parse({
      id: "worker-terminal",
      taskId: "task-terminal",
      agent: "codex",
      target: { kind: "modal", sandboxId: "sandbox-terminal" },
      status: "running",
      startedAt: "2026-08-23T12:00:00.000Z",
    });

    const receipt = vi.fn(async () => undefined);
    const runtime = new DexDaemonRuntime({
      bridge: {
        receipt,
        syncOnce: vi.fn(async () => []),
        notify: vi.fn(async () => undefined),
      } as never,
      router: {} as never,
      orchestrator: {} as never,
      store: {
        read: vi.fn(async () => state),
        updateState: vi.fn(async () => {
          throw new Error("simulated state write failure");
        }),
      } as never,
      events: {} as never,
      battery: {} as never,
      power: {} as never,
      codexAuthLeasePath: leasePath,
    });
    const command: DexVerifiedCommand = {
      id: "command-terminal",
      issuedAt: "2026-08-23T12:00:00.000Z",
      command: {
        type: "task.cloud.completed",
        payload: {
          taskId: "task-terminal",
          workerId: "worker-terminal",
          status: "failed",
          summary: "Cloud worker reached a terminal result.",
          sandboxId: "sandbox-terminal",
          handoffSha256,
        },
      },
      authority: {
        kind: "verified_owner",
        ownerId: "owner-1",
        verified: true,
      },
      verified: true,
      signingKeyId: "server-key-1",
    };

    await runtime.handleCommand(command);

    await expect(access(leasePath)).resolves.toBeUndefined();
    expect(receipt).toHaveBeenCalledWith(
      command.id,
      "rejected",
      "simulated state write failure",
    );

    const terminalEvidenceCommand: DexVerifiedCommand = {
      ...command,
      id: "command-terminal-evidence",
      command: {
        ...command.command,
        payload: {
          ...command.command.payload,
          sandboxTerminal: { kind: "terminate_wait", volumePersisted: true },
        },
      },
    };
    await runtime.handleCommand(terminalEvidenceCommand);

    // Terminal sandbox evidence is necessary but not sufficient: if Dex
    // cannot commit the terminal state plus replay journal, it retains the
    // account-auth lease so a new owner cannot race the unresolved callback.
    await expect(access(leasePath)).resolves.toBeUndefined();
    expect(receipt).toHaveBeenCalledWith(
      terminalEvidenceCommand.id,
      "rejected",
      "simulated state write failure",
    );
  });
});
