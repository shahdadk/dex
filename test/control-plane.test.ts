import { describe, expect, it, vi } from "vitest";
import {
  DexCloudMessagingClient,
  createDexPairingPayload,
  createDexSyncPayload,
  generateDexDeviceKeyPair,
  verifyDexCommand,
  type DexDeviceKeyPair,
  type DexFetch,
} from "../src/cloud/messaging/index.js";
import {
  DexControlPlaneService,
  InMemoryControlPlaneRepository,
  MonitorJobOutbox,
  SetupCodePairingChallengeService,
  createDexControlPlaneFetchHandler,
  createDexControlPlaneServer,
  deterministicControlPlaneId,
  parseInboundMessage,
  verifySendblueWebhookSecret,
  type ConversationAssociationVerifier,
  type SendblueInboundWebhook,
  type VerifiedConversationAssociation,
} from "../src/cloud/control-plane/index.js";
import { modalMonitorTerminalKey } from "../src/cloud/modal-monitor/index.js";

const NOW_ISO = "2026-08-23T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const OWNER = "owner-1";
const CONVERSATION = "conversation-1";
const PHONE = "+14165550123";
const DEX_LINE = "+14165550999";
const WEBHOOK_SECRET = "sendblue-test-secret";
const INTERNAL_SECRET = "internal-test-secret";
const HASH = "a".repeat(64);
const SETUP_CODE = "K7D4Q9";

function inbound(
  messageHandle: string,
  content: string,
  overrides: Partial<SendblueInboundWebhook> = {},
): SendblueInboundWebhook {
  return {
    content,
    is_outbound: false,
    message_handle: messageHandle,
    date_sent: NOW_ISO,
    from_number: PHONE,
    to_number: DEX_LINE,
    sendblue_number: DEX_LINE,
    group_id: "",
    message_type: "message",
    ...overrides,
  };
}

function sendblueHeaders(secret = WEBHOOK_SECRET): Headers {
  return new Headers({
    "content-type": "application/json",
    "sb-signing-secret": secret,
  });
}

interface Fixture {
  repository: InMemoryControlPlaneRepository;
  service: DexControlPlaneService;
  signingKey: DexDeviceKeyPair;
  associationVerifier: ConversationAssociationVerifier;
  now: { value: number };
}

function fixture(options: {
  association?: VerifiedConversationAssociation | null;
} = {}): Fixture {
  const repository = new InMemoryControlPlaneRepository();
  const signingKey = generateDexDeviceKeyPair();
  const association = options.association === undefined
    ? { ownerId: OWNER, conversationId: CONVERSATION, phoneE164: PHONE }
    : options.association;
  const associationVerifier: ConversationAssociationVerifier = {
    verify: vi.fn(async () => association),
  };
  const now = { value: NOW };
  const service = new DexControlPlaneService({
    repository,
    associationVerifier,
    signingKey,
    sendblueWebhookSecret: WEBHOOK_SECRET,
    internalSecret: INTERNAL_SECRET,
    now: () => now.value,
  });
  return { repository, service, signingKey, associationVerifier, now };
}

async function issuePairingCode(
  state: Fixture,
  messageId = "pair-message-1",
  setupCode = SETUP_CODE,
): Promise<string> {
  const outcome = await state.service.processSendblueWebhook(
    inbound(messageId, `PAIR ${setupCode}`),
    sendblueHeaders(),
  );
  expect(outcome.kind).toBe("pairing_challenge");
  const messages = await state.repository.listSendblueOutbox();
  const text = messages.find((message) => message.dedupeKey === `sendblue:pair:${messageId}`)?.text;
  expect(text).toContain("verified this setup code");
  expect(text).not.toContain(setupCode);
  return setupCode;
}

function localFetch(
  service: DexControlPlaneService,
  onMonitorRegistered?: () => Promise<void>,
): DexFetch {
  const handler = createDexControlPlaneFetchHandler({
    service,
    ...(onMonitorRegistered === undefined ? {} : { onMonitorRegistered }),
  });
  return async (input, init) => handler(new Request(input, init));
}

async function pairDevice(state: Fixture): Promise<{
  deviceKey: DexDeviceKeyPair;
  deviceId: string;
  nextSequence: number;
}> {
  const pairingCode = await issuePairingCode(state);
  const deviceKey = generateDexDeviceKeyPair();
  const client = new DexCloudMessagingClient({
    baseUrl: "https://cloud.dex.test",
    keyPair: deviceKey,
    fetch: localFetch(state.service),
    now: () => state.now.value,
    nonce: (sequence) => `pair-request-${sequence}`,
  });
  const response = await client.pair(createDexPairingPayload({
    pairingCode,
    deviceName: "Test Mac",
    keyId: deviceKey.keyId,
    publicKey: deviceKey.publicKey,
  }));
  expect(response).toMatchObject({
    keyId: deviceKey.keyId,
    ownerId: OWNER,
    pairedConversationId: CONVERSATION,
    nextSequence: 2,
  });
  return {
    deviceKey,
    deviceId: response.deviceId,
    nextSequence: response.nextSequence!,
  };
}

