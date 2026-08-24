import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModalTaskMover,
  type ModalMonitorRegistration,
} from "../src/cloud/modal-task-mover.js";
import { isCodexAuthLeaseBusyError } from "../src/setup/modal-auth.js";
import {
  ModalAdapter,
  type ModalClientLike,
  type ModalSandboxCreateParams,
  type ModalSdkSandboxLike,
} from "../src/cloud/modal/index.js";
import { resolveDexPaths } from "../src/config/paths.js";
import { EventLog } from "../src/state/events.js";
import { DexTaskSchema, type DexTask } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { TaskManager } from "../src/tasks/task-manager.js";
import type { HandoffDocument } from "../src/tasks/handoff.js";
import { execFile } from "../src/utils/exec.js";

const SIGNING_KEY = "modal-task-mover-test-signing-key";
const ACKNOWLEDGED_AT = "2026-08-23T12:30:00.000Z";
const TEST_CODEX_AUTH_VOLUME = "dex-codex-auth-0123456789abcdef0123";
const ORIGINAL_CODEX_AUTH_VOLUME = process.env.DEX_MODAL_CODEX_AUTH_VOLUME;
const temporaryDirectories: string[] = [];

interface MoverFixture {
  directory: string;
  stateFile: string;
  store: DexStateStore;
  events: EventLog;
  tasks: TaskManager;
  task: DexTask;
  handoffsRoot: string;
  workerScriptPath: string;
}

interface ModalHarness {
  modal: ModalAdapter;
  calls: string[];
  getUploadedHandoff(): HandoffDocument | undefined;
  getCreateParams(): ModalSandboxCreateParams | undefined;
}

interface ModalHarnessHooks {
  onCreate?(): void | Promise<void>;
  onCopy?(remotePath: string): void | Promise<void>;
  onStartupRead?(): void | Promise<void>;
  onList?(tags: Record<string, string>): void | Promise<void>;
  listSandboxIds?(tags: Record<string, string>): string[] | Promise<string[]>;
  onFromId?(sandboxId: string): void | Promise<void>;
  poll?(): number | null | Promise<number | null>;
  terminate?(params?: { wait?: boolean }): void | number | Promise<void | number>;
}

