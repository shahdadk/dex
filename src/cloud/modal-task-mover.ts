import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskMover } from "../dex/orchestrator.js";
import {
  createGitCheckpoint,
  listTrackedFiles,
  readTrackedTextFilesAtRevision,
  resolveGitRevision,
  type TaskKnowledge,
} from "../memory/index.js";
import {
  acquireCodexAuthLease,
  isCodexAuthLeaseBusyError,
  releaseCodexAuthLease,
  type CodexAuthLeaseReleaseEvidence,
} from "../setup/modal-auth.js";
import { assertStrongRootHandoffKey } from "../setup/handoff-key.js";
import type { EventLog } from "../state/events.js";
import { WorkerSessionSchema, type AgentKind, type DexTask } from "../state/schemas.js";
import type { DexStateStore } from "../state/store.js";
import type { TaskManager } from "../tasks/task-manager.js";
import {
  assertValidHandoff,
  createHandoff,
  writeHandoff,
  type HandoffDocument,
} from "../tasks/handoff.js";
import { workerId } from "../utils/ids.js";
import { redactString } from "../utils/redact.js";
import { ModalAdapter } from "./modal/adapter.js";
import {
  ModalResultArtifactSchema,
  ModalStartupAcknowledgementSchema,
  type ModalStartupAcknowledgement,
} from "./modal/schemas.js";

export const MODAL_CODEX_WORKER_SANDBOX_NAME = "dex-codex-account-worker";
export const MODAL_HANDOFF_JOURNAL_KEY = "modalHandoffJournal";

const DEFAULT_RECOVERY_MAX_ATTEMPTS = 4;
const DEFAULT_RECOVERY_BACKOFF_MS = 1_000;
const MAX_RECOVERY_BACKOFF_MS = 30_000;
const DEFAULT_MODAL_STARTUP_TIMEOUT_MS = 3 * 60_000;
const HANDOFF_DERIVATION_DOMAIN = "dex-handoff-v1";
const MAX_REPOSITORY_INSTRUCTION_FILES = 32;
const MAX_REPOSITORY_INSTRUCTION_FILE_BYTES = 64 * 1024;
const MAX_REPOSITORY_INSTRUCTION_TOTAL_BYTES = 128 * 1024;
const MAX_HANDOFF_KEY_INSTALL_ERROR_BYTES = 2_000;
const INSTALL_HANDOFF_KEY_SCRIPT = String.raw`
const {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { randomUUID } = require("node:crypto");
const target = "/dex/handoff.key";
const temporary = target + ".tmp-" + process.pid + "-" + randomUUID();
let descriptor;
let key;
(async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new Error("Dex handoff key exceeds the secure installer limit");
    chunks.push(bytes);
  }
  key = Buffer.concat(chunks);
  if (key.length < 16) throw new Error("Dex handoff key is too short");
  descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
    0o600,
  );
  writeFileSync(descriptor, key);
  fsyncSync(descriptor);
  closeSync(descriptor);
  descriptor = undefined;
  const before = lstatSync(temporary);
  if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) {
    throw new Error("Dex handoff key temporary file failed security validation");
  }
  renameSync(temporary, target);
  const after = lstatSync(target);
  if (!after.isFile() || after.nlink !== 1 || (after.mode & 0o777) !== 0o600) {
    throw new Error("Dex handoff key failed post-rename security validation");
  }
})().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => {
  if (key) key.fill(0);
  if (descriptor !== undefined) {
    try { closeSync(descriptor); } catch {}
  }
  try { unlinkSync(temporary); } catch {}
});
`;
const MODAL_WORKER_OUTBOUND_DOMAINS = [
  "openai.com",
  "*.openai.com",
  "chatgpt.com",
  "*.chatgpt.com",
  "oaistatic.com",
  "*.oaistatic.com",
  "oaiusercontent.com",
  "*.oaiusercontent.com",
  "registry.npmjs.org",
] as const;

type ModalSandbox = Awaited<ReturnType<ModalAdapter["fromId"]>>;

export interface ModalMonitorRegistration {
  taskId: string;
  workerId: string;
  sandboxId: string;
  handoffSha256: string;
  startedAt: string;
  resultPath: string;
}

export type ModalHandoffJournalPhase =
  | "prepared"
  | "sandbox_created"
  | "artifacts_uploaded"
  | "ready_sent"
  | "startup_acknowledged"
  // Accepted for recovery compatibility with the earlier journal ordering.
  | "monitor_scheduled"
  | "completed"
  | "stopped"
  | "failed";

export interface ModalHandoffJournal {
  version: 1;
  phase: ModalHandoffJournalPhase;
  workerId: string;
  handoffSha256: string;
  operationToken?: string;
  startedAt: string;
  updatedAt: string;
  monitorRegistration?: ModalMonitorRegistration;
  startupAcknowledgedAt?: string;
  monitorScheduledAt?: string;
  finalizedAt?: string;
  failure?: string;
  cleanupPending?: boolean;
  terminalEvidence?: CodexAuthLeaseReleaseEvidence;
  recoveryAttempts?: number;
  nextRecoveryAt?: string;
  lastRecoveryError?: string;
}

export interface ModalTaskMoverOptions {
  store: DexStateStore;
  events: EventLog;
  tasks: TaskManager;
  handoffsRoot: string;
  modal?: ModalAdapter;
  codexAuthVolumeName?: string;
  codexAuthLeasePath?: string;
  signingKey?: string;
  workerScriptPath?: string;
  taskKnowledge?(taskId: string): TaskKnowledge | Promise<TaskKnowledge>;
  scheduleMonitor(registration: ModalMonitorRegistration): Promise<void>;
  startupTimeoutMs?: number;
  recoveryMaxAttempts?: number;
  recoveryBackoffMs?: number;
  sleep?(milliseconds: number): Promise<void>;
  releaseCodexAuthLease?(
    leasePath: string,
    taskId: string,
    evidence: CodexAuthLeaseReleaseEvidence,
  ): Promise<boolean>;
}

export class ModalTaskMover implements TaskMover {
  readonly #options: ModalTaskMoverOptions;

  constructor(options: ModalTaskMoverOptions) {
    this.#options = options;
  }