describe("Sendblue ingress security and parsing", () => {
  it("checks the documented secret header before identity lookup or parsing", async () => {
    const state = fixture();
    expect(verifySendblueWebhookSecret(sendblueHeaders(), WEBHOOK_SECRET)).toBe(true);
    expect(verifySendblueWebhookSecret(sendblueHeaders("wrong"), WEBHOOK_SECRET)).toBe(false);

    await expect(state.service.processSendblueWebhook(
      { secretValue: WEBHOOK_SECRET },
      sendblueHeaders("wrong"),
    )).rejects.toMatchObject({ status: 401, code: "invalid_sendblue_secret" });
    expect(state.associationVerifier.verify).not.toHaveBeenCalled();
    expect(await state.repository.listSendblueOutbox()).toEqual([]);
  });

  it("requires the injected verified phone/conversation association", async () => {
    const absent = fixture({ association: null });
    await expect(absent.service.processSendblueWebhook(
      inbound("message-1", "fix checkout"),
      sendblueHeaders(),
    )).rejects.toMatchObject({ status: 403, code: "unverified_owner" });

    const mismatchedPhone = fixture({
      association: { ownerId: OWNER, conversationId: CONVERSATION, phoneE164: "+14165550000" },
    });
    await expect(mismatchedPhone.service.processSendblueWebhook(
      inbound("message-2", "fix checkout"),
      sendblueHeaders(),
    )).rejects.toMatchObject({ status: 403, code: "unverified_owner" });
  });

  it("parses PAIR exactly and preserves engineering text as inert data", () => {
    expect(parseInboundMessage(" Dex: pair ")).toEqual({ kind: "pair" });
    expect(parseInboundMessage(`PAIR ${SETUP_CODE}`)).toEqual({
      kind: "pair",
      setupCode: SETUP_CODE,
    });
    expect(parseInboundMessage("pair k7d4q9")).toEqual({
      kind: "pair",
      setupCode: SETUP_CODE,
    });
    expect(() => parseInboundMessage("PAIR 1234")).toThrow("six characters");
    expect(parseInboundMessage("DEX, fix parser; $(touch /tmp/not-executed) && rm -rf ./x"))
      .toEqual({
        kind: "engineering",
        text: "fix parser; $(touch /tmp/not-executed) && rm -rf ./x",
      });
  });
});

