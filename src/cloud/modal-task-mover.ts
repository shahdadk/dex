import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskMover } from "../dex/orchestrator.js";
import type { EventLog } from "../state/events.js";
import { WorkerSessionSchema, type AgentKind, type DexTask } from "../state/schemas.js";
import type { DexStateStore } from "../state/store.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { createHandoff, writeHandoff } from "../tasks/handoff.js";
import { execFile } from "../utils/exec.js";
import { workerId } from "../utils/ids.js";
import { ModalAdapter } from "./modal/adapter.js";
import { ModalStartupAcknowledgementSchema, type ModalStartupAcknowledgement } from "./modal/schemas.js";
import type { TaskKnowledge } from "../memory/index.js";
import { acquireCodexAuthLease, DEFAULT_MODAL_CODEX_AUTH_VOLUME, releaseCodexAuthLease } from "../setup/modal-auth.js";

export interface ModalMonitorRegistration {
  taskId: string;
  workerId: string;
  sandboxId: string;
  handoffSha256: string;
  startedAt: string;
  resultPath: string;
}

export interface ModalTaskMoverOptions {
  store: DexStateStore;
  events: EventLog;
  tasks: TaskManager;
  handoffsRoot: string;
  modal?: ModalAdapter;
  modalSecretName?: string;
  codexAuthVolumeName?: string;
  codexAuthLeasePath?: string;
  signingKey?: string;
  workerScriptPath?: string;
  taskKnowledge?(taskId: string): TaskKnowledge | Promise<TaskKnowledge>;
  scheduleMonitor(registration: ModalMonitorRegistration): Promise<void>;
  startupTimeoutMs?: number;
}

export class ModalTaskMover implements TaskMover {
  readonly #options: ModalTaskMoverOptions;

  constructor(options: ModalTaskMoverOptions) {
    this.#options = options;
  }

