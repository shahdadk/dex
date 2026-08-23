import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModalTaskMover,
  type ModalMonitorRegistration,
} from "../src/cloud/modal-task-mover.js";
import {
  ModalAdapter,
  type ModalClientLike,
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
}

afterEach(async () => {
  vi.restoreAllMocks();
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
): ModalHarness {
  const calls: string[] = [];
  let uploadedHandoff: HandoffDocument | undefined;
  const filesystem = {
    copyFromLocal: async (localPath: string, remotePath: string) => {
      calls.push(`copy:${remotePath}`);
      if (remotePath === "/dex/handoff.json") {
        uploadedHandoff = JSON.parse(await readFile(localPath, "utf8")) as HandoffDocument;
      }
    },
    copyToLocal: async (remotePath: string, localPath: string) => {
      calls.push(`download:${remotePath}:${localPath}`);
    },
    readText: async (remotePath: string) => {
      calls.push(`read:${remotePath}`);
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
    terminate: async () => {
      calls.push("terminate");
    },
    poll: async () => null,
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
      create: async () => {
        calls.push("create");
        return rawSandbox;
      },
      fromId: async () => rawSandbox,
    },
    secrets: {
      fromName: async (name, options) => {
        calls.push(`secret:${name}:${options?.requiredKeys?.join(",") ?? ""}`);
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
  };
}

describe("ModalTaskMover", () => {
  it("durably persists the sandbox and provider thread before scheduling the monitor and detaching", async () => {
    const fixture = await createMoverFixture();
    const harness = createModalHarness((handoff) => ({
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      providerThreadId: "thread-durable-456",
      loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
      acknowledgedAt: ACKNOWLEDGED_AT,
    }));
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
    expect(uploaded?.failedApproaches).toHaveLength(1);
    const workerId = registration?.workerId;
    expect(workerId).toEqual(expect.any(String));
    expect(registration).toMatchObject({
      taskId: fixture.task.id,
      sandboxId: "sb-durable-123",
      handoffSha256: uploaded?.contentHash,
      startedAt: ACKNOWLEDGED_AT,
      resultPath: "/dex/result.json",
    });
    expect(stateAtSchedule?.workers[workerId!]).toMatchObject({
      taskId: fixture.task.id,
      providerSessionId: "thread-durable-456",
      target: { kind: "modal", sandboxId: "sb-durable-123" },
      status: "running",
    });
    expect(stateAtSchedule?.tasks[fixture.task.id]).toMatchObject({
      currentWorkerId: workerId,
      metadata: {
        sandboxId: "sb-durable-123",
        handoffHash: uploaded?.contentHash,
        memoryCount: uploaded?.memories.length,
        failedApproachCount: uploaded?.failedApproaches.length,
      },
    });

    const reloaded = await new DexStateStore(fixture.stateFile).read();
    expect(reloaded.tasks[fixture.task.id]).toMatchObject({
      status: "running",
      currentWorkerId: workerId,
      workerHistory: ["worker-local", workerId],
    });
    expect(harness.calls.indexOf("monitor")).toBeLessThan(harness.calls.indexOf("detach"));
    expect(harness.calls).toContain("close");
    expect(harness.calls).not.toContain("terminate");
  });

  it("terminates the sandbox and does not detach or schedule when startup context is incomplete", async () => {
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

    expect(harness.calls).toContain("terminate");
    expect(harness.calls).not.toContain("detach");
    expect(harness.calls).not.toContain("monitor");
    expect(scheduleMonitor).not.toHaveBeenCalled();
    const state = await new DexStateStore(fixture.stateFile).read();
    expect(Object.values(state.workers).some((worker) => worker.target.kind === "modal")).toBe(false);
  });
});