describe("signed pairing challenge lifecycle", () => {
  it("supports setup polling before and after the verified PAIR code arrives", async () => {
    const state = fixture();
    const deviceKey = generateDexDeviceKeyPair();
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      keyPair: deviceKey,
      fetch: localFetch(state.service),
      now: () => state.now.value,
      nonce: (sequence) => `setup-poll-${sequence}`,
    });
    const payload = createDexPairingPayload({
      pairingCode: SETUP_CODE,
      deviceName: "Polling Mac",
      keyId: deviceKey.keyId,
      publicKey: deviceKey.publicKey,
    });
    await expect(client.pair(payload)).rejects.toMatchObject({
      status: 401,
      code: "invalid_pairing_code",
    });
    await state.service.processSendblueWebhook(
      inbound("setup-code-arrived", `PAIR ${SETUP_CODE}`),
      sendblueHeaders(),
    );
    await expect(client.pair(payload)).resolves.toMatchObject({
      ownerId: OWNER,
      pairedConversationId: CONVERSATION,
      nextSequence: 3,
    });
  });

  it("HMACs the presented setup code and binds one device through a signed request", async () => {
    const state = fixture();
    const pairingCode = await issuePairingCode(state);
    const challengeService = new SetupCodePairingChallengeService({
      secret: INTERNAL_SECRET,
    });
    const identity = challengeService.identify(pairingCode);
    expect(identity).toMatchObject({
      challengeId: expect.stringMatching(/^pair_/),
      codeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const storedChallenge = await state.repository.getPairingChallenge(identity.challengeId);
    expect(storedChallenge).toMatchObject({
      codeDigest: identity.codeDigest,
      attempts: 0,
      maxAttempts: 5,
      ownerId: OWNER,
      conversationId: CONVERSATION,
    });
    expect(JSON.stringify(storedChallenge)).not.toContain(pairingCode);

    const deviceKey = generateDexDeviceKeyPair();
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      keyPair: deviceKey,
      fetch: localFetch(state.service),
      now: () => state.now.value,
      nonce: (sequence) => `pair-proof-${sequence}`,
    });
    const payload = createDexPairingPayload({
      pairingCode,
      deviceName: "Shahdad's Mac",
      keyId: deviceKey.keyId,
      publicKey: deviceKey.publicKey,
    });
    const paired = await client.pair(payload);
    expect(await state.repository.getDevice(paired.deviceId)).toMatchObject({
      keyId: deviceKey.keyId,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      lastSequence: 1,
    });
    await expect(client.pair(payload)).resolves.toMatchObject({
      deviceId: paired.deviceId,
      nextSequence: 3,
    });

    const secondDeviceKey = generateDexDeviceKeyPair();
    const secondDevice = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      keyPair: secondDeviceKey,
      fetch: localFetch(state.service),
      now: () => state.now.value,
      nonce: (sequence) => `second-device-${sequence}`,
    });
    await expect(secondDevice.pair(createDexPairingPayload({
      pairingCode,
      deviceName: "Another Mac",
      keyId: secondDeviceKey.keyId,
      publicKey: secondDeviceKey.publicKey,
    }))).rejects.toMatchObject({
      status: 409,
      code: "pairing_code_consumed",
    });
  });

  it("expires challenges and bounds failed consume attempts", async () => {
    const state = fixture();
    const pairingCode = await issuePairingCode(state);
    const challengeService = new SetupCodePairingChallengeService({ secret: INTERNAL_SECRET });
    const identified = challengeService.identify(pairingCode);
    const wrongKey = generateDexDeviceKeyPair();
    const wrongDevice = {
      id: "wrong-device",
      keyId: wrongKey.keyId,
      publicKey: wrongKey.publicKey,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      phoneE164: PHONE,
      deviceName: "Wrong Mac",
      createdAt: NOW_ISO,
      lastSequence: 1,
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(state.repository.consumePairingChallenge({
        challengeId: identified.challengeId,
        codeDigest: "0".repeat(64),
        now: NOW_ISO,
        device: wrongDevice,
      })).resolves.toEqual({ kind: "mismatch" });
    }
    await expect(state.repository.consumePairingChallenge({
      challengeId: identified.challengeId,
      codeDigest: identified.codeDigest,
      now: NOW_ISO,
      device: wrongDevice,
    })).resolves.toEqual({ kind: "attempts_exhausted" });

    const expiredState = fixture();
    const expiredCode = await issuePairingCode(expiredState);
    expiredState.now.value += 10 * 60_000 + 1;
    const deviceKey = generateDexDeviceKeyPair();
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      keyPair: deviceKey,
      fetch: localFetch(expiredState.service),
      now: () => expiredState.now.value,
      nonce: (sequence) => `expired-proof-${sequence}`,
    });
    await expect(client.pair(createDexPairingPayload({
      pairingCode: expiredCode,
      deviceName: "Late Mac",
      keyId: deviceKey.keyId,
      publicKey: deviceKey.publicKey,
    }))).rejects.toMatchObject({ status: 401, code: "pairing_code_expired" });
  });

  it("deduplicates repeated PAIR provider message IDs without a second outbox row", async () => {
    const state = fixture();
    const calls = await Promise.all(Array.from({ length: 8 }, () =>
      state.service.processSendblueWebhook(
        inbound("pair-duplicate", `PAIR ${SETUP_CODE}`),
        sendblueHeaders(),
      )));
    expect(calls.filter((result) => result.kind === "pairing_challenge")).toHaveLength(1);
    expect(calls.filter((result) => result.kind === "duplicate")).toHaveLength(7);
    expect(await state.repository.listSendblueOutbox()).toHaveLength(1);
  });
});

