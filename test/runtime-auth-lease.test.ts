import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexVerifiedCommand } from "../src/cloud/messaging/index.js";
import { DexDaemonRuntime } from "../src/local/daemon/runtime.js";
import { acquireCodexAuthLease } from "../src/setup/modal-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("cloud Codex auth lease lifecycle", () => {
  it("releases the owner lease on a terminal callback even if local bookkeeping fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-runtime-auth-lease-"));
    temporaryDirectories.push(directory);
    const leasePath = path.join(directory, "codex-auth.lease");
    await acquireCodexAuthLease(leasePath, "task-terminal");

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
          status: "failed",
          summary: "Cloud worker reached a terminal result.",
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

    await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(receipt).toHaveBeenCalledWith(
      command.id,
      "rejected",
      "simulated state write failure",
    );
  });
});
