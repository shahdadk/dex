import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
  vi.unstubAllGlobals();
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
  it("generates short, unambiguous human pairing codes", async () => {
    const { generatePairingCode, PAIRING_CODE_LENGTH } = await import("../src/setup/onboarding.js");
    const codes = Array.from({ length: 100 }, () => generatePairingCode());

    expect(PAIRING_CODE_LENGTH).toBe(6);
    expect(codes).toEqual(codes.map((code) => expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/)));
  });

  it("retries with fake time and returns a verified pairing without real sleeps", async () => {
    vi.useFakeTimers();
    const identity = {
      deviceId: "device-1",
      keyId: "device-key-1",
      ownerId: "owner-1",
      pairedConversationId: "conversation-1",
    };
    const events: string[] = [];
    const loadIdentity = vi.fn(async () => {
      events.push("identity");
      return null;
    });
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
      preflight: async () => { events.push("preflight"); },
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
    expect(events.slice(0, 2)).toEqual(["preflight", "identity"]);
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
      preflight: async () => undefined,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      message: expect.stringContaining("Phone pairing timed out"),
      cause: lastFailure,
    });

    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(pair).toHaveBeenCalledTimes(3);
  });

  it("fails preflight before loading or consuming a pairing", async () => {
    const loadIdentity = vi.fn(async () => null);
    const pair = vi.fn();
    vi.doMock("../src/local/pairing/index.js", () => ({
      MacOSDexKeychain: class FakeKeychain {},
      DexPairingService: class FakePairingService {
        loadIdentity = loadIdentity;
        pair = pair;
      },
    }));
    const { pairMac } = await import("../src/setup/onboarding.js");

    await expect(pairMac({
      config: config(),
      pairingCode: "ABC234",
      deviceName: "Test Mac",
      preflight: async () => { throw new Error("missing prerequisite"); },
    })).rejects.toThrow("missing prerequisite");
    expect(loadIdentity).not.toHaveBeenCalled();
    expect(pair).not.toHaveBeenCalled();
  });

  it("requires credentials, healthy tools, Modal, and ChatGPT auth in setup preflight", async () => {
    const doctor = vi.fn(async () => [
      { name: "Node", status: "pass" as const, detail: "Node 22" },
      { name: "Modal", status: "pass" as const, detail: "authenticated" },
    ]);
    const validateCodexAuth = vi.fn(async () => undefined);
    const { runSetupPreflight } = await import("../src/setup/onboarding.js");

    await expect(runSetupPreflight(config(), {
      env: { DEX_HANDOFF_SIGNING_KEY: "handoff", GEMINI_API_KEY: "gemini" },
      doctor,
      validateCodexAuth,
    })).resolves.toHaveLength(2);
    expect(doctor).toHaveBeenCalledOnce();
    expect(validateCodexAuth).toHaveBeenCalledOnce();

    await expect(runSetupPreflight(config(), {
      env: {},
      doctor,
      validateCodexAuth,
    })).rejects.toThrow("DEX_HANDOFF_SIGNING_KEY and GEMINI_API_KEY");
    expect(doctor).toHaveBeenCalledOnce();
    expect(validateCodexAuth).toHaveBeenCalledOnce();
  });
});