describe("deterministic device command protocol", () => {
  it("deduplicates provider IDs, signs one deterministic command, and acknowledges it", async () => {
    const state = fixture();
    const paired = await pairDevice(state);
    const engineering = inbound(
      "engineering-message-1",
      "Dex, fix checkout; $(touch /tmp/not-executed)",
    );
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      state.service.processSendblueWebhook(engineering, sendblueHeaders())));
    const accepted = results.find((result) => result.kind === "engineering_command");
    expect(results.filter((result) => result.kind === "engineering_command")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "duplicate")).toHaveLength(5);
    expect(accepted).toMatchObject({
      taskId: deterministicControlPlaneId("task", "sendblue:engineering-message-1"),
      commandId: deterministicControlPlaneId("cmd", "sendblue:engineering-message-1"),
    });

    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER,
      keyPair: paired.deviceKey,
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: state.signingKey.keyId,
        publicKey: state.signingKey.publicKey,
      }],
      initialSequence: paired.nextSequence - 1,
      fetch: localFetch(state.service),
      now: () => state.now.value,
      nonce: (sequence) => `sync-proof-${sequence}`,
    });
    const first = await client.sync(createDexSyncPayload({
      events: [{
        id: "event-1",
        timestamp: NOW_ISO,
        type: "message.received",
        payload: { observed: true },
      }],
    }));
    expect(first.acceptedEventIds).toEqual(["event-1"]);
    expect(first.commands).toHaveLength(1);
    expect(first.commands[0]).toMatchObject({
      verified: true,
      signingKeyId: state.signingKey.keyId,
      command: {
        type: "message.received",
        payload: {
          text: "fix checkout; $(touch /tmp/not-executed)",
          conversationId: CONVERSATION,
          messageId: "engineering-message-1",
          providerMessageId: "engineering-message-1",
        },
      },
      authority: {
        kind: "verified_owner",
        ownerId: OWNER,
        conversationId: CONVERSATION,
        verified: true,
      },
    });

    const second = await client.sync(createDexSyncPayload({
      cursor: first.cursor,
      receipts: [{
        commandId: first.commands[0]!.id,
        status: "processed",
        occurredAt: NOW_ISO,
      }],
    }));
    expect(second.acceptedReceiptIds).toEqual([first.commands[0]!.id]);
    expect(second.commands).toEqual([]);
    expect(await state.repository.listPendingDeviceCommands(paired.deviceId, 500)).toEqual([]);
  });

  it("enqueues a bounded pairing instruction instead of a command for an unpaired owner", async () => {
    const state = fixture();
    const result = await state.service.processSendblueWebhook(
      inbound("unpaired-work", "investigate the flaky test"),
      sendblueHeaders(),
    );
    expect(result.kind).toBe("pairing_required");
    expect(await state.repository.listSendblueOutbox()).toMatchObject([{
      dedupeKey: "sendblue:unpaired:unpaired-work",
      toPhone: PHONE,
    }]);
  });

  it("returns a durable sequence floor for replay recovery and rejects a bad proof", async () => {
    const state = fixture();
    const paired = await pairDevice(state);
    const handler = createDexControlPlaneFetchHandler({ service: state.service });
    const sequences: string[] = [];
    const recoveringFetch: DexFetch = async (input, init) => {
      const request = new Request(input, init);
      sequences.push(request.headers.get("x-appfi-sequence") ?? "");
      return handler(request);
    };
    const recoveringClient = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER,
      keyPair: paired.deviceKey,
      pinnedServerKeys: [],
      initialSequence: 0,
      fetch: recoveringFetch,
      now: () => state.now.value,
      nonce: (sequence) => `recovery-${sequence}`,
    });
    await expect(recoveringClient.sync(createDexSyncPayload())).resolves.toMatchObject({
      nextSequence: 3,
      commands: [],
    });
    expect(sequences).toEqual(["1", "2"]);

    const tamperedFetch: DexFetch = async (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("x-appfi-signature", "not-a-valid-signature");
      return handler(new Request(request, { headers }));
    };
    const tamperedClient = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER,
      keyPair: paired.deviceKey,
      pinnedServerKeys: [],
      initialSequence: 2,
      fetch: tamperedFetch,
      now: () => state.now.value,
      nonce: (sequence) => `tampered-${sequence}`,
    });
    await expect(tamperedClient.sync(createDexSyncPayload())).rejects.toMatchObject({
      status: 401,
      code: "invalid_request_signature",
    });
  });
});

