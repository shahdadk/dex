import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  type AgentProcessSpawner,
  type SpawnedAgentProcess,
} from "../src/agents/index.js";
import {
  DexControlPlaneService,
  InMemoryControlPlaneRepository,
  MonitorJobOutbox,
  createDexControlPlaneFetchHandler,
  deterministicControlPlaneId,
  type SendblueInboundWebhook,
} from "../src/cloud/control-plane/index.js";
import {
  ModalMonitor,
  type ModalMonitorOutcome,
  type ModalTerminalEvent,
} from "../src/cloud/modal-monitor/index.js";
import {
  ModalTaskMover,
  type ModalMonitorRegistration,
} from "../src/cloud/modal-task-mover.js";
import {
  ModalAdapter,
  type ModalClientLike,
  type ModalImageLike,
  type ModalSdkSandboxLike,
} from "../src/cloud/modal/index.js";
import {
  DexCloudMessagingClient,
  createDexPairingPayload,
  createDexSyncPayload,
  generateDexDeviceKeyPair,
  type DexFetch,
} from "../src/cloud/messaging/index.js";
import { DexConfigSchema } from "../src/config/config.js";
import { resolveDexPaths } from "../src/config/paths.js";
import { GeminiRouter } from "../src/dex/gemini.js";
import { DexOrchestrator } from "../src/dex/orchestrator.js";
import { MessageRouter } from "../src/dex/router.js";
import { BatteryMonitor } from "../src/local/battery-monitor.js";
import { DexCloudBridge } from "../src/local/daemon/cloud-bridge.js";
import { DexPowerController } from "../src/local/daemon/power-controller.js";
import { DexDaemonRuntime } from "../src/local/daemon/runtime.js";
import { MacMachineController, type SleepInhibitor } from "../src/local/machine/index.js";
import { simulatedBatteryReading } from "../src/local/power/index.js";
import { MemoryContinuity } from "../src/memory/index.js";
import { EventLog } from "../src/state/events.js";
import { DexProjectSchema, type DexEvent } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { TaskManager } from "../src/tasks/task-manager.js";
import type { HandoffDocument } from "../src/tasks/handoff.js";
import { execFile } from "../src/utils/exec.js";

const NOW_ISO = "2026-08-23T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const OWNER_ID = "owner-golden";
const CONVERSATION_ID = "conversation-golden";
const PHONE = "+14165550123";
const DEX_LINE = "+14165550999";
const WEBHOOK_SECRET = "golden-sendblue-secret";
const INTERNAL_SECRET = "golden-internal-secret";
const HANDOFF_SECRET = "golden-handoff-signing-key";
const SETUP_CODE = "ABCDEFGHJKLMNPQRST23";
const FAILED_APPROACH = "npm test -- --runInBand";
const FAILED_REASON = "Serializing the retry test deadlocked and did not prove exactly-once delivery.";
const ENGINEERING_MESSAGE =
  "fix auth retries with codex, and have claude investigate checkout completion status";

const temporaryDirectories: string[] = [];
const boundaryProcesses: BoundaryProcess[] = [];

afterEach(async () => {
  for (const process of boundaryProcesses.splice(0)) process.finish(null, "SIGKILL");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ),
  );
});

class BoundaryProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  prompt = "";
  #closed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      this.prompt += chunk.toString("utf8");
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    const resolved = typeof signal === "string" ? signal : "SIGTERM";
    queueMicrotask(() => this.finish(null, resolved));
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function agentProcessBoundary(): {
  spawner: AgentProcessSpawner;
  starts: BoundaryProcess[];
  byCommand: Map<string, BoundaryProcess>;
} {
  const starts: BoundaryProcess[] = [];
  const byCommand = new Map<string, BoundaryProcess>();
  const spawner: AgentProcessSpawner = (command, args) => {
    const child = new BoundaryProcess();
    boundaryProcesses.push(child);
    if (args.length === 1 && args[0] === "--version") {
      queueMicrotask(() => child.finish(0));
    } else {
      starts.push(child);
      byCommand.set(command, child);
      queueMicrotask(() => {
        if (command === "claude") {
          child.stdout.write(`${JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "session-claude-local-golden",
          })}\n`);
          child.stdout.write(`${JSON.stringify({
            type: "assistant",
            session_id: "session-claude-local-golden",
            message: {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: "toolu_failed_retry",
                name: FAILED_APPROACH,
                input: {},
              }],
            },
          })}\n`);
          child.stdout.write(`${JSON.stringify({
            type: "user",
            session_id: "session-claude-local-golden",
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: "toolu_failed_retry",
                is_error: true,
                content: FAILED_REASON,
              }],
            },
          })}\n`);
        } else {
          child.stdout.write(
            `${JSON.stringify({ type: "thread.started", thread_id: "thread-codex-local-golden" })}\n`,
          );
          child.stdout.write(`${JSON.stringify({
            type: "item.completed",
            item: {
              id: "auth-implementation",
              type: "file_change",
              path: "src/auth.ts",
              status: "completed",
            },
          })}\n`);
        }
      });
    }
    return child as unknown as SpawnedAgentProcess;
  };
  return { spawner, starts, byCommand };
}

