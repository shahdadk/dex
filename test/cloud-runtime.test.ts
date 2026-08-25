import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDexDeviceKeyPair } from "../src/cloud/messaging/index.js";
import type { ModalAdapter, ModalSandbox } from "../src/cloud/modal/index.js";
import { ModalMonitorLeaseBusyError } from "../src/cloud/modal-monitor/index.js";
import {
  AtomicFileStateBackend,
  CloudSqlPostgresStateBackend,
  DurableDexCloudRepository,
  DurableModalMonitorOnce,
  PostgresStateBackend,
} from "../src/cloud/persistence/index.js";
import {
  ConfiguredAssociationVerifier,
  DeterministicMonitorRunner,
  createDexCloudRuntime,
  loadDexCloudConfig,
  type DexCloudConfig,
} from "../src/cloud/runtime/index.js";

const NOW_ISO = "2026-08-23T18:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const PHONE = "+14165550123";
const DEX_LINE = "+14165550999";
const HASH = "a".repeat(64);
const directories: string[] = [];

async function stateFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "dex-cloud-runtime-"));
  directories.push(directory);
  return path.join(directory, "state.json");
}

function config(filePath: string): DexCloudConfig {
  return {
    environment: "test",
    persistence: { kind: "file", filePath },
    signingKey: generateDexDeviceKeyPair(),
    ownerAssociations: [{
      ownerId: "owner-1",
      conversationId: "conversation-1",
      phoneE164: PHONE,
    }],
    sendblue: {
      apiKeyId: "api-key-id",
      apiSecretKey: "api-secret-key",
      line: DEX_LINE,
      webhookSecret: "webhook-secret",
    },
    internalSecret: "internal-secret-at-least-sixteen",
    host: "127.0.0.1",
    port: 8080,
    workerId: "cloud-test-worker",
    pollIntervalMs: 1_000,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Dex Cloud environment and verified ownership", () => {
  it("requires PostgreSQL in production and loads a validated server signing key", async () => {
    const key = generateDexDeviceKeyPair();
    const base: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      DEX_SERVER_SIGNING_PRIVATE_KEY: key.privateKey,
      DEX_OWNER_ALLOWLIST_JSON: JSON.stringify([{
        ownerId: "owner-1",
        conversationId: "conversation-1",
        phoneE164: PHONE,
      }]),
      DEX_SENDBLUE_LINE: DEX_LINE,
      SENDBLUE_API_KEY_ID: "api-key-id",
      SENDBLUE_API_SECRET_KEY: "api-secret-key",
      DEX_SENDBLUE_WEBHOOK_SECRET: "webhook-secret",
      DEX_INTERNAL_SECRET: "internal-secret-at-least-sixteen",
    };
    await expect(loadDexCloudConfig(base)).rejects.toThrow("DEX_DATABASE_URL");

    await expect(loadDexCloudConfig({
      ...base,
      DEX_DATABASE_URL: "postgresql://dex:password@db.example.test/dex",
    })).rejects.toThrow("Cloud Tasks configuration is required");

    const cloudTasksEnv = {
      DEX_CLOUD_TASKS_PROJECT: "dex-project",
      DEX_CLOUD_TASKS_LOCATION: "northamerica-northeast1",
      DEX_CLOUD_TASKS_QUEUE: "modal-monitors",
      DEX_CLOUD_TASKS_SERVICE_URL: "https://dex.example.test",
      DEX_CLOUD_TASKS_AUDIENCE: "https://dex.example.test",
      DEX_CLOUD_TASKS_SERVICE_ACCOUNT: "tasks@dex-project.iam.gserviceaccount.com",
    };

    const loaded = await loadDexCloudConfig({
      ...base,
      DEX_DATABASE_URL: "postgresql://dex:password@db.example.test/dex",
      DEX_DATABASE_SSL_MODE: "verify-full",
      ...cloudTasksEnv,
    });
    expect(loaded.persistence).toMatchObject({ kind: "postgres", ssl: true });
    expect(loaded.signingKey).toMatchObject({
      algorithm: "ed25519",
      keyId: key.keyId,
      publicKey: key.publicKey,
    });
    expect(loaded.signingKey.privateKey).not.toBe("");

    const withCloudTasks = await loadDexCloudConfig({
      ...base,
      DEX_DATABASE_URL: "postgresql://dex:password@db.example.test/dex",
      ...cloudTasksEnv,
    });
    expect(withCloudTasks.cloudTasks).toEqual({
      project: "dex-project",
      location: "northamerica-northeast1",
      queue: "modal-monitors",
      serviceUrl: "https://dex.example.test",
      audience: "https://dex.example.test",
      serviceAccountEmail: "tasks@dex-project.iam.gserviceaccount.com",
    });
    await expect(loadDexCloudConfig({
      ...base,
      DEX_DATABASE_URL: "postgresql://dex:password@db.example.test/dex",
      DEX_CLOUD_TASKS_QUEUE: "modal-monitors",
    })).rejects.toThrow("DEX_CLOUD_TASKS_PROJECT");
    await expect(loadDexCloudConfig({
      ...base,
      DEX_DATABASE_URL: "postgresql://dex:password@db.example.test/dex",
      DEX_CLOUD_TASKS_PROJECT: "dex-project",
      DEX_CLOUD_TASKS_LOCATION: "northamerica-northeast1",
      DEX_CLOUD_TASKS_QUEUE: "modal-monitors",
      DEX_CLOUD_TASKS_SERVICE_URL: "http://dex.example.test",
      DEX_CLOUD_TASKS_AUDIENCE: "https://dex.example.test",
      DEX_CLOUD_TASKS_SERVICE_ACCOUNT: "tasks@dex-project.iam.gserviceaccount.com",
    })).rejects.toThrow("must be an HTTPS URL");

    const cloudSql = await loadDexCloudConfig({
      ...base,
      DEX_CLOUD_SQL_INSTANCE: "appfi-dev-80693:northamerica-northeast1:ai-employee-pg",
      DEX_CLOUD_SQL_DATABASE: "ai_employee",
      DEX_CLOUD_SQL_IAM_USER: "dex-cloud@appfi-dev-80693.iam",
      ...cloudTasksEnv,
    });
    expect(cloudSql.persistence).toEqual({
      kind: "cloud-sql",
      instanceConnectionName: "appfi-dev-80693:northamerica-northeast1:ai-employee-pg",
      database: "ai_employee",
      user: "dex-cloud@appfi-dev-80693.iam",
      ipType: "PUBLIC",
    });

    await expect(loadDexCloudConfig({
      ...base,
      DEX_DATABASE_URL: "postgresql://dex:password@db.example.test/dex",
      DEX_CLOUD_SQL_INSTANCE: "appfi-dev-80693:northamerica-northeast1:ai-employee-pg",
      DEX_CLOUD_SQL_DATABASE: "ai_employee",
      DEX_CLOUD_SQL_IAM_USER: "dex-cloud@appfi-dev-80693.iam",
    })).rejects.toThrow("Set only one");
  });

  it("accepts the existing Appfi Sendblue secret names without copying credentials", async () => {
    const key = generateDexDeviceKeyPair();
    const loaded = await loadDexCloudConfig({
      NODE_ENV: "test",
      DEX_SERVER_SIGNING_PRIVATE_KEY: key.privateKey,
      DEX_OWNER_ALLOWLIST_JSON: JSON.stringify([{
        ownerId: "owner-1",
        conversationId: "conversation-1",
        phoneE164: PHONE,
      }]),
      SENDBLUE_NUMBER: DEX_LINE,
      SENDBLUE_API_KEY_ID: "existing-key-id",
      SENDBLUE_API_SECRET: "existing-api-secret",
      SENDBLUE_WEBHOOK_SECRET: "existing-webhook-secret",
      DEX_INTERNAL_SECRET: "internal-secret-at-least-sixteen",
    });
    expect(loaded.sendblue).toMatchObject({
      line: DEX_LINE,
      apiKeyId: "existing-key-id",
      apiSecretKey: "existing-api-secret",
      webhookSecret: "existing-webhook-secret",
    });
  });

  it("fails closed for the wrong line, group context, or ambiguous allowlist", async () => {
    const verifier = new ConfiguredAssociationVerifier({
      sendblueNumber: DEX_LINE,
      associations: [
        { ownerId: "owner-1", conversationId: "direct", phoneE164: PHONE },
        {
          ownerId: "owner-1",
          conversationId: "group",
          phoneE164: PHONE,
          providerConversationId: "group-1",
        },
      ],
    });
    await expect(verifier.verify({
      provider: "sendblue",
      providerMessageId: "message-1",
      fromPhone: PHONE,
      toPhone: DEX_LINE,
    })).resolves.toEqual({
      ownerId: "owner-1",
      conversationId: "direct",
      phoneE164: PHONE,
    });
    await expect(verifier.verify({
      provider: "sendblue",
      providerMessageId: "message-2",
      fromPhone: PHONE,
      toPhone: DEX_LINE,
      providerConversationId: "unknown-group",
    })).resolves.toBeNull();
    await expect(verifier.verify({
      provider: "sendblue",
      providerMessageId: "message-3",
      fromPhone: PHONE,
      toPhone: "+14165550000",
    })).resolves.toBeNull();

    const ambiguous = new ConfiguredAssociationVerifier({
      sendblueNumber: DEX_LINE,
      associations: [
        { ownerId: "owner-1", conversationId: "one", phoneE164: PHONE },
        { ownerId: "owner-2", conversationId: "two", phoneE164: PHONE },
      ],
    });
    await expect(ambiguous.verify({
      provider: "sendblue",
      providerMessageId: "message-4",
      fromPhone: PHONE,
      toPhone: DEX_LINE,
    })).resolves.toBeNull();
  });
});