describe("durable device transport events", () => {
  it("adopts a unique cloud ingress task when the local task-created identity arrives", async () => {
    const state = fixture();
    const paired = await pairDevice(state);
    const ingress = await state.service.processSendblueWebhook(
      inbound("identity-ingress-1", "Fix checkout and add a regression test"),
      sendblueHeaders(),
    );
    if (ingress.kind !== "engineering_command") throw new Error("Expected engineering command");
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER,
      keyPair: paired.deviceKey,
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: state.signingKey.keyId,
        publicKey: state.signingKey.publicKey,
      }],
      initialSequence: paired.nextSequence - 1,
      fetch: localFetch(state.service),
      now: () => state.now.value,
      nonce: (sequence) => `identity-${sequence}`,
    });

    const synced = await client.sync(createDexSyncPayload({ events: [{
      id: "local-identity-created-1",
      timestamp: NOW_ISO,
      type: "task.created",
      taskId: "local-checkout-task",
      payload: {
        title: "Fix checkout and add a regression test",
        originalRequest: "Fix checkout and add a regression test",
        conversationId: CONVERSATION,
      },
    }] }));

    expect(synced.commands).toEqual([expect.objectContaining({
      command: expect.objectContaining({
        type: "message.received",
        payload: expect.objectContaining({ cloudTaskId: ingress.taskId }),
      }),
    })]);
    expect(await state.repository.getTask(ingress.taskId)).toBeNull();
    expect(await state.repository.getTask("local-checkout-task")).toMatchObject({
      id: "local-checkout-task",
      cloudIngressTaskId: ingress.taskId,
      sourceMessageId: "identity-ingress-1",
      origin: "device",
      request: "Fix checkout and add a regression test",
    });
  });

  it("upserts local task identity and enqueues message.sent exactly once", async () => {
    const state = fixture();
    const paired = await pairDevice(state);
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER,
      keyPair: paired.deviceKey,
      pinnedServerKeys: [],
      initialSequence: paired.nextSequence - 1,
      fetch: localFetch(state.service),
      now: () => state.now.value,
      nonce: (sequence) => `transport-${sequence}`,
    });
    const events = [{
      id: "local-task-created-1",
      timestamp: NOW_ISO,
      type: "task.created",
      taskId: "local-split-task-1",
      payload: {
        title: "Fix checkout",
        originalRequest: "Fix checkout and add a regression test",
        conversationId: CONVERSATION,
        projectId: "project-1",
      },
    }, {
      id: "local-message-sent-1",
      timestamp: NOW_ISO,
      type: "message.sent",
      taskId: "local-split-task-1",
      payload: {
        conversationId: CONVERSATION,
        text: "I split checkout into two durable tasks.",
      },
    }] as const;

    const first = await client.sync(createDexSyncPayload({ events }));
    expect(first.acceptedEventIds).toEqual([
      "local-task-created-1",
      "local-message-sent-1",
    ]);
    expect(await state.repository.getTask("local-split-task-1")).toMatchObject({
      id: "local-split-task-1",
      ownerId: OWNER,
      conversationId: CONVERSATION,
      title: "Fix checkout",
      request: "Fix checkout and add a regression test",
      status: "queued",
    });
    const sent = (await state.repository.listSendblueOutbox())
      .filter((message) => message.dedupeKey.includes("local-message-sent-1"));
    expect(sent).toEqual([expect.objectContaining({
      dedupeKey: `device-event:${paired.deviceId}:local-message-sent-1`,
      conversationId: CONVERSATION,
      toPhone: PHONE,
      text: "I split checkout into two durable tasks.",
      taskId: "local-split-task-1",
    })]);

    const duplicate = await client.sync(createDexSyncPayload({
      cursor: first.cursor,
      events,
    }));
    expect(duplicate.acceptedEventIds).toEqual(first.acceptedEventIds);
    expect((await state.repository.listSendblueOutbox())
      .filter((message) => message.dedupeKey.includes("local-message-sent-1")))
      .toHaveLength(1);
  });

  it("rejects cross-conversation task and message events without acknowledging or enqueueing", async () => {
    const state = fixture();
    const paired = await pairDevice(state);
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER,
      keyPair: paired.deviceKey,
      pinnedServerKeys: [],
      initialSequence: paired.nextSequence - 1,
      fetch: localFetch(state.service),
      now: () => state.now.value,
      nonce: (sequence) => `association-${sequence}`,
    });
    await expect(client.sync(createDexSyncPayload({ events: [{
      id: "wrong-conversation-message",
      timestamp: NOW_ISO,
      type: "message.sent",
      payload: { conversationId: "conversation-attacker", text: "send this" },
    }] }))).rejects.toMatchObject({ status: 400, code: "invalid_transport_event" });
    expect((await state.repository.listSendblueOutbox())
      .some((message) => message.dedupeKey.includes("wrong-conversation-message")))
      .toBe(false);

    await expect(client.sync(createDexSyncPayload({ events: [{
      id: "wrong-conversation-task",
      timestamp: NOW_ISO,
      type: "task.created",
      taskId: "forged-task",
      payload: {
        title: "Forged",
        originalRequest: "Do not accept",
        conversationId: "conversation-attacker",
      },
    }] }))).rejects.toMatchObject({ status: 400, code: "invalid_transport_event" });
    expect(await state.repository.getTask("forged-task")).toBeNull();
  });

  it("registers one monitor job before acknowledgement and dispatches it once", async () => {
    const state = fixture();
    const paired = await pairDevice(state);
    const onMonitorRegistered = vi.fn(async () => undefined);
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.test",
      deviceId: paired.deviceId,
      ownerId: OWNER,
      keyPair: paired.deviceKey,
      pinnedServerKeys: [],
      initialSequence: paired.nextSequence - 1,
      fetch: localFetch(state.service, onMonitorRegistered),
      now: () => state.now.value,
      nonce: (sequence) => `monitor-event-${sequence}`,
    });
    await client.sync(createDexSyncPayload({ events: [{
      id: "monitor-task-created",
      timestamp: NOW_ISO,
      type: "task.created",
      taskId: "local-modal-task",
      payload: {
        title: "Cloud continuation",
        originalRequest: "Continue this task in Modal",
        conversationId: CONVERSATION,
      },
    }] }));
    expect(onMonitorRegistered).toHaveBeenCalledOnce();
    onMonitorRegistered.mockClear();

    await expect(client.sync(createDexSyncPayload({ events: [{
      id: "invalid-monitor-event",
      timestamp: NOW_ISO,
      type: "modal.monitor.registered",
      taskId: "local-modal-task",
      payload: { taskId: "local-modal-task", sandboxId: "sandbox-1" },
    }] }))).rejects.toMatchObject({ status: 400, code: "invalid_transport_event" });
    expect(await state.repository.listPendingMonitorJobs(100)).toEqual([]);

    const monitorEvent = {
      id: "monitor-registered-1",
      timestamp: NOW_ISO,
      type: "modal.monitor.registered",
      taskId: "local-modal-task",
      workerId: "worker-1",
      payload: {
        taskId: "local-modal-task",
        workerId: "worker-1",
        sandboxId: "sandbox-1",
        handoffSha256: HASH,
        startedAt: NOW_ISO,
        resultPath: "/dex/result.json",
      },
    } as const;
    onMonitorRegistered.mockClear();
    onMonitorRegistered.mockRejectedValueOnce(new Error("Cloud Tasks unavailable"));
    await expect(client.sync(createDexSyncPayload({ events: [monitorEvent] })))
      .rejects.toMatchObject({ status: 500, code: "internal_error", retryable: true });
    expect(await state.repository.listPendingMonitorJobs(100)).toHaveLength(1);

    onMonitorRegistered.mockClear();
    const registered = await client.sync(createDexSyncPayload({ events: [monitorEvent] }));
    expect(onMonitorRegistered).toHaveBeenCalledOnce();
    expect(registered.acceptedEventIds).toEqual(["monitor-registered-1"]);
    expect(await state.repository.getTask("local-modal-task")).toMatchObject({
      status: "running",
      monitor: { sandboxId: "sandbox-1", workerId: "worker-1", handoffSha256: HASH },
    });
    expect(await state.repository.listPendingMonitorJobs(100)).toEqual([
      expect.objectContaining({
        idempotencyKey: `modal-monitor:local-modal-task:${HASH.slice(0, 16)}:initial`,
        taskId: "local-modal-task",
        registration: expect.objectContaining({ sandboxId: "sandbox-1", workerId: "worker-1" }),
        request: expect.objectContaining({ sandboxId: "sandbox-1", attempt: 0 }),
      }),
    ]);

    await client.sync(createDexSyncPayload({ events: [monitorEvent] }));
    expect(await state.repository.listPendingMonitorJobs(100)).toHaveLength(1);

    const dispatched: string[] = [];
    const dispatchOptions = {
      repository: state.repository,
      dispatcher: {
        dispatch: async (job) => {
          dispatched.push(job.idempotencyKey);
        },
      },
      now: () => state.now.value,
    } as const;
    const firstOutbox = new MonitorJobOutbox(dispatchOptions);
    const competingOutbox = new MonitorJobOutbox(dispatchOptions);
    const dispatchResults = await Promise.all([
      firstOutbox.dispatchPending(),
      competingOutbox.dispatchPending(),
    ]);
    expect(dispatchResults).toEqual(expect.arrayContaining([
      { attempted: 1, dispatched: 1 },
      { attempted: 0, dispatched: 0 },
    ]));
    expect(dispatched).toEqual([`modal-monitor:local-modal-task:${HASH.slice(0, 16)}:initial`]);
    expect(await state.repository.listPendingMonitorJobs(100)).toEqual([]);
  });
});