  /**
   * Reconnects the exact persisted operation. Monitoring is not republished
   * until the signed local package and the Sandbox startup acknowledgement
   * have both been revalidated.
   */
  async recoverInterruptedHandoff(task: DexTask): Promise<boolean> {
    const modal = this.#options.modal ?? new ModalAdapter();
    try {
      for (;;) {
        const state = await this.#options.store.read();
        const current = state.tasks[task.id];
        if (!current) throw new Error(`Task disappeared before Modal handoff recovery: ${task.id}`);
        const journal = modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
        if (!journal) {
          await this.#markRecoveryFailed(
            task.id,
            undefined,
            "cloud handoff was interrupted before durable Modal operation metadata was recorded",
            modal,
          );
          return true;
        }
        if (journal.phase === "stopped" || journal.phase === "failed") {
          if (!journal.cleanupPending) return true;
          try {
            return await this.#recoverPendingCleanup(task.id, journal, modal);
          } catch (error) {
            if (isCodexAuthLeaseBusyError(error)) return false;
            await this.#recordPendingCleanupFailure(task.id, journal, errorMessage(error));
            return false;
          }
        }

        const retryAt = journal.nextRecoveryAt ? Date.parse(journal.nextRecoveryAt) : Number.NaN;
        if (Number.isFinite(retryAt) && retryAt > Date.now()) {
          await this.#sleep(retryAt - Date.now());
        }

        try {
          await this.#recoverOnce(task.id, journal, modal);
          return true;
        } catch (error) {
          if (isCodexAuthLeaseBusyError(error)) return false;
          const message = errorMessage(error);
          const recorded = await this.#recordRecoveryFailure(task.id, journal, message);
          if (recorded.attempt >= this.#recoveryMaxAttempts()) {
            return await this.#markRecoveryFailed(
              task.id,
              recorded.journal,
              `Modal handoff recovery exhausted ${recorded.attempt} attempts: ${message}`,
              modal,
            );
          }
          await this.#sleep(recorded.delayMs);
        }
      }
    } finally {
      await modal.close();
    }
  }

  async stopCloudTask(task: DexTask, expectedWorkerId?: string): Promise<boolean> {
    const state = await this.#options.store.read();
    const current = state.tasks[task.id];
    if (!current) return false;
    const ownedWorkerId = expectedWorkerId ?? current.currentWorkerId;
    if (!ownedWorkerId || current.currentWorkerId !== ownedWorkerId) return false;
    const worker = state.workers[ownedWorkerId];
    if (
      !worker ||
      worker.taskId !== task.id ||
      worker.target.kind !== "modal" ||
      !worker.target.sandboxId
    ) {
      return false;
    }
    const sandboxId = worker.target.sandboxId;
    const journal = modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
    if (
      !journal ||
      journal.workerId !== ownedWorkerId ||
      journal.monitorRegistration?.sandboxId !== sandboxId
    ) {
      return false;
    }

    const modal = this.#options.modal ?? new ModalAdapter();
    try {
      const sandbox = await modal.fromId(sandboxId);
      const fence = await this.#options.store.read();
      const fencedTask = fence.tasks[task.id];
      const fencedWorker = fence.workers[ownedWorkerId];
      if (
        fencedTask?.currentWorkerId !== ownedWorkerId ||
        fencedWorker?.target.kind !== "modal" ||
        fencedWorker.target.sandboxId !== sandboxId ||
        fencedTask.metadata.sandboxId !== sandboxId
      ) {
        await Promise.resolve(sandbox.detach()).catch(() => undefined);
        return false;
      }

      // Persist cancellation intent before touching Modal. If termination
      // succeeds and this daemon crashes before recording evidence, startup
      // recovery will see cleanupPending and re-establish terminal proof
      // before releasing the shared account-auth lease.
      await this.#markStopped(
        task.id,
        journal,
        "stop requested by the orchestrator",
        true,
      );
      const evidence = await terminalizeSandbox(
        sandbox,
        journalOperationToken(journal),
      );
      await this.#markStopped(
        task.id,
        journal,
        "stopped at the orchestrator's request",
        true,
        evidence,
      );
      await this.#releaseLease(task.id, evidence);
      await this.#markStopped(
        task.id,
        journal,
        "stopped at the orchestrator's request",
        false,
        evidence,
      );
      return true;
    } finally {
      await modal.close();
    }
  }

  async moveToCloud(
    task: DexTask,
    preferredAgent: AgentKind = "codex",
    signal?: AbortSignal,
  ): Promise<void> {
    if (preferredAgent !== "codex") throw new Error("Dex P0 cloud continuation requires Codex");
    const codexAuthVolumeName = this.#codexAuthVolumeName();
    const rootSigningKey = this.#rootSigningKey();
    throwIfAborted(signal);

    const directory = path.join(this.#options.handoffsRoot, task.id);
    const bundlePath = path.join(directory, "repo.bundle");
    const handoffPath = path.join(directory, "handoff.json");
    const readyPath = path.join(directory, "ready");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#options.store.updateState((state) => {
      const current = state.tasks[task.id];
      if (!current) throw new Error(`Task disappeared before cloud handoff: ${task.id}`);
      clearFinishedCloudRunMetadata(current);
      current.metadata.cloudMonitorAcknowledged = false;
      delete current.metadata.cloudFailure;
      delete current.metadata.reconciledAt;
      delete current.metadata.sandboxId;
      delete current.metadata.handoffHash;
      delete current.metadata.memoryCount;
      delete current.metadata.failedApproachCount;
      current.updatedAt = new Date().toISOString();
    });
    throwIfAborted(signal);

    await this.#options.tasks.transition(task.id, "checkpointing", {
      stage: "checkpointing",
      latestSummary: "saving code, tests, and memory for cloud continuation",
    });
    throwIfAborted(signal);
    await this.#options.events.append({
      type: "handoff.started",
      taskId: task.id,
      payload: { source: "local", destination: "modal", agent: "codex" },
    });

    const baseCommit = await resolveGitRevision({
      repositoryPath: task.worktreePath,
      revision: task.baseBranch,
    });
    const validation = await validationCommands(task.worktreePath, task);
    const checkpoint = await createGitCheckpoint({
      repositoryPath: task.worktreePath,
      bundlePath,
      baseCommit,
      branch: task.dexBranch,
      commitDirty: true,
      commitMessage: "dex: checkpoint before cloud handoff",
    });
    const repositoryInstructions = await repositoryInstructionConstraints(
      task.worktreePath,
      checkpoint.headCommit,
    );
    const handoffCreatedAt = new Date().toISOString();
    const handoffSigningKey = deriveHandoffSigningKey(
      rootSigningKey,
      task.id,
      handoffCreatedAt,
    );
    const handoff = await createHandoff(
      {
        taskId: task.id,
        createdAt: handoffCreatedAt,
        goal: task.originalRequest,
        constraints: [
          "Do not push, deploy, merge, or modify protected branches.",
          "Preserve inherited failures and validate the completed implementation.",
          ...repositoryInstructions,
        ],
        acceptanceCriteria: [
          task.nextStep ?? "Complete the requested engineering outcome",
          "Report concrete validation evidence",
        ],
        repository: {
          ...(task.repositoryRemote ? { url: task.repositoryRemote } : {}),
          path: task.worktreePath,
          baseCommit,
          workingBranch: task.dexBranch,
          checkpoint,
          project: path.basename(task.repositoryPath),
        },
        validation: {
          commands: validation,
          expectedEvidence: task.testStatus?.summary
            ? [task.testStatus.summary]
            : ["Relevant validation passes"],
        },
        taskKnowledge: taskKnowledge(task),
        metadata: {
          sourceWorkerId: task.currentWorkerId,
          destinationAgent: "codex",
          destination: "modal",
        },
      },
      {
        signingKey: handoffSigningKey,
        signingKeyId: process.env.DEX_HANDOFF_KEY_ID ?? "dex-device",
        ...(this.#options.taskKnowledge
          ? { taskKnowledgeProvider: () => this.#options.taskKnowledge!(task.id) }
          : {}),
      },
    );
    await writeHandoff(handoffPath, handoff);
    await writeFile(readyPath, "ready\n", { mode: 0o600 });
    throwIfAborted(signal);
    await this.#options.tasks.transition(task.id, "handoff", {
      stage: "handing_off",
      latestSummary: `${handoff.memories.length} memories and ${handoff.failedApproaches.length} failed approaches packaged`,
    });
    throwIfAborted(signal);

    const modal = this.#options.modal ?? new ModalAdapter();
    const cloudWorkerId = workerId();
    const handoffStartedAt = new Date().toISOString();
    const operationToken = modalOperationToken(task.id, cloudWorkerId, handoff.contentHash);
    const preparedJournal: ModalHandoffJournal = {
      version: 1,
      phase: "prepared",
      workerId: cloudWorkerId,
      handoffSha256: handoff.contentHash,
      operationToken,
      startedAt: handoffStartedAt,
      updatedAt: handoffStartedAt,
    };
    let sandbox: ModalSandbox | undefined;
    let leaseAcquired = false;
    let sandboxCreationAttempted = false;

    try {
      await this.#options.store.updateState((state) => {
        const current = state.tasks[task.id];
        if (!current) throw new Error(`Task disappeared before Modal Sandbox creation: ${task.id}`);
        current.metadata[MODAL_HANDOFF_JOURNAL_KEY] = preparedJournal;
        current.updatedAt = handoffStartedAt;
      });
      throwIfAborted(signal);

      await acquireCodexAuthLease(this.#leasePath(), task.id, {
        workerId: cloudWorkerId,
        operationToken,
      });
      leaseAcquired = true;
      throwIfAborted(signal);

      try {
        sandboxCreationAttempted = true;
        sandbox = await modal.create({
          appName: "dex",
          image: "node:22-bookworm",
          imageCommands: [
            "RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
            "RUN npm install --global @openai/codex@0.149.1",
          ],
          volumeNames: {
            "/codex-home": codexAuthVolumeName,
          },
          params: {
            // Modal supports a maximum 24-hour Sandbox lifetime. Keep the
            // completed result filesystem alive for the rest of that window
            // so a sleeping Mac can reconnect and import result.bundle.
            timeoutMs: 24 * 60 * 60_000,
            workdir: "/workspace",
            env: { CODEX_HOME: "/codex-home" },
            outboundDomainAllowlist: [...MODAL_WORKER_OUTBOUND_DOMAINS],
            name: modalSandboxName(operationToken),
            command: [
              "/bin/sh",
              "-c",
              "while [ ! -f /dex/ready ]; do sleep 0.2; done; node /dex/cloud-worker.js; status=$?; if [ -f /dex/result.json ]; then while :; do sleep 3600; done; fi; exit $status",
            ],
            tags: modalOperationTags(task.id, handoff.contentHash, operationToken),
          },
        });
      } catch (createError) {
        const discovered = await this.#discoverOperationSandboxes(
          modal,
          task.id,
          handoff.contentHash,
          operationToken,
        ).catch(() => []);
        if (discovered.length !== 1) throw createError;
        sandbox = await modal.fromId(discovered[0]!);
      }

      const registration = await this.#persistSandboxCreated(
        task.id,
        preparedJournal,
        sandbox.sandboxId,
      );
      throwIfAborted(signal);

      await this.#copyHandoffArtifacts(sandbox, task.id, false);
      await this.#setJournalPhase(task.id, registration, "artifacts_uploaded");
      throwIfAborted(signal);

      await this.#copyHandoffArtifacts(sandbox, task.id, true, true);
      await this.#setJournalPhase(task.id, registration, "ready_sent");
      throwIfAborted(signal);

      const startup = await waitForStartup(
        sandbox,
        expectedStartup(handoff),
        this.#options.startupTimeoutMs ?? DEFAULT_MODAL_STARTUP_TIMEOUT_MS,
        signal,
      );
      await this.#persistStartupAcknowledgement(task.id, registration, startup);
      throwIfAborted(signal);

      await this.#options.scheduleMonitor(registration);
      await this.#persistCompleted(task.id, registration);
      throwIfAborted(signal);

      const latest = (await this.#options.store.read()).tasks[task.id];
      if (latest?.status === "checkpointing" || latest?.status === "handoff") {
        await this.#options.tasks.transitionIfCurrentWorker(
          task.id,
          cloudWorkerId,
          "running",
          {
            stage: "implementing",
            latestSummary: `codex is continuing in Modal with ${startup.loadedMemoryIds.length} inherited memories`,
          },
        );
      }
      throwIfAborted(signal);

      await this.#options.events.append({
        type: "handoff.completed",
        taskId: task.id,
        workerId: cloudWorkerId,
        payload: {
          source: "local",
          destination: "modal",
          sandboxId: sandbox.sandboxId,
          providerSessionId: startup.providerThreadId,
          handoffSha256: handoff.contentHash,
          loadedMemoryIds: startup.loadedMemoryIds,
          loadedFailedApproachIds: startup.loadedFailedApproachIds,
        },
      });
      await sandbox.detach();
    } catch (error) {
      if (isCodexAuthLeaseBusyError(error)) {
        await this.#restoreAfterLeaseBusy(task, preparedJournal);
        throw error;
      }

      const latestJournal = await this.#currentJournal(task.id, operationToken);
      if (isAbortError(error) || signal?.aborted) {
        const abort = abortError();
        if (latestJournal) {
          if (leaseAcquired) {
            const cleanup = await this.#cleanupOperation(
              task.id,
              latestJournal,
              modal,
              sandbox,
              { sandboxCreationDefinitelyNotAttempted: !sandboxCreationAttempted },
            );
            if (cleanup.evidence) {
              await this.#markStopped(
                task.id,
                latestJournal,
                abort.message,
                true,
                cleanup.evidence,
              );
              await this.#releaseLease(task.id, cleanup.evidence);
              await this.#markStopped(
                task.id,
                latestJournal,
                abort.message,
                false,
                cleanup.evidence,
              );
            } else {
              await this.#markFailureState(
                task.id,
                latestJournal,
                `${abort.message}; terminal cleanup failed: ${cleanup.error ?? "unknown cleanup error"}`,
                true,
              );
            }
          } else {
            await this.#markStopped(task.id, latestJournal, abort.message, false);
          }
        }
        throw abort;
      }

      const message = errorMessage(error);
      if (!sandbox) {
        if (latestJournal) {
          await this.#recordRecoveryFailure(task.id, latestJournal, message);
        }
        throw error;
      }

      const cleanup = latestJournal
        ? await this.#cleanupOperation(task.id, latestJournal, modal, sandbox)
        : { error: "Modal handoff journal disappeared before cleanup" };
      if (latestJournal) {
        await this.#markFailureState(
          task.id,
          latestJournal,
          cleanup.error ? `${message}; terminal cleanup failed: ${cleanup.error}` : message,
          true,
          cleanup.evidence,
        );
        if (cleanup.evidence) {
          await this.#releaseLease(task.id, cleanup.evidence);
          await this.#markFailureState(
            task.id,
            latestJournal,
            message,
            false,
            cleanup.evidence,
          );
        }
      }
      throw error;
    } finally {
      await modal.close();
    }
  }

  async #recoverOnce(
    taskId: string,
    originalJournal: ModalHandoffJournal,
    modal: ModalAdapter,
  ): Promise<void> {
    let journal = originalJournal;
    const handoff = await this.#readExactHandoff(taskId, journal);
    const operationToken = journalOperationToken(journal);
    await acquireCodexAuthLease(this.#leasePath(), taskId, {
      workerId: journal.workerId,
      operationToken,
      adoptExisting: true,
    });

    let sandbox: ModalSandbox | undefined;
    try {
      if (!journal.monitorRegistration) {
        const discovered = await this.#discoverOperationSandboxes(
          modal,
          taskId,
          journal.handoffSha256,
          operationToken,
        );
        if (discovered.length === 0) {
          throw new Error("The journaled Modal Sandbox is not visible by its exact operation tag");
        }
        if (discovered.length > 1) {
          throw new Error("Multiple Modal Sandboxes matched one exact operation token");
        }
        sandbox = await modal.fromId(discovered[0]!);
        await this.#persistSandboxCreated(taskId, journal, sandbox.sandboxId);
        journal = await this.#requireCurrentJournal(taskId, operationToken);
      } else {
        this.#assertJournalOwnership(taskId, journal);
        sandbox = await modal.fromId(journal.monitorRegistration.sandboxId);
      }

      const registration = journal.monitorRegistration;
      if (!registration) throw new Error("Recovered Modal Sandbox ownership was not persisted");
      await this.#clearMonitorOwnership(taskId, journal);

      if (journal.phase === "sandbox_created") {
        await this.#copyHandoffArtifacts(sandbox, taskId, false);
        await this.#setJournalPhase(taskId, registration, "artifacts_uploaded");
        journal = await this.#requireCurrentJournal(taskId, operationToken);
      }
      if (journal.phase === "artifacts_uploaded" || journal.phase === "monitor_scheduled") {
        await this.#copyHandoffArtifacts(sandbox, taskId, true, true);
        await this.#setJournalPhase(taskId, registration, "ready_sent");
      }

      const startup = await waitForStartup(
        sandbox,
        expectedStartup(handoff),
        this.#options.startupTimeoutMs ?? DEFAULT_MODAL_STARTUP_TIMEOUT_MS,
      );
      await this.#persistStartupAcknowledgement(taskId, registration, startup);
      await this.#options.scheduleMonitor(registration);
      await this.#persistCompleted(taskId, registration);

      const latest = (await this.#options.store.read()).tasks[taskId];
      if (latest?.status === "checkpointing" || latest?.status === "handoff") {
        await this.#options.tasks.transitionIfCurrentWorker(
          taskId,
          journal.workerId,
          "running",
          {
            stage: "implementing",
            latestSummary:
              "codex is continuing in Modal; exact startup and monitoring ownership were restored",
          },
        );
      }
    } finally {
      if (sandbox) {
        await Promise.resolve(sandbox.detach()).catch(() => undefined);
      }
    }
  }

  async #readExactHandoff(
    taskId: string,
    journal: ModalHandoffJournal,
  ): Promise<HandoffDocument> {
    const { handoff } = await this.#readHandoffPackage(taskId);
    if (handoff.contentHash !== journal.handoffSha256) {
      throw new Error("Recovered handoff does not match the journaled content hash");
    }
    return handoff;
  }

  async #readHandoffPackage(
    taskId: string,
  ): Promise<{ handoff: HandoffDocument; signingKey: string }> {
    const rootSigningKey = this.#rootSigningKey();
    const directory = path.join(this.#options.handoffsRoot, taskId);
    const handoffPath = path.join(directory, "handoff.json");
    let candidate: unknown;
    try {
      candidate = JSON.parse(await readFile(handoffPath, "utf8"));
    } catch (error) {
      throw new Error("Could not parse the local Modal handoff package", { cause: error });
    }
    const handoff = handoffSigningEnvelope(candidate, taskId);
    const signingKey = deriveHandoffSigningKey(
      rootSigningKey,
      handoff.taskId,
      handoff.createdAt,
    );
    await assertValidHandoff(handoff, signingKey);

    const artifact = handoff.integrity.artifacts.find(
      (entry) => entry.path === "repo.bundle",
    );
    if (!artifact) throw new Error("Recovered handoff manifest does not contain repo.bundle");
    const bundle = await readFile(path.join(directory, "repo.bundle"));
    if (sha256(bundle) !== artifact.sha256) {
      throw new Error("Recovered repo.bundle does not match the signed handoff package");
    }
    return { handoff, signingKey };
  }

  async #persistSandboxCreated(
    taskId: string,
    journal: ModalHandoffJournal,
    sandboxId: string,
  ): Promise<ModalMonitorRegistration> {
    const registration: ModalMonitorRegistration = {
      taskId,
      workerId: journal.workerId,
      sandboxId,
      handoffSha256: journal.handoffSha256,
      startedAt: journal.startedAt,
      resultPath: "/dex/result.json",
    };
    const startingWorker = WorkerSessionSchema.parse({
      id: journal.workerId,
      taskId,
      agent: "codex",
      target: { kind: "modal", sandboxId },
      status: "starting",
      startedAt: journal.startedAt,
      lastMessage: "Modal Sandbox created; waiting for exact startup acknowledgement",
      lastEventAt: journal.startedAt,
    });
    const updatedAt = new Date().toISOString();
    const operationToken = journalOperationToken(journal);
    await this.#options.store.updateState((state) => {
      const current = state.tasks[taskId];
      if (!current) throw new Error(`Task disappeared after Modal Sandbox creation: ${taskId}`);
      const persisted = modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!persisted || journalOperationToken(persisted) !== operationToken) {
        throw new Error(`Modal operation changed before Sandbox ownership was persisted: ${taskId}`);
      }
      const existingWorker = state.workers[journal.workerId];
      if (
        current.currentWorkerId !== journal.workerId &&
        current.status !== "checkpointing" &&
        current.status !== "handoff"
      ) {
        throw new Error(`A newer worker owns the task before Modal Sandbox adoption: ${taskId}`);
      }
      if (
        existingWorker &&
        (existingWorker.target.kind !== "modal" ||
          existingWorker.target.sandboxId !== sandboxId)
      ) {
        throw new Error(`Cloud worker ID already belongs to another Sandbox: ${journal.workerId}`);
      }
      state.workers[journal.workerId] = existingWorker ?? startingWorker;
      current.currentWorkerId = journal.workerId;
      if (!current.workerHistory.includes(journal.workerId)) {
        current.workerHistory.push(journal.workerId);
      }
      current.metadata.handoffHash = journal.handoffSha256;
      current.metadata.sandboxId = sandboxId;
      current.metadata[MODAL_HANDOFF_JOURNAL_KEY] = {
        ...persisted,
        operationToken,
        phase: "sandbox_created",
        monitorRegistration: registration,
        updatedAt,
      } satisfies ModalHandoffJournal;
      current.updatedAt = updatedAt;
    });
    return registration;
  }

  async #persistStartupAcknowledgement(
    taskId: string,
    registration: ModalMonitorRegistration,
    startup: ModalStartupAcknowledgement,
  ): Promise<void> {
    const acknowledgedAt = startup.acknowledgedAt ?? new Date().toISOString();
    await this.#options.store.updateState((state) => {
      const current = state.tasks[taskId];
      const worker = state.workers[registration.workerId];
      if (!current || current.currentWorkerId !== registration.workerId) {
        throw new Error(`Modal task ownership changed before startup acknowledgement: ${taskId}`);
      }
      if (
        !worker ||
        worker.target.kind !== "modal" ||
        worker.target.sandboxId !== registration.sandboxId
      ) {
        throw new Error(`Modal worker ownership changed before startup acknowledgement: ${registration.workerId}`);
      }
      const journal = modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || !sameMonitorRegistration(journal.monitorRegistration, registration)) {
        throw new Error(`Modal handoff changed during startup: ${taskId}`);
      }
      worker.status = "running";
      worker.providerSessionId = startup.providerThreadId;
      worker.lastMessage =
        `loaded ${startup.loadedMemoryIds.length} memories and ${startup.loadedFailedApproachIds.length} failed approaches`;
      worker.lastEventAt = acknowledgedAt;
      current.metadata.memoryCount = startup.loadedMemoryIds.length;
      current.metadata.failedApproachCount = startup.loadedFailedApproachIds.length;
      const {
        nextRecoveryAt: _nextRecoveryAt,
        lastRecoveryError: _lastRecoveryError,
        ...stableJournal
      } = journal;
      current.metadata[MODAL_HANDOFF_JOURNAL_KEY] = {
        ...stableJournal,
        phase: "startup_acknowledged",
        startupAcknowledgedAt: acknowledgedAt,
        updatedAt: acknowledgedAt,
        recoveryAttempts: 0,
      } satisfies ModalHandoffJournal;
      current.updatedAt = acknowledgedAt;
    });
  }

  async #persistCompleted(
    taskId: string,
    registration: ModalMonitorRegistration,
  ): Promise<void> {
    const finalizedAt = new Date().toISOString();
    await this.#options.store.updateState((state) => {
      const current = state.tasks[taskId];
      if (!current || current.currentWorkerId !== registration.workerId) {
        throw new Error(`Modal task ownership changed while completing handoff: ${taskId}`);
      }
      const journal = modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || !sameMonitorRegistration(journal.monitorRegistration, registration)) {
        throw new Error(`Modal handoff changed while completing: ${taskId}`);
      }
      const {
        nextRecoveryAt: _nextRecoveryAt,
        lastRecoveryError: _lastRecoveryError,
        ...stableJournal
      } = journal;
      current.metadata[MODAL_HANDOFF_JOURNAL_KEY] = {
        ...stableJournal,
        phase: "completed",
        monitorScheduledAt: finalizedAt,
        finalizedAt,
        updatedAt: finalizedAt,
        recoveryAttempts: 0,
      } satisfies ModalHandoffJournal;
      current.updatedAt = finalizedAt;
    });
  }

  async #setJournalPhase(
    taskId: string,
    registration: ModalMonitorRegistration,
    phase: ModalHandoffJournalPhase,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.#options.store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task || task.currentWorkerId !== registration.workerId) {
        throw new Error(`Task ownership changed while advancing Modal handoff: ${taskId}`);
      }
      const journal = modalHandoffJournal(task.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || !sameMonitorRegistration(journal.monitorRegistration, registration)) {
        throw new Error(`Modal handoff changed while advancing: ${taskId}`);
      }
      task.metadata[MODAL_HANDOFF_JOURNAL_KEY] = {
        ...journal,
        phase,
        updatedAt,
      } satisfies ModalHandoffJournal;
      task.updatedAt = updatedAt;
    });
  }

  async #copyHandoffArtifacts(
    sandbox: ModalSandbox,
    taskId: string,
    includeReady: boolean,
    readyOnly = false,
  ): Promise<void> {
    const directory = path.join(this.#options.handoffsRoot, taskId);
    if (!readyOnly) {
      const { signingKey } = await this.#readHandoffPackage(taskId);
      const workerScript =
        this.#options.workerScriptPath ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), "cloud-worker.js");
      await sandbox.copyFromLocal(path.join(directory, "repo.bundle"), "/dex/repo.bundle");
      await sandbox.copyFromLocal(path.join(directory, "handoff.json"), "/dex/handoff.json");
      await sandbox.copyFromLocal(workerScript, "/dex/cloud-worker.js");
      await installScopedHandoffKey(sandbox, signingKey);
    }
    if (includeReady) {
      await sandbox.copyFromLocal(path.join(directory, "ready"), "/dex/ready");
    }
  }

  async #discoverOperationSandboxes(
    modal: ModalAdapter,
    taskId: string,
    handoffSha256: string,
    operationToken: string,
  ): Promise<string[]> {
    const client = await modal.client();
    const service = client.sandboxes as typeof client.sandboxes & {
      list?: (params: {
        tags: Record<string, string>;
      }) => AsyncIterable<{ sandboxId: string }>;
    };
    if (typeof service.list !== "function") {
      throw new Error(
        "The installed Modal SDK cannot discover Sandboxes by operation tag; the auth lease was retained for safe manual cleanup",
      );
    }
    const ids: string[] = [];
    for await (const sandbox of service.list({
      tags: modalOperationTags(taskId, handoffSha256, operationToken),
    })) {
      if (typeof sandbox.sandboxId === "string" && sandbox.sandboxId) {
        ids.push(sandbox.sandboxId);
      }
      if (ids.length >= 100) {
        throw new Error("Too many Modal Sandboxes matched one operation token");
      }
    }
    return [...new Set(ids)];
  }

  async #clearMonitorOwnership(
    taskId: string,
    journal: ModalHandoffJournal,
  ): Promise<void> {
    const operationToken = journalOperationToken(journal);
    await this.#options.store.updateState((state) => {
      const current = state.tasks[taskId];
      const persisted = current
        ? modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY])
        : undefined;
      if (!current || !persisted || journalOperationToken(persisted) !== operationToken) {
        throw new Error(`Modal handoff changed before monitor recovery: ${taskId}`);
      }
      const registration = persisted.monitorRegistration;
      const worker = state.workers[persisted.workerId];
      if (
        !registration ||
        current.currentWorkerId !== persisted.workerId ||
        !worker ||
        worker.target.kind !== "modal" ||
        worker.target.sandboxId !== registration.sandboxId ||
        !["starting", "running", "waiting"].includes(worker.status)
      ) {
        throw new Error(`A newer worker owns the task before Modal monitor recovery: ${taskId}`);
      }
      current.metadata.cloudMonitorAcknowledged = false;
      current.updatedAt = new Date().toISOString();
    });
  }

  #assertJournalOwnership(taskId: string, journal: ModalHandoffJournal): void {
    const registration = journal.monitorRegistration;
    if (
      !registration ||
      registration.taskId !== taskId ||
      registration.workerId !== journal.workerId ||
      registration.handoffSha256 !== journal.handoffSha256 ||
      registration.startedAt !== journal.startedAt ||
      registration.resultPath !== "/dex/result.json"
    ) {
      throw new Error("Modal handoff ownership metadata is internally inconsistent");
    }
  }

  async #recordRecoveryFailure(
    taskId: string,
    expectedJournal: ModalHandoffJournal,
    message: string,
  ): Promise<{ attempt: number; delayMs: number; journal: ModalHandoffJournal }> {
    const operationToken = journalOperationToken(expectedJournal);
    let recorded: ModalHandoffJournal | undefined;
    let delayMs = 0;
    await this.#options.store.updateState((state) => {
      const current = state.tasks[taskId];
      if (!current) throw new Error(`Task disappeared while recording Modal recovery: ${taskId}`);
      const journal = modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || journalOperationToken(journal) !== operationToken) {
        throw new Error(`Modal operation changed while recording recovery: ${taskId}`);
      }
      const attempt = (journal.recoveryAttempts ?? 0) + 1;
      delayMs = Math.min(
        this.#recoveryBackoffMs() * 2 ** Math.max(0, attempt - 1),
        MAX_RECOVERY_BACKOFF_MS,
      );
      const updatedAt = new Date().toISOString();
      recorded = {
        ...journal,
        operationToken,
        recoveryAttempts: attempt,
        nextRecoveryAt: new Date(Date.now() + delayMs).toISOString(),
        lastRecoveryError: message,
        updatedAt,
      };
      current.metadata[MODAL_HANDOFF_JOURNAL_KEY] = recorded;
      current.updatedAt = updatedAt;
    });
    if (!recorded) throw new Error("Modal recovery failure was not persisted");
    return {
      attempt: recorded.recoveryAttempts ?? 0,
      delayMs,
      journal: recorded,
    };
  }

  async #markRecoveryFailed(
    taskId: string,
    journal: ModalHandoffJournal | undefined,
    message: string,
    modal: ModalAdapter,
  ): Promise<boolean> {
    if (!journal) {
      const failedAt = new Date().toISOString();
      await this.#options.store.updateState((state) => {
        const task = state.tasks[taskId];
        if (!task) return;
        if (task.status === "checkpointing" || task.status === "handoff") {
          task.status = "failed";
          task.stage = "failed";
          task.blockedReason = message;
          task.latestSummary = message;
          task.updatedAt = failedAt;
        }
      });
      return true;
    }

    const cleanup = await this.#cleanupOperation(taskId, journal, modal);
    await this.#markFailureState(
      taskId,
      journal,
      cleanup.error ? `${message}; terminal cleanup failed: ${cleanup.error}` : message,
      true,
      cleanup.evidence,
    );
    if (cleanup.evidence) {
      await this.#releaseLease(taskId, cleanup.evidence);
      await this.#markFailureState(taskId, journal, message, false, cleanup.evidence);
    }
    return cleanup.evidence !== undefined;
  }

  async #cleanupOperation(
    taskId: string,
    journal: ModalHandoffJournal,
    modal: ModalAdapter,
    knownSandbox?: ModalSandbox,
    options: { sandboxCreationDefinitelyNotAttempted?: boolean } = {},
  ): Promise<{ evidence?: CodexAuthLeaseReleaseEvidence; error?: string }> {
    const operationToken = journalOperationToken(journal);
    const sandboxes: ModalSandbox[] = [];
    try {
      if (knownSandbox) {
        sandboxes.push(knownSandbox);
      } else if (journal.monitorRegistration) {
        sandboxes.push(await modal.fromId(journal.monitorRegistration.sandboxId));
      } else {
        const ids = await this.#discoverOperationSandboxes(
          modal,
          taskId,
          journal.handoffSha256,
          operationToken,
        );
        for (const id of ids) sandboxes.push(await modal.fromId(id));
        if (sandboxes.length === 0) {
          if (options.sandboxCreationDefinitelyNotAttempted) {
            return {
              evidence: { kind: "sandbox-not-created", operationToken },
            };
          }
          return {
            error:
              "No operation-tagged Modal Sandbox is currently visible; creation outcome remains ambiguous",
          };
        }
      }

      let evidence: CodexAuthLeaseReleaseEvidence | undefined;
      for (const sandbox of sandboxes) {
        evidence = await terminalizeSandbox(sandbox, operationToken);
      }
      return evidence ? { evidence } : { error: "No owned Modal Sandbox was available" };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  async #recoverPendingCleanup(
    taskId: string,
    journal: ModalHandoffJournal,
    modal: ModalAdapter,
  ): Promise<boolean> {
    let evidence = journal.terminalEvidence;
    if (!evidence) {
      const operationToken = journalOperationToken(journal);
      await acquireCodexAuthLease(this.#leasePath(), taskId, {
        workerId: journal.workerId,
        operationToken,
        adoptExisting: true,
      });
      const cleanup = await this.#cleanupOperation(taskId, journal, modal);
      if (!cleanup.evidence) {
        await this.#recordPendingCleanupFailure(
          taskId,
          journal,
          cleanup.error ?? "No terminal cleanup evidence was produced",
        );
        return false;
      }
      evidence = cleanup.evidence;
      if (journal.phase === "stopped") {
        await this.#markStopped(
          taskId,
          journal,
          journal.failure ?? "cloud task stopped",
          true,
          evidence,
        );
      } else {
        await this.#markFailureState(
          taskId,
          journal,
          journal.failure ?? "cloud handoff failed",
          true,
          evidence,
        );
      }
    }

    await this.#releaseLease(taskId, evidence);
    if (journal.phase === "stopped") {
      await this.#markStopped(
        taskId,
        journal,
        journal.failure ?? "cloud task stopped",
        false,
        evidence,
      );
    } else {
      await this.#markFailureState(
        taskId,
        journal,
        journal.failure ?? "cloud handoff failed",
        false,
        evidence,
      );
    }
    return true;
  }

  async #recordPendingCleanupFailure(
    taskId: string,
    expectedJournal: ModalHandoffJournal,
    message: string,
  ): Promise<void> {
    const operationToken = journalOperationToken(expectedJournal);
    await this.#options.store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) return;
      const journal = modalHandoffJournal(task.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || journalOperationToken(journal) !== operationToken) return;
      const updatedAt = new Date().toISOString();
      task.metadata[MODAL_HANDOFF_JOURNAL_KEY] = {
        ...journal,
        cleanupPending: true,
        lastRecoveryError: message,
        updatedAt,
      } satisfies ModalHandoffJournal;
      task.updatedAt = updatedAt;
    });
  }

  async #markFailureState(
    taskId: string,
    expectedJournal: ModalHandoffJournal,
    message: string,
    cleanupPending: boolean,
    terminalEvidence?: CodexAuthLeaseReleaseEvidence,
  ): Promise<void> {
    const failedAt = new Date().toISOString();
    const operationToken = journalOperationToken(expectedJournal);
    await this.#options.store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) return;
      const journal = modalHandoffJournal(task.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || journalOperationToken(journal) !== operationToken) return;
      const ownsTask =
        !journal.monitorRegistration || task.currentWorkerId === journal.workerId;
      if (ownsTask) task.metadata.cloudMonitorAcknowledged = false;
      task.metadata[MODAL_HANDOFF_JOURNAL_KEY] = {
        ...journal,
        phase: "failed",
        failure: message,
        cleanupPending,
        ...(terminalEvidence ? { terminalEvidence } : {}),
        finalizedAt: failedAt,
        updatedAt: failedAt,
      } satisfies ModalHandoffJournal;
      const worker = state.workers[journal.workerId];
      if (
        worker &&
        worker.target.kind === "modal" &&
        worker.target.sandboxId === journal.monitorRegistration?.sandboxId &&
        ["starting", "running", "waiting"].includes(worker.status)
      ) {
        worker.status = "failed";
        worker.lastMessage = message;
        worker.lastEventAt = failedAt;
        worker.endedAt = failedAt;
      }
      if (
        ownsTask &&
        !cleanupPending &&
        (task.status === "checkpointing" || task.status === "handoff")
      ) {
        task.status = "failed";
        task.stage = "failed";
        task.blockedReason = message;
        task.latestSummary = `cloud handoff failed: ${message}`;
      }
      task.updatedAt = failedAt;
    });
  }

  async #markStopped(
    taskId: string,
    expectedJournal: ModalHandoffJournal,
    message: string,
    cleanupPending: boolean,
    terminalEvidence?: CodexAuthLeaseReleaseEvidence,
  ): Promise<void> {
    const stoppedAt = new Date().toISOString();
    const operationToken = journalOperationToken(expectedJournal);
    await this.#options.store.updateState((state) => {
      const task = state.tasks[taskId];
      if (!task) return;
      const journal = modalHandoffJournal(task.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || journalOperationToken(journal) !== operationToken) return;
      const worker = state.workers[journal.workerId];
      if (
        worker &&
        worker.target.kind === "modal" &&
        worker.target.sandboxId === journal.monitorRegistration?.sandboxId
      ) {
        worker.status = "stopped";
        worker.lastMessage = message;
        worker.lastEventAt = stoppedAt;
        worker.endedAt = stoppedAt;
      }
      if (task.currentWorkerId === journal.workerId) {
        task.metadata.cloudMonitorAcknowledged = false;
      }
      task.metadata[MODAL_HANDOFF_JOURNAL_KEY] = {
        ...journal,
        phase: "stopped",
        failure: message,
        cleanupPending,
        ...(terminalEvidence ? { terminalEvidence } : {}),
        finalizedAt: stoppedAt,
        updatedAt: stoppedAt,
      } satisfies ModalHandoffJournal;
      task.updatedAt = stoppedAt;
    });
  }

  async #restoreAfterLeaseBusy(
    originalTask: DexTask,
    expectedJournal: ModalHandoffJournal,
  ): Promise<void> {
    const operationToken = journalOperationToken(expectedJournal);
    await this.#options.store.updateState((state) => {
      const current = state.tasks[originalTask.id];
      if (!current) return;
      const journal = modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY]);
      if (!journal || journalOperationToken(journal) !== operationToken) return;
      delete current.metadata[MODAL_HANDOFF_JOURNAL_KEY];
      if (current.status === "checkpointing" || current.status === "handoff") {
        current.status = originalTask.status;
        current.stage = originalTask.stage;
        current.latestSummary = originalTask.latestSummary;
        current.blockedReason = originalTask.blockedReason;
      }
      current.updatedAt = new Date().toISOString();
    });
  }

  async #currentJournal(
    taskId: string,
    operationToken: string,
  ): Promise<ModalHandoffJournal | undefined> {
    const current = (await this.#options.store.read()).tasks[taskId];
    const journal = current
      ? modalHandoffJournal(current.metadata[MODAL_HANDOFF_JOURNAL_KEY])
      : undefined;
    return journal && journalOperationToken(journal) === operationToken
      ? journal
      : undefined;
  }

  async #requireCurrentJournal(
    taskId: string,
    operationToken: string,
  ): Promise<ModalHandoffJournal> {
    const journal = await this.#currentJournal(taskId, operationToken);
    if (!journal) throw new Error(`Modal operation changed during recovery: ${taskId}`);
    return journal;
  }

  #rootSigningKey(): string {
    const value = this.#options.signingKey ?? process.env.DEX_HANDOFF_SIGNING_KEY;
    assertStrongRootHandoffKey(value);
    return value;
  }

  #leasePath(): string {
    return (
      this.#options.codexAuthLeasePath ??
      path.join(this.#options.handoffsRoot, ".codex-account-auth.lease")
    );
  }

  #codexAuthVolumeName(): string {
    const value = this.#options.codexAuthVolumeName ?? process.env.DEX_MODAL_CODEX_AUTH_VOLUME;
    if (!value) {
      throw new Error(
        "A paired device-specific DEX_MODAL_CODEX_AUTH_VOLUME is required before Modal Sandbox creation",
      );
    }
    if (!/^dex-codex-auth-[a-f0-9]{20}$/.test(value)) {
      throw new Error("DEX_MODAL_CODEX_AUTH_VOLUME must be the paired device-specific Dex volume");
    }
    return value;
  }

  #releaseLease(
    taskId: string,
    evidence: CodexAuthLeaseReleaseEvidence,
  ): Promise<boolean> {
    const release = this.#options.releaseCodexAuthLease ?? releaseCodexAuthLease;
    return release(this.#leasePath(), taskId, evidence);
  }

  #recoveryMaxAttempts(): number {
    return Math.max(
      1,
      Math.floor(this.#options.recoveryMaxAttempts ?? DEFAULT_RECOVERY_MAX_ATTEMPTS),
    );
  }

  #recoveryBackoffMs(): number {
    return Math.max(0, this.#options.recoveryBackoffMs ?? DEFAULT_RECOVERY_BACKOFF_MS);
  }

  #sleep(milliseconds: number): Promise<void> {
    return this.#options.sleep?.(milliseconds) ?? delay(milliseconds);
  }
}

