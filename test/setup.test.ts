import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

const mockedModules = [
  "node:fs/promises",
  "node:os",
  "../src/utils/exec.js",
  "../src/local/pairing/index.js",
  "../src/config/config.js",
  "../src/config/paths.js",
  "../src/daemon.js",
  "../src/state/store.js",
  "../src/setup/doctor.js",
  "../src/setup/service.js",
  "../src/tasks/worktree.js",
  "../src/utils/ids.js",
  "../src/local/machine/mac-machine.js",
  "../src/cloud/modal/adapter.js",
  "../src/setup/onboarding.js",
  "../src/local/daemon/control-socket.js",
  "../src/local/pairing/secrets.js",
  "../src/setup/modal-auth.js",
] as const;

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const module of mockedModules) vi.doUnmock(module);
  vi.resetModules();
});

function config() {
  return {
    version: 1 as const,
    cloudUrl: "https://dex.example.test",
    sendblueLine: "+15555550123",
    serverKeys: [{
      algorithm: "ed25519" as const,
      keyId: "server-key-1",
      publicKey: "pinned-public-key",
    }],
    maxConcurrency: 2,
    models: {
      fastLane: "gemini-3.5-flash-lite" as const,
      brain: "gemini-3.7-flash" as const,
    },
  };
}

describe("phone onboarding", () => {
  it("retries with fake time and returns a verified pairing without real sleeps", async () => {
    vi.useFakeTimers();
    const identity = {
      deviceId: "device-1",
      keyId: "device-key-1",
      ownerId: "owner-1",
      pairedConversationId: "conversation-1",
    };
    const loadIdentity = vi.fn(async () => null);
    const pair = vi.fn()
      .mockRejectedValueOnce(new Error("not paired yet"))
      .mockResolvedValueOnce(identity);
    const constructorOptions: unknown[] = [];
    vi.doMock("../src/local/pairing/index.js", () => ({
      MacOSDexKeychain: class FakeKeychain {},
      DexPairingService: class FakePairingService {
        constructor(options: unknown) {
          constructorOptions.push(options);
        }

        loadIdentity = loadIdentity;
        pair = pair;
      },
    }));
    const { pairMac } = await import("../src/setup/onboarding.js");
    const lines: string[] = [];

    const pending = pairMac({
      config: config(),
      pairingCode: "abc234",
      deviceName: "Test Mac",
      timeoutMs: 50,
      pollMs: 10,
      print: (line) => lines.push(line),
    });
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toEqual(identity);
    expect(pair).toHaveBeenNthCalledWith(1, {
      pairingCode: "ABC234",
      deviceName: "Test Mac",
    });
    expect(pair).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toContain("PAIR ABC234");
    expect(lines.join("\n")).toContain("+15555550123");
    expect(constructorOptions).toEqual([expect.objectContaining({
      baseUrl: "https://dex.example.test",
      pinnedServerKeys: config().serverKeys,
    })]);
  });

  it("bounds unsuccessful pairing with fake time and preserves the last failure as cause", async () => {
    vi.useFakeTimers();
    const lastFailure = new Error("phone has not replied");
    const pair = vi.fn(async () => { throw lastFailure; });
    vi.doMock("../src/local/pairing/index.js", () => ({
      MacOSDexKeychain: class FakeKeychain {},
      DexPairingService: class FakePairingService {
        loadIdentity = vi.fn(async () => null);
        pair = pair;
      },
    }));
    const { pairMac } = await import("../src/setup/onboarding.js");
    const pending = pairMac({
      config: config(),
      pairingCode: "timeout-code",
      deviceName: "Test Mac",
      timeoutMs: 25,
      pollMs: 10,
      print: () => undefined,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      message: expect.stringContaining("Phone pairing timed out"),
      cause: lastFailure,
    });

    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(pair).toHaveBeenCalledTimes(3);
  });
});