describe("Modal Codex auth setup", () => {
  async function authFixture(): Promise<{ directory: string; authPath: string }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-setup-auth-"));
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "access", refresh_token: "refresh", id_token: "id" },
    }), { mode: 0o600 });
    return { directory, authPath };
  }

  function fakeModal(modeExitCode = 0) {
    const executions: string[][] = [];
    const sandbox = {
      sandboxId: "sb-setup-auth",
      exec: vi.fn(async (argv: string[]) => {
        executions.push(argv);
        const isModeCheck = argv[0] === "node" && argv.some((part) => part.includes("auth.auth_mode"));
        return {
          stdout: { readText: async () => "" },
          stderr: { readText: async () => "" },
          wait: async () => isModeCheck ? modeExitCode : 0,
        };
      }),
      terminate: vi.fn(async () => undefined),
    };
    return {
      executions,
      modal: {
        create: vi.fn(async () => sandbox),
        close: vi.fn(async () => undefined),
      },
    };
  }

  it.each([
    { remote: false, disposition: "seeded" as const },
    { remote: true, disposition: "reused" as const },
  ])("reports $disposition account auth idempotently", async ({ remote, disposition }) => {
    const fixture = await authFixture();
    try {
      const report = vi.fn();
      const runner = vi.fn(async (_command: string, args: readonly string[]) => {
        if (args[1] === "ls") {
          return remote
            ? { stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]), stderr: "", exitCode: 0 }
            : { stdout: "", stderr: "No such file or directory", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const fake = fakeModal();
      const { seedModalCodexAuth } = await import("../src/setup/modal-auth.js");

      const result = await seedModalCodexAuth({
        authPath: fixture.authPath,
        volumeName: "private-auth",
        leasePath: path.join(fixture.directory, "account.lease"),
        operationToken: "6".repeat(64),
        runner,
        modal: fake.modal as never,
        report,
      });

      expect(result).toEqual({ volumeName: "private-auth" });
      expect(result.disposition).toBe(disposition);
      expect(report).toHaveBeenCalledWith(result);
      expect(runner.mock.calls.some(([, args]) => args.includes("put"))).toBe(!remote);
      expect(fake.executions.some((argv) => argv.some((part) => part.includes("auth.auth_mode")))).toBe(true);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects reused remote auth unless its cache is structurally ChatGPT mode", async () => {
    const fixture = await authFixture();
    try {
      const runner = vi.fn(async (_command: string, args: readonly string[]) => args[1] === "ls"
        ? { stdout: JSON.stringify([{ filename: "auth.json", type: "file" }]), stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 });
      const fake = fakeModal(1);
      const { seedModalCodexAuth } = await import("../src/setup/modal-auth.js");

      await expect(seedModalCodexAuth({
        authPath: fixture.authPath,
        volumeName: "private-auth",
        leasePath: path.join(fixture.directory, "account.lease"),
        operationToken: "7".repeat(64),
        runner,
        modal: fake.modal as never,
      })).rejects.toThrow("not a ChatGPT account login");
      expect(runner.mock.calls.some(([, args]) => args.includes("put"))).toBe(false);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
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
    const waitForHealthySignedTransport = vi.fn();
    const installRuntime = vi.fn(async () => "/tmp/runtime");
    const installLaunchAgent = vi.fn(async () => "/tmp/agent.plist");
    const pairMac = vi.fn(async () => ({
      deviceId: "device-1",
      keyId: "device-key-1",
      ownerId: "owner-1",
      pairedConversationId: "conversation-1",
    }));
    const persistRuntimeSecrets = vi.fn(async () => undefined);
    const deviceVolume = "dex-codex-auth-aabbccddeeff00112233";
    const seedModalCodexAuth = vi.fn(async () => {
      expect(writeFile).not.toHaveBeenCalled();
      return { volumeName: deviceVolume };
    });
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
      modalCodexAuthVolumeForDevice: vi.fn(() => deviceVolume),
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
      waitForHealthySignedTransport,
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
      seedModalCodexAuth,
    }));

    vi.stubEnv("DEX_HANDOFF_SIGNING_KEY", "handoff-signing-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    vi.stubEnv("DEX_MODAL_CODEX_AUTH_VOLUME", "");
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
    expect(runDoctor).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "device-1" }), {
      signedTransportMode: "preinstall",
    });
    expect(runDoctor).toHaveBeenCalledOnce();
    expect(seedModalCodexAuth).toHaveBeenCalledOnce();
    expect(seedModalCodexAuth).toHaveBeenCalledWith({
      volumeName: deviceVolume,
      leasePath: path.join(paths.handoffs, ".codex-account-auth.lease"),
    });
    expect(persistRuntimeSecrets).toHaveBeenCalledOnce();
    expect(modalConstructor).not.toHaveBeenCalled();
    expect(machineConstructor).not.toHaveBeenCalled();
    expect(installRuntime).not.toHaveBeenCalled();
    expect(installLaunchAgent).not.toHaveBeenCalled();
    expect(waitForHealthySignedTransport).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(
      paths.config,
      expect.stringMatching(new RegExp(`"deviceId": "device-1"[\\s\\S]*"modalCodexAuthVolume": "${deviceVolume}"`)),
      { mode: 0o600 },
    );
    expect(process.env.DEX_MODAL_CODEX_AUTH_VOLUME).toBe(deviceVolume);
    expect(log.mock.calls.flat().join("\n")).toContain("signed transport were not started");
    expect(log.mock.calls.flat().join("\n")).not.toContain("You're done. Close Terminal and text Dex.");
  });

  it("repairs stale pre-install health and completes only after a new signed daemon sync", async () => {
    const result = await runServiceSetupCommand();

    expect(result.error).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
    expect(result.runDoctor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ deviceId: "device-1" }),
      { signedTransportMode: "preinstall" },
    );
    expect(result.waitForHealthySignedTransport).toHaveBeenCalledWith(expect.objectContaining({
      loadState: expect.any(Function),
      afterRevision: 8,
      notBefore: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      previousLastSuccessAt: "2026-08-24T11:00:00.000Z",
    }));
    expect(result.runDoctor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deviceId: "device-1" }),
    );
    expect(result.installLaunchAgent).toHaveBeenCalledOnce();
    expect(result.log.mock.calls.flat().join("\n")).toContain(
      "You're done. Close Terminal and text Dex.",
    );
  });

  it("does not claim setup completion when post-install signed sync times out", async () => {
    const timeout = new Error(
      "Dex background service did not record a new healthy signed cloud sync within 45s",
    );
    const result = await runServiceSetupCommand({ waitError: timeout });

    expect(process.exitCode).toBe(1);
    expect(result.installLaunchAgent).toHaveBeenCalledOnce();
    expect(result.waitForHealthySignedTransport).toHaveBeenCalledOnce();
    expect(result.runDoctor).toHaveBeenCalledOnce();
    expect(result.error.mock.calls.flat().join("\n")).toContain(timeout.message);
    expect(result.log.mock.calls.flat().join("\n")).not.toContain(
      "You're done. Close Terminal and text Dex.",
    );
  });
});

