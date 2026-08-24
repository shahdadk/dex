import { describe, expect, it, vi } from "vitest";
import {
  ModalAdapter,
  ModalResultArtifactSchema,
  ModalStartupAcknowledgementSchema,
  type ModalClientLike,
  type ModalSdkSandboxLike,
} from "../src/cloud/modal/index.js";
import {
  MODAL_MONITOR_DEADLINE_MS,
  ModalMonitor,
  type ModalTerminalEvent,
} from "../src/cloud/modal-monitor/index.js";

const HASH = "a".repeat(64);
const STARTED_AT = "2026-08-23T12:00:00.000Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);

function processResult(exitCode = 0) {
  return {
    stdout: { readText: async () => "stdout" },
    stderr: { readText: async () => "" },
    wait: async () => exitCode,
  };
}

function sandbox(
  exitCode: number | null,
  calls: string[] = [],
): ModalSdkSandboxLike {
  return {
    sandboxId: "sb-1",
    filesystem: {
      copyFromLocal: async (local, remote) => {
        calls.push(`upload:${local}:${remote}`);
      },
      copyToLocal: async (remote, local) => {
        calls.push(`download:${remote}:${local}`);
      },
    },
    exec: async (command) => {
      calls.push(`exec:${command.join(" ")}`);
      return processResult();
    },
    detach: () => {
      calls.push("detach");
    },
    terminate: async () => {
      calls.push("terminate");
    },
    poll: async () => exitCode,
  };
}

function result(status: "succeeded" | "failed" | "cancelled" = "succeeded") {
  return {
    taskId: "task-1",
    handoffSha256: HASH,
    status,
    summary: "Implemented the Modal handoff.",
    validation: { commands: ["npm test"], passed: status === "succeeded" },
    git: { branch: "dex/task-1", commit: "abc123" },
    authVolumePersisted: {
      version: 1 as const,
      method: "modal-volume-v2-sync" as const,
      mountPath: "/codex-home" as const,
      taskId: "task-1",
      handoffSha256: HASH,
      authSha256: "b".repeat(64),
      persistedAt: "2026-08-23T12:00:10.000Z",
    },
  };
}

describe("ModalAdapter", () => {
  it("lazily loads the real SDK shape and delegates the sandbox lifecycle", async () => {
    const calls: string[] = [];
    const rawSandbox = sandbox(null, calls);
    const client: ModalClientLike = {
      apps: {
        fromName: async (name, options) => {
          calls.push(`app:${name}:${String(options?.createIfMissing)}`);
          return { appId: "ap-1" };
        },
      },
      images: {
        fromRegistry: (tag) => {
          calls.push(`image:${tag}`);
          return {
            dockerfileCommands: (commands) => {
              calls.push(`image-commands:${commands.join("|")}`);
              return {};
            },
          };
        },
      },
      sandboxes: {
        create: async (_app, _image, params) => {
          calls.push(`create:${String(params?.timeoutMs)}`);
          return rawSandbox;
        },
        fromId: async (id) => {
          calls.push(`from-id:${id}`);
          return rawSandbox;
        },
      },
    };
    const sdkLoader = vi.fn(async () => ({
      ModalClient: class {
        constructor() {
          return client;
        }
      },
    }));
    const modal = new ModalAdapter({ sdk: sdkLoader });

    expect(sdkLoader).not.toHaveBeenCalled();
    const created = await modal.create({
      appName: "dex-test",
      image: "node:22",
      imageCommands: ["RUN npm install -g @openai/codex"],
      params: { timeoutMs: 1_500_000 },
    });
    expect(created.sandboxId).toBe("sb-1");
    await created.copyFromLocal("handoff.json", "/dex/handoff.json");
    await created.exec(["codex", "exec"]);
    await created.detach();

    const attached = await modal.fromId("sb-1");
    await attached.copyToLocal("/dex/result.json", "result.json");
    await attached.terminate();

    expect(sdkLoader).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "app:dex-test:true",
      "image:node:22",
      "image-commands:RUN npm install -g @openai/codex",
      "create:1500000",
      "upload:handoff.json:/dex/handoff.json",
      "exec:codex exec",
      "detach",
      "from-id:sb-1",
      "download:/dex/result.json:result.json",
      "terminate",
    ]);
  });

  it("attaches ephemeral worker credentials through Modal secrets without serializing them", async () => {
    const rawSandbox = sandbox(null);
    const observed: Array<{ keys: string[]; secretCount?: number }> = [];
    const client: ModalClientLike = {
      apps: { fromName: async () => ({ appId: "ap-1" }) },
      images: { fromRegistry: () => ({}) },
      sandboxes: {
        create: async (_app, _image, params) => {
          observed.push({
            keys: [],
            secretCount: Array.isArray(params?.secrets) ? params.secrets.length : 0,
          });
          return rawSandbox;
        },
        fromId: async () => rawSandbox,
      },
      secrets: {
        fromName: async () => ({}),
        fromObject: async (entries) => {
          observed.push({ keys: Object.keys(entries).sort() });
          return {};
        },
      },
    };
    const modal = new ModalAdapter({ client });

    await modal.create({
      secretValues: {
        MODEL_CREDENTIAL: "test-model-credential",
        DEX_HANDOFF_SIGNING_KEY: "test-handoff-key",
      },
    });

    expect(observed).toEqual([
      { keys: ["DEX_HANDOFF_SIGNING_KEY", "MODEL_CREDENTIAL"] },
      { keys: [], secretCount: 1 },
    ]);
    expect(JSON.stringify(observed)).not.toContain("test-model-credential");
    expect(JSON.stringify(observed)).not.toContain("test-handoff-key");
  });

  it("mounts a named persistent Volume without creating it implicitly", async () => {
    const rawSandbox = sandbox(null);
    const observed: Array<Record<string, unknown>> = [];
    const volume = { volumeId: "vo-auth" };
    const client: ModalClientLike = {
      apps: { fromName: async () => ({ appId: "ap-1" }) },
      images: { fromRegistry: () => ({}) },
      sandboxes: {
        create: async (_app, _image, params) => {
          observed.push({ mounted: params?.volumes });
          return rawSandbox;
        },
        fromId: async () => rawSandbox,
      },
      volumes: {
        fromName: async (name, params) => {
          observed.push({ name, createIfMissing: params?.createIfMissing });
          return volume;
        },
      },
    };
    const modal = new ModalAdapter({ client });

    await modal.create({ volumeNames: { "/codex-home": "dex-codex-auth" } });

    expect(observed).toEqual([
      { name: "dex-codex-auth", createIfMissing: false },
      { mounted: { "/codex-home": volume } },
    ]);
  });
});

