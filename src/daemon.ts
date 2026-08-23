import { hostname } from "node:os";
import { loadConfig } from "./config/config.js";
import { resolveDexPaths } from "./config/paths.js";
import { acquireDaemonLock } from "./local/daemon/lock.js";
import { DexStateStore } from "./state/store.js";
import { createDaemonRuntime } from "./local/daemon/runtime.js";
import { startControlSocket } from "./local/daemon/control-socket.js";
import { hydrateRuntimeSecrets } from "./local/pairing/secrets.js";

export interface DaemonOptions {
  signal?: AbortSignal;
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
  try {
    await hydrateRuntimeSecrets();
    const config = await loadConfig(paths);
    const store = new DexStateStore(paths.state);
    await store.updateState((state) => {
    if (config.deviceId) {
      state.machine = {
        id: config.deviceId,
        hostname: config.deviceName ?? hostname(),
        sleepPreventionActive: state.machine?.sleepPreventionActive ?? false,
        aggressiveLidModeActive: false,
        batteryAlertThresholds: state.machine?.batteryAlertThresholds ?? [],
        updatedAt: new Date().toISOString(),
      };
    }
    for (const worker of Object.values(state.workers)) {
      if (worker.target.kind === "local" && (worker.status === "starting" || worker.status === "running")) {
        worker.status = "stopped";
        worker.endedAt = new Date().toISOString();
        worker.lastMessage = "daemon restarted; task remains durable";
      }
    }
    });
    runtime = await createDaemonRuntime({ paths, config, store, signal: controller.signal });
    const activeRuntime = runtime;
    control = await startControlSocket(paths.controlSocket, async (command) => {
      if (command.type === "demo.battery") await activeRuntime.injectDemoBattery(command.percent);
      else await activeRuntime.restorePower();
    });
    await runtime.run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await runtime?.shutdown().catch(() => undefined);
    await control?.close().catch(() => undefined);
    await lock.release();
  }
}
