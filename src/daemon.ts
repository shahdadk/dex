import { hostname } from "node:os";
import {
  terminateSurvivingDexAgentProcessGroup,
  type AgentProcessGroupReconciliation,
} from "./agents/process.js";
import { loadConfig } from "./config/config.js";
import { resolveDexPaths } from "./config/paths.js";
import { acquireDaemonLock } from "./local/daemon/lock.js";
import { DexStateStore } from "./state/store.js";
import { createDaemonRuntime } from "./local/daemon/runtime.js";
import { startControlSocket } from "./local/daemon/control-socket.js";
import { hydrateRuntimeSecrets } from "./local/pairing/secrets.js";
import type { DexState } from "./state/schemas.js";

export interface DaemonOptions {
  signal?: AbortSignal;
}

/** Runs daemon work and reports cleanup failures without ever replacing the
 * primary setup/runtime failure. Exported for direct lifecycle regression
 * coverage; callers should return every independently observed cleanup error. */
export async function runWithDaemonCleanup(
  operation: () => Promise<void>,
  cleanup: () => Promise<readonly unknown[]>,
): Promise<void> {
  let primaryFailed = false;
  let primaryFailure: unknown;
  try {
    await operation();
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }

  let cleanupFailures: readonly unknown[];
  try {
    cleanupFailures = await cleanup();
  } catch (error) {
    cleanupFailures = [error];
  }

  if (primaryFailed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        "Dex daemon failed and cleanup also failed",
        { cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Dex daemon cleanup failed");
  }
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const paths = resolveDexPaths();
  const lock = await acquireDaemonLock(paths.daemonPid);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop, { once: true });
  let runtime: Awaited<ReturnType<typeof createDaemonRuntime>> | undefined;
  let control: Awaited<ReturnType<typeof startControlSocket>> | undefined;
  await runWithDaemonCleanup(async () => {
    await hydrateRuntimeSecrets();
    const config = await loadConfig(paths);
    const store = new DexStateStore(paths.state);
    await terminateRestartedLocalWorkerProcesses(await store.read());
    await store.updateState((state) => {
      if (config.deviceId) {
        state.machine = {
          id: config.deviceId,
          hostname: config.deviceName ?? hostname(),
          // A new daemon owns no prior caffeinate process. Durable intent is
          // re-established by DexPowerController.reconcileStartup().
          sleepPreventionActive: false,
          aggressiveLidModeActive: false,
          batteryAlertThresholds: state.machine?.batteryAlertThresholds ?? [],
          updatedAt: new Date().toISOString(),
        };
      }
      markInterruptedLocalWorkers(state);
    });
    runtime = await createDaemonRuntime({ paths, config, store, signal: controller.signal });
    await runtime.recoverInterruptedTasks();
    const activeRuntime = runtime;
    control = await startControlSocket(paths.controlSocket, async (command) => {
      if (command.type === "demo.battery") await activeRuntime.injectDemoBattery(command.percent);
      else await activeRuntime.restorePower();
    });
    await runtime.run(controller.signal);
  }, async () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
    const cleanupFailures: unknown[] = [];
    await runtime?.shutdown().catch((error) => cleanupFailures.push(error));
    await control?.close().catch((error) => cleanupFailures.push(error));
    await lock.release().catch((error) => cleanupFailures.push(error));
    return cleanupFailures;
  });
}

export interface RestartedWorkerProcessReconciliation extends AgentProcessGroupReconciliation {
  workerId: string;
  taskId: string;
}

/** Verifies and stops surviving local process groups before any replacement
 * worker can be launched from durable state. */
export async function terminateRestartedLocalWorkerProcesses(
  state: DexState,
): Promise<RestartedWorkerProcessReconciliation[]> {
  const candidates = new Set<string>();
  for (const worker of Object.values(state.workers)) {
    if (worker.target.kind === "local" &&
        ["starting", "running", "waiting"].includes(worker.status)) {
      candidates.add(worker.id);
    }
  }
  for (const task of Object.values(state.tasks)) {
    if (!["preparing", "running"].includes(task.status) || !task.currentWorkerId) continue;
    const worker = state.workers[task.currentWorkerId];
    if (worker?.target.kind === "local") candidates.add(worker.id);
  }

  const reconciled: RestartedWorkerProcessReconciliation[] = [];
  for (const workerId of candidates) {
    const worker = state.workers[workerId];
    if (!worker || worker.target.kind !== "local") continue;
    const task = state.tasks[worker.taskId];
    const result = await terminateSurvivingDexAgentProcessGroup({
      provider: worker.agent,
      ...(worker.pid === undefined ? {} : { pid: worker.pid }),
      ...(task ? { cwd: task.worktreePath } : {}),
      startedAt: worker.startedAt,
    });
    const record: RestartedWorkerProcessReconciliation = {
      workerId,
      taskId: worker.taskId,
      ...result,
    };
    reconciled.push(record);
    if (result.status === "unverified") {
      throw new Error(
        `Refusing to replace local worker ${workerId}: ${result.reason ?? "its process group could not be verified"}`,
      );
    }
  }
  return reconciled;
}

export function markInterruptedLocalWorkers(state: DexState, now = new Date().toISOString()): string[] {
  const interruptedTaskIds = new Set<string>();
  for (const worker of Object.values(state.workers)) {
    if (worker.target.kind !== "local" || !["starting", "running", "waiting"].includes(worker.status)) continue;
    worker.status = "stopped";
    worker.endedAt = now;
    worker.lastMessage = "daemon restarted; task remains durable";
    interruptedTaskIds.add(worker.taskId);
  }
  for (const task of Object.values(state.tasks)) {
    // Checkpoint/handoff ownership is intentionally not inferred from a stale
    // local worker: a Modal sandbox may already exist in the narrow window
    // before its worker record is persisted. The durable handoff monitor owns
    // reconciliation there and avoids a duplicate local continuation.
    if (!["preparing", "running"].includes(task.status)) continue;
    const currentWorker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
    if (currentWorker?.target.kind === "modal" && ["starting", "running", "waiting"].includes(currentWorker.status)) continue;
    if (!currentWorker || currentWorker.target.kind === "local") interruptedTaskIds.add(task.id);
  }
  for (const taskId of interruptedTaskIds) {
    const task = state.tasks[taskId];
    if (!task || ["completed", "failed", "cancelled"].includes(task.status)) continue;
    task.status = "failed";
    task.stage = "failed";
    task.blockedReason = "local worker was interrupted when the Dex daemon restarted";
    task.latestSummary = "recovering the interrupted local worker from durable context";
    task.metadata.interruptedByDaemonRestart = true;
    task.updatedAt = now;
  }
  return [...interruptedTaskIds];
}