describe("durable outbox and monitor execution", () => {
  it("validates connection sources before opening Cloud SQL or PostgreSQL resources", () => {
    expect(() => new PostgresStateBackend({})).toThrow(
      "Exactly one PostgreSQL connection source is required",
    );
    expect(() => new PostgresStateBackend({
      databaseUrl: "postgresql://dex:password@db.example.test/dex",
      poolOptions: {
        stream: () => { throw new Error("must not connect"); },
        user: "dex",
        database: "dex",
      },
    })).toThrow("Exactly one PostgreSQL connection source is required");
    expect(() => new CloudSqlPostgresStateBackend({
      instanceConnectionName: "dex-project:northamerica-northeast1:dex",
      database: "dex",
      user: "dex@dex-project.iam",
      ipType: "PSC" as "PUBLIC",
    })).toThrow("Cloud SQL IP type must be PUBLIC or PRIVATE");
  });

  it("closes the file backend once and rejects readiness checks after shutdown", async () => {
    const backend = new AtomicFileStateBackend({ filePath: await stateFile() });
    await backend.ready();
    const first = backend.close();
    const second = backend.close();
    expect(second).toBe(first);
    await first;
    await expect(backend.ready()).rejects.toThrow("backend is closed");
  });

  it("persists control-plane state and reconciles after an ambiguous send without another POST", async () => {
    const filePath = await stateFile();
    const firstBackend = new AtomicFileStateBackend({ filePath });
    const first = new DurableDexCloudRepository({
      backend: firstBackend,
      sendblueReconciliationRetryMs: 1_000,
    });
    await first.commitUnpairedMessage("inbound-1", {
      id: "outbox-1",
      dedupeKey: "sendblue:inbound-1",
      ownerId: "owner-1",
      conversationId: "conversation-1",
      toPhone: PHONE,
      text: "Pair your Mac first.",
      createdAt: NOW_ISO,
    });
    await firstBackend.close();

    const secondBackend = new AtomicFileStateBackend({ filePath });
    const second = new DurableDexCloudRepository({
      backend: secondBackend,
      sendblueReconciliationRetryMs: 1_000,
    });
    expect(await second.hasProcessedInbound("inbound-1")).toBe(true);
    const send = await second.claimNext({
      workerId: "worker-a",
      claimedAt: NOW_ISO,
      leaseMs: 1_000,
    });
    expect(send).toMatchObject({ action: "send", attemptStartedAt: NOW_ISO });
    await second.recordAmbiguous({
      outboxId: "outbox-1",
      claimToken: send!.claimToken,
      attemptStartedAt: NOW_ISO,
      observedAt: NOW_ISO,
      reason: "network_failure",
    });
    await expect(second.claimNext({
      workerId: "worker-b",
      claimedAt: "2026-08-23T18:00:00.999Z",
      leaseMs: 1_000,
    })).resolves.toBeNull();
    const reconcile = await second.claimNext({
      workerId: "worker-b",
      claimedAt: "2026-08-23T18:00:01.000Z",
      leaseMs: 1_000,
    });
    expect(reconcile).toMatchObject({
      action: "reconcile",
      attemptStartedAt: NOW_ISO,
    });
    expect(reconcile?.claimToken).not.toBe(send?.claimToken);
    await secondBackend.close();
  });

  it("replays rejected device events as sequence-only history across acceptance-rule changes", async () => {
    const filePath = await stateFile();
    const firstBackend = new AtomicFileStateBackend({ filePath });
    const first = new DurableDexCloudRepository({ backend: firstBackend });
    await first.commitPairingChallenge("pair-message", {
      id: "pair-challenge",
      codeDigest: "1".repeat(64),
      issuedAt: NOW_ISO,
      expiresAt: "2026-08-23T19:00:00.000Z",
      ownerId: "owner-1",
      conversationId: "conversation-1",
      phoneE164: PHONE,
      sourceMessageId: "pair-message",
      attempts: 0,
      maxAttempts: 5,
    }, {
      id: "pair-notification",
      dedupeKey: "pair-notification",
      ownerId: "owner-1",
      conversationId: "conversation-1",
      toPhone: PHONE,
      text: "Pairing ready",
      createdAt: NOW_ISO,
    });
    await first.consumePairingChallenge({
      challengeId: "pair-challenge",
      codeDigest: "1".repeat(64),
      now: NOW_ISO,
      device: {
        id: "device-1",
        keyId: "device-key-1",
        publicKey: "public-key",
        ownerId: "owner-1",
        conversationId: "conversation-1",
        phoneE164: PHONE,
        deviceName: "Dex Mac",
        createdAt: NOW_ISO,
        lastSequence: 0,
      },
    });
    await first.commitDeviceSync({
      deviceId: "device-1",
      sequence: 1,
      events: [{
        id: "task-created",
        occurredAt: NOW_ISO,
        type: "task.created",
        taskId: "retryable-task",
        payload: {
          title: "Retryable task",
          originalRequest: "Continue this task",
          conversationId: "conversation-1",
        },
      }],
      receipts: [],
      commandLimit: 100,
      now: NOW_ISO,
    });
    await first.registerModalMonitor({
      taskId: "retryable-task",
      workerId: "worker-old",
      sandboxId: "sandbox-old",
      handoffSha256: "a".repeat(64),
      startedAt: NOW_ISO,
      resultPath: "/dex/result.json",
    }, NOW_ISO);
    await first.completeModalTaskAndEnqueue(
      "retryable-task",
      "old-completion",
      "failed",
      "The first attempt failed",
      {
        id: "old-completion-message",
        dedupeKey: "old-completion-message",
        ownerId: "owner-1",
        conversationId: "conversation-1",
        toPhone: PHONE,
        text: "The first attempt failed",
        createdAt: "2026-08-23T18:01:00.000Z",
        taskId: "retryable-task",
      },
      "2026-08-23T18:01:00.000Z",
    );

    await firstBackend.mutate((state) => {
      state.controlPlaneOperations.push({
        kind: "commit_device_sync",
        input: {
          deviceId: "device-1",
          sequence: 2,
          events: [{
            id: "historically-rejected-monitor",
            occurredAt: "2026-08-23T18:02:00.000Z",
            type: "modal.monitor.registered",
            taskId: "retryable-task",
            workerId: "worker-new",
            payload: {
              taskId: "retryable-task",
              workerId: "worker-new",
              sandboxId: "sandbox-new",
              handoffSha256: "b".repeat(64),
              startedAt: "2026-08-23T18:02:00.000Z",
              resultPath: "/dex/result.json",
            },
          }],
          receipts: [],
          commandLimit: 100,
          now: "2026-08-23T18:02:00.000Z",
        },
        expectedInvalidEvent: {
          eventId: "historically-rejected-monitor",
          message: "Task is already terminal",
        },
      });
    });
    await firstBackend.close();

    const secondBackend = new AtomicFileStateBackend({ filePath });
    const second = new DurableDexCloudRepository({ backend: secondBackend });
    await expect(second.getTask("retryable-task")).resolves.toMatchObject({
      status: "failed",
      monitor: { sandboxId: "sandbox-old", handoffSha256: "a".repeat(64) },
    });
    await expect(second.commitDeviceSync({
      deviceId: "device-1",
      sequence: 3,
      events: [],
      receipts: [],
      commandLimit: 100,
      now: "2026-08-23T18:03:00.000Z",
    })).resolves.toMatchObject({ nextSequence: 4 });
    await secondBackend.close();
  });

  it("retries a definitive 429 as a new bounded send attempt", async () => {
    const backend = new AtomicFileStateBackend({ filePath: await stateFile() });
    const repository = new DurableDexCloudRepository({
      backend,
      sendblueRetryMs: 1_000,
    });
    await repository.commitUnpairedMessage("rate-limited-inbound", {
      id: "rate-limited-outbox",
      dedupeKey: "sendblue:rate-limited-inbound",
      ownerId: "owner-1",
      conversationId: "conversation-1",
      toPhone: PHONE,
      text: "Retry this confirmed non-delivery.",
      createdAt: NOW_ISO,
    });
    const first = await repository.claimNext({
      workerId: "worker-a",
      claimedAt: NOW_ISO,
      leaseMs: 1_000,
    });
    expect(first).toMatchObject({ action: "send", sendAttempt: 1 });
    await repository.recordRejected({
      outboxId: "rate-limited-outbox",
      claimToken: first!.claimToken,
      rejectedAt: NOW_ISO,
      reason: "request_rejected",
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 2_000,
    });
    await expect(repository.claimNext({
      workerId: "worker-b",
      claimedAt: "2026-08-23T18:00:01.999Z",
      leaseMs: 1_000,
    })).resolves.toBeNull();
    await expect(repository.claimNext({
      workerId: "worker-b",
      claimedAt: "2026-08-23T18:00:02.000Z",
      leaseMs: 1_000,
    })).resolves.toMatchObject({
      action: "send",
      sendAttempt: 2,
      attemptStartedAt: "2026-08-23T18:00:02.000Z",
    });
    await backend.close();
  });

  it("does not acknowledge a duplicate while another durable monitor effect owns the lease", async () => {
    const backend = new AtomicFileStateBackend({ filePath: await stateFile() });
    let release!: () => void;
    let started!: () => void;
    const effectStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = new DurableModalMonitorOnce({
      backend,
      workerId: "monitor-a",
      now: () => NOW,
      leaseMs: 10_000,
    });
    const duplicate = new DurableModalMonitorOnce({
      backend,
      workerId: "monitor-b",
      now: () => NOW + 1_000,
      leaseMs: 10_000,
    });
    const execution = first.runOnce("modal-monitor:task-1:terminal", async () => {
      started();
      await gate;
    });
    await effectStarted;

    await expect(duplicate.runOnce(
      "modal-monitor:task-1:terminal",
      async () => undefined,
    )).rejects.toBeInstanceOf(ModalMonitorLeaseBusyError);
    release();
    await expect(execution).resolves.toBe(true);
    await expect(duplicate.runOnce(
      "modal-monitor:task-1:terminal",
      async () => undefined,
    )).resolves.toBe(false);
    await backend.close();
  });

  it("executes due monitor jobs in stable order and durably schedules deterministic retries", async () => {
    const backend = new AtomicFileStateBackend({ filePath: await stateFile() });
    const repository = new DurableDexCloudRepository({ backend });
    const clock = { value: NOW };
    const sandbox = {
      poll: vi.fn(async () => null),
      detach: vi.fn(async () => undefined),
      terminate: vi.fn(async () => undefined),
      copyToLocal: vi.fn(async () => {
        throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
      }),
    } as unknown as ModalSandbox;
    const modal = { fromId: vi.fn(async () => sandbox) } as unknown as Pick<ModalAdapter, "fromId">;
    const terminal = vi.fn(async () => undefined);
    const runner = new DeterministicMonitorRunner({
      repository,
      modal,
      once: new DurableModalMonitorOnce({
        backend,
        workerId: "monitor-worker",
        now: () => clock.value,
      }),
      onTerminal: terminal,
      now: () => clock.value,
    });
    await repository.enqueueScheduledMonitor({
      idempotencyKey: "modal-monitor:task-1:initial-test",
      delayMs: 0,
      request: {
        taskId: "task-1",
        sandboxId: "sandbox-1",
        handoffSha256: HASH,
        startedAt: NOW_ISO,
        resultPath: "/dex/result.json",
        attempt: 0,
      },
    }, NOW_ISO);

    const first = await runner.drain();
    expect(first).toMatchObject({
      initialAttempted: 0,
      scheduledAttempted: 1,
      scheduledCompleted: 1,
      outcomes: [{
        kind: "rescheduled",
        delayMs: 5_000,
        nextAttempt: 1,
        idempotencyKey: `modal-monitor:task-1:${HASH.slice(0, 16)}:attempt:1`,
        scheduled: true,
      }],
    });
    clock.value += 4_999;
    expect(await runner.drain()).toMatchObject({ scheduledAttempted: 0 });
    clock.value += 1;
    const second = await runner.drain();
    expect(second.outcomes).toEqual([expect.objectContaining({
      kind: "rescheduled",
      delayMs: 10_000,
      nextAttempt: 2,
      idempotencyKey: `modal-monitor:task-1:${HASH.slice(0, 16)}:attempt:2`,
    })]);
    expect(sandbox.poll).toHaveBeenCalledTimes(2);
    expect(terminal).not.toHaveBeenCalled();
    await backend.close();
  });
});