async function installScopedHandoffKey(
  sandbox: ModalSandbox,
  signingKey: string,
): Promise<void> {
  const installer = await sandbox.exec(
    ["node", "-e", INSTALL_HANDOFF_KEY_SCRIPT],
    { mode: "text", timeoutMs: 30_000 },
  );
  if (!installer.stdin) {
    throw new Error("The Modal SDK did not expose stdin for secure handoff-key delivery");
  }
  const writer = installer.stdin.getWriter();
  try {
    await writer.write(signingKey);
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw new Error("Could not deliver the scoped handoff key through Modal stdin", {
      cause: error,
    });
  } finally {
    writer.releaseLock();
  }
  const exitCode = await installer.wait();
  if (exitCode !== 0) {
    const stderr = redactString(await installer.stderr.readText().catch(() => ""))
      .slice(0, MAX_HANDOFF_KEY_INSTALL_ERROR_BYTES);
    throw new Error(
      stderr
        ? `Modal rejected the scoped handoff key installation: ${stderr}`
        : `Modal rejected the scoped handoff key installation with exit code ${exitCode}`,
    );
  }
}

function modalHandoffJournal(value: unknown): ModalHandoffJournal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !isModalHandoffJournalPhase(candidate.phase) ||
    typeof candidate.workerId !== "string" ||
    !candidate.workerId ||
    typeof candidate.handoffSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.handoffSha256) ||
    typeof candidate.startedAt !== "string" ||
    !candidate.startedAt ||
    typeof candidate.updatedAt !== "string" ||
    !candidate.updatedAt ||
    (candidate.operationToken !== undefined &&
      (typeof candidate.operationToken !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.operationToken)))
  ) {
    return undefined;
  }
  if (
    candidate.monitorRegistration !== undefined &&
    !isModalMonitorRegistration(candidate.monitorRegistration)
  ) {
    return undefined;
  }
  if (
    candidate.recoveryAttempts !== undefined &&
    (!Number.isInteger(candidate.recoveryAttempts) ||
      (candidate.recoveryAttempts as number) < 0)
  ) {
    return undefined;
  }
  if (
    candidate.terminalEvidence !== undefined &&
    !isCodexAuthLeaseReleaseEvidence(candidate.terminalEvidence)
  ) {
    return undefined;
  }
  if (candidate.terminalEvidence !== undefined) {
    const evidence = candidate.terminalEvidence as CodexAuthLeaseReleaseEvidence;
    const operationToken = typeof candidate.operationToken === "string"
      ? candidate.operationToken
      : modalOperationToken(
          isModalMonitorRegistration(candidate.monitorRegistration)
            ? candidate.monitorRegistration.taskId
            : "",
          candidate.workerId,
          candidate.handoffSha256,
        );
    if (evidence.operationToken !== operationToken) return undefined;
  }
  return candidate as unknown as ModalHandoffJournal;
}

