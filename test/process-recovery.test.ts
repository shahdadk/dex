import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCancelledError,
  AgentStartupError,
  AgentStartupTimeoutError,
} from "../src/agents/errors.js";
import {
  launchJsonlAgent,
  nodeProcessSpawner,
  stopAllDexLocalAgentProcesses,
  terminateSurvivingDexAgentProcessGroup,
} from "../src/agents/process.js";
import type { AgentProcessSpawner, CodexJsonEvent } from "../src/agents/types.js";

const processGroups = new Set<number>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const processGroupId of processGroups) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch (error) {
      if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  processGroups.clear();
  await Promise.all([...temporaryDirectories].map((directory) =>
    rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

describe.skipIf(process.platform === "win32")("Dex local process recovery", () => {
  it.each([
    { failure: "startup timeout", expected: AgentStartupTimeoutError },
    { failure: "startup abort", expected: AgentCancelledError },
  ] as const)("does not reject a $failure until the process group is dead", async ({ failure, expected }) => {
    const fixture = await processFixture();
    const controller = new AbortController();
    let childPid: number | undefined;
    let markChildReady!: () => void;
    const childReady = new Promise<void>((resolve) => { markChildReady = resolve; });
    const spawner: AgentProcessSpawner = (command, args, options) => {
      const child = nodeProcessSpawner(command, args, options, "codex");
      childPid = child.pid;
      if (child.pid) processGroups.add(child.pid);
      child.stdout?.on("data", (chunk: unknown) => {
        if (String(chunk).includes("child-ready")) markChildReady();
      });
      return child;
    };
    let startupSettled = false;
    const startup = launchJsonlAgent<CodexJsonEvent>({
      provider: "codex",
      command: fixture.executable,
      args: ["-e", [
        "process.on('SIGTERM', () => undefined);",
        "process.stdout.write('child-ready\\n');",
        "setInterval(() => undefined, 1000);",
      ].join(" ")],
      options: {
        cwd: fixture.directory,
        prompt: "work",
        signal: controller.signal,
        startupTimeoutMs: failure === "startup timeout" ? 100 : 60_000,
        stopGraceMs: 120,
      },
      spawner,
      identify: (event) => event.type === "thread.started" ? event.thread_id : undefined,
      interpret: () => ({}),
    }).then(
      (handle) => {
        startupSettled = true;
        return handle;
      },
      (error: unknown) => {
        startupSettled = true;
        throw error;
      },
    );
    const startupOutcome = startup.catch((error: unknown) => error);

    await childReady;
    expect(childPid).toBeTypeOf("number");
    if (failure === "startup abort") controller.abort();
    else await delay(110);
    await delay(20);

    expect(startupSettled).toBe(false);
    expect(processGroupAlive(childPid!)).toBe(true);
    expect(await startupOutcome).toBeInstanceOf(expected);
    expect(processGroupAlive(childPid!)).toBe(false);
  });

  it("orderly shutdown stops and awaits a worker that is still starting", async () => {
    const fixture = await processFixture();
    let childPid: number | undefined;
    let markDescendantStarted!: () => void;
    const descendantStarted = new Promise<void>((resolve) => {
      markDescendantStarted = resolve;
    });
    const spawner: AgentProcessSpawner = (command, args, options) => {
      const child = nodeProcessSpawner(command, args, options);
      childPid = child.pid;
      if (child.pid) processGroups.add(child.pid);
      child.stdout?.on("data", (chunk: unknown) => {
        if (String(chunk).includes("descendant-ready")) markDescendantStarted();
      });
      return child;
    };
    const ready = launchJsonlAgent<CodexJsonEvent>({
      provider: "codex",
      command: fixture.executable,
      args: ["-e", [
        "const { spawn } = require('node:child_process');",
        `const nested = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); process.stdout.write('ready\\\\n'); setInterval(() => undefined, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });`,
        "nested.stdout.once('data', () => process.stdout.write('descendant-ready\\n'));",
        "setInterval(() => undefined, 1000);",
      ].join(" ")],
      options: {
        cwd: fixture.directory,
        prompt: "work",
        startupTimeoutMs: 60_000,
        stopGraceMs: 50,
      },
      spawner,
      identify: (event) => event.type === "thread.started" ? event.thread_id : undefined,
      interpret: () => ({}),
    });
    const startup = ready.catch((error: unknown) => error);

    expect(childPid).toBeTypeOf("number");
    await descendantStarted;
    expect(processGroupAlive(childPid!)).toBe(true);
    await stopAllDexLocalAgentProcesses();

    expect(await startup).toBeInstanceOf(AgentStartupError);
    expect(processGroupAlive(childPid!)).toBe(false);
  });

  it("discovers and terminates a marked Dex process group before its PID is persisted", async () => {
    const fixture = await processFixture();
    const startedAt = new Date().toISOString();
    const handle = await launchJsonlAgent<CodexJsonEvent>({
      provider: "codex",
      command: fixture.executable,
      args: [
        "-e",
        `process.stdout.write('{"type":"thread.started","thread_id":"thread-recovery"}\\n'); setInterval(() => undefined, 1000)`,
      ],
      options: { cwd: fixture.directory, prompt: "work" },
      identify: (event) => event.type === "thread.started" ? event.thread_id : undefined,
      interpret: () => ({}),
    });
    expect(handle.pid).toBeTypeOf("number");
    processGroups.add(handle.pid!);

    await expect(terminateSurvivingDexAgentProcessGroup({
      provider: "codex",
      cwd: fixture.directory,
      startedAt,
    }, { stopGraceMs: 250, killWaitMs: 250, pollIntervalMs: 10 })).resolves.toEqual({
      status: "terminated",
      processGroupId: handle.pid,
    });
    await handle.result;

    expect(processGroupAlive(handle.pid!)).toBe(false);
  });

  it("uses the logical provider marker for a custom agent executable", async () => {
    const fixture = await processFixture("custom-codex-wrapper");
    const startedAt = new Date().toISOString();
    const handle = await launchJsonlAgent<CodexJsonEvent>({
      provider: "codex",
      command: fixture.executable,
      args: [
        "-e",
        `process.stdout.write('{"type":"thread.started","thread_id":"thread-custom-command"}\\n'); setInterval(() => undefined, 1000)`,
      ],
      options: { cwd: fixture.directory, prompt: "work" },
      identify: (event) => event.type === "thread.started" ? event.thread_id : undefined,
      interpret: () => ({}),
    });
    expect(handle.pid).toBeTypeOf("number");
    processGroups.add(handle.pid!);

    await expect(terminateSurvivingDexAgentProcessGroup({
      provider: "codex",
      cwd: fixture.directory,
      startedAt,
    }, { stopGraceMs: 250, killWaitMs: 250, pollIntervalMs: 10 })).resolves.toEqual({
      status: "terminated",
      processGroupId: handle.pid,
    });
    await handle.result;

    expect(processGroupAlive(handle.pid!)).toBe(false);
  });

  it("fails closed when a plausible PID-less Dex process has an unverifiable cwd", async () => {
    const fixture = await processFixture();
    const differentDirectory = await mkdtemp(path.join(tmpdir(), "dex-process-recovery-other-"));
    temporaryDirectories.add(differentDirectory);
    const startedAt = new Date().toISOString();
    const handle = await launchJsonlAgent<CodexJsonEvent>({
      provider: "codex",
      command: fixture.executable,
      args: [
        "-e",
        `process.stdout.write('{"type":"thread.started","thread_id":"thread-cwd-fence"}\\n'); setInterval(() => undefined, 1000)`,
      ],
      options: { cwd: fixture.directory, prompt: "work" },
      identify: (event) => event.type === "thread.started" ? event.thread_id : undefined,
      interpret: () => ({}),
    });
    expect(handle.pid).toBeTypeOf("number");
    processGroups.add(handle.pid!);

    const result = await terminateSurvivingDexAgentProcessGroup({
      provider: "codex",
      cwd: differentDirectory,
      startedAt,
    }, { stopGraceMs: 50, killWaitMs: 50, pollIntervalMs: 5 });

    expect(result).toMatchObject({
      status: "unverified",
      processGroupId: handle.pid,
    });
    expect(result.reason).toMatch(/working directory/i);
    expect(processGroupAlive(handle.pid!)).toBe(true);

    await handle.stop();
    await handle.result;
  });

  it("fails closed for an exact marked PID-less process outside the five-minute launch window", async () => {
    const fixture = await processFixture();
    const handle = await launchJsonlAgent<CodexJsonEvent>({
      provider: "codex",
      command: fixture.executable,
      args: [
        "-e",
        `process.stdout.write('{"type":"thread.started","thread_id":"thread-old-pidless"}\\n'); setInterval(() => undefined, 1000)`,
      ],
      options: { cwd: fixture.directory, prompt: "work" },
      identify: (event) => event.type === "thread.started" ? event.thread_id : undefined,
      interpret: () => ({}),
    });
    expect(handle.pid).toBeTypeOf("number");
    processGroups.add(handle.pid!);

    const result = await terminateSurvivingDexAgentProcessGroup({
      provider: "codex",
      cwd: fixture.directory,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }, { stopGraceMs: 50, killWaitMs: 50, pollIntervalMs: 5 });

    expect(result).toMatchObject({
      status: "unverified",
      processGroupId: handle.pid,
    });
    expect(result.reason).toMatch(/older marked Dex process group/i);
    expect(processGroupAlive(handle.pid!)).toBe(true);

    await handle.stop();
    await handle.result;
  });

  it("refuses to signal an unrelated process after a persisted PID is reused", async () => {
    const fixture = await processFixture();
    const child = spawn(fixture.executable, ["-e", "setInterval(() => undefined, 1000)"], {
      cwd: fixture.directory,
      detached: true,
      stdio: "ignore",
    });
    expect(child.pid).toBeTypeOf("number");
    processGroups.add(child.pid!);

    const result = await terminateSurvivingDexAgentProcessGroup({
      provider: "codex",
      pid: child.pid,
      cwd: fixture.directory,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }, { stopGraceMs: 50, killWaitMs: 50, pollIntervalMs: 5 });

    expect(result).toMatchObject({
      status: "unverified",
      processGroupId: child.pid,
    });
    expect(processGroupAlive(child.pid!)).toBe(true);
  });
});

async function processFixture(executableName = "codex"): Promise<{ directory: string; executable: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "dex-process-recovery-"));
  temporaryDirectories.add(directory);
  const executable = path.join(directory, executableName);
  await symlink(process.execPath, executable);
  return { directory, executable };
}

function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