describe("runnable cloud composition", () => {
  it("coalesces concurrent readiness probes and reports shutdown as unavailable", async () => {
    const backend = new AtomicFileStateBackend({ filePath: await stateFile() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = vi.spyOn(backend, "ready").mockImplementation(async () => gate);
    const modal = {
      fromId: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runtime = createDexCloudRuntime({
      config: config(await stateFile()),
      backend,
      modal,
    });

    const probes = Array.from({ length: 12 }, () =>
      runtime.fetchHandler(new Request("https://cloud.dex.test/readyz")));
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    release();
    expect((await Promise.all(probes)).map(({ status }) => status))
      .toEqual(Array.from({ length: 12 }, () => 200));

    await runtime.close();
    const afterClose = await runtime.fetchHandler(new Request("https://cloud.dex.test/readyz"));
    expect(afterClose.status).toBe(503);
  });

  it("serializes concurrent listen and close calls", async () => {
    const runtimeConfig = config(await stateFile());
    runtimeConfig.port = 0;
    const modal = {
      fromId: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runtime = createDexCloudRuntime({ config: runtimeConfig, modal });

    const [firstAddress, secondAddress] = await Promise.all([
      runtime.listen(),
      runtime.listen(),
    ]);
    expect(secondAddress).toEqual(firstAddress);
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(modal.close).toHaveBeenCalledOnce();
  });

  it("closes persistence even when Modal cleanup fails", async () => {
    const backend = new AtomicFileStateBackend({ filePath: await stateFile() });
    const modal = {
      fromId: vi.fn(),
      close: vi.fn(async () => { throw new Error("Modal cleanup failed"); }),
    } as unknown as ModalAdapter;
    const runtime = createDexCloudRuntime({
      config: config(await stateFile()),
      backend,
      modal,
    });

    await expect(runtime.close()).rejects.toThrow("Modal cleanup failed");
    await expect(backend.ready()).rejects.toThrow("backend is closed");
  });

  it("keeps Sendblue retries live while Cloud Tasks owns Modal monitoring", async () => {
    const calls: string[] = [];
    const sendblueFetch = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        message_handle: "provider-cloud-tasks-1",
        status: "QUEUED",
        content: "Dex needs a paired Mac before it can accept engineering work. Run dex setup to begin.",
        from_number: DEX_LINE,
        number: PHONE,
        is_outbound: true,
        date_created: NOW_ISO,
      }), { status: 200 });
    });
    const modal = {
      fromId: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const cloudConfig: DexCloudConfig = {
      ...config(await stateFile()),
      cloudTasks: {
        project: "dex-project",
        location: "northamerica-northeast1",
        queue: "modal-monitors",
        serviceUrl: "https://dex.example.test",
        audience: "https://dex.example.test",
        serviceAccountEmail: "tasks@dex-project.iam.gserviceaccount.com",
      },
    };
    const runtime = createDexCloudRuntime({
      config: cloudConfig,
      fetch: sendblueFetch,
      modal,
      now: () => NOW,
    });
    const interval = vi.spyOn(globalThis, "setInterval");

    runtime.startBackgroundWork();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), cloudConfig.pollIntervalMs);
    await runtime.runCycle();

    const webhook = await runtime.fetchHandler(new Request(
      "https://cloud.dex.test/webhooks/sendblue",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sb-signing-secret": "webhook-secret",
        },
        body: JSON.stringify({
          content: "implement durable retries",
          is_outbound: false,
          message_handle: "incoming-cloud-tasks-1",
          date_sent: NOW_ISO,
          from_number: PHONE,
          to_number: DEX_LINE,
        }),
      },
    ));
    expect(webhook.status).toBe(200);
    await runtime.close();
    expect(calls).toEqual(["https://api.sendblue.com/api/send-message"]);
  });

  it("does not hold an accepted webhook open while Sendblue delivery is slow", async () => {
    let releaseProvider!: () => void;
    const providerPending = new Promise<Response>((resolve) => {
      releaseProvider = () => resolve(new Response(JSON.stringify({
        message_handle: "provider-background-1",
        status: "QUEUED",
        content: "Dex needs a paired Mac before it can accept engineering work. Run dex setup to begin.",
        from_number: DEX_LINE,
        number: PHONE,
        is_outbound: true,
        date_created: NOW_ISO,
      }), { status: 200 }));
    });
    const sendblueFetch = vi.fn(async () => providerPending);
    const modal = {
      fromId: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const cloudConfig: DexCloudConfig = {
      ...config(await stateFile()),
      cloudTasks: {
        project: "dex-project",
        location: "northamerica-northeast1",
        queue: "modal-monitors",
        serviceUrl: "https://dex.example.test",
        audience: "https://dex.example.test",
        serviceAccountEmail: "tasks@dex-project.iam.gserviceaccount.com",
      },
    };
    const runtime = createDexCloudRuntime({
      config: cloudConfig,
      fetch: sendblueFetch,
      modal,
      now: () => NOW,
    });

    const webhookPromise = runtime.fetchHandler(new Request(
      "https://cloud.dex.test/webhooks/sendblue",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sb-signing-secret": "webhook-secret",
        },
        body: JSON.stringify({
          content: "implement durable retries",
          is_outbound: false,
          message_handle: "incoming-background-1",
          date_sent: NOW_ISO,
          from_number: PHONE,
          to_number: DEX_LINE,
        }),
      },
    ));
    const blocked = Symbol("blocked");
    const winner = await Promise.race([
      webhookPromise,
      new Promise<typeof blocked>((resolve) => setTimeout(() => resolve(blocked), 100)),
    ]);
    releaseProvider();
    const webhook = await webhookPromise;

    expect(winner).not.toBe(blocked);
    expect(webhook.status).toBe(200);
    await runtime.runCycle();
    expect(sendblueFetch).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("serves webhook/pair/sync routes and drains the resulting Sendblue outbox", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const sendblueFetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(init?.body === undefined ? {} : { body: String(init.body) }),
      });
      return new Response(JSON.stringify({
        message_handle: "provider-handle-1",
        status: "QUEUED",
        content: "Dex needs a paired Mac before it can accept engineering work. Run dex setup to begin.",
        from_number: DEX_LINE,
        number: PHONE,
        is_outbound: true,
        date_created: NOW_ISO,
      }), { status: 200 });
    });
    const modal = {
      fromId: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as ModalAdapter;
    const runtime = createDexCloudRuntime({
      config: config(await stateFile()),
      fetch: sendblueFetch,
      modal,
      now: () => NOW,
    });
    const webhook = await runtime.fetchHandler(new Request(
      "https://cloud.dex.test/webhooks/sendblue",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sb-signing-secret": "webhook-secret",
        },
        body: JSON.stringify({
          content: "implement durable retries",
          is_outbound: false,
          message_handle: "incoming-runtime-1",
          date_sent: NOW_ISO,
          from_number: PHONE,
          to_number: DEX_LINE,
        }),
      },
    ));
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toMatchObject({ kind: "pairing_required" });

    const pair = await runtime.fetchHandler(new Request(
      "https://cloud.dex.test/v1/device/pair",
      { method: "POST", body: "{}" },
    ));
    const sync = await runtime.fetchHandler(new Request(
      "https://cloud.dex.test/v1/device/sync",
      { method: "POST", body: "{}" },
    ));
    expect(await pair.json()).toEqual({ code: "invalid_pairing_request" });
    expect(await sync.json()).toEqual({ code: "invalid_sync_request" });

    const cycle = await runtime.runCycle();
    expect(cycle.sendblue).toEqual([
      expect.objectContaining({ kind: "delivered", providerHandle: "provider-handle-1" }),
      { kind: "idle" },
    ]);
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
    const outbox = await runtime.repository.listSendblueOutbox();
    expect(outbox).toHaveLength(1);
    await expect(runtime.repository.getSendblueDelivery(outbox[0]!.id)).resolves.toMatchObject({
      state: "delivered",
      providerHandle: "provider-handle-1",
      resolution: "send",
    });
    await runtime.close();
  });
});