function clearFinishedCloudRunMetadata(task: DexTask): void {
  if (task.metadata.pendingCloudResultImport !== undefined) {
    throw new Error(
      `Task ${task.id} still has a pending cloud result import; finish recovery before another handoff`,
    );
  }

  const rawEffects = task.metadata.cloudCompletionEffects;
  const completedEffects = rawEffects === undefined
    ? false
    : cloudCompletionEffectsComplete(rawEffects, task.id);
  if (rawEffects !== undefined && !completedEffects) {
    throw new Error(
      `Task ${task.id} still has unfinished cloud completion effects; finish recovery before another handoff`,
    );
  }

  const rawJournal = task.metadata[MODAL_HANDOFF_JOURNAL_KEY];
  if (rawJournal !== undefined) {
    const journal = modalHandoffJournal(rawJournal);
    if (!journal) {
      throw new Error(`Task ${task.id} has an invalid Modal handoff journal`);
    }
    const cleanupFinished =
      (journal.phase === "failed" || journal.phase === "stopped") &&
      journal.cleanupPending !== true;
    const priorCompletionFinished = journal.phase === "completed" && completedEffects;
    if (!cleanupFinished && !priorCompletionFinished) {
      throw new Error(
        `Task ${task.id} still has an active or unfinished Modal handoff; recover it before starting another`,
      );
    }
    delete task.metadata[MODAL_HANDOFF_JOURNAL_KEY];
  }

  if (completedEffects) {
    delete task.metadata.cloudCompletionEffects;
    delete task.metadata.resultImport;
  }
}

