import { describe, expect, it, vi } from "vitest";
import type { ModalAdapter, ModalSandbox } from "../src/cloud/modal/index.js";
import {
  MODAL_MONITOR_DEADLINE_MS,
  ModalMonitor,
  modalMonitorDeadlineCleanupKey,
  modalMonitorTerminalKey,
  type ModalMonitorOnce,
} from "../src/cloud/modal-monitor/index.js";

const STARTED_AT = "2026-08-23T18:00:00.000Z";
const HANDOFF_SHA256 = "a".repeat(64);
const REQUEST = {
  taskId: "task-deadline",
  sandboxId: "sandbox-retained-owner",
  handoffSha256: HANDOFF_SHA256,
  startedAt: STARTED_AT,
  resultPath: "/dex/result.json",
  attempt: 17,
} as const;

function deterministicOnce(): ModalMonitorOnce & { keys: string[] } {
  const completed = new Set<string>();
  const keys: string[] = [];
  return {
    keys,
    async runOnce(key, effect) {
      keys.push(key);
      if (completed.has(key)) return false;
      await effect();
      completed.add(key);
      return true;
    },
  };
}

describe("Modal monitor deadline", () => {
  it("terminal-fails exactly once when reconnect remains unavailable after the deadline", async () => {
    const clock = {
      value: Date.parse(STARTED_AT) + MODAL_MONITOR_DEADLINE_MS,
    };
    const schedule = vi.fn(async () => undefined);
    const onTerminal = vi.fn(async () => undefined);
    const once = deterministicOnce();
    const fromId = vi.fn(async () => {
      throw new Error("sandbox is unavailable");
    });
    const monitor = new ModalMonitor({
      modal: { fromId } as unknown as Pick<ModalAdapter, "fromId">,
      schedule,
      onTerminal,
      once,
      now: () => clock.value,
    });

    const first = await monitor.run(REQUEST);
    clock.value += 60_000;
    const duplicate = await monitor.run(REQUEST);

    expect(first).toMatchObject({
      kind: "terminal",
      callbackInvoked: true,
      event: {
        taskId: REQUEST.taskId,
        sandboxId: REQUEST.sandboxId,
        completionKey: modalMonitorTerminalKey(REQUEST.taskId, HANDOFF_SHA256),
        status: "failed",
        reason: "deadline_exceeded",
        exitCode: null,
        error: expect.stringContaining("Sandbox ownership remains recorded"),
      },
    });
    expect(duplicate).toMatchObject({ kind: "terminal", callbackInvoked: false });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: REQUEST.sandboxId,
      status: "failed",
      reason: "deadline_exceeded",
    }));
    expect(schedule).not.toHaveBeenCalled();
    expect(once.keys).not.toContain(
      modalMonitorDeadlineCleanupKey(REQUEST.taskId, HANDOFF_SHA256),
    );
  });

  it("fences one cleanup attempt and terminal-fails once when terminate continuously fails", async () => {
    const clock = {
      value: Date.parse(STARTED_AT) + MODAL_MONITOR_DEADLINE_MS + 1,
    };
    const terminate = vi.fn(async () => {
      throw new Error("snapshot finalization unavailable");
    });
    const detach = vi.fn(async () => undefined);
    const sandbox = {
      poll: vi.fn(async () => null),
      terminate,
      detach,
    } as unknown as ModalSandbox;
    const schedule = vi.fn(async () => undefined);
    const onTerminal = vi.fn(async () => undefined);
    const once = deterministicOnce();
    const monitor = new ModalMonitor({
      modal: {
        fromId: vi.fn(async () => sandbox),
      } as unknown as Pick<ModalAdapter, "fromId">,
      schedule,
      onTerminal,
      once,
      now: () => clock.value,
    });

    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      outcomes.push(await monitor.run({ ...REQUEST, attempt: REQUEST.attempt + attempt }));
      clock.value += 60_000;
    }

    expect(outcomes).toEqual([
      expect.objectContaining({
        kind: "terminal",
        callbackInvoked: true,
        event: expect.objectContaining({
          sandboxId: REQUEST.sandboxId,
          status: "failed",
          reason: "deadline_exceeded",
          error: expect.stringContaining("cleanup could not be confirmed"),
        }),
      }),
      expect.objectContaining({ kind: "terminal", callbackInvoked: false }),
      expect.objectContaining({ kind: "terminal", callbackInvoked: false }),
    ]);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith({ wait: true });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(once.keys.filter((key) => key === modalMonitorDeadlineCleanupKey(
      REQUEST.taskId,
      HANDOFF_SHA256,
    ))).toHaveLength(3);
  });
});