  async moveToCloud(task: DexTask, preferredAgent: AgentKind = "codex"): Promise<void> {
    if (preferredAgent !== "codex") throw new Error("Dex P0 cloud continuation requires Codex");
    const signingKey = this.#options.signingKey ?? process.env.DEX_HANDOFF_SIGNING_KEY;
    if (!signingKey) throw new Error("DEX_HANDOFF_SIGNING_KEY is required for cloud handoff");
    const directory = path.join(this.#options.handoffsRoot, task.id);
    const bundlePath = path.join(directory, "repo.bundle");
    const handoffPath = path.join(directory, "handoff.json");
    const readyPath = path.join(directory, "ready");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#options.tasks.transition(task.id, "checkpointing", {
      stage: "checkpointing",
      latestSummary: "saving code, tests, and memory for cloud continuation",
    });
    await this.#options.events.append({ type: "handoff.started", taskId: task.id, payload: { source: "local", destination: "modal", agent: "codex" } });
    const baseCommitResult = await execFile("git", ["-C", task.worktreePath, "rev-parse", task.baseBranch]);
    if (baseCommitResult.exitCode !== 0) throw new Error(`Could not resolve handoff base commit: ${baseCommitResult.stderr}`);
    const validation = await validationCommands(task.worktreePath, task);
    const handoff = await createHandoff(
      {
        taskId: task.id,
        goal: task.originalRequest,
        constraints: [
          "Do not push, deploy, merge, or modify protected branches.",
          "Preserve inherited failures and validate the completed implementation.",
        ],
        acceptanceCriteria: [task.nextStep ?? "Complete the requested engineering outcome", "Report concrete validation evidence"],
        repository: {
          ...(task.repositoryRemote ? { url: task.repositoryRemote } : {}),
          path: task.worktreePath,
          baseCommit: baseCommitResult.stdout.trim(),
          workingBranch: task.dexBranch,
          project: path.basename(task.repositoryPath),
        },
        validation: {
          commands: validation,
          expectedEvidence: task.testStatus?.summary ? [task.testStatus.summary] : ["Relevant validation passes"],
        },
        taskKnowledge: taskKnowledge(task),
        metadata: { sourceWorkerId: task.currentWorkerId, destinationAgent: "codex", destination: "modal" },
      },
      {
        gitCheckpoint: {
          bundlePath,
          commitDirty: true,
          commitMessage: "dex: checkpoint before cloud handoff",
        },
        signingKey,
        signingKeyId: process.env.DEX_HANDOFF_KEY_ID ?? "dex-device",
        ...(this.#options.taskKnowledge
          ? { taskKnowledgeProvider: () => this.#options.taskKnowledge!(task.id) }
          : {}),
      },
    );
    await writeHandoff(handoffPath, handoff);
    await writeFile(readyPath, "ready\n", { mode: 0o600 });
    await this.#options.tasks.transition(task.id, "handoff", {
      stage: "handing_off",
      latestSummary: `${handoff.memories.length} memories and ${handoff.failedApproaches.length} failed approaches packaged`,
    });

    const modal = this.#options.modal ?? new ModalAdapter();
    const codexAuthVolumeName = this.#options.codexAuthVolumeName
      ?? process.env.DEX_MODAL_CODEX_AUTH_VOLUME ?? DEFAULT_MODAL_CODEX_AUTH_VOLUME;
    const leasePath = this.#options.codexAuthLeasePath ?? path.join(this.#options.handoffsRoot, ".codex-account-auth.lease");
    await acquireCodexAuthLease(leasePath, task.id);
    let sandbox: Awaited<ReturnType<ModalAdapter["create"]>> | undefined;
    try {
    sandbox = await modal.create({
      appName: "dex",
      image: "node:22-bookworm",
      imageCommands: [
        "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
        "RUN npm install --global @openai/codex@0.149.0",
      ],
      secretNames: [this.#options.modalSecretName ?? process.env.DEX_MODAL_SECRET_NAME ?? "dex-workers"],
      requiredSecretKeys: ["DEX_HANDOFF_SIGNING_KEY"],
      volumeNames: { "/codex-home": codexAuthVolumeName },
      params: {
        timeoutMs: 25 * 60_000,
        workdir: "/workspace",
        env: { CODEX_HOME: "/codex-home" },
        command: ["/bin/sh", "-c", "while [ ! -f /dex/ready ]; do sleep 0.2; done; exec node /dex/cloud-worker.js"],
        tags: { product: "dex", task: task.id },
      },
    });
    const workerScript = this.#options.workerScriptPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "cloud-worker.js");
    await sandbox.copyFromLocal(bundlePath, "/dex/repo.bundle");
    await sandbox.copyFromLocal(handoffPath, "/dex/handoff.json");
    await sandbox.copyFromLocal(workerScript, "/dex/cloud-worker.js");
    await sandbox.copyFromLocal(readyPath, "/dex/ready");

    const startup = await waitForStartup(sandbox, {
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      memoryIds: handoff.memories.map((memory) => String(memory.id)),
      failedApproachIds: handoff.failedApproaches.map((failure, index) => String(failure.sourceMemoryId ?? `failed-${index + 1}`)),
    }, this.#options.startupTimeoutMs ?? 60_000);
    const startedSandbox = sandbox;
    const id = workerId();
    const startedAt = startup.acknowledgedAt ?? new Date().toISOString();
    const worker = WorkerSessionSchema.parse({
      id,
      taskId: task.id,
      agent: "codex",
      target: { kind: "modal", sandboxId: sandbox.sandboxId },
      status: "running",
      providerSessionId: startup.providerThreadId,
      startedAt,
      lastMessage: `loaded ${startup.loadedMemoryIds.length} memories and ${startup.loadedFailedApproachIds.length} failed approaches`,
      lastEventAt: startedAt,
    });
    await this.#options.store.updateState((state) => {
      state.workers[id] = worker;
      const current = state.tasks[task.id];
      if (!current) throw new Error(`Task disappeared during handoff: ${task.id}`);
      current.currentWorkerId = id;
      current.workerHistory.push(id);
      current.updatedAt = new Date().toISOString();
      current.metadata.handoffHash = handoff.contentHash;
      current.metadata.memoryCount = startup.loadedMemoryIds.length;
      current.metadata.failedApproachCount = startup.loadedFailedApproachIds.length;
      current.metadata.sandboxId = startedSandbox.sandboxId;
    });
    await this.#options.scheduleMonitor({
      taskId: task.id,
      workerId: id,
      sandboxId: startedSandbox.sandboxId,
      handoffSha256: handoff.contentHash,
      startedAt,
      resultPath: "/dex/result.json",
    });
    await this.#options.tasks.transition(task.id, "running", {
      stage: "implementing",
      latestSummary: `codex is continuing in Modal with ${startup.loadedMemoryIds.length} inherited memories`,
    });
    await this.#options.events.append({
      type: "handoff.completed",
      taskId: task.id,
      workerId: id,
      payload: {
        source: "local",
        destination: "modal",
        sandboxId: startedSandbox.sandboxId,
        providerSessionId: startup.providerThreadId,
        handoffSha256: handoff.contentHash,
        loadedMemoryIds: startup.loadedMemoryIds,
        loadedFailedApproachIds: startup.loadedFailedApproachIds,
      },
    });
    await startedSandbox.detach();
    } catch (error) {
      await sandbox?.terminate().catch(() => undefined);
      await releaseCodexAuthLease(leasePath, task.id).catch(() => undefined);
      throw error;
    } finally {
      await modal.close();
    }
  }
}