function cloudCompletionEffectsComplete(value: unknown, taskId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    candidate.phase !== "complete" ||
    typeof candidate.commandId !== "string" ||
    candidate.commandId.length < 1 ||
    candidate.commandId.length > 512 ||
    !candidate.completion ||
    typeof candidate.completion !== "object" ||
    Array.isArray(candidate.completion) ||
    (candidate.completion as Record<string, unknown>).taskId !== taskId ||
    !["succeeded", "failed", "cancelled"].includes(String(candidate.finalStatus)) ||
    typeof candidate.summary !== "string" ||
    candidate.summary.length < 1 ||
    candidate.summary.length > 20_000 ||
    typeof candidate.eventId !== "string" ||
    candidate.eventId.length < 1 ||
    !isIsoTimestamp(candidate.createdAt) ||
    !isIsoTimestamp(candidate.updatedAt) ||
    (candidate.operationToken !== undefined &&
      (typeof candidate.operationToken !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.operationToken))) ||
    (candidate.leaseReleaseEvidence !== undefined &&
      !isCodexAuthLeaseReleaseEvidence(candidate.leaseReleaseEvidence))
  ) {
    return false;
  }
  if (!candidate.effects || typeof candidate.effects !== "object" || Array.isArray(candidate.effects)) {
    return false;
  }
  const effects = candidate.effects as Record<string, unknown>;
  const requiredEffects = [
    "sandboxTerminated",
    "eventAppended",
    "leaseReleased",
    "queueDrained",
    "receiptQueued",
    "receiptAccepted",
    "powerChecked",
  ];
  return (
    Object.keys(effects).length === requiredEffects.length &&
    requiredEffects.every((name) => effects[name] === true)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isCodexAuthLeaseReleaseEvidence(
  value: unknown,
): value is CodexAuthLeaseReleaseEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.operationToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.operationToken)
  ) {
    return false;
  }
  if (candidate.kind === "sandbox-not-created") return true;
  if (
    typeof candidate.sandboxId !== "string" ||
    candidate.sandboxId.length === 0
  ) {
    return false;
  }
  if (candidate.kind === "terminal-poll") {
    return typeof candidate.exitCode === "number" && Number.isInteger(candidate.exitCode);
  }
  return candidate.kind === "terminate-wait" && candidate.volumePersisted === true;
}