interface ModalBoundary {
  adapter: ModalAdapter;
  calls: string[];
  uploadedHandoff(): HandoffDocument | undefined;
  acknowledgedContext(): Record<string, unknown> | undefined;
}

function modalBoundary(): ModalBoundary {
  const calls: string[] = [];
  let handoff: HandoffDocument | undefined;
  let startup: Record<string, unknown> | undefined;
  const filesystem = {
    copyFromLocal: async (localPath: string, remotePath: string) => {
      calls.push(`upload:${remotePath}`);
      if (remotePath === "/dex/handoff.json") {
        handoff = JSON.parse(await readFile(localPath, "utf8")) as HandoffDocument;
      }
    },
    copyToLocal: async (remotePath: string, localPath: string) => {
      calls.push(`download:${remotePath}:${localPath}`);
    },
    readText: async (remotePath: string) => {
      calls.push(`read:${remotePath}`);
      if (remotePath !== "/dex/startup.json" || !handoff) {
        const error = new Error(`Missing fake Modal artifact: ${remotePath}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      startup = {
        taskId: handoff.taskId,
        handoffSha256: handoff.contentHash,
        providerThreadId: "thread-modal-golden",
        loadedMemoryIds: handoff.memories.map(({ id }) => String(id)),
        loadedFailedApproachIds: handoff.failedApproaches.map(
          ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
        ),
        acknowledgedAt: NOW_ISO,
      };
      return JSON.stringify(startup);
    },
    writeText: async (_data: string, remotePath: string) => {
      calls.push(`write:${remotePath}`);
    },
  };
  const sandbox: ModalSdkSandboxLike = {
    sandboxId: "sandbox-golden",
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
    poll: async () => 0,
  };
  const image: ModalImageLike = {
    dockerfileCommands: () => image,
  };
  const client: ModalClientLike = {
    apps: { fromName: async () => ({ appId: "app-golden" }) },
    images: { fromRegistry: () => image },
    sandboxes: {
      create: async () => sandbox,
      fromId: async () => sandbox,
    },
    secrets: { fromName: async () => ({}) },
    close: () => {
      calls.push("close");
    },
  };
  return {
    adapter: new ModalAdapter({ client }),
    calls,
    uploadedHandoff: () => handoff,
    acknowledgedContext: () => startup,
  };
}

function inbound(
  messageHandle: string,
  content: string,
): SendblueInboundWebhook {
  return {
    content,
    is_outbound: false,
    message_handle: messageHandle,
    date_sent: NOW_ISO,
    from_number: PHONE,
    to_number: DEX_LINE,
    sendblue_number: DEX_LINE,
    group_id: "",
    message_type: "message",
  };
}

function sendblueHeaders(): Headers {
  return new Headers({
    "content-type": "application/json",
    "sb-signing-secret": WEBHOOK_SECRET,
  });
}

function localFetch(service: DexControlPlaneService): DexFetch {
  const handler = createDexControlPlaneFetchHandler({ service });
  return async (input, init) => handler(new Request(input, init));
}

async function mustGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function createRepository(directory: string): Promise<string> {
  const repository = path.join(directory, "repository");
  await mkdir(repository);
  await mustGit(["init", "-b", "main"], repository);
  await mustGit(["config", "user.name", "Dex Golden Path"], repository);
  await mustGit(["config", "user.email", "dex@example.test"], repository);
  await writeFile(path.join(repository, "README.md"), "golden path fixture\n", "utf8");
  await mustGit(["add", "README.md"], repository);
  await mustGit(["commit", "-m", "initial fixture"], repository);
  return repository;
}

async function readEvents(file: string): Promise<DexEvent[]> {
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as DexEvent);
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe("Dex golden path", () => {
  it("carries one Sendblue request through durable local and Modal execution exactly once", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-golden-path-"));
    temporaryDirectories.push(directory);
    const repositoryPath = await createRepository(directory);
    const paths = resolveDexPaths(path.join(directory, "dex-home"));
    const store = new DexStateStore(paths.state);
    const events = new EventLog(paths.events);
    const repository = new InMemoryControlPlaneRepository();
    const serverKey = generateDexDeviceKeyPair();
    const service = new DexControlPlaneService({
      repository,
      associationVerifier: {
        verify: async () => ({
          ownerId: OWNER_ID,
          conversationId: CONVERSATION_ID,
          phoneE164: PHONE,
        }),
      },
      signingKey: serverKey,
      sendblueWebhookSecret: WEBHOOK_SECRET,
      internalSecret: INTERNAL_SECRET,
      now: () => NOW,
    });

    const pairWebhook = inbound("pair-golden", `PAIR ${SETUP_CODE}`);
    const pairOutcomes = await Promise.all([
      service.processSendblueWebhook(pairWebhook, sendblueHeaders()),
      service.processSendblueWebhook(pairWebhook, sendblueHeaders()),
      service.processSendblueWebhook(pairWebhook, sendblueHeaders()),
    ]);
    expect(pairOutcomes.filter(({ kind }) => kind === "pairing_challenge")).toHaveLength(1);
    expect(pairOutcomes.filter(({ kind }) => kind === "duplicate")).toHaveLength(2);
    expect((await repository.listSendblueOutbox())
      .filter(({ dedupeKey }) => dedupeKey === "sendblue:pair:pair-golden"))
      .toHaveLength(1);

    const deviceKey = generateDexDeviceKeyPair();
    const pairingClient = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      keyPair: deviceKey,
      fetch: localFetch(service),
      now: () => NOW,
      nonce: (sequence) => `golden-pair-${sequence}`,
    });
    const paired = await pairingClient.pair(createDexPairingPayload({
      pairingCode: SETUP_CODE,
      deviceName: "Golden Mac",
      keyId: deviceKey.keyId,
      publicKey: deviceKey.publicKey,
    }));
    expect(paired).toMatchObject({
      ownerId: OWNER_ID,
      pairedConversationId: CONVERSATION_ID,
      nextSequence: 2,
    });

    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER_ID,
      keyPair: deviceKey,
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: serverKey.keyId,
        publicKey: serverKey.publicKey,
      }],
      initialSequence: paired.nextSequence! - 1,
      fetch: localFetch(service),
      now: () => NOW,
      nonce: (sequence) => `golden-sync-${sequence}`,
    });
    const bridge = new DexCloudBridge(client, store, events);

    const project = DexProjectSchema.parse({
      id: "project-golden",
      name: "Golden repository",
      path: repositoryPath,
      defaultBranch: "main",
      createdAt: NOW_ISO,
    });
    await store.updateState((state) => {
      state.projects[project.id] = project;
    });
    const tasks = new TaskManager(store, events, paths);
    const memory = new MemoryContinuity({ client: null, store });
    const agentBoundary = agentProcessBoundary();
    const modal = modalBoundary();
    let registration: ModalMonitorRegistration | undefined;
    const mover = new ModalTaskMover({
      store,
      events,
      tasks,
      handoffsRoot: paths.handoffs,
      workerScriptPath: path.join(process.cwd(), "src", "cloud", "cloud-worker.ts"),
      signingKey: HANDOFF_SECRET,
      modal: modal.adapter,
      taskKnowledge: (taskId) => memory.getTaskKnowledge(taskId),
      scheduleMonitor: async (input) => {
        registration = input;
        await bridge.publish({
          type: "modal.monitor.registered",
          taskId: input.taskId,
          workerId: input.workerId,
          payload: { ...input },
        }, { flush: true });
        await store.updateState((state) => {
          const task = state.tasks[input.taskId];
          if (!task) throw new Error(`Task disappeared: ${input.taskId}`);
          task.metadata.cloudMonitorAcknowledged = true;
          task.metadata.sandboxId = input.sandboxId;
        });
      },
      startupTimeoutMs: 100,
    });
    const router = new MessageRouter({ gemini: new GeminiRouter({ apiKey: "" }) });
    const orchestrator = new DexOrchestrator({
      store,
      events,
      tasks,
      paths,
      config: DexConfigSchema.parse({ maxConcurrency: 2, deviceId: paired.deviceId }),
      project,
      agents: {
        codex: new CodexAgentAdapter({ spawner: agentBoundary.spawner }),
        claude: new ClaudeAgentAdapter({ spawner: agentBoundary.spawner }),
      },
      notify: (conversationId, text) => bridge.notify(conversationId, text),
      publishTask: async (task, conversationId) => {
        await bridge.publish({
          type: "task.created",
          taskId: task.id,
          payload: {
            title: task.title,
            originalRequest: task.originalRequest,
            conversationId,
            projectId: task.projectId,
          },
        });
      },
      memory,
      mover,
    });
    let awake = false;
    const sleepInhibitor: SleepInhibitor = {
      get active() { return awake; },
      start: async () => {
        awake = true;
        return 4242;
      },
      restore: async () => {
        const changed = awake;
        awake = false;
        return changed;
      },
    };
    const powerCommands: string[] = [];
    const machine = new MacMachineController({
      caffeinate: sleepInhibitor,
      commandExecutor: async (command, args) => {
        powerCommands.push(`${command} ${args.join(" ")}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const power = new DexPowerController({
      store,
      events,
      machine,
      notify: (conversationId, text) => bridge.notify(conversationId, text),
    });
    const battery = new BatteryMonitor({
      store,
      events,
      deviceId: paired.deviceId,
      notify: (text) => bridge.notify(CONVERSATION_ID, text),
    });
    const runtime = new DexDaemonRuntime({
      bridge,
      router,
      orchestrator,
      store,
      events,
      battery,
      power,
    });

    const engineeringWebhook = inbound("engineering-golden", ENGINEERING_MESSAGE);
    const engineeringOutcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.processSendblueWebhook(engineeringWebhook, sendblueHeaders())),
    );
    const accepted = engineeringOutcomes.find(
      (outcome) => outcome.kind === "engineering_command",
    );
    expect(accepted).toMatchObject({
      kind: "engineering_command",
      taskId: deterministicControlPlaneId("task", "sendblue:engineering-golden"),
      commandId: deterministicControlPlaneId("cmd", "sendblue:engineering-golden"),
    });
    expect(engineeringOutcomes.filter(({ kind }) => kind === "engineering_command"))
      .toHaveLength(1);
    expect(engineeringOutcomes.filter(({ kind }) => kind === "duplicate"))
      .toHaveLength(3);
    expect(await repository.listPendingDeviceCommands(paired.deviceId, 500)).toHaveLength(1);

    const firstDelivery = await bridge.syncOnce(0);
    const retriedDelivery = await bridge.syncOnce(0);
    expect(firstDelivery).toHaveLength(1);
    expect(retriedDelivery.map(({ id }) => id)).toEqual(firstDelivery.map(({ id }) => id));
    await runtime.handleCommand(firstDelivery[0]!);
    await runtime.handleCommand(retriedDelivery[0]!);

    let state = await store.read();
    const created = Object.values(state.tasks);
    expect(created).toHaveLength(2);
    expect(created.map(({ originalRequest }) => originalRequest)).toEqual([
      "fix auth retries",
      "investigate checkout completion status",
    ]);
    expect(created.map(({ status }) => status)).toEqual(["running", "running"]);
    expect(agentBoundary.starts).toHaveLength(2);
    expect(state.processedMessageIds).toEqual(expect.arrayContaining([
      "engineering-golden",
      deterministicControlPlaneId("cmd", "sendblue:engineering-golden"),
    ]));

    const statusRoute = await router.route("status?");
    const status = await orchestrator.handle(statusRoute.actions, {
      conversationId: CONVERSATION_ID,
      messageId: "status-golden",
    });
    expect(status).toContain("2 things active:");
    expect(status).toContain("running validation");
    expect(status).toContain("nothing needs you right now");

    const primary = created.find(({ preferredAgent }) => preferredAgent === "codex")!;
    const cloudTask = created.find(({ preferredAgent }) => preferredAgent === "claude")!;
    await eventually(async () => {
      const durable = await store.read();
      expect(durable.tasks[cloudTask.id]?.metadata.taskKnowledge).toMatchObject({
        failedApproaches: [{
          approach: FAILED_APPROACH,
          reason: FAILED_REASON,
          failed: true,
          shouldRetry: false,
        }],
      });
    });

    const localCodex = agentBoundary.byCommand.get("codex");
    expect(localCodex).toBeDefined();
    localCodex!.stdout.write(`${JSON.stringify({
      type: "item.completed",
      item: {
        id: "auth-summary",
        type: "agent_message",
        text: "Implemented the auth retry fix and validated it.",
      },
    })}\n`);
    localCodex!.stdout.write('{"type":"turn.completed","usage":{}}\n');
    localCodex!.finish(0);
    await eventually(async () => {
      expect((await store.read()).tasks[primary.id]).toMatchObject({
        status: "completed",
        stage: "done",
      });
    });

    await expect(battery.handleBatteryReading(simulatedBatteryReading({
      batteryPercent: 8,
      charging: false,
      powerSource: "battery",
      remainingMinutes: 24,
    }))).resolves.toBe(true);

    const outboundBeforeRetry = await readEvents(paths.events);
    expect(outboundBeforeRetry).toContainEqual(expect.objectContaining({
      type: "worker.command",
      taskId: cloudTask.id,
      payload: { name: FAILED_APPROACH, status: "failed" },
    }));
    expect(outboundBeforeRetry).toContainEqual(expect.objectContaining({
      type: "battery.low",
      payload: expect.objectContaining({
        percent: 8,
        simulated: true,
        activeLocalTasks: [cloudTask.title],
      }),
    }));
    expect((await repository.listSendblueOutbox()).some(
      ({ text }) => text.includes("8% (demo reading)"),
    )).toBe(true);
    const retriedEvents = outboundBeforeRetry.filter((event) =>
      (event.type === "task.created" || event.type === "message.sent") &&
      event.payload.conversationId === CONVERSATION_ID);
    expect(retriedEvents.filter(({ type }) => type === "task.created")).toHaveLength(2);
    const sendblueCountBeforeSyncRetry = (await repository.listSendblueOutbox()).length;
    const duplicateSync = await client.sync(createDexSyncPayload({ events: retriedEvents }));
    expect(duplicateSync.acceptedEventIds).toEqual(retriedEvents.map(({ id }) => id));
    expect((await repository.listSendblueOutbox())).toHaveLength(sendblueCountBeforeSyncRetry);
    expect(await repository.getTask(primary.id)).toMatchObject({ status: "queued" });
    expect(await repository.getTask(cloudTask.id)).toMatchObject({ status: "queued" });

    const moveReply = await orchestrator.handle([{
      type: "MOVE_TASK",
      taskQuery: cloudTask.title,
      destination: "cloud",
      preferredAgent: "codex",
    }], {
      conversationId: CONVERSATION_ID,
      messageId: "move-golden",
    });
    expect(moveReply).toContain("is being handed to codex in the cloud");
    expect(registration).toMatchObject({
      taskId: cloudTask.id,
      sandboxId: "sandbox-golden",
      resultPath: "/dex/result.json",
    });

    const handoff = modal.uploadedHandoff();
    expect(handoff).toBeDefined();
    const knownFailure = handoff!.failedApproaches.find(
      ({ approach }) => approach === FAILED_APPROACH,
    );
    expect(knownFailure).toMatchObject({
      approach: FAILED_APPROACH,
      reason: FAILED_REASON,
      doNotRepeat: true,
    });
    const knownFailureId = String(
      knownFailure!.sourceMemoryId ??
        `failed-${handoff!.failedApproaches.indexOf(knownFailure!) + 1}`,
    );
    expect(modal.acknowledgedContext()).toMatchObject({
      taskId: cloudTask.id,
      providerThreadId: "thread-modal-golden",
      loadedMemoryIds: handoff!.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: expect.arrayContaining([
        knownFailureId,
      ]),
    });
    state = await store.read();
    const modalWorker = Object.values(state.workers).find(
      (worker) => worker.taskId === cloudTask.id && worker.target.kind === "modal",
    );
    expect(modalWorker).toMatchObject({
      status: "running",
      providerSessionId: "thread-modal-golden",
      target: { kind: "modal", sandboxId: "sandbox-golden" },
    });
    expect(state.tasks[cloudTask.id]).toMatchObject({
      status: "running",
      metadata: {
        failedApproachCount: handoff!.failedApproaches.length,
        cloudMonitorAcknowledged: true,
      },
    });
    expect(state.tasks[primary.id]).toMatchObject({ status: "completed", stage: "done" });

    await expect(power.requestSleep("now", CONVERSATION_ID)).resolves.toBeUndefined();
    expect(powerCommands).toEqual(["/usr/bin/pmset sleepnow"]);
    expect((await store.read()).pendingMachineActions).toEqual([]);
    expect((await readEvents(paths.events))).toContainEqual(expect.objectContaining({
      type: "power.sleep_requested",
      payload: expect.objectContaining({ cloudTasks: [cloudTask.id] }),
    }));
    expect((await repository.listSendblueOutbox()).some(
      ({ text }) => text.includes("running in the cloud. sleeping this mac now"),
    )).toBe(true);

    const monitorEvents = (await readEvents(paths.events)).filter(
      ({ type }) => type === "modal.monitor.registered",
    );
    expect(monitorEvents).toHaveLength(1);
    expect(await repository.listPendingMonitorJobs(100)).toHaveLength(1);
    await client.sync(createDexSyncPayload({ events: monitorEvents }));
    await client.sync(createDexSyncPayload({ events: monitorEvents }));
    expect(await repository.listPendingMonitorJobs(100)).toHaveLength(1);

    const terminalArtifact = {
      taskId: cloudTask.id,
      handoffSha256: handoff!.contentHash,
      status: "succeeded" as const,
      summary: "Implemented atomic checkout retry completion.",
      validation: { commands: ["npm test"], passed: true },
      git: { branch: cloudTask.dexBranch, commit: "golden123" },
    };
    const terminalCallbacks: Array<{
      event: ModalTerminalEvent;
      result: Awaited<ReturnType<DexControlPlaneService["handleModalTerminal"]>>;
    }> = [];
    const monitor = new ModalMonitor({
      modal: modal.adapter,
      now: () => NOW + 1_000,
      schedule: async () => {
        throw new Error("A terminal sandbox must not be rescheduled");
      },
      readResult: async () => terminalArtifact,
      onTerminal: async (event) => {
        terminalCallbacks.push({
          event,
          result: await service.handleModalTerminal(event),
        });
      },
    });
    let dispatchedOutcome: ModalMonitorOutcome | undefined;
    const monitorOutbox = new MonitorJobOutbox({
      repository,
      dispatcher: {
        dispatch: async (job) => {
          dispatchedOutcome = await monitor.run(job.request);
        },
      },
    });
    await expect(monitorOutbox.dispatchPending()).resolves.toEqual({
      attempted: 1,
      dispatched: 1,
    });
    expect(dispatchedOutcome).toMatchObject({
      kind: "terminal",
      callbackInvoked: true,
      event: {
        taskId: cloudTask.id,
        status: "succeeded",
        reason: "result",
        result: terminalArtifact,
      },
    });
    expect(terminalCallbacks).toMatchObject([{
      result: { transitioned: true, completionEnqueued: true },
    }]);

    const terminalEvent = terminalCallbacks[0]!.event;
    const monitorRetries = await Promise.all([
      monitor.run(registration!),
      monitor.run(registration!),
      monitor.run(registration!),
    ]);
    expect(monitorRetries.every(
      (outcome) => outcome.kind === "terminal" && !outcome.callbackInvoked,
    )).toBe(true);
    expect(terminalCallbacks).toHaveLength(1);
    const callbackDeliveryRetries = await Promise.all([
      service.handleModalTerminal(terminalEvent),
      service.handleModalTerminal(terminalEvent),
      service.handleModalTerminal(terminalEvent),
    ]);
    expect(callbackDeliveryRetries).toEqual(Array.from({ length: 3 }, () =>
      expect.objectContaining({ transitioned: false, completionEnqueued: false })));

    expect(await repository.getTask(cloudTask.id)).toMatchObject({
      status: "succeeded",
      completionKey: `modal-monitor:${cloudTask.id}:terminal`,
      summary: terminalArtifact.summary,
    });
    const completionMessages = (await repository.listSendblueOutbox()).filter(
      ({ dedupeKey }) => dedupeKey === `modal-monitor:${cloudTask.id}:terminal`,
    );
    expect(completionMessages).toEqual([expect.objectContaining({
      taskId: cloudTask.id,
      conversationId: CONVERSATION_ID,
      toPhone: PHONE,
      text: expect.stringContaining(terminalArtifact.summary),
    })]);
    expect(await repository.listPendingDeviceCommands(paired.deviceId, 500)).toEqual([]);
    expect(agentBoundary.starts).toHaveLength(2);
    expect(modal.calls).not.toContain("terminate");
  }, 30_000);
});
