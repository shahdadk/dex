import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export interface DaemonLock {
  release(): Promise<void>;
}

export async function acquireDaemonLock(pidFile: string): Promise<DaemonLock> {
  await mkdir(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(pidFile, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    if (Number.isInteger(pid) && isAlive(pid)) {
      throw new Error(`Dex is already running (pid ${pid})`);
    }
    await unlink(pidFile).catch(() => undefined);
    return acquireDaemonLock(pidFile);
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const current = Number.parseInt((await readFile(pidFile, "utf8").catch(() => "")).trim(), 10);
      if (current === process.pid) await unlink(pidFile).catch(() => undefined);
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