function isModalHandoffJournalPhase(value: unknown): value is ModalHandoffJournalPhase {
  return (
    value === "prepared" ||
    value === "sandbox_created" ||
    value === "artifacts_uploaded" ||
    value === "ready_sent" ||
    value === "startup_acknowledged" ||
    value === "monitor_scheduled" ||
    value === "completed" ||
    value === "stopped" ||
    value === "failed"
  );
}

function isModalMonitorRegistration(value: unknown): value is ModalMonitorRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.taskId === "string" &&
    candidate.taskId.length > 0 &&
    typeof candidate.workerId === "string" &&
    candidate.workerId.length > 0 &&
    typeof candidate.sandboxId === "string" &&
    candidate.sandboxId.length > 0 &&
    typeof candidate.handoffSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.handoffSha256) &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.resultPath === "string" &&
    candidate.resultPath.length > 0
  );
}

function sameMonitorRegistration(
  left: ModalMonitorRegistration | undefined,
  right: ModalMonitorRegistration,
): boolean {
  return (
    left !== undefined &&
    left.taskId === right.taskId &&
    left.workerId === right.workerId &&
    left.sandboxId === right.sandboxId &&
    left.handoffSha256 === right.handoffSha256 &&
    left.startedAt === right.startedAt &&
    left.resultPath === right.resultPath
  );
}