describe("Modal task registration and exactly-once completion", () => {
  it("atomically transitions a task and enqueues one terminal Sendblue message", async () => {
    const state = fixture();
    const paired = await pairDevice(state);
    const accepted = await state.service.processSendblueWebhook(
      inbound("modal-task-message", "implement durable retries"),
      sendblueHeaders(),
    );
    if (accepted.kind !== "engineering_command") throw new Error("Expected an engineering command");
    const registration = {
      taskId: accepted.taskId,
      sandboxId: "sandbox-1",
      handoffSha256: HASH,
      startedAt: NOW_ISO,
      resultPath: "/dex/result.json",
    };
    await expect(state.service.registerModalMonitor(registration)).resolves.toEqual({
      taskId: accepted.taskId,
      created: true,
      status: "running",
    });
    await expect(state.service.registerModalMonitor(registration)).resolves.toMatchObject({
      created: false,
    });

    const terminal = {
      taskId: accepted.taskId,
      sandboxId: "sandbox-1",
      completionKey: modalMonitorTerminalKey(accepted.taskId, HASH),
      status: "succeeded" as const,
      reason: "result" as const,
      exitCode: 0,
      result: {
        taskId: accepted.taskId,
        handoffSha256: HASH,
        status: "succeeded" as const,
        summary: "Implemented bounded retry state.",
        validation: { commands: ["npm test"], passed: true },
        git: {
          branch: "dex/retries",
          commit: "abc123",
          bundlePath: "/dex/result.bundle",
          bundleSha256: "b".repeat(64),
        },
      },
      sandboxRetentionExpiresAt: "2026-08-23T12:05:00.000Z",
    };
    const completions = await Promise.all(
      Array.from({ length: 10 }, () => state.service.handleModalTerminal(terminal)),
    );
    expect(completions.filter((result) => result.transitioned)).toHaveLength(1);
    expect(completions.filter((result) => result.completionEnqueued)).toHaveLength(1);
    expect(await state.repository.getTask(accepted.taskId)).toMatchObject({
      status: "succeeded",
      completionKey: terminal.completionKey,
      summary: "Implemented bounded retry state.",
      completion: expect.objectContaining({
        sandboxId: "sandbox-1",
        resultPath: "/dex/result.json",
        sandboxRetentionExpiresAt: "2026-08-23T12:05:00.000Z",
        bundle: { path: "/dex/result.bundle", sha256: "b".repeat(64) },
      }),
    });
    const terminalMessages = (await state.repository.listSendblueOutbox())
      .filter((message) => message.taskId === accepted.taskId);
    expect(terminalMessages).toHaveLength(1);
    expect(terminalMessages[0]).toMatchObject({
      dedupeKey: terminal.completionKey,
      toPhone: PHONE,
    });
    const completionCommands = (await state.repository.listPendingDeviceCommands(
      paired.deviceId,
      100,
    )).filter((record) => record.command.command.type === "task.cloud.completed");
    expect(completionCommands).toHaveLength(1);
    const verified = verifyDexCommand(completionCommands[0]!.command, {
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: state.signingKey.keyId,
        publicKey: state.signingKey.publicKey,
      }],
      ownerId: OWNER,
      now: () => NOW,
    });
    expect(verified.command).toMatchObject({
      type: "task.cloud.completed",
      payload: {
        taskId: accepted.taskId,
        sandboxId: "sandbox-1",
        resultPath: "/dex/result.json",
        sandboxRetentionExpiresAt: "2026-08-23T12:05:00.000Z",
        bundle: { path: "/dex/result.bundle", sha256: "b".repeat(64) },
        result: terminal.result,
      },
    });
    await expect(state.service.handleModalTerminal({
      ...terminal,
      status: "failed",
      reason: "invalid_result",
      result: undefined,
      error: "late conflicting delivery",
    })).rejects.toMatchObject({ status: 409, code: "modal_result_conflict" });
  });

  it("rejects terminal evidence that does not match the registered handoff", async () => {
    const state = fixture();
    await pairDevice(state);
    const accepted = await state.service.processSendblueWebhook(
      inbound("invalid-modal-task", "implement parser"),
      sendblueHeaders(),
    );
    if (accepted.kind !== "engineering_command") throw new Error("Expected an engineering command");
    await state.service.registerModalMonitor({
      taskId: accepted.taskId,
      sandboxId: "sandbox-1",
      handoffSha256: HASH,
      startedAt: NOW_ISO,
    });
    await expect(state.service.handleModalTerminal({
      taskId: accepted.taskId,
      sandboxId: "sandbox-1",
      completionKey: modalMonitorTerminalKey(accepted.taskId, HASH),
      status: "succeeded",
      reason: "result",
      exitCode: 0,
      result: {
        taskId: accepted.taskId,
        handoffSha256: "b".repeat(64),
        status: "succeeded",
        summary: "Unverified result",
        validation: { commands: [], passed: true },
        git: { branch: "dex/parser", commit: "abc123" },
      },
    })).rejects.toMatchObject({ status: 409, code: "modal_result_conflict" });
    expect(await state.repository.getTask(accepted.taskId)).toMatchObject({ status: "running" });
  });

  it("reopens the same durable task for a newer distinct Modal attempt", async () => {
    const state = fixture();
    await pairDevice(state);
    const accepted = await state.service.processSendblueWebhook(
      inbound("modal-retry-task", "fix checkout with durable retry"),
      sendblueHeaders(),
    );
    if (accepted.kind !== "engineering_command") throw new Error("Expected an engineering command");

    await state.service.registerModalMonitor({
      taskId: accepted.taskId,
      workerId: "worker-first",
      sandboxId: "sandbox-first",
      handoffSha256: HASH,
      startedAt: NOW_ISO,
      resultPath: "/dex/result.json",
    });
    const firstCompletionKey = modalMonitorTerminalKey(accepted.taskId, HASH);
    await state.service.handleModalTerminal({
      taskId: accepted.taskId,
      sandboxId: "sandbox-first",
      completionKey: firstCompletionKey,
      status: "failed",
      reason: "nonzero_exit",
      exitCode: 1,
      error: "Nested sandbox failed",
    });

    state.now.value += 60_000;
    const retryStartedAt = new Date(state.now.value).toISOString();
    const retryHash = "b".repeat(64);
    await expect(state.service.registerModalMonitor({
      taskId: accepted.taskId,
      workerId: "worker-retry",
      sandboxId: "sandbox-retry",
      handoffSha256: retryHash,
      startedAt: retryStartedAt,
      resultPath: "/dex/result.json",
    })).resolves.toEqual({ taskId: accepted.taskId, created: true, status: "running" });

    const reopened = await state.repository.getTask(accepted.taskId);
    expect(reopened).toMatchObject({
      status: "running",
      monitor: {
        workerId: "worker-retry",
        sandboxId: "sandbox-retry",
        handoffSha256: retryHash,
      },
    });
    expect(reopened).not.toHaveProperty("completionKey");
    expect(reopened).not.toHaveProperty("completion");

    const retryCompletionKey = modalMonitorTerminalKey(accepted.taskId, retryHash);
    await state.service.handleModalTerminal({
      taskId: accepted.taskId,
      sandboxId: "sandbox-retry",
      completionKey: retryCompletionKey,
      status: "succeeded",
      reason: "result",
      exitCode: 0,
      result: {
        taskId: accepted.taskId,
        handoffSha256: retryHash,
        status: "succeeded",
        summary: "Checkout retry completed",
        validation: { commands: ["npm test"], passed: true },
        git: { branch: "dex/checkout-retry", commit: "abc123" },
      },
    });
    expect(await state.repository.getTask(accepted.taskId)).toMatchObject({
      status: "succeeded",
      completionKey: retryCompletionKey,
    });
    expect((await state.repository.listSendblueOutbox())
      .filter(({ dedupeKey }) => dedupeKey === firstCompletionKey || dedupeKey === retryCompletionKey))
      .toHaveLength(2);
  });
});