interface ExpectedStartupContext {
  taskId: string;
  handoffSha256: string;
  memoryIds: string[];
  failedApproachIds: string[];
}

async function waitForStartup(
  sandbox: Awaited<ReturnType<ModalAdapter["create"]>>,
  expected: ExpectedStartupContext,
  timeoutMs: number,
): Promise<ModalStartupAcknowledgement> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const parsed = ModalStartupAcknowledgementSchema.parse(
        JSON.parse(await sandbox.raw.filesystem.readText("/dex/startup.json")),
      );
      if (parsed.taskId !== expected.taskId) throw new Error("Modal startup acknowledged the wrong task");
      if (parsed.handoffSha256 !== expected.handoffSha256) throw new Error("Modal startup acknowledged the wrong handoff hash");
      if (!sameIds(parsed.loadedMemoryIds, expected.memoryIds)) throw new Error("Modal startup did not load the exact memory package");
      if (!sameIds(parsed.loadedFailedApproachIds, expected.failedApproachIds)) throw new Error("Modal startup did not load the exact failed-approach package");
      return parsed;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await sandbox.terminate().catch(() => undefined);
  throw new Error("Timed out waiting for Codex/Modal startup acknowledgement", { cause: lastError });
}

function sameIds(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((value, index) => value === right[index]);
}

async function validationCommands(repositoryPath: string, task: DexTask): Promise<string[][]> {
  const configured = task.metadata.validationArgv;
  if (Array.isArray(configured) && configured.every((item) => Array.isArray(item) && item.every((part) => typeof part === "string"))) {
    return configured as string[][];
  }
  const packageCheck = await execFile("git", ["-C", repositoryPath, "ls-files", "--error-unmatch", "package.json"]);
  return packageCheck.exitCode === 0 ? [["npm", "test"]] : [];
}

function taskKnowledge(task: DexTask) {
  const stored = task.metadata.taskKnowledge;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored;
  return {
    learnedFacts: task.latestSummary ? [task.latestSummary] : [],
    failedApproaches: Array.isArray(task.metadata.failedApproaches) ? task.metadata.failedApproaches : [],
    nextSteps: task.nextStep ? [task.nextStep] : [],
    filesChanged: Array.isArray(task.metadata.filesTouched) ? task.metadata.filesTouched : [],
  };
}