describe("setup command", () => {
  it("completes the skip-smoke/no-service path entirely through fakes", async () => {
    const paths = {
      home: "/tmp/dex-setup-test",
      config: "/tmp/dex-setup-test/config.json",
      state: "/tmp/dex-setup-test/state.json",
      events: "/tmp/dex-setup-test/events.jsonl",
      daemonPid: "/tmp/dex-setup-test/daemon.pid",
      daemonLog: "/tmp/dex-setup-test/daemon.log",
      powerState: "/tmp/dex-setup-test/power-state.json",
      worktrees: "/tmp/dex-setup-test/worktrees",
      handoffs: "/tmp/dex-setup-test/handoffs",
      runtime: "/tmp/dex-setup-test/runtime",
      controlSocket: "/tmp/dex-setup-test/runtime/control.sock",
    };
    const writeFile = vi.fn(async () => undefined);
    const loadConfig = vi.fn(async () => config());
    const parseConfig = vi.fn((value: unknown) => value);
    const runDoctor = vi.fn(async () => [
      {
        name: "Node",
        status: "pass",
        detail: "Node 22",
      },
      {
        name: "Modal",
        status: "pass",
        detail: "authenticated CLI profile available",
      },
    ]);
    const installRuntime = vi.fn(async () => "/tmp/runtime");
    const installLaunchAgent = vi.fn(async () => "/tmp/agent.plist");
    const pairMac = vi.fn(async () => ({
      deviceId: "device-1",
      keyId: "device-key-1",
      ownerId: "owner-1",
      pairedConversationId: "conversation-1",
    }));
    const persistRuntimeSecrets = vi.fn(async () => undefined);
    const seedModalCodexAuth = vi.fn(async () => ({ volumeName: "dex-codex-auth" }));
    const modalConstructor = vi.fn();
    const machineConstructor = vi.fn();
    const updateState = vi.fn(async (mutator: (state: { projects: Record<string, unknown>; revision: number }) => void) => {
      const state = { projects: {}, revision: 0 };
      mutator(state);
      return state;
    });

    vi.doMock("node:fs/promises", async () => ({
      ...await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
      writeFile,
    }));
    vi.doMock("../src/config/config.js", () => ({
      DexConfigSchema: { parse: parseConfig },
      loadConfig,
    }));
    vi.doMock("../src/config/paths.js", () => ({ resolveDexPaths: () => paths }));
    vi.doMock("../src/daemon.js", () => ({ runDaemon: vi.fn() }));
    vi.doMock("../src/state/store.js", () => ({
      DexStateStore: class FakeStateStore {
        read = vi.fn(async () => ({ projects: {} }));
        updateState = updateState;
      },
    }));
    vi.doMock("../src/setup/doctor.js", () => ({
      runDoctor,
      formatDoctor: () => "Dex Setup\n\nReady.",
    }));
    vi.doMock("../src/setup/service.js", () => ({ installRuntime, installLaunchAgent }));
    vi.doMock("../src/tasks/worktree.js", () => ({
      inspectRepository: vi.fn(async () => ({
        root: "/tmp/project",
        branch: "main",
        remote: "git@example.test:owner/project.git",
      })),
    }));
    vi.doMock("../src/utils/ids.js", () => ({ projectId: () => "project-1" }));
    vi.doMock("../src/local/machine/mac-machine.js", () => ({
      MacMachineController: class FakeMachineController {
        constructor() {
          machineConstructor();
        }
      },
    }));
    vi.doMock("../src/cloud/modal/adapter.js", () => ({
      ModalAdapter: class FakeModalAdapter {
        constructor() {
          modalConstructor();
        }
      },
    }));
    vi.doMock("../src/setup/onboarding.js", () => ({
      detectMacName: vi.fn(async () => "unexpected detected name"),
      pairMac,
    }));
    vi.doMock("../src/local/daemon/control-socket.js", () => ({ sendControlCommand: vi.fn() }));
    vi.doMock("../src/local/pairing/secrets.js", () => ({
      hydrateRuntimeSecrets: vi.fn(),
      persistRuntimeSecrets,
    }));
    vi.doMock("../src/setup/modal-auth.js", () => ({
      DEFAULT_MODAL_CODEX_AUTH_VOLUME: "dex-codex-auth",
      seedModalCodexAuth,
    }));

    vi.stubEnv("DEX_HANDOFF_SIGNING_KEY", "handoff-signing-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    process.argv = [
      process.execPath,
      "dex",
      "setup",
      "--no-service",
      "--skip-modal-smoke",
      "--project",
      "/tmp/project",
      "--pairing-code",
      "pair-code",
      "--device-name",
      "Test Mac",
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await import("../src/cli.js");

    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
    expect(pairMac).toHaveBeenCalledWith(expect.objectContaining({
      pairingCode: "pair-code",
      deviceName: "Test Mac",
    }));
    expect(runDoctor).toHaveBeenCalledOnce();
    expect(seedModalCodexAuth).toHaveBeenCalledOnce();
    expect(persistRuntimeSecrets).toHaveBeenCalledOnce();
    expect(modalConstructor).not.toHaveBeenCalled();
    expect(machineConstructor).not.toHaveBeenCalled();
    expect(installRuntime).not.toHaveBeenCalled();
    expect(installLaunchAgent).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(
      paths.config,
      expect.stringContaining('"deviceId": "device-1"'),
      { mode: 0o600 },
    );
    expect(log.mock.calls.flat().join("\n")).toContain("You're done. Close Terminal and text Dex.");
  });
});

async function mockServiceDependencies(options: {
  existingPlist?: string;
  bootstrapExitCode?: number;
  kickstartExitCode?: number;
} = {}) {
  const cp = vi.fn(async () => undefined);
  const mkdir = vi.fn(async () => undefined);
  const readFile = options.existingPlist === undefined
    ? vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })
    : vi.fn(async () => options.existingPlist!);
  const writeFile = vi.fn(async () => undefined);
  const execFile = vi.fn(async (command: string, args: readonly string[]) => {
    const operation = args[0];
    if (command === "launchctl" && operation === "bootout") {
      return { stdout: "", stderr: "not loaded", exitCode: 3 };
    }
    if (command === "launchctl" && operation === "bootstrap") {
      return {
        stdout: "",
        stderr: options.bootstrapExitCode ? "bootstrap failed" : "",
        exitCode: options.bootstrapExitCode ?? 0,
      };
    }
    if (command === "launchctl" && operation === "kickstart") {
      return {
        stdout: "",
        stderr: options.kickstartExitCode ? "kickstart failed" : "",
        exitCode: options.kickstartExitCode ?? 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  vi.doMock("node:fs/promises", async () => ({
    ...await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
    cp,
    mkdir,
    readFile,
    writeFile,
  }));
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...actual,
      default: { ...actual, homedir: () => "/Users/tester" },
      homedir: () => "/Users/tester",
    };
  });
  vi.doMock("../src/utils/exec.js", () => ({ execFile }));
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  vi.spyOn(process, "getuid").mockReturnValue(123);
  const service = await import("../src/setup/service.js");
  return { ...service, cp, mkdir, readFile, writeFile, execFile };
}

