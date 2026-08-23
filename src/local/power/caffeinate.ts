import { spawn, type ChildProcess } from "node:child_process";

export interface CaffeinateProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: "spawn", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type CaffeinateSpawner = (
  command: string,
  args: readonly string[],
) => CaffeinateProcess;

export interface CaffeinateControllerOptions {
  spawnProcess?: CaffeinateSpawner;
  parentPid?: number;
  stopTimeoutMs?: number;
}

interface ActiveCaffeinate {
  child: CaffeinateProcess;
  pid: number;
}

const defaultSpawner: CaffeinateSpawner = (command, args) =>
  spawn(command, [...args], {
    detached: false,
    stdio: "ignore",
  }) as ChildProcess;

function validPid(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && (pid ?? 0) > 0;
}

export class CaffeinateController {
  readonly #spawnProcess: CaffeinateSpawner;
  readonly #parentPid: number;
  readonly #stopTimeoutMs: number;
  #active: ActiveCaffeinate | undefined;
  #starting: Promise<number> | undefined;
  #stopping: Promise<boolean> | undefined;

  constructor(options: CaffeinateControllerOptions = {}) {
    this.#spawnProcess = options.spawnProcess ?? defaultSpawner;
    this.#parentPid = options.parentPid ?? process.pid;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
    if (!validPid(this.#parentPid)) throw new RangeError("parentPid must be a positive integer");
    if (!Number.isFinite(this.#stopTimeoutMs) || this.#stopTimeoutMs < 0) {
      throw new RangeError("stopTimeoutMs must be non-negative");
    }
  }

  get active(): boolean {
    return this.#active !== undefined && this.#active.child.exitCode === null;
  }

  get pid(): number | null {
    return this.active ? (this.#active?.pid ?? null) : null;
  }

  start(): Promise<number> {
    if (this.active && this.#active) return Promise.resolve(this.#active.pid);
    if (this.#starting) return this.#starting;

    const operation = this.#start();
    this.#starting = operation;
    const clearStarting = (): void => {
      if (this.#starting === operation) this.#starting = undefined;
    };
    void operation.then(clearStarting, clearStarting);
    return operation;
  }

  async #start(): Promise<number> {
    if (this.#stopping) await this.#stopping;
    if (this.active && this.#active) return this.#active.pid;

    // -i is the least-privileged assertion needed here. -w ties its lifetime to
    // this process so a crash cannot leave an orphaned sleep inhibitor behind.
    const child = this.#spawnProcess("/usr/bin/caffeinate", [
      "-i",
      "-w",
      String(this.#parentPid),
    ]);

    const pid = await new Promise<number>((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        if (!validPid(child.pid)) {
          reject(new Error("caffeinate started without a valid PID"));
          return;
        }
        resolve(child.pid);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new Error(`failed to start caffeinate: ${error.message}`, { cause: error }));
      };
      const cleanup = (): void => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };

      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    const active = { child, pid };
    this.#active = active;
    child.once("exit", () => {
      if (this.#active === active) this.#active = undefined;
    });
    child.once("error", () => {
      if (this.#active === active) this.#active = undefined;
    });
    return pid;
  }

  stop(): Promise<boolean> {
    if (this.#stopping) return this.#stopping;
    const operation = this.#stop();
    this.#stopping = operation;
    const clearStopping = (): void => {
      if (this.#stopping === operation) this.#stopping = undefined;
    };
    void operation.then(clearStopping, clearStopping);
    return operation;
  }

  async #stop(): Promise<boolean> {
    if (this.#starting) await this.#starting;
    const active = this.#active;
    if (!active || active.child.exitCode !== null) {
      if (this.#active === active) this.#active = undefined;
      return false;
    }

    // Keep both the object identity and captured PID. Never signal a PID loaded
    // from disk or looked up by name, either of which could have been reused.
    if (active.child.pid !== active.pid || !validPid(active.pid)) {
      throw new Error("refusing to stop caffeinate because its PID identity changed");
    }

    const exited = new Promise<void>((resolve) => {
      active.child.once("exit", () => resolve());
    });
    const signalled = active.child.kill("SIGTERM");
    if (!signalled && active.child.exitCode === null) {
      throw new Error(`failed to signal caffeinate PID ${active.pid}`);
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`caffeinate PID ${active.pid} did not exit after SIGTERM`));
          }, this.#stopTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (this.#active === active) this.#active = undefined;
    return true;
  }

  /** Restore the Mac's normal idle-sleep behavior. */
  restore(): Promise<boolean> {
    return this.stop();
  }
}