function modalOperationToken(
  taskId: string,
  workerIdValue: string,
  handoffSha256: string,
): string {
  return sha256(`dex-modal-operation\0${taskId}\0${workerIdValue}\0${handoffSha256}`);
}

function journalOperationToken(journal: ModalHandoffJournal): string {
  return (
    journal.operationToken ??
    modalOperationToken(journal.monitorRegistration?.taskId ?? "", journal.workerId, journal.handoffSha256)
  );
}

function modalSandboxName(operationToken: string): string {
  return `${MODAL_CODEX_WORKER_SANDBOX_NAME}-${operationToken.slice(0, 16)}`;
}

function modalOperationTags(
  taskId: string,
  handoffSha256: string,
  operationToken: string,
): Record<string, string> {
  return {
    product: "dex",
    task: taskId,
    handoff: handoffSha256,
    operation: operationToken,
  };
}

interface ExpectedStartupContext {
  taskId: string;
  handoffSha256: string;
  memoryIds: string[];
  failedApproachIds: string[];
}

function expectedStartup(handoff: HandoffDocument): ExpectedStartupContext {
  return {
    taskId: handoff.taskId,
    handoffSha256: handoff.contentHash,
    memoryIds: handoff.memories.map((memory) => String(memory.id)),
    failedApproachIds: handoff.failedApproaches.map((failure, index) =>
      String(failure.sourceMemoryId ?? `failed-${index + 1}`)
    ),
  };
}