async function runServiceSetupCommand(options: { waitError?: Error } = {}) {
  const setupPaths = {
    home: "/tmp/dex-service-setup-test",
    config: "/tmp/dex-service-setup-test/config.json",
    state: "/tmp/dex-service-setup-test/state.json",
    events: "/tmp/dex-service-setup-test/events.jsonl",
    daemonPid: "/tmp/dex-service-setup-test/daemon.pid",
    daemonLog: "/tmp/dex-service-setup-test/daemon.log",
    powerState: "/tmp/dex-service-setup-test/power-state.json",
    worktrees: "/tmp/dex-service-setup-test/worktrees",
    handoffs: "/tmp/dex-service-setup-test/handoffs",
    runtime: "/tmp/dex-service-setup-test/runtime",
    controlSocket: "/tmp/dex-service-setup-test/runtime/control.sock",
  };
  const state: {
    projects: Record<string, unknown>;
    revision: number;
    signedTransportHealth: {
      status: "healthy";
      consecutiveFailures: 0;
      lastAttemptAt: string;
      lastSuccessAt: string;
    };
  } = {
    projects: {},
    revision: 7,
    signedTransportHealth: {
      status: "healthy",
      consecutiveFailures: 0,
      lastAttemptAt: "2026-08-24T11:00:00.000Z",
      lastSuccessAt: "2026-08-24T11:00:00.000Z",
    },
  };
  const writeFile = vi.fn(async () => undefined);
  const runDoctor = vi.fn(async () => [
    { name: "Node", status: "pass" as const, detail: "Node 22" },
    { name: "Dex Cloud", status: "pass" as const, detail: "signed sync healthy" },
    { name: "Dex Cloud readiness", status: "pass" as const, detail: "/readyz reachable" },
    { name: "Modal", status: "pass" as const, detail: "authenticated" },
  ]);
  const waitForHealthySignedTransport = options.waitError
    ? vi.fn(async () => { throw options.waitError; })
    : vi.fn(async () => ({
        status: "healthy" as const,
        consecutiveFailures: 0 as const,
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
      }));
  const installRuntime = vi.fn(async () => "/tmp/dex-runtime");
  const installLaunchAgent = vi.fn(async () => "/tmp/com.dex.daemon.plist");
  const deviceVolume = "dex-codex-auth-aabbccddeeff00112233";

  vi.doMock("node:fs/promises", async () => ({
    ...await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
    writeFile,
  }));
  vi.doMock("../src/config/config.js", () => ({
    DexConfigSchema: { parse: (value: unknown) => value },
    loadConfig: vi.fn(async () => config()),
    modalCodexAuthVolumeForDevice: vi.fn(() => deviceVolume),
  }));
  vi.doMock("../src/config/paths.js", () => ({ resolveDexPaths: () => setupPaths }));
  vi.doMock("../src/daemon.js", () => ({ runDaemon: vi.fn() }));
  vi.doMock("../src/state/store.js", () => ({
    DexStateStore: class FakeStateStore {
      read = vi.fn(async () => structuredClone(state));
      updateState = vi.fn(async (mutator: (draft: typeof state) => void) => {
        mutator(state);
        state.revision += 1;
        return structuredClone(state);
      });
    },
  }));
  vi.doMock("../src/setup/doctor.js", () => ({
    runDoctor,
    formatDoctor: (_checks: unknown, title: string) => `${title}\n\nReady.`,
    waitForHealthySignedTransport,
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
  vi.doMock("../src/cloud/modal/adapter.js", () => ({
    ModalAdapter: class FakeModalAdapter {},
  }));
  vi.doMock("../src/setup/onboarding.js", () => ({
    detectMacName: vi.fn(async () => "Test Mac"),
    pairMac: vi.fn(async () => ({
      deviceId: "device-1",
      keyId: "device-key-1",
      ownerId: "owner-1",
      pairedConversationId: "conversation-1",
    })),
  }));
  vi.doMock("../src/local/daemon/control-socket.js", () => ({ sendControlCommand: vi.fn() }));
  vi.doMock("../src/local/pairing/secrets.js", () => ({
    hydrateRuntimeSecrets: vi.fn(async () => undefined),
    persistRuntimeSecrets: vi.fn(async () => undefined),
  }));
  vi.doMock("../src/setup/modal-auth.js", () => ({
    seedModalCodexAuth: vi.fn(async () => ({ volumeName: deviceVolume, disposition: "reused" })),
  }));

  vi.stubEnv("DEX_HANDOFF_SIGNING_KEY", "handoff-signing-key");
  vi.stubEnv("GEMINI_API_KEY", "gemini-key");
  process.exitCode = undefined;
  process.argv = [
    process.execPath,
    "dex",
    "setup",
    "--skip-modal-smoke",
    "--project",
    "/tmp/project",
    "--device-name",
    "Test Mac",
  ];
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await import("../src/cli.js");

  return {
    runDoctor,
    waitForHealthySignedTransport,
    installLaunchAgent,
    log,
    error,
  };
}

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
      ".env.example",
    ]);
    expect(execFile).toHaveBeenCalledWith(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: "/Users/tester/.dex/runtime/0.0.1" },
    );
  });

  it("writes an escaped plist and uses the expected launchctl lifecycle", async () => {
    vi.stubEnv("PATH", '/opt/Dex & Tools/"bin"/<current>');
    vi.stubEnv("DEX_DEVICE_KEY_ID", "device-key-custom");
    vi.stubEnv("DEX_MODAL_CODEX_AUTH_VOLUME", "auth-volume-custom");
    vi.stubEnv("DEX_MODAL_SECRET_NAME", "worker-secret-custom");
    vi.stubEnv("CLAUDE_MEM_WORKER_URL", "http://127.0.0.1:47777/a&b");
    const { installLaunchAgent, mkdir, writeFile, execFile } = await mockServiceDependencies();
    const runtime = "/Users/tester/Dex & Runtime/current";
    const probeControlSocket = vi.fn(async () => undefined);

    await expect(installLaunchAgent(runtime, paths, {
      probeControlSocket,
      codexAuthVolumeName: "auth-volume-device-specific",
    })).resolves.toBe(
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
    expect(body).toContain("<key>DEX_DEVICE_KEY_ID</key><string>device-key-custom</string>");
    expect(body).toContain("<key>DEX_MODAL_CODEX_AUTH_VOLUME</key><string>auth-volume-device-specific</string>");
    expect(body).toContain("<key>DEX_MODAL_SECRET_NAME</key><string>worker-secret-custom</string>");
    expect(body).toContain("<key>CLAUDE_MEM_WORKER_URL</key><string>http://127.0.0.1:47777/a&amp;b</string>");
    expect(body).toContain("<string>daemon</string>");
    expect(probeControlSocket).toHaveBeenCalledWith(paths.controlSocket);
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
    await first.installLaunchAgent("/runtime", paths, { probeControlSocket: async () => undefined });
    const body = String(first.writeFile.mock.calls[0]![1]);

    vi.restoreAllMocks();
    vi.resetModules();
    const second = await mockServiceDependencies({ existingPlist: body, bootstrapExitCode: 5 });
    await expect(second.installLaunchAgent("/runtime", paths, {
      probeControlSocket: async () => undefined,
    })).rejects.toThrow(
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

  it("waits for the daemon control socket and fails if readiness never arrives", async () => {
    const service = await mockServiceDependencies();
    const wait = vi.fn(async () => undefined);
    const eventuallyReady = vi.fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(undefined);
    await expect(service.installLaunchAgent("/runtime", paths, {
      probeControlSocket: eventuallyReady,
      wait,
      readinessTimeoutMs: 1_000,
    })).resolves.toContain("com.dex.daemon.plist");
    expect(eventuallyReady).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();

    const neverReady = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(service.installLaunchAgent("/runtime", paths, {
      probeControlSocket: neverReady,
      readinessTimeoutMs: 0,
    })).rejects.toThrow("control socket did not become ready");
  });
});

describe("persisted LaunchAgent runtime settings", () => {
  it("stores custom Modal and Claude-Mem settings with the Modal token ID", async () => {
    const saved: unknown[] = [];
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      saved.push(JSON.parse(args.at(-1)!));
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    vi.doMock("../src/utils/exec.js", () => ({ execFile }));
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
    vi.stubEnv("MODAL_TOKEN_ID", "modal-key-id");
    vi.stubEnv("MODAL_TOKEN_SECRET", "modal-secret");
    vi.stubEnv("DEX_MODAL_SECRET_NAME", "workers-custom");
    vi.stubEnv("DEX_MODAL_CODEX_AUTH_VOLUME", "auth-custom");
    vi.stubEnv("CLAUDE_MEM_WORKER_URL", "http://127.0.0.1:48888");
    vi.stubEnv("CLAUDE_MEM_DATA_DIR", "/Users/tester/claude-mem-custom");
    const { persistRuntimeSecrets } = await import("../src/local/pairing/secrets.js");

    await persistRuntimeSecrets();

    expect(saved).toEqual([expect.objectContaining({
      MODAL_TOKEN_ID: "modal-key-id",
      MODAL_TOKEN_SECRET: "modal-secret",
      DEX_MODAL_SECRET_NAME: "workers-custom",
      DEX_MODAL_CODEX_AUTH_VOLUME: "auth-custom",
      CLAUDE_MEM_WORKER_URL: "http://127.0.0.1:48888",
      CLAUDE_MEM_DATA_DIR: "/Users/tester/claude-mem-custom",
    })]);
  });
});

describe("doctor cloud wording", () => {
  it("treats signed transport as pending during pre-install while still probing readiness", async () => {
    const { dexCloudChecks } = await import("../src/setup/doctor.js");
    const loadState = vi.fn(async () => { throw new Error("stale state must not block repair"); });
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(dexCloudChecks({
      ...config(),
      deviceId: "device-1",
    }, {
      signedTransportMode: "preinstall",
      loadState,
      fetch,
    })).resolves.toEqual([
      expect.objectContaining({
        name: "Dex Cloud",
        status: "warn",
        detail: expect.stringContaining("pending service installation or restart"),
      }),
      expect.objectContaining({ name: "Dex Cloud readiness", status: "pass" }),
    ]);
    expect(loadState).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();

    const unavailable = await dexCloudChecks({
      ...config(),
      deviceId: "device-1",
    }, {
      signedTransportMode: "preinstall",
      loadState,
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    });
    expect(unavailable[0]).toMatchObject({ name: "Dex Cloud", status: "warn" });
    expect(unavailable[1]).toMatchObject({ name: "Dex Cloud readiness", status: "fail" });
  });

  it("waits through stale pre-install health for a new daemon-signed success", async () => {
    const { waitForHealthySignedTransport } = await import("../src/setup/doctor.js");
    let clock = Date.parse("2026-08-24T12:00:00.000Z");
    const stale = {
      version: 1 as const,
      revision: 10,
      projects: {},
      tasks: {},
      workers: {},
      pendingMachineActions: [],
      pendingConversationPrompts: [],
      pendingSessionSelections: {},
      processedMessageIds: [],
      pendingTransportEvents: [],
      pendingTransportReceipts: [],
      signedTransportHealth: {
        status: "healthy" as const,
        consecutiveFailures: 0 as const,
        lastAttemptAt: "2026-08-24T11:58:00.000Z",
        lastSuccessAt: "2026-08-24T11:58:00.000Z",
      },
    };
    const repaired = {
      ...stale,
      revision: 11,
      signedTransportHealth: {
        status: "healthy" as const,
        consecutiveFailures: 0 as const,
        lastAttemptAt: "2026-08-24T12:00:00.200Z",
        lastSuccessAt: "2026-08-24T12:00:00.200Z",
      },
    };
    const loadState = vi.fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(repaired);
    const wait = vi.fn(async (ms: number) => { clock += ms; });

    await expect(waitForHealthySignedTransport({
      loadState,
      afterRevision: 10,
      notBefore: "2026-08-24T12:00:00.000Z",
      previousLastSuccessAt: "2026-08-24T11:58:00.000Z",
      timeoutMs: 45_000,
      pollMs: 250,
      now: () => clock,
      wait,
    })).resolves.toEqual(repaired.signedTransportHealth);
    expect(loadState).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it("bounds post-install waiting when signed transport never becomes healthy", async () => {
    const { waitForHealthySignedTransport } = await import("../src/setup/doctor.js");
    let clock = Date.parse("2026-08-24T12:00:00.000Z");
    const wait = vi.fn(async (ms: number) => { clock += ms; });
    const loadState = vi.fn(async () => ({
      version: 1 as const,
      revision: 11,
      projects: {},
      tasks: {},
      workers: {},
      pendingMachineActions: [],
      pendingConversationPrompts: [],
      pendingSessionSelections: {},
      processedMessageIds: [],
      pendingTransportEvents: [],
      pendingTransportReceipts: [],
      signedTransportHealth: {
        status: "degraded" as const,
        consecutiveFailures: 2,
        lastAttemptAt: "2026-08-24T12:00:00.000Z",
        lastError: "http" as const,
      },
    }));

    await expect(waitForHealthySignedTransport({
      loadState,
      afterRevision: 10,
      notBefore: "2026-08-24T12:00:00.000Z",
      timeoutMs: 500,
      pollMs: 250,
      now: () => clock,
      wait,
    })).rejects.toThrow(/did not record a new healthy signed cloud sync.*degraded/i);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(loadState).toHaveBeenCalledTimes(3);
  });

  it("passes only when signed daemon sync is recent and reports /readyz separately", async () => {
    const { dexCloudChecks } = await import("../src/setup/doctor.js");
    const state = {
      version: 1 as const,
      revision: 0,
      projects: {},
      tasks: {},
      workers: {},
      pendingMachineActions: [],
      pendingConversationPrompts: [],
      pendingSessionSelections: {},
      processedMessageIds: [],
      pendingTransportEvents: [],
      pendingTransportReceipts: [],
      signedTransportHealth: {
        status: "healthy" as const,
        consecutiveFailures: 0 as const,
        lastAttemptAt: "2026-08-24T12:00:20.000Z",
        lastSuccessAt: "2026-08-24T12:00:20.000Z",
      },
    };
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const checks = await dexCloudChecks({
      ...config(),
      deviceId: "device-1",
    }, {
      now: () => Date.parse("2026-08-24T12:00:30.000Z"),
      loadState: async () => state,
      fetch,
    });

    expect(checks).toEqual([
      expect.objectContaining({
        name: "Dex Cloud",
        status: "pass",
        detail: expect.stringContaining("signed daemon sync succeeded 10s ago"),
      }),
      expect.objectContaining({
        name: "Dex Cloud readiness",
        status: "pass",
        detail: "/readyz is reachable (supporting check only)",
      }),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "stale",
      health: {
        status: "healthy" as const,
        consecutiveFailures: 0 as const,
        lastAttemptAt: "2026-08-24T11:58:00.000Z",
        lastSuccessAt: "2026-08-24T11:58:00.000Z",
      },
      detail: "stale",
    },
    {
      name: "degraded",
      health: {
        status: "degraded" as const,
        consecutiveFailures: 3,
        lastAttemptAt: "2026-08-24T12:00:29.000Z",
        lastSuccessAt: "2026-08-24T12:00:20.000Z",
        lastError: "http" as const,
      },
      detail: "degraded",
    },
  ])("fails when /readyz is 200 but signed transport is $name", async ({ health, detail }) => {
    const { dexCloudChecks } = await import("../src/setup/doctor.js");
    const checks = await dexCloudChecks({
      ...config(),
      deviceId: "device-1",
    }, {
      now: () => Date.parse("2026-08-24T12:00:30.000Z"),
      loadState: async () => ({
        version: 1,
        revision: 0,
        projects: {},
        tasks: {},
        workers: {},
        pendingMachineActions: [],
        pendingConversationPrompts: [],
        pendingSessionSelections: {},
        processedMessageIds: [],
        pendingTransportEvents: [],
        pendingTransportReceipts: [],
        signedTransportHealth: health,
      }),
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
    });

    expect(checks[0]).toMatchObject({ name: "Dex Cloud", status: "fail" });
    expect(checks[0]?.detail).toContain(detail);
    expect(checks[1]).toMatchObject({ name: "Dex Cloud readiness", status: "pass" });
  });

  it("keeps unpaired setup intuitive without probing cloud or local daemon state", async () => {
    const { dexCloudChecks } = await import("../src/setup/doctor.js");
    const loadState = vi.fn();
    const fetch = vi.fn();

    await expect(dexCloudChecks(config(), { loadState, fetch })).resolves.toEqual([
      expect.objectContaining({
        name: "Dex Cloud",
        status: "warn",
        detail: "not paired yet",
      }),
    ]);
    expect(loadState).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a paired-but-unobserved daemon without treating readiness as signed health", async () => {
    const { dexCloudChecks } = await import("../src/setup/doctor.js");
    const checks = await dexCloudChecks({
      ...config(),
      deviceId: "device-1",
    }, {
      loadState: async () => ({
        version: 1,
        revision: 0,
        projects: {},
        tasks: {},
        workers: {},
        pendingMachineActions: [],
        pendingConversationPrompts: [],
        pendingSessionSelections: {},
        processedMessageIds: [],
        pendingTransportEvents: [],
        pendingTransportReceipts: [],
      }),
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
    });

    expect(checks[0]).toMatchObject({ name: "Dex Cloud", status: "warn" });
    expect(checks[0]?.detail).toContain("daemon may be unavailable");
    expect(checks[1]).toMatchObject({ name: "Dex Cloud readiness", status: "pass" });
  });
});