describe("Modal artifact schemas", () => {
  it("validates startup evidence and terminal results", () => {
    expect(
      ModalStartupAcknowledgementSchema.parse({
        taskId: "task-1",
        handoffSha256: HASH,
        providerThreadId: "thread-1",
        loadedMemoryIds: ["memory-1"],
        loadedFailedApproachIds: ["attempt-1"],
      }),
    ).toMatchObject({ taskId: "task-1" });
    expect(ModalResultArtifactSchema.parse(result()).status).toBe("succeeded");
    expect(() =>
      ModalResultArtifactSchema.parse({ ...result(), status: "running" }),
    ).toThrow();
  });
});

describe("ModalMonitor", () => {
  it("uses a 5 second first retry and 10 second subsequent retries", async () => {
    const schedules: Array<{ delayMs: number; attempt: number }> = [];
    const raw = sandbox(null);
    const monitor = new ModalMonitor({
      modal: {
        fromId: async () => new (await import("../src/cloud/modal/index.js")).ModalSandbox(raw),
      },
      now: () => STARTED_AT_MS,
      schedule: async ({ delayMs, request }) => {
        schedules.push({ delayMs, attempt: request.attempt });
      },
      onTerminal: async () => undefined,
    });

    const first = await monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    });
    const duplicateFirst = await monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    });
    const second = await monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
      attempt: 1,
    });

    expect(first).toMatchObject({ kind: "rescheduled", delayMs: 5_000 });
    expect(duplicateFirst).toMatchObject({
      kind: "rescheduled",
      delayMs: 5_000,
      scheduled: false,
    });
    expect(second).toMatchObject({ kind: "rescheduled", delayMs: 10_000 });
    expect(schedules).toEqual([
      { delayMs: 5_000, attempt: 1 },
      { delayMs: 10_000, attempt: 2 },
    ]);
  });

  it("delivers a validated terminal result exactly once", async () => {
    const callbacks: ModalTerminalEvent[] = [];
    const raw = sandbox(0);
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    const monitor = new ModalMonitor({
      modal: { fromId: async () => new ModalSandbox(raw) },
      now: () => STARTED_AT_MS + 20_000,
      schedule: async () => undefined,
      onTerminal: async (event) => {
        callbacks.push(event);
      },
      readResult: async () => result(),
    });
    const request = {
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    } as const;

    const first = await monitor.run(request);
    const duplicate = await monitor.run(request);

    expect(first).toMatchObject({
      kind: "terminal",
      callbackInvoked: true,
      event: {
        status: "succeeded",
        reason: "result",
        sandboxTerminal: { kind: "poll", volumePersisted: true },
      },
    });
    expect(duplicate).toMatchObject({
      kind: "terminal",
      callbackInvoked: false,
    });
    expect(callbacks).toHaveLength(1);
  });

  it("collects a completed result while the sandbox hold process is still running", async () => {
    const calls: string[] = [];
    const callbacks: ModalTerminalEvent[] = [];
    const raw = sandbox(null, calls);
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    const monitor = new ModalMonitor({
      modal: { fromId: async () => new ModalSandbox(raw) },
      now: () => STARTED_AT_MS + 20_000,
      schedule: async () => {
        throw new Error("completed results must not be rescheduled");
      },
      onTerminal: async (event) => {
        callbacks.push(event);
      },
      readResult: async () => result(),
    });

    await expect(monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    })).resolves.toMatchObject({
      kind: "terminal",
      callbackInvoked: true,
      event: {
        status: "succeeded",
        reason: "result",
        exitCode: 0,
        sandboxRetentionExpiresAt: new Date(STARTED_AT_MS + 20_000 + 5 * 60_000).toISOString(),
      },
    });

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.sandboxTerminal).toBeUndefined();
    expect(calls).toContain("detach");
    expect(calls).not.toContain("terminate");
  });

  it.each([
    ["missing", undefined],
    ["forged", {
      version: 1,
      method: "modal-volume-v2-sync",
      mountPath: "/codex-home",
      taskId: "another-task",
      handoffSha256: HASH,
      authSha256: "b".repeat(64),
      persistedAt: "2026-08-23T12:00:10.000Z",
    }],
  ] as const)("does not retain a successful sandbox with %s auth persistence evidence", async (_kind, evidence) => {
    const calls: string[] = [];
    const callbacks: ModalTerminalEvent[] = [];
    const raw = sandbox(null, calls);
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    const artifact = result();
    const candidate = { ...artifact, authVolumePersisted: evidence };
    if (evidence === undefined) delete (candidate as { authVolumePersisted?: unknown }).authVolumePersisted;
    const monitor = new ModalMonitor({
      modal: { fromId: async () => new ModalSandbox(raw) },
      now: () => STARTED_AT_MS + 20_000,
      schedule: async () => undefined,
      onTerminal: async (event) => { callbacks.push(event); },
      readResult: async () => candidate,
    });

    await expect(monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    })).resolves.toMatchObject({
      kind: "terminal",
      event: { status: "failed", reason: "invalid_result" },
    });
    expect(callbacks).toHaveLength(1);
    expect(calls).toContain("terminate");
    expect(calls).not.toContain("detach");
  });

  it("keeps a readable result alive when durable terminal delivery fails", async () => {
    const calls: string[] = [];
    const raw = sandbox(null, calls);
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    let attempts = 0;
    const monitor = new ModalMonitor({
      modal: { fromId: async () => new ModalSandbox(raw) },
      now: () => STARTED_AT_MS + 20_000,
      schedule: async () => undefined,
      onTerminal: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("durable store unavailable");
      },
      readResult: async () => result(),
    });
    const request = {
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    } as const;

    await expect(monitor.run(request)).rejects.toThrow("durable store unavailable");
    expect(calls).not.toContain("terminate");

    await expect(monitor.run(request)).resolves.toMatchObject({
      kind: "terminal",
      event: { status: "succeeded", reason: "result" },
    });
    expect(attempts).toBe(2);
    expect(calls).toContain("detach");
    expect(calls).not.toContain("terminate");
  });

  it("retries cleanup instead of delivering a terminal event without persistence evidence", async () => {
    const calls: string[] = [];
    const callbacks: ModalTerminalEvent[] = [];
    const schedules: Array<{ attempt: number; delayMs: number }> = [];
    const raw = sandbox(null, calls);
    let terminationAttempts = 0;
    raw.terminate = async () => {
      calls.push("terminate");
      terminationAttempts += 1;
      if (terminationAttempts === 1) throw new Error("snapshot still committing");
    };
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    const monitor = new ModalMonitor({
      modal: { fromId: async () => new ModalSandbox(raw) },
      now: () => STARTED_AT_MS + 20_000,
      schedule: async ({ request, delayMs }) => {
        schedules.push({ attempt: request.attempt, delayMs });
      },
      onTerminal: async (event) => {
        callbacks.push(event);
      },
      readResult: async () => result("failed"),
    });

    await expect(monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    })).resolves.toMatchObject({
      kind: "rescheduled",
      delayMs: 10_000,
      nextAttempt: 1,
    });
    expect(callbacks).toHaveLength(0);
    expect(schedules).toEqual([{ attempt: 1, delayMs: 10_000 }]);

    await expect(monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
      attempt: 1,
    })).resolves.toMatchObject({
      kind: "terminal",
      event: {
        status: "failed",
        reason: "result",
        sandboxTerminal: { kind: "terminate_wait", volumePersisted: true },
      },
    });
    expect(callbacks).toHaveLength(1);
    expect(terminationAttempts).toBe(2);
  });

  it("reschedules transient result retrieval failures without destroying valid work", async () => {
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    for (const exitCode of [null, 0] as const) {
      const calls: string[] = [];
      const callbacks: ModalTerminalEvent[] = [];
      const schedules: Array<{ attempt: number; delayMs: number }> = [];
      const monitor = new ModalMonitor({
        modal: { fromId: async () => new ModalSandbox(sandbox(exitCode, calls)) },
        now: () => STARTED_AT_MS + 20_000,
        schedule: async ({ request, delayMs }) => {
          schedules.push({ attempt: request.attempt, delayMs });
        },
        onTerminal: async (event) => {
          callbacks.push(event);
        },
        readResult: async () => {
          throw new Error("temporary Modal filesystem transport failure");
        },
      });

      await expect(monitor.run({
        taskId: "task-1",
        sandboxId: "sb-1",
        handoffSha256: HASH,
        startedAt: STARTED_AT,
      })).resolves.toMatchObject({
        kind: "rescheduled",
        delayMs: 10_000,
        nextAttempt: 1,
      });
      expect(schedules).toEqual([{ attempt: 1, delayMs: 10_000 }]);
      expect(callbacks).toHaveLength(0);
      expect(calls).toContain("detach");
      expect(calls).not.toContain("terminate");
    }
  });

  it("retries an exited sandbox while its result artifact is not yet visible", async () => {
    const calls: string[] = [];
    const callbacks: ModalTerminalEvent[] = [];
    const schedules: Array<{ attempt: number; delayMs: number }> = [];
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    const monitor = new ModalMonitor({
      modal: { fromId: async () => new ModalSandbox(sandbox(0, calls)) },
      now: () => STARTED_AT_MS + 20_000,
      schedule: async ({ request, delayMs }) => {
        schedules.push({ attempt: request.attempt, delayMs });
      },
      onTerminal: async (event) => {
        callbacks.push(event);
      },
      readResult: async () => {
        const error = new Error("result.json does not exist yet") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });

    await expect(monitor.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    })).resolves.toMatchObject({
      kind: "rescheduled",
      delayMs: 10_000,
      nextAttempt: 1,
    });
    expect(schedules).toEqual([{ attempt: 1, delayMs: 10_000 }]);
    expect(callbacks).toHaveLength(0);
    expect(calls).toContain("detach");
    expect(calls).not.toContain("terminate");
  });

  it("fails closed on invalid results and enforces the 25 minute deadline", async () => {
    const events: ModalTerminalEvent[] = [];
    const { ModalSandbox } = await import("../src/cloud/modal/index.js");
    const completed = new ModalMonitor({
      modal: { fromId: async () => new ModalSandbox(sandbox(0)) },
      now: () => STARTED_AT_MS + 1_000,
      schedule: async () => undefined,
      onTerminal: async (event) => {
        events.push(event);
      },
      readResult: async () => ({ ...result(), handoffSha256: "b".repeat(64) }),
    });
    await completed.run({
      taskId: "task-1",
      sandboxId: "sb-1",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    });

    const timeoutCalls: string[] = [];
    const timedOut = new ModalMonitor({
      modal: {
        fromId: async () => new ModalSandbox(sandbox(null, timeoutCalls)),
      },
      now: () => STARTED_AT_MS + MODAL_MONITOR_DEADLINE_MS,
      schedule: async () => {
        throw new Error("must not reschedule");
      },
      onTerminal: async (event) => {
        events.push(event);
      },
    });
    await timedOut.run({
      taskId: "task-2",
      sandboxId: "sb-2",
      handoffSha256: HASH,
      startedAt: STARTED_AT,
    });

    expect(events).toMatchObject([
      {
        taskId: "task-1",
        status: "failed",
        reason: "invalid_result",
        sandboxTerminal: { kind: "poll", volumePersisted: true },
      },
      {
        taskId: "task-2",
        status: "failed",
        reason: "deadline_exceeded",
        sandboxTerminal: { kind: "terminate_wait", volumePersisted: true },
      },
    ]);
    expect(timeoutCalls).toContain("terminate");
  });
});