async function waitForStartup(
  sandbox: ModalSandbox,
  expected: ExpectedStartupContext,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ModalStartupAcknowledgement> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let raw: string;
    try {
      raw = await sandbox.raw.filesystem.readText("/dex/startup.json");
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!isRetryableModalFileRead(error)) throw error;
      lastError = error;
      const terminal = await readPreStartupResult(sandbox);
      if (terminal) {
        if (terminal.taskId !== expected.taskId) {
          throw new Error("Modal worker published a pre-start result for the wrong task");
        }
        if (terminal.handoffSha256 !== expected.handoffSha256) {
          throw new Error("Modal worker published a pre-start result for the wrong handoff");
        }
        throw new Error(
          `Modal worker ${terminal.status} before startup acknowledgement: ${redactString(terminal.summary).slice(0, 500)}`,
        );
      }
      try {
        const exitCode = await sandbox.poll();
        if (exitCode !== null) {
          throw new Error(
            `Modal worker exited with code ${exitCode} before startup acknowledgement`,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          /^Modal worker exited with code /.test(error.message)
        ) {
          throw error;
        }
        lastError = error;
      }
      await abortableDelay(Math.min(500, Math.max(0, deadline - Date.now())), signal);
      continue;
    }

    let parsed: ModalStartupAcknowledgement;
    try {
      parsed = ModalStartupAcknowledgementSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error("Modal worker published an invalid startup acknowledgement", {
        cause: error,
      });
    }
    if (parsed.taskId !== expected.taskId) {
      throw new Error("Modal startup acknowledged the wrong task");
    }
    if (parsed.handoffSha256 !== expected.handoffSha256) {
      throw new Error("Modal startup acknowledged the wrong handoff hash");
    }
    if (!sameIds(parsed.loadedMemoryIds, expected.memoryIds)) {
      throw new Error("Modal startup did not load the exact memory package");
    }
    if (!sameIds(parsed.loadedFailedApproachIds, expected.failedApproachIds)) {
      throw new Error("Modal startup did not load the exact failed-approach package");
    }
    return parsed;
  }
  throw new Error("Timed out waiting for Codex/Modal startup acknowledgement", {
    cause: lastError,
  });
}

async function readPreStartupResult(
  sandbox: ModalSandbox,
): Promise<ReturnType<typeof ModalResultArtifactSchema.parse> | undefined> {
  let raw: string;
  try {
    raw = await sandbox.raw.filesystem.readText("/dex/result.json");
  } catch (error) {
    if (isRetryableModalFileRead(error)) return undefined;
    throw error;
  }
  try {
    return ModalResultArtifactSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error("Modal worker published an invalid terminal result before startup", {
      cause: error,
    });
  }
}

function isMissingModalFile(error: unknown): boolean {
  const candidate = error as (NodeJS.ErrnoException & { name?: string }) | undefined;
  return (
    candidate?.code === "ENOENT" ||
    candidate?.name === "SandboxFilesystemNotFoundError" ||
    /(?:no such file|not found|does not exist)/i.test(errorMessage(error))
  );
}

function isRetryableModalFileRead(error: unknown): boolean {
  if (isMissingModalFile(error)) return true;
  const retryableCodes = new Set<string | number>([
    "EAI_AGAIN",
    "ECONNRESET",
    "EHOSTUNREACH",
    "EIO",
    "ENETDOWN",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
    "ABORTED",
    "CANCELLED",
    "DEADLINE_EXCEEDED",
    "INTERNAL",
    "RESOURCE_EXHAUSTED",
    "UNAVAILABLE",
    1,
    4,
    8,
    10,
    13,
    14,
  ]);
  for (const candidate of errorChain(error)) {
    const code = (candidate as { code?: unknown }).code;
    if (
      (typeof code === "string" || typeof code === "number") &&
      (retryableCodes.has(code) || retryableCodes.has(String(code).toUpperCase()))
    ) {
      return true;
    }
    const name = candidate instanceof Error ? candidate.name : "";
    if (name === "SandboxTimeoutError" || name === "TimeoutError") return true;
    const message = errorMessage(candidate);
    if (
      /(?:deadline exceeded|timed? out|temporarily unavailable|service unavailable|sandbox is unavailable|connection (?:reset|closed)|transport (?:error|closed)|control[- ]plane (?:error|unavailable))/i.test(message)
    ) {
      return true;
    }
    if (
      name === "SandboxFilesystemError" &&
      /^An unexpected error occurred,/i.test(message)
    ) {
      return true;
    }
  }
  return false;
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && values.length < 5) {
    seen.add(current);
    values.push(current);
    if (typeof current !== "object") break;
    current = (current as { cause?: unknown }).cause;
  }
  return values;
}

async function terminalizeSandbox(
  sandbox: ModalSandbox,
  operationToken: string,
): Promise<CodexAuthLeaseReleaseEvidence> {
  let exitCode: number | null = null;
  try {
    exitCode = await sandbox.poll();
  } catch {
    // A successful wait-termination below is independently sufficient proof.
  }
  if (exitCode !== null) {
    return {
      kind: "terminal-poll",
      sandboxId: sandbox.sandboxId,
      exitCode,
      operationToken,
    };
  }
  await sandbox.terminate({ wait: true });
  return {
    kind: "terminate-wait",
    sandboxId: sandbox.sandboxId,
    volumePersisted: true,
    operationToken,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Modal handoff aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (!signal) return delay(milliseconds);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameIds(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((value, index) => value === right[index]);
}

function deriveHandoffSigningKey(
  rootSigningKey: string,
  taskId: string,
  createdAt: string,
): string {
  return createHmac("sha256", rootSigningKey)
    .update(HANDOFF_DERIVATION_DOMAIN)
    .update("\0")
    .update(taskId)
    .update("\0")
    .update(createdAt)
    .digest("base64url");
}

function handoffSigningEnvelope(candidate: unknown, expectedTaskId: string): HandoffDocument {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Local Modal handoff is not a document");
  }
  const envelope = candidate as Record<string, unknown>;
  if (envelope.taskId !== expectedTaskId) {
    throw new Error("Recovered handoff belongs to the wrong task");
  }
  if (
    typeof envelope.createdAt !== "string" ||
    envelope.createdAt.length > 64 ||
    Number.isNaN(Date.parse(envelope.createdAt))
  ) {
    throw new Error("Recovered handoff has an invalid signing context");
  }
  return candidate as HandoffDocument;
}

async function repositoryInstructionConstraints(
  repositoryPath: string,
  revision: string,
): Promise<string[]> {
  const files = (await readTrackedTextFilesAtRevision({
    repositoryPath,
    revision,
    pathspecs: ["AGENTS.md"],
    maxFiles: MAX_REPOSITORY_INSTRUCTION_FILES,
    maxFileBytes: MAX_REPOSITORY_INSTRUCTION_FILE_BYTES,
    maxTotalBytes: MAX_REPOSITORY_INSTRUCTION_TOTAL_BYTES,
  }))
    .sort((left, right) => {
      const depth = left.path.split("/").length - right.path.split("/").length;
      return depth === 0 ? left.path.localeCompare(right.path) : depth;
    });
  const constraints: string[] = [];
  for (const file of files) {
    const content = file.content.trim();
    if (!content) continue;
    const scope = path.posix.dirname(file.path) === "."
      ? "repository root"
      : `${path.posix.dirname(file.path)}/`;
    constraints.push(
      `Repository instructions from ${file.path} (scope: ${scope}):\n${content}`,
    );
  }
  return constraints;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function validationCommands(
  repositoryPath: string,
  task: DexTask,
): Promise<string[][]> {
  const configured = task.metadata.validationArgv;
  if (
    Array.isArray(configured) &&
    configured.every(
      (item) =>
        Array.isArray(item) && item.every((part) => typeof part === "string"),
    )
  ) {
    return configured as string[][];
  }
  const tracked = await listTrackedFiles({ repositoryPath, pathspecs: ["package.json"] });
  return tracked.includes("package.json") ? [["npm", "test"]] : [];
}

function taskKnowledge(task: DexTask): TaskKnowledge {
  const stored = task.metadata.taskKnowledge;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const durable = stored as TaskKnowledge;
    return {
      ...durable,
      // An explicit, durable continuation instruction is the user's latest
      // requested outcome and supersedes worker-authored prior next steps.
      nextSteps: task.nextStep ? [task.nextStep] : (durable.nextSteps ?? []),
    };
  }
  return {
    learnedFacts: task.latestSummary ? [task.latestSummary] : [],
    failedApproaches: Array.isArray(task.metadata.failedApproaches)
      ? task.metadata.failedApproaches
      : [],
    nextSteps: task.nextStep ? [task.nextStep] : [],
    filesChanged: Array.isArray(task.metadata.filesTouched)
      ? task.metadata.filesTouched
      : [],
  };
}