const paths = {
  home: "/Users/tester/.dex",
  config: "/Users/tester/.dex/config.json",
  state: "/Users/tester/.dex/state.json",
  events: "/Users/tester/.dex/events.jsonl",
  daemonPid: "/Users/tester/.dex/daemon.pid",
  daemonLog: "/Users/tester/.dex/logs/daemon & errors.log",
  powerState: "/Users/tester/.dex/power-state.json",
  worktrees: "/Users/tester/.dex/worktrees",
  handoffs: "/Users/tester/.dex/handoffs",
  runtime: "/Users/tester/.dex/runtime",
  controlSocket: "/Users/tester/.dex/runtime/control.sock",
};

describe("runtime and LaunchAgent installation", () => {
  it("copies the packed runtime inputs and installs production dependencies through a fake runner", async () => {
    const { installRuntime, cp, mkdir, execFile } = await mockServiceDependencies();

    await expect(installRuntime(paths, "0.0.1")).resolves.toBe(
      "/Users/tester/.dex/runtime/0.0.1",
    );
    expect(mkdir).toHaveBeenCalledWith("/Users/tester/.dex/runtime/0.0.1", {
      recursive: true,
      mode: 0o700,
    });
    expect(cp.mock.calls.map((call) => path.basename(String(call[1])))).toEqual([
      "dist",
      "package.json",
      "README.md",
      "docs",
    ]);
    expect(execFile).toHaveBeenCalledWith(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: "/Users/tester/.dex/runtime/0.0.1" },
    );
  });

  it("writes an escaped plist and uses the expected launchctl lifecycle", async () => {
    vi.stubEnv("PATH", '/opt/Dex & Tools/"bin"/<current>');
    const { installLaunchAgent, mkdir, writeFile, execFile } = await mockServiceDependencies();
    const runtime = "/Users/tester/Dex & Runtime/current";

    await expect(installLaunchAgent(runtime, paths)).resolves.toBe(
      "/Users/tester/Library/LaunchAgents/com.dex.daemon.plist",
    );
    expect(mkdir).toHaveBeenCalledWith("/Users/tester/Library/LaunchAgents", {
      recursive: true,
    });
    expect(writeFile).toHaveBeenCalledOnce();
    const [plistPath, body, writeOptions] = writeFile.mock.calls[0]!;
    expect(plistPath).toBe("/Users/tester/Library/LaunchAgents/com.dex.daemon.plist");
    expect(writeOptions).toEqual({ mode: 0o600 });
    expect(body).toContain(`<string>${process.execPath}</string>`);
    expect(body).toContain("/Users/tester/Dex &amp; Runtime/current/dist/cli.js");
    expect(body).toContain("/Users/tester/.dex/logs/daemon &amp; errors.log");
    expect(body).toContain("/opt/Dex &amp; Tools/&quot;bin&quot;/&lt;current&gt;");
    expect(body).toContain("<key>DEX_HOME</key><string>/Users/tester/.dex</string>");
    expect(body).toContain("<string>daemon</string>");
    expect(execFile.mock.calls).toEqual([
      ["launchctl", [
        "bootout",
        "gui/123",
        "/Users/tester/Library/LaunchAgents/com.dex.daemon.plist",
      ]],
      ["launchctl", [
        "bootstrap",
        "gui/123",
        "/Users/tester/Library/LaunchAgents/com.dex.daemon.plist",
      ]],
      ["launchctl", ["kickstart", "-k", "gui/123/com.dex.daemon"]],
    ]);
  });

  it("does not rewrite an identical plist and stops when bootstrap fails", async () => {
    const first = await mockServiceDependencies();
    await first.installLaunchAgent("/runtime", paths);
    const body = String(first.writeFile.mock.calls[0]![1]);

    vi.restoreAllMocks();
    vi.resetModules();
    const second = await mockServiceDependencies({ existingPlist: body, bootstrapExitCode: 5 });
    await expect(second.installLaunchAgent("/runtime", paths)).rejects.toThrow(
      "Could not start Dex background service: bootstrap failed",
    );
    expect(second.writeFile).not.toHaveBeenCalled();
    expect(second.execFile.mock.calls.map((call) => call[1][0])).toEqual([
      "bootout",
      "bootstrap",
    ]);
  });

  it("reports a kickstart failure after installing the LaunchAgent", async () => {
    const service = await mockServiceDependencies({ kickstartExitCode: 5 });

    await expect(service.installLaunchAgent("/runtime", paths)).rejects.toThrow(
      "Dex background service was installed but did not start: kickstart failed",
    );
    expect(service.execFile.mock.calls.map((call) => call[1][0])).toEqual([
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
  });
});