beforeEach(() => {
  process.env.DEX_MODAL_CODEX_AUTH_VOLUME = TEST_CODEX_AUTH_VOLUME;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (ORIGINAL_CODEX_AUTH_VOLUME === undefined) {
    delete process.env.DEX_MODAL_CODEX_AUTH_VOLUME;
  } else {
    process.env.DEX_MODAL_CODEX_AUTH_VOLUME = ORIGINAL_CODEX_AUTH_VOLUME;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function mustGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function createMoverFixture(): Promise<MoverFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-modal-mover-"));
  temporaryDirectories.push(directory);
  const repositoryPath = path.join(directory, "repo");
  const dexHome = path.join(directory, "dex-home");
  const stateFile = path.join(dexHome, "state.json");
  const eventsFile = path.join(dexHome, "events.jsonl");
  const handoffsRoot = path.join(dexHome, "handoffs");
  const workerScriptPath = path.join(directory, "cloud-worker.js");
  await mkdir(repositoryPath);
  await mustGit(["init", "-b", "main"], repositoryPath);
  await mustGit(["config", "user.name", "Dex Test"], repositoryPath);
  await mustGit(["config", "user.email", "dex@example.test"], repositoryPath);
  await writeFile(path.join(repositoryPath, "README.md"), "modal mover fixture\n", "utf8");
  await mustGit(["add", "README.md"], repositoryPath);
  await mustGit(["commit", "-m", "initial checkpoint"], repositoryPath);
  await mustGit(["checkout", "-b", "dex/task-modal"], repositoryPath);
  await writeFile(workerScriptPath, "// copied into the fake sandbox\n", "utf8");

  const now = "2026-08-23T12:00:00.000Z";
  const task = DexTaskSchema.parse({
    id: "task-modal",
    projectId: "project-1",
    title: "Continue in Modal",
    originalRequest: "Continue the task in Modal",
    repositoryPath,
    baseBranch: "main",
    dexBranch: "dex/task-modal",
    worktreePath: repositoryPath,
    status: "running",
    stage: "implementing",
    createdAt: now,
    updatedAt: now,
    currentWorkerId: "worker-local",
    workerHistory: ["worker-local"],
    metadata: {
      validationArgv: [],
      taskKnowledge: {
        learnedFacts: ["The task requires durable cloud ownership."],
        decisions: ["Persist the Modal sandbox before detach."],
        failedApproaches: [
          {
            approach: "Detach before scheduling the monitor",
            reason: "The task could become unowned.",
            failed: true,
          },
        ],
        constraints: ["Do not lose the provider thread ID."],
        nextSteps: ["Schedule deterministic monitoring."],
      },
    },
  });
  const store = new DexStateStore(stateFile);
  await store.updateState((state) => {
    state.tasks[task.id] = task;
  });
  const events = new EventLog(eventsFile);
  const tasks = new TaskManager(store, events, resolveDexPaths(dexHome));
  return {
    directory,
    stateFile,
    store,
    events,
    tasks,
    task,
    handoffsRoot,
    workerScriptPath,
  };
}

function createModalHarness(
  startup: (handoff: HandoffDocument) => Record<string, unknown>,
  hooks: ModalHarnessHooks = {},
): ModalHarness {
  const calls: string[] = [];
  let uploadedHandoff: HandoffDocument | undefined;
  let createParams: ModalSandboxCreateParams | undefined;
  const filesystem = {
    copyFromLocal: async (localPath: string, remotePath: string) => {
      calls.push(`copy:${remotePath}`);
      await hooks.onCopy?.(remotePath);
      if (remotePath === "/dex/handoff.json") {
        uploadedHandoff = JSON.parse(await readFile(localPath, "utf8")) as HandoffDocument;
      }
    },
    copyToLocal: async (remotePath: string, localPath: string) => {
      calls.push(`download:${remotePath}:${localPath}`);
    },
    readText: async (remotePath: string) => {
      calls.push(`read:${remotePath}`);
      if (remotePath === "/dex/startup.json") await hooks.onStartupRead?.();
      if (remotePath !== "/dex/startup.json" || !uploadedHandoff) {
        const error = new Error(`Missing fake Modal file ${remotePath}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return JSON.stringify(startup(uploadedHandoff));
    },
    writeText: async (_data: string, remotePath: string) => {
      calls.push(`write:${remotePath}`);
    },
  };
  const rawSandbox: ModalSdkSandboxLike = {
    sandboxId: "sb-durable-123",
    filesystem,
    exec: async () => ({
      stdout: { readText: async () => "" },
      stderr: { readText: async () => "" },
      wait: async () => 0,
    }),
    detach: () => {
      calls.push("detach");
    },
    terminate: async (params) => {
      calls.push(`terminate:${String(params?.wait)}`);
      return hooks.terminate?.(params);
    },
    poll: async () => hooks.poll?.() ?? null,
  };
  const image = {
    dockerfileCommands: (commands: string[]) => {
      calls.push(`image-commands:${commands.length}`);
      return image;
    },
  };
  const client: ModalClientLike = {
    apps: {
      fromName: async (name) => {
        calls.push(`app:${name}`);
        return { appId: "app-dex" };
      },
    },
    images: {
      fromRegistry: (tag) => {
        calls.push(`image:${tag}`);
        return image;
      },
    },
    sandboxes: {
      create: async (_app, _image, params) => {
        calls.push("create");
        createParams = params;
        await hooks.onCreate?.();
        calls.push(`sandbox-name:${String(params?.name)}`);
        return rawSandbox;
      },
      fromId: async (sandboxId) => {
        calls.push(`from-id:${sandboxId}`);
        await hooks.onFromId?.(sandboxId);
        return rawSandbox;
      },
      list: async function* (params: { tags: Record<string, string> }) {
        calls.push(`list:${params.tags.operation}`);
        await hooks.onList?.(params.tags);
        const sandboxIds = await hooks.listSandboxIds?.(params.tags) ?? [rawSandbox.sandboxId];
        for (const sandboxId of sandboxIds) {
          yield sandboxId === rawSandbox.sandboxId
            ? rawSandbox
            : { ...rawSandbox, sandboxId };
        }
      },
    } as ModalClientLike["sandboxes"],
    secrets: {
      fromName: async (name, options) => {
        calls.push(`secret:${name}:${options?.requiredKeys?.join(",") ?? ""}`);
        return {};
      },
    },
    volumes: {
      fromName: async (name, options) => {
        calls.push(`volume:${name}:${String(options?.createIfMissing)}`);
        return {};
      },
    },
    close: () => {
      calls.push("close");
    },
  };
  return {
    modal: new ModalAdapter({ client }),
    calls,
    getUploadedHandoff: () => uploadedHandoff,
    getCreateParams: () => createParams,
  };
}

describe("ModalTaskMover", () => {
  it("rejects a missing per-device auth volume before creating a sandbox", async () => {
    const fixture = await createMoverFixture();
    delete process.env.DEX_MODAL_CODEX_AUTH_VOLUME;
    const harness = createModalHarness(() => ({}));
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });

    await expect(mover.moveToCloud(fixture.task)).rejects.toThrow(
      "A paired device-specific DEX_MODAL_CODEX_AUTH_VOLUME is required",
    );

    expect(harness.calls).not.toContain("create");
    expect((await fixture.store.read()).tasks[fixture.task.id]).toMatchObject({
      status: "running",
      stage: "implementing",
    });
  });

  it("journals before create, uploads before monitoring, and updates the persisted worker on startup", async () => {
    const fixture = await createMoverFixture();
    let stateAtCreate: Awaited<ReturnType<DexStateStore["read"]>> | undefined;
    let stateAtUpload: Awaited<ReturnType<DexStateStore["read"]>> | undefined;
    let stateAtStartupRead: Awaited<ReturnType<DexStateStore["read"]>> | undefined;
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-durable-456",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }), {
      onCreate: async () => {
        stateAtCreate = await new DexStateStore(fixture.stateFile).read();
      },
      onCopy: async () => {
        stateAtUpload ??= await new DexStateStore(fixture.stateFile).read();
      },
      onStartupRead: async () => {
        stateAtStartupRead ??= await new DexStateStore(fixture.stateFile).read();
      },
    });
    let registration: ModalMonitorRegistration | undefined;
    let stateAtSchedule: Awaited<ReturnType<DexStateStore["read"]>> | undefined;
    const scheduleMonitor = vi.fn(async (value: ModalMonitorRegistration) => {
      harness.calls.push("monitor");
      registration = value;
      stateAtSchedule = await new DexStateStore(fixture.stateFile).read();
    });
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor,
      startupTimeoutMs: 50,
    });

    await mover.moveToCloud(fixture.task);

    const uploaded = harness.getUploadedHandoff();
    expect(uploaded).toBeDefined();
    expect(uploaded?.memories.length).toBeGreaterThanOrEqual(5);
    expect(uploaded?.failedApproaches).toContainEqual(expect.objectContaining({
      approach: "Detach before scheduling the monitor",
      reason: "The task could become unowned.",
      doNotRepeat: true,
    }));
    const journalAtCreate = stateAtCreate?.tasks[fixture.task.id]?.metadata.modalHandoffJournal as Record<string, unknown> | undefined;
    expect(journalAtCreate).toMatchObject({
      version: 1,
      phase: "prepared",
      workerId: expect.any(String),
      handoffSha256: uploaded?.contentHash,
      startedAt: expect.any(String),
    });
    expect(stateAtCreate?.workers[String(journalAtCreate?.workerId)]).toBeUndefined();
    const workerId = registration?.workerId;
    expect(workerId).toEqual(expect.any(String));
    expect(workerId).toBe(journalAtCreate?.workerId);
    expect(registration).toMatchObject({
      taskId: fixture.task.id,
      sandboxId: "sb-durable-123",
      handoffSha256: uploaded?.contentHash,
      startedAt: journalAtCreate?.startedAt,
      resultPath: "/dex/result.json",
    });
    expect(stateAtSchedule?.workers[workerId!]).toMatchObject({
      taskId: fixture.task.id,
      target: { kind: "modal", sandboxId: "sb-durable-123" },
      status: "running",
      providerSessionId: "thread-durable-456",
      startedAt: registration?.startedAt,
    });
    expect(stateAtSchedule?.tasks[fixture.task.id]).toMatchObject({
      currentWorkerId: workerId,
      metadata: {
        sandboxId: "sb-durable-123",
        handoffHash: uploaded?.contentHash,
        modalHandoffJournal: {
          phase: "startup_acknowledged",
          workerId,
          monitorRegistration: registration,
          startupAcknowledgedAt: ACKNOWLEDGED_AT,
        },
      },
    });
    expect(stateAtUpload?.workers[workerId!]).toMatchObject({ status: "starting" });
    expect(stateAtUpload?.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "sandbox_created",
      monitorRegistration: registration,
    });
    expect(stateAtStartupRead?.workers[workerId!]).toMatchObject({ status: "starting" });

    const reloaded = await new DexStateStore(fixture.stateFile).read();
    expect(reloaded.tasks[fixture.task.id]).toMatchObject({
      status: "running",
      currentWorkerId: workerId,
      workerHistory: ["worker-local", workerId],
      metadata: {
        sandboxId: "sb-durable-123",
        handoffHash: uploaded?.contentHash,
        memoryCount: uploaded?.memories.length,
        failedApproachCount: uploaded?.failedApproaches.length,
        modalHandoffJournal: {
          phase: "completed",
          workerId,
          monitorRegistration: registration,
          startupAcknowledgedAt: ACKNOWLEDGED_AT,
          finalizedAt: expect.any(String),
        },
      },
    });
    expect(reloaded.workers[workerId!]).toMatchObject({
      id: workerId,
      status: "running",
      providerSessionId: "thread-durable-456",
      target: { kind: "modal", sandboxId: "sb-durable-123" },
    });
    expect(Object.values(reloaded.workers).filter((worker) => worker.target.kind === "modal")).toHaveLength(1);
    expect(harness.calls.indexOf("copy:/dex/repo.bundle")).toBeLessThan(harness.calls.indexOf("monitor"));
    expect(harness.calls.indexOf("copy:/dex/handoff.json")).toBeLessThan(harness.calls.indexOf("monitor"));
    expect(harness.calls.indexOf("copy:/dex/cloud-worker.js")).toBeLessThan(harness.calls.indexOf("monitor"));
    expect(harness.calls.indexOf("copy:/dex/ready")).toBeLessThan(harness.calls.indexOf("read:/dex/startup.json"));
    expect(harness.calls.indexOf("read:/dex/startup.json")).toBeLessThan(harness.calls.indexOf("monitor"));
    expect(harness.calls.indexOf("monitor")).toBeLessThan(harness.calls.indexOf("detach"));
    expect(harness.calls).toContain(`volume:${TEST_CODEX_AUTH_VOLUME}:false`);
    expect(harness.calls).toContain("secret:dex-workers:DEX_HANDOFF_SIGNING_KEY");
    expect(harness.getCreateParams()).toMatchObject({
      timeoutMs: 24 * 60 * 60_000,
      command: expect.arrayContaining([
        expect.stringContaining("while :; do sleep 3600; done"),
      ]),
    });
    expect(harness.calls).toContainEqual(expect.stringMatching(/^sandbox-name:dex-codex-account-worker-[a-f0-9]{16}$/));
    expect(harness.calls).toContain("close");
    expect(harness.calls.some((call) => call.startsWith("terminate:"))).toBe(false);
    expect(JSON.parse(await readFile(
      path.join(fixture.handoffsRoot, ".codex-account-auth.lease"),
      "utf8",
    ))).toMatchObject({
      version: 1,
      taskId: fixture.task.id,
      workerId,
      operationToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("terminates and finalizes the persisted worker and journal when startup fails", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-incomplete",
      loadedMemoryIds: handoff.memories.slice(0, 4).map(({ id }) => String(id)),
      loadedFailedApproachIds: [],
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    const scheduleMonitor = vi.fn(async () => {
      harness.calls.push("monitor");
    });
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor,
      startupTimeoutMs: 1,
    });

    await expect(mover.moveToCloud(fixture.task)).rejects.toThrow(
      "Timed out waiting for Codex/Modal startup acknowledgement",
    );

    const failed = await fixture.store.read();
    expect(failed.tasks[fixture.task.id]).toMatchObject({
      status: "failed",
      stage: "failed",
      currentWorkerId: expect.any(String),
      metadata: {
        cloudMonitorAcknowledged: false,
        sandboxId: "sb-durable-123",
        handoffHash: expect.any(String),
        modalHandoffJournal: {
          phase: "failed",
          workerId: expect.any(String),
          monitorRegistration: {
            taskId: fixture.task.id,
            sandboxId: "sb-durable-123",
          },
          finalizedAt: expect.any(String),
          failure: "Timed out waiting for Codex/Modal startup acknowledgement",
          cleanupPending: false,
        },
      },
    });
    const failedWorkerId = failed.tasks[fixture.task.id]?.currentWorkerId;
    expect(failed.workers[failedWorkerId!]).toMatchObject({
      id: failedWorkerId,
      status: "failed",
      target: { kind: "modal", sandboxId: "sb-durable-123" },
      endedAt: expect.any(String),
    });
    expect(harness.calls).toContain("terminate:true");
    expect(harness.calls).not.toContain("detach");
    expect(harness.calls).toContain("copy:/dex/ready");
    expect(scheduleMonitor).not.toHaveBeenCalled();
    await expect(access(
      path.join(fixture.handoffsRoot, ".codex-account-auth.lease"),
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably retries lease release after startup cleanup without terminating twice", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-release-retry",
      loadedMemoryIds: [],
      loadedFailedApproachIds: [],
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    const releaseFailure = vi.fn(async () => {
      throw new Error("simulated lease unlink failure");
    });
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 1,
      releaseCodexAuthLease: releaseFailure,
    });

    await expect(mover.moveToCloud(fixture.task)).rejects.toThrow(
      "simulated lease unlink failure",
    );

    let state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "handoff",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          cleanupPending: true,
          terminalEvidence: {
            kind: "terminate-wait",
            sandboxId: "sb-durable-123",
            volumePersisted: true,
            operationToken: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
    });
    expect(releaseFailure).toHaveBeenCalledOnce();
    expect(harness.calls.filter((call) => call === "terminate:true")).toHaveLength(1);
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .resolves.toBeUndefined();

    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });
    const beforeRecovery = harness.calls.length;

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    const recoveryCalls = harness.calls.slice(beforeRecovery);
    expect(recoveryCalls).not.toContain("create");
    expect(recoveryCalls).not.toContain("terminate:true");
    expect(recoveryCalls.some((call) => call.startsWith("from-id:"))).toBe(false);
    expect(recoveryCalls.some((call) => call.startsWith("list:"))).toBe(false);
    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "failed",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          cleanupPending: false,
          terminalEvidence: {
            kind: "terminate-wait",
            sandboxId: "sb-durable-123",
          },
        },
      },
    });
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("idempotently reschedules from persisted metadata without creating another sandbox", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-recoverable-789",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    let initialRegistration: ModalMonitorRegistration | undefined;
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async (registration) => {
        initialRegistration = registration;
      },
      startupTimeoutMs: 50,
    });
    await mover.moveToCloud(fixture.task);
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });

    const recovered: ModalMonitorRegistration[] = [];
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async (registration) => {
        recovered.push(registration);
      },
      startupTimeoutMs: 50,
      recoveryBackoffMs: 0,
    });

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);
    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);
    expect(recovered).toEqual([initialRegistration, initialRegistration]);
    expect((await fixture.store.read()).tasks[fixture.task.id]).toMatchObject({
      status: "running",
      stage: "implementing",
      latestSummary: "codex is continuing in Modal; exact startup and monitoring ownership were restored",
    });
    expect(harness.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(harness.calls.filter((call) => call === `from-id:${initialRegistration?.sandboxId}`)).toHaveLength(2);
    expect(harness.calls.filter((call) => call === "read:/dex/startup.json").length).toBeGreaterThanOrEqual(3);
  });

  it("reconnects and uploads all artifacts after a crash immediately following sandbox persistence", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-recovered-upload",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    let registration: ModalMonitorRegistration | undefined;
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async (value) => {
        registration = value;
      },
      startupTimeoutMs: 50,
    });
    await initialMover.moveToCloud(fixture.task);
    if (!registration) throw new Error("test did not capture Modal monitor registration");
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });
    await fixture.store.updateState((state) => {
      const task = state.tasks[fixture.task.id]!;
      const journal = task.metadata.modalHandoffJournal as Record<string, unknown>;
      task.metadata.modalHandoffJournal = { ...journal, phase: "sandbox_created" };
      state.workers[registration!.workerId]!.status = "starting";
    });
    const beforeRecovery = harness.calls.length;
    const recovered: ModalMonitorRegistration[] = [];
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async (value) => {
        harness.calls.push("monitor-recovered");
        recovered.push(value);
      },
      startupTimeoutMs: 50,
      recoveryBackoffMs: 0,
    });

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    const recoveryCalls = harness.calls.slice(beforeRecovery);
    expect(recoveryCalls).toContain(`from-id:${registration.sandboxId}`);
    expect(recoveryCalls).toContain("copy:/dex/repo.bundle");
    expect(recoveryCalls).toContain("copy:/dex/handoff.json");
    expect(recoveryCalls).toContain("copy:/dex/cloud-worker.js");
    expect(recoveryCalls).toContain("monitor-recovered");
    expect(recoveryCalls).toContain("copy:/dex/ready");
    expect(recoveryCalls.indexOf("copy:/dex/repo.bundle")).toBeLessThan(recoveryCalls.indexOf("copy:/dex/ready"));
    expect(recoveryCalls.indexOf("copy:/dex/ready")).toBeLessThan(recoveryCalls.indexOf("read:/dex/startup.json"));
    expect(recoveryCalls.indexOf("read:/dex/startup.json")).toBeLessThan(recoveryCalls.indexOf("monitor-recovered"));
    expect(recoveryCalls).toContain("detach");
    expect(recoveryCalls).not.toContain("create");
    expect(recovered).toEqual([registration]);
    expect((await fixture.store.read()).tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "completed",
      monitorRegistration: registration,
      startupAcknowledgedAt: ACKNOWLEDGED_AT,
    });
  });

  it("discovers and adopts the exact operation-tagged orphan after create returned before ID journaling", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-orphan-adopted",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await initialMover.moveToCloud(fixture.task);
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });
    await fixture.store.updateState((state) => {
      const task = state.tasks[fixture.task.id]!;
      const journal = task.metadata.modalHandoffJournal as Record<string, unknown>;
      const orphanWorkerId = String(journal.workerId);
      task.metadata.modalHandoffJournal = {
        ...journal,
        phase: "prepared",
        monitorRegistration: undefined,
        startupAcknowledgedAt: undefined,
        monitorScheduledAt: undefined,
        finalizedAt: undefined,
      };
      task.currentWorkerId = "worker-local";
      delete state.workers[orphanWorkerId];
    });
    const scheduleMonitor = vi.fn(async () => undefined);
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor,
      startupTimeoutMs: 50,
      recoveryBackoffMs: 0,
    });
    const beforeRecovery = harness.calls.length;

    await expect(mover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    const recoveryCalls = harness.calls.slice(beforeRecovery);
    expect(recoveryCalls.some((call) => call.startsWith("list:"))).toBe(true);
    expect(recoveryCalls).toContain("from-id:sb-durable-123");
    expect(recoveryCalls).not.toContain("create");
    expect(scheduleMonitor).toHaveBeenCalledOnce();
    const state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "running",
      stage: "implementing",
      metadata: {
        modalHandoffJournal: {
          phase: "completed",
          monitorRegistration: {
            sandboxId: "sb-durable-123",
          },
        },
      },
    });
  });

  it("retains the exact lease after an empty ambiguous-create listing and cleans up a delayed orphan on restart", async () => {
    const fixture = await createMoverFixture();
    let orphanVisible = false;
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-delayed-orphan",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }), {
      listSandboxIds: () => orphanVisible ? ["sb-durable-123"] : [],
    });
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await initialMover.moveToCloud(fixture.task);
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });
    await fixture.store.updateState((state) => {
      const task = state.tasks[fixture.task.id]!;
      const journal = task.metadata.modalHandoffJournal as Record<string, unknown>;
      const orphanWorkerId = String(journal.workerId);
      task.metadata.modalHandoffJournal = {
        ...journal,
        phase: "prepared",
        monitorRegistration: undefined,
        startupAcknowledgedAt: undefined,
        monitorScheduledAt: undefined,
        finalizedAt: undefined,
        recoveryAttempts: 0,
      };
      task.currentWorkerId = "worker-local";
      delete state.workers[orphanWorkerId];
    });
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      recoveryMaxAttempts: 1,
      recoveryBackoffMs: 0,
    });
    const beforeInvisibleRecovery = harness.calls.length;

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(false);

    let state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "handoff",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          cleanupPending: true,
          recoveryAttempts: 1,
          lastRecoveryError: expect.stringContaining("not visible"),
        },
      },
    });
    expect(harness.calls.slice(beforeInvisibleRecovery)).not.toContain("terminate:true");
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .resolves.toBeUndefined();

    orphanVisible = true;
    const beforeVisibleRecovery = harness.calls.length;
    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    const cleanupCalls = harness.calls.slice(beforeVisibleRecovery);
    expect(cleanupCalls.some((call) => call.startsWith("list:"))).toBe(true);
    expect(cleanupCalls).toContain("from-id:sb-durable-123");
    expect(cleanupCalls).toContain("terminate:true");
    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "failed",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          cleanupPending: false,
        },
      },
    });
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries durable failed cleanup after restart and releases the exact operation lease only after wait termination", async () => {
    const fixture = await createMoverFixture();
    let terminationFails = true;
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-cleanup-retry",
      loadedMemoryIds: [],
      loadedFailedApproachIds: [],
      acknowledgedAt: ACKNOWLEDGED_AT,
    }), {
      terminate: () => {
        if (terminationFails) throw new Error("temporary Modal termination outage");
      },
    });
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 1,
    });

    await expect(initialMover.moveToCloud(fixture.task)).rejects.toThrow(
      "Timed out waiting for Codex/Modal startup acknowledgement",
    );

    let state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "handoff",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          cleanupPending: true,
          failure: expect.stringContaining("terminal cleanup failed"),
        },
      },
    });
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .resolves.toBeUndefined();

    terminationFails = false;
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });
    const beforeRestartCleanup = harness.calls.length;

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    const restartCalls = harness.calls.slice(beforeRestartCleanup);
    expect(restartCalls).toContain("from-id:sb-durable-123");
    expect(restartCalls).toContain("terminate:true");
    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "failed",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          cleanupPending: false,
        },
      },
    });
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats auth-lease contention during recovery as capacity without consuming recovery attempts", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-recovery-contention",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await initialMover.moveToCloud(fixture.task);
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });
    const before = await fixture.store.read();
    const journalBefore = before.tasks[fixture.task.id]!.metadata.modalHandoffJournal;
    await writeFile(
      path.join(fixture.handoffsRoot, ".codex-account-auth.lease"),
      `${JSON.stringify({ version: 1, taskId: "task-other" })}\n`,
      { mode: 0o600 },
    );
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      recoveryMaxAttempts: 1,
      recoveryBackoffMs: 0,
    });
    const beforeRecovery = harness.calls.length;

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(false);

    const after = await fixture.store.read();
    expect(after.tasks[fixture.task.id]).toMatchObject({
      status: "handoff",
      metadata: { modalHandoffJournal: journalBefore },
    });
    expect(harness.calls.slice(beforeRecovery).some((call) => call.startsWith("list:"))).toBe(false);
    expect(harness.calls.slice(beforeRecovery).some((call) => call.startsWith("from-id:"))).toBe(false);
    expect(JSON.parse(await readFile(
      path.join(fixture.handoffsRoot, ".codex-account-auth.lease"),
      "utf8",
    ))).toEqual({ version: 1, taskId: "task-other" });
  });

  it("persists bounded recovery backoff before explicit terminal cleanup", async () => {
    const fixture = await createMoverFixture();
    let failStartupReads = false;
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-retry",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }), {
      onStartupRead: () => {
        if (failStartupReads) throw new Error("temporary startup read outage");
      },
    });
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await initialMover.moveToCloud(fixture.task);
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });
    failStartupReads = true;
    const sleeps: number[] = [];
    const scheduleMonitor = vi.fn(async () => undefined);
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor,
      startupTimeoutMs: 2,
      recoveryMaxAttempts: 3,
      recoveryBackoffMs: 0,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    const failed = await fixture.store.read();
    expect(failed.tasks[fixture.task.id]).toMatchObject({
      status: "failed",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          recoveryAttempts: 3,
          cleanupPending: false,
          lastRecoveryError: expect.stringContaining("Timed out"),
          failure: expect.stringContaining("exhausted 3 attempts"),
        },
      },
    });
    expect(sleeps).toEqual([0, 0]);
    expect(scheduleMonitor).not.toHaveBeenCalled();
    expect(harness.calls).toContain("terminate:true");
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains exhausted-recovery evidence until a failed lease release is retried", async () => {
    const fixture = await createMoverFixture();
    let failStartupReads = false;
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-exhausted-release-retry",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }), {
      onStartupRead: () => {
        if (failStartupReads) throw new Error("temporary startup read outage");
      },
    });
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await initialMover.moveToCloud(fixture.task);
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });
    failStartupReads = true;
    const releaseFailure = vi.fn(async () => {
      throw new Error("simulated exhausted-recovery lease unlink failure");
    });
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 2,
      recoveryMaxAttempts: 1,
      recoveryBackoffMs: 0,
      releaseCodexAuthLease: releaseFailure,
    });

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).rejects.toThrow(
      "simulated exhausted-recovery lease unlink failure",
    );

    let state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "handoff",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          cleanupPending: true,
          recoveryAttempts: 1,
          terminalEvidence: {
            kind: "terminate-wait",
            sandboxId: "sb-durable-123",
          },
        },
      },
    });
    expect(harness.calls.filter((call) => call === "terminate:true")).toHaveLength(1);

    const restartMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });
    const beforeRestart = harness.calls.length;
    await expect(restartMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);
    const restartCalls = harness.calls.slice(beforeRestart);
    expect(restartCalls).not.toContain("create");
    expect(restartCalls).not.toContain("terminate:true");
    expect(restartCalls.some((call) => call.startsWith("from-id:"))).toBe(false);
    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]).toMatchObject({
      status: "failed",
      metadata: { modalHandoffJournal: { phase: "failed", cleanupPending: false } },
    });
  });

  it("refuses monitor ownership when the recovered signed handoff package was changed", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-package-integrity",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    const initialMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await initialMover.moveToCloud(fixture.task);
    await fixture.tasks.transition(fixture.task.id, "checkpointing", { stage: "checkpointing" });
    await fixture.tasks.transition(fixture.task.id, "handoff", { stage: "handing_off" });
    const handoffPath = path.join(fixture.handoffsRoot, fixture.task.id, "handoff.json");
    const changed = JSON.parse(await readFile(handoffPath, "utf8")) as Record<string, unknown>;
    changed.goal = "tampered after signing";
    await writeFile(handoffPath, `${JSON.stringify(changed)}\n`, "utf8");
    const scheduleMonitor = vi.fn(async () => undefined);
    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor,
      recoveryMaxAttempts: 1,
      recoveryBackoffMs: 0,
    });

    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    expect(scheduleMonitor).not.toHaveBeenCalled();
    expect((await fixture.store.read()).tasks[fixture.task.id]).toMatchObject({
      status: "failed",
      metadata: {
        modalHandoffJournal: {
          phase: "failed",
          failure: expect.stringContaining("Handoff verification failed"),
          cleanupPending: false,
        },
      },
    });
    expect(harness.calls).toContain("terminate:true");
  });

  it("propagates shared-auth lease busy without failing the task or creating a sandbox", async () => {
    const fixture = await createMoverFixture();
    await mkdir(fixture.handoffsRoot, { recursive: true });
    await writeFile(
      path.join(fixture.handoffsRoot, ".codex-account-auth.lease"),
      `${JSON.stringify({ version: 1, taskId: "task-other" })}\n`,
      { mode: 0o600 },
    );
    const harness = createModalHarness(() => ({}));
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });

    const error = await mover.moveToCloud(fixture.task).catch((caught) => caught);

    expect(isCodexAuthLeaseBusyError(error)).toBe(true);
    expect(harness.calls).not.toContain("create");
    expect((await fixture.store.read()).tasks[fixture.task.id]).toMatchObject({
      status: "running",
      stage: "implementing",
    });
    expect((await fixture.store.read()).tasks[fixture.task.id]?.metadata.modalHandoffJournal).toBeUndefined();
  });

  it("aborts at a durable phase boundary, waits for termination, and releases only after cleanup", async () => {
    const fixture = await createMoverFixture();
    const controller = new AbortController();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-never-started",
      loadedMemoryIds: [],
      loadedFailedApproachIds: [],
    }), {
      onCopy: (remotePath) => {
        if (remotePath === "/dex/ready") controller.abort();
      },
    });
    const scheduleMonitor = vi.fn(async () => undefined);
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor,
    });

    const error = await mover.moveToCloud(fixture.task, "codex", controller.signal).catch((caught) => caught);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(scheduleMonitor).not.toHaveBeenCalled();
    expect(harness.calls).toContain("terminate:true");
    const state = await fixture.store.read();
    const workerId = state.tasks[fixture.task.id]?.currentWorkerId;
    expect(state.workers[workerId!]).toMatchObject({ status: "stopped" });
    expect(state.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "stopped",
      cleanupPending: false,
    });
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains abort cleanup evidence until lease release succeeds after restart", async () => {
    const fixture = await createMoverFixture();
    const controller = new AbortController();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-abort-release-retry",
      loadedMemoryIds: [],
      loadedFailedApproachIds: [],
    }), {
      onCopy: (remotePath) => {
        if (remotePath === "/dex/ready") controller.abort();
      },
    });
    const releaseFailure = vi.fn(async () => {
      throw new Error("simulated abort lease unlink failure");
    });
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      releaseCodexAuthLease: releaseFailure,
    });

    await expect(
      mover.moveToCloud(fixture.task, "codex", controller.signal),
    ).rejects.toThrow("simulated abort lease unlink failure");

    let state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "stopped",
      cleanupPending: true,
      terminalEvidence: {
        kind: "terminate-wait",
        sandboxId: "sb-durable-123",
      },
    });
    expect(harness.calls.filter((call) => call === "terminate:true")).toHaveLength(1);

    const restartMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });
    const beforeRestart = harness.calls.length;
    await expect(restartMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);
    const restartCalls = harness.calls.slice(beforeRestart);
    expect(restartCalls).not.toContain("create");
    expect(restartCalls).not.toContain("terminate:true");
    expect(restartCalls.some((call) => call.startsWith("from-id:"))).toBe(false);
    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "stopped",
      cleanupPending: false,
    });
  });

  it("stops only the currently owned Modal worker and preserves a newer worker fence", async () => {
    const fixture = await createMoverFixture();
    let replaceDuringReconnect = false;
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-stop",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }), {
      onFromId: async () => {
        if (!replaceDuringReconnect) return;
        await fixture.store.updateState((draft) => {
          draft.tasks[fixture.task.id]!.currentWorkerId = "worker-newer";
        });
      },
    });
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await mover.moveToCloud(fixture.task);
    let state = await fixture.store.read();
    const cloudWorkerId = state.tasks[fixture.task.id]!.currentWorkerId!;
    replaceDuringReconnect = true;
    const beforeFencedStop = harness.calls.length;
    await expect(mover.stopCloudTask(fixture.task, cloudWorkerId)).resolves.toBe(false);
    expect(harness.calls.slice(beforeFencedStop)).toContain("from-id:sb-durable-123");
    expect(harness.calls.slice(beforeFencedStop)).not.toContain("terminate:true");
    replaceDuringReconnect = false;
    await fixture.store.updateState((draft) => {
      draft.tasks[fixture.task.id]!.currentWorkerId = cloudWorkerId;
    });

    await expect(mover.stopCloudTask(fixture.task, cloudWorkerId)).resolves.toBe(true);

    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]!.currentWorkerId).toBe(cloudWorkerId);
    expect(state.workers[cloudWorkerId]).toMatchObject({
      status: "stopped",
      endedAt: expect.any(String),
    });
    expect(harness.calls).toContain("terminate:true");
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries an explicit-stop lease release without touching the terminated sandbox again", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-stop-release-retry",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    const releaseFailure = vi.fn(async () => {
      throw new Error("simulated explicit-stop lease unlink failure");
    });
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
      releaseCodexAuthLease: releaseFailure,
    });
    await mover.moveToCloud(fixture.task);
    const cloudWorkerId = (await fixture.store.read()).tasks[fixture.task.id]!.currentWorkerId!;

    await expect(mover.stopCloudTask(fixture.task, cloudWorkerId)).rejects.toThrow(
      "simulated explicit-stop lease unlink failure",
    );

    let state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "stopped",
      cleanupPending: true,
      terminalEvidence: {
        kind: "terminate-wait",
        sandboxId: "sb-durable-123",
      },
    });
    expect(harness.calls.filter((call) => call === "terminate:true")).toHaveLength(1);

    const recoveryMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });
    const beforeRecovery = harness.calls.length;
    await expect(recoveryMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);

    const recoveryCalls = harness.calls.slice(beforeRecovery);
    expect(recoveryCalls).not.toContain("create");
    expect(recoveryCalls).not.toContain("terminate:true");
    expect(recoveryCalls.some((call) => call.startsWith("from-id:"))).toBe(false);
    expect(recoveryCalls.some((call) => call.startsWith("list:"))).toBe(false);
    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "stopped",
      cleanupPending: false,
    });
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers explicit stop after termination wins but terminal evidence persistence crashes", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-stop-persist-crash",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
    const mover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
      startupTimeoutMs: 50,
    });
    await mover.moveToCloud(fixture.task);
    const cloudWorkerId = (await fixture.store.read()).tasks[fixture.task.id]!.currentWorkerId!;
    const originalUpdate = fixture.store.updateState.bind(fixture.store);
    const update = vi.spyOn(fixture.store, "updateState").mockImplementation(async (mutator) =>
      originalUpdate((draft) => {
        const before = draft.tasks[fixture.task.id]?.metadata.modalHandoffJournal as
          | { phase?: unknown; terminalEvidence?: unknown }
          | undefined;
        mutator(draft);
        const after = draft.tasks[fixture.task.id]?.metadata.modalHandoffJournal as
          | { phase?: unknown; terminalEvidence?: unknown }
          | undefined;
        if (
          before?.phase === "stopped" &&
          after?.phase === "stopped" &&
          after.terminalEvidence !== undefined
        ) {
          throw new Error("simulated crash before terminal evidence persistence");
        }
      }));

    await expect(mover.stopCloudTask(fixture.task, cloudWorkerId)).rejects.toThrow(
      "simulated crash before terminal evidence persistence",
    );
    update.mockRestore();

    let state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "stopped",
      cleanupPending: true,
      failure: "stop requested by the orchestrator",
    });
    expect(
      (state.tasks[fixture.task.id]?.metadata.modalHandoffJournal as { terminalEvidence?: unknown })
        .terminalEvidence,
    ).toBeUndefined();
    expect(harness.calls.filter((call) => call === "terminate:true")).toHaveLength(1);

    const restartMover = new ModalTaskMover({
      store: fixture.store,
      events: fixture.events,
      tasks: fixture.tasks,
      handoffsRoot: fixture.handoffsRoot,
      workerScriptPath: fixture.workerScriptPath,
      signingKey: SIGNING_KEY,
      modal: harness.modal,
      scheduleMonitor: async () => undefined,
    });
    await expect(restartMover.recoverInterruptedHandoff(fixture.task)).resolves.toBe(true);
    state = await fixture.store.read();
    expect(state.tasks[fixture.task.id]?.metadata.modalHandoffJournal).toMatchObject({
      phase: "stopped",
      cleanupPending: false,
      terminalEvidence: {
        kind: "terminate-wait",
        sandboxId: "sb-durable-123",
      },
    });
    expect(harness.calls.filter((call) => call === "terminate:true")).toHaveLength(2);
    await expect(access(path.join(fixture.handoffsRoot, ".codex-account-auth.lease")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