describe("bounded HTTP surface", () => {
  it("requires internal authorization, bounds bodies, and exposes an unbound Node server", async () => {
    const state = fixture();
    const handler = createDexControlPlaneFetchHandler({ service: state.service, maxBodyBytes: 1_024 });
    const unauthorized = await handler(new Request("https://cloud.dex.test/v1/modal/monitors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ code: "unauthorized" });

    const oversized = await handler(new Request("https://cloud.dex.test/webhooks/sendblue", {
      method: "POST",
      headers: sendblueHeaders(),
      body: JSON.stringify({ content: "x".repeat(2_000) }),
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ code: "body_too_large" });

    const health = await handler(new Request("https://cloud.dex.test/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const live = await handler(new Request("https://cloud.dex.test/livez"));
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });

    const ready = await handler(new Request("https://cloud.dex.test/readyz"));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });

    const server = createDexControlPlaneServer({ service: state.service });
    expect(server.listening).toBe(false);
  });

  it("keeps liveness up while readiness and health report persistence failure", async () => {
    const state = fixture();
    const handler = createDexControlPlaneFetchHandler({
      service: state.service,
      readiness: async () => { throw new Error("database unavailable"); },
    });

    for (const path of ["/readyz", "/healthz"]) {
      const response = await handler(new Request(`https://cloud.dex.test${path}`));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    }
    expect((await handler(new Request("https://cloud.dex.test/livez"))).status).toBe(200);

    const wrongMethod = await handler(new Request("https://cloud.dex.test/readyz", {
      method: "POST",
    }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(await wrongMethod.json()).toEqual({ code: "method_not_allowed" });
  });

  it("runs only the monitor body returned by Cloud Tasks verification", async () => {
    const state = fixture();
    const verified = { request: { taskId: "verified-task" } };
    const verify = vi.fn(async (_headers: Headers, body: unknown) => {
      expect(body).toEqual({ untrusted: true });
      return verified;
    });
    const run = vi.fn(async (body: unknown) => ({ accepted: body === verified }));
    const handler = createDexControlPlaneFetchHandler({
      service: state.service,
      monitorTask: { verify, run },
    });

    const response = await handler(new Request(
      "https://cloud.dex.test/internal/modal/monitor",
      {
        method: "POST",
        headers: {
          authorization: "Bearer signed-cloud-task-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ untrusted: true }),
      },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(verify).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(verified);
  });

  it("returns safe errors without echoing configured secrets", async () => {
    const state = fixture();
    const handler = createDexControlPlaneFetchHandler({ service: state.service });
    const response = await handler(new Request("https://cloud.dex.test/webhooks/sendblue", {
      method: "POST",
      headers: sendblueHeaders("wrong-secret"),
      body: JSON.stringify(inbound("unsafe", WEBHOOK_SECRET)),
    }));
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe('{"code":"invalid_sendblue_secret"}');
    expect(body).not.toContain(WEBHOOK_SECRET);
    expect(body).not.toContain(INTERNAL_SECRET);
  });
});
