import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDexDeviceKeyPair } from "../src/cloud/messaging/index.js";
import type { ModalAdapter, ModalSandbox } from "../src/cloud/modal/index.js";
import {
  AtomicFileStateBackend,
  DurableDexCloudRepository,
  DurableModalMonitorOnce,
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

    const loaded = await loadDexCloudConfig({
      ...base,
      DEX_DATABASE_URL: "postgresql://dex:password@db.example.test/dex",
      DEX_DATABASE_SSL_MODE: "verify-full",
    });
    expect(loaded.persistence).toMatchObject({ kind: "postgres", ssl: true });
    expect(loaded.signingKey).toMatchObject({
      algorithm: "ed25519",
      keyId: key.keyId,
      publicKey: key.publicKey,
    });
    expect(loaded.signingKey.privateKey).not.toBe("");

    const cloudSql = await loadDexCloudConfig({
      ...base,
      DEX_CLOUD_SQL_INSTANCE: "appfi-dev-80693:northamerica-northeast1:ai-employee-pg",
      DEX_CLOUD_SQL_DATABASE: "ai_employee",
      DEX_CLOUD_SQL_IAM_USER: "dex-cloud@appfi-dev-80693.iam",
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

  it("executes due monitor jobs in stable order and durably schedules deterministic retries", async () => {
    const backend = new AtomicFileStateBackend({ filePath: await stateFile() });
    const repository = new DurableDexCloudRepository({ backend });
    const clock = { value: NOW };
    const sandbox = {
      poll: vi.fn(async () => null),
      detach: vi.fn(async () => undefined),
      terminate: vi.fn(async () => undefined),
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
        idempotencyKey: "modal-monitor:task-1:attempt:1",
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
      idempotencyKey: "modal-monitor:task-1:attempt:2",
    })]);
    expect(sandbox.poll).toHaveBeenCalledTimes(2);
    expect(terminal).not.toHaveBeenCalled();
    await backend.close();
  });
});

describe("runnable cloud composition", () => {
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
