import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  DexCloudProtocolError,
  type DexCloudMessagingClient,
  type DexSyncPayload,
  type DexVerifiedCommand,
} from "../src/cloud/messaging/index.js";
import { DEFAULT_CONTROL_PLANE_BODY_LIMIT } from "../src/cloud/control-plane/http.js";
import { startControlSocket, sendControlCommand } from "../src/local/daemon/control-socket.js";
import { DexCloudBridge } from "../src/local/daemon/cloud-bridge.js";
import { flushMonitorRegistration } from "../src/local/daemon/runtime.js";
import { EventLog } from "../src/state/events.js";
import { DexStateStore } from "../src/state/store.js";

const directories: string[] = [];
const runFile = promisify(execFile);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-runtime-"));
  directories.push(directory);
  return {
    directory,
    store: new DexStateStore(path.join(directory, "state.json")),
    events: new EventLog(path.join(directory, "events.jsonl")),
  };
}

const QUEUED_AT = "2026-08-24T12:00:00.000Z";

function queuedEvent(index: number, text = "queued") {
  return {
    id: `event-${index}`,
    timestamp: QUEUED_AT,
    type: "test.event",
    payload: { text },
  };
}

function queuedReceipt(index: number) {
  return {
    commandId: `receipt-${index}`,
    status: "processed" as const,
    occurredAt: QUEUED_AT,
  };
}

function verifiedCommand(id: string): DexVerifiedCommand {
  return {
    id,
    issuedAt: QUEUED_AT,
    command: { type: "message.received", payload: { text: id, conversationId: "chat-1" } },
    authority: {
      kind: "verified_owner",
      ownerId: "owner-1",
      conversationId: "chat-1",
      verified: true,
    },
    verified: true,
    signingKeyId: "server-1",
  };
}

function acceptedResult(
  payload: DexSyncPayload,
  cursor: string,
  commands: DexVerifiedCommand[] = [],
) {
  return {
    version: 1 as const,
    cursor,
    commands,
    acceptedEventIds: payload.events.map(({ id }) => id),
    acceptedReceiptIds: payload.receipts.map(({ commandId }) => commandId),
    transport: {
      kind: "polling" as const,
      survivesHostSleep: true as const,
      status: "healthy" as const,
      consecutiveFailures: 0,
    },
  };
}

describe("DexCloudBridge", () => {
  it("persists outbound messages until cloud acknowledgement and returns verified commands", async () => {
    const { store, events } = await fixture();
    const command = {
      id: "command-1",
      issuedAt: new Date().toISOString(),
      command: { type: "message.received", payload: { text: "status", conversationId: "chat-1" } },
      authority: { kind: "verified_owner", ownerId: "owner-1", conversationId: "chat-1", verified: true },
      verified: true,
      signingKeyId: "server-1",
    } satisfies DexVerifiedCommand;
    const sync = vi.fn(async (payload: { events: Array<{ id: string }>; receipts: Array<{ commandId: string }> }) => ({
      version: 1 as const,
      cursor: "cursor-1",
      commands: [command],
      acceptedEventIds: payload.events.map((event) => event.id),
      acceptedReceiptIds: payload.receipts.map((receipt) => receipt.commandId),
      transport: { kind: "polling" as const, survivesHostSleep: true as const, status: "healthy" as const, consecutiveFailures: 0 },
    }));
    const client = { sync, health: () => ({ kind: "polling", survivesHostSleep: true }) } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);

    await bridge.notify("chat-1", "auth is running", false);
    expect((await store.read()).pendingTransportEvents).toHaveLength(1);
    await expect(bridge.syncOnce(0)).resolves.toEqual([command]);
    const state = await store.read();
    expect(state.pendingTransportEvents).toEqual([]);
    expect(state.lastInboundCursor).toBe("cursor-1");
  });

  it("commits the transport outbox before diagnostics so a crash cannot lose a message", async () => {
    const { directory, store, events } = await fixture();
    vi.spyOn(events, "append").mockRejectedValueOnce(new Error("diagnostic disk unavailable"));
    const offline = {
      sync: vi.fn(async () => { throw new Error("must not flush yet"); }),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    const first = new DexCloudBridge(offline, store, events);

    await expect(first.publish({
      type: "message.sent",
      payload: { conversationId: "chat-1", text: "durable completion" },
    }, { flush: false })).resolves.toEqual(expect.any(String));

    const queued = (await store.read()).pendingTransportEvents;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: "message.sent",
      payload: { conversationId: "chat-1", text: "durable completion" },
    });

    const payloads: DexSyncPayload[] = [];
    const restarted = new DexCloudBridge({
      sync: vi.fn(async (payload: DexSyncPayload) => {
        payloads.push(payload);
        return acceptedResult(payload, "cursor-after-restart");
      }),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient, store, new EventLog(path.join(directory, "restarted-events.jsonl")));

    await restarted.syncOnce(0);

    expect(payloads.flatMap(({ events: sent }) => sent.map(({ id }) => id)))
      .toEqual([queued[0]!.id]);
    expect((await store.read()).pendingTransportEvents).toEqual([]);
  });

  it("bounds oversized outbound text before it enters the durable transport queue", async () => {
    const { store, events } = await fixture();
    let observedText = "";
    const sync = vi.fn(async (payload: {
      events: Array<{ id: string; payload: Record<string, unknown> }>;
      receipts: Array<{ commandId: string }>;
    }) => {
      observedText = String(payload.events[0]?.payload.text ?? "");
      return {
        version: 1 as const,
        cursor: "cursor-bounded",
        commands: [],
        acceptedEventIds: payload.events.map((event) => event.id),
        acceptedReceiptIds: payload.receipts.map((receipt) => receipt.commandId),
        transport: { kind: "polling" as const, survivesHostSleep: true as const, status: "healthy" as const, consecutiveFailures: 0 },
      };
    });
    const client = { sync, health: () => ({ kind: "polling", survivesHostSleep: true }) } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);

    await bridge.notify("chat-1", "x".repeat(10_000));

    expect(observedText).toHaveLength(7_900);
    expect(observedText.endsWith("…")).toBe(true);
    expect((await store.read()).pendingTransportEvents).toEqual([]);
  });

  it("rejects one oversized generic event before persistence without blocking later delivery", async () => {
    const { directory, store, events } = await fixture();
    const payloads: DexSyncPayload[] = [];
    const sync = vi.fn(async (payload: DexSyncPayload) => {
      payloads.push(payload);
      return acceptedResult(payload, `cursor-${payloads.length}`);
    });
    const client = { sync, health: () => ({ kind: "polling", survivesHostSleep: true }) } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);

    await expect(bridge.publish({
      type: "worker.output",
      payload: { text: "x".repeat(DEFAULT_CONTROL_PLANE_BODY_LIMIT * 2) },
    })).rejects.toThrow(/event exceeds.*request limit/i);
    expect((await store.read()).pendingTransportEvents).toEqual([]);
    await expect(readFile(path.join(directory, "events.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    await bridge.publish({
      type: "worker.output",
      payload: { text: "valid event after oversized event" },
    }, { flush: true, waitMs: 0 });

    expect(payloads.flatMap(({ events: queued }) => queued.map(({ payload }) => payload.text)))
      .toContain("valid event after oversized event");
    expect(payloads.every((payload) =>
      canonicalJsonBytes(payload).byteLength < DEFAULT_CONTROL_PLANE_BODY_LIMIT)).toBe(true);
    expect((await store.read()).pendingTransportEvents).toEqual([]);
  });

  it("does not let an older in-flight receipt acknowledgement delete a newer revision", async () => {
    const { store, events } = await fixture();
    let releaseFirstSync!: () => void;
    const firstSyncBlocked = new Promise<void>((resolve) => { releaseFirstSync = resolve; });
    let firstPayloadObserved!: () => void;
    const firstPayloadReady = new Promise<void>((resolve) => { firstPayloadObserved = resolve; });
    const payloads: DexSyncPayload[] = [];
    const sync = vi.fn(async (payload: DexSyncPayload) => {
      payloads.push(payload);
      if (payloads.length === 1) {
        firstPayloadObserved();
        await firstSyncBlocked;
      }
      return acceptedResult(payload, `cursor-${payloads.length}`);
    });
    const client = { sync, health: () => ({ kind: "polling", survivesHostSleep: true }) } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);

    await bridge.receipt("command-race", "processed", "older status");
    const firstSync = bridge.syncOnce(0);
    await firstPayloadReady;
    const newerReceipt = bridge.receipt("command-race", "failed", "newer status");
    releaseFirstSync();
    await Promise.all([firstSync, newerReceipt]);

    const retained = (await store.read()).pendingTransportReceipts;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      commandId: "command-race",
      status: "failed",
      reason: "newer status",
    });

    await bridge.syncOnce(0);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.receipts[0]).toMatchObject({
      commandId: "command-race",
      status: "processed",
      reason: "older status",
    });
    expect(payloads[1]?.receipts[0]).toMatchObject({
      commandId: "command-race",
      status: "failed",
      reason: "newer status",
    });
    expect((await store.read()).pendingTransportReceipts).toEqual([]);
  });

  it("fails the power barrier closed while a durable event or receipt remains pending", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.pendingTransportEvents.push(queuedEvent(1));
      state.pendingTransportReceipts.push(queuedReceipt(1));
    });
    const client = {
      sync: vi.fn(async (payload: DexSyncPayload) => acceptedResult(payload, "unused")),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);
    const effect = vi.fn(async () => "slept");

    await expect(bridge.withDrainedTransport(effect)).resolves.toEqual({ drained: false });
    expect(effect).not.toHaveBeenCalled();
    expect(client.sync).not.toHaveBeenCalled();
  });

  it("holds the drained barrier against a concurrent publication", async () => {
    const { store, events } = await fixture();
    const client = {
      sync: vi.fn(async (payload: DexSyncPayload) => acceptedResult(payload, "unused")),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);
    let releaseEffect!: () => void;
    const effectBlocked = new Promise<void>((resolve) => { releaseEffect = resolve; });
    let effectStarted!: () => void;
    const effectReady = new Promise<void>((resolve) => { effectStarted = resolve; });

    const barrier = bridge.withDrainedTransport(async () => {
      effectStarted();
      await effectBlocked;
      return "done";
    });
    await effectReady;
    const publication = bridge.publish({
      type: "worker.output",
      payload: { text: "must wait behind power" },
    }, { flush: false });

    expect((await store.read()).pendingTransportEvents).toEqual([]);
    releaseEffect();
    await expect(barrier).resolves.toEqual({ drained: true, value: "done" });
    await publication;
    expect((await store.read()).pendingTransportEvents).toHaveLength(1);
  });

  it("waits for an in-flight publication and then observes its durable outbox record", async () => {
    const { store, events } = await fixture();
    let releaseDiagnostics!: () => void;
    const diagnosticsBlocked = new Promise<void>((resolve) => { releaseDiagnostics = resolve; });
    let diagnosticsStarted!: () => void;
    const diagnosticsReady = new Promise<void>((resolve) => { diagnosticsStarted = resolve; });
    const appendDiagnostic = events.append.bind(events);
    vi.spyOn(events, "append").mockImplementationOnce(async (input) => {
      diagnosticsStarted();
      await diagnosticsBlocked;
      return appendDiagnostic(input);
    });
    const client = {
      sync: vi.fn(async (payload: DexSyncPayload) => acceptedResult(payload, "unused")),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);
    const publication = bridge.publish({
      type: "worker.output",
      payload: { text: "already publishing" },
    }, { flush: false });
    await diagnosticsReady;
    const effect = vi.fn(async () => "must-not-run");
    const barrier = bridge.withDrainedTransport(effect);

    releaseDiagnostics();
    await publication;
    await expect(barrier).resolves.toEqual({ drained: false });
    expect(effect).not.toHaveBeenCalled();
    expect((await store.read()).pendingTransportEvents).toHaveLength(1);
  });

  it("waits for an in-flight sync before entering the drained barrier", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.pendingTransportEvents.push(queuedEvent(1));
    });
    let releaseSync!: () => void;
    const syncBlocked = new Promise<void>((resolve) => { releaseSync = resolve; });
    let syncStarted!: () => void;
    const syncReady = new Promise<void>((resolve) => { syncStarted = resolve; });
    const client = {
      sync: vi.fn(async (payload: DexSyncPayload) => {
        syncStarted();
        await syncBlocked;
        return acceptedResult(payload, "cursor-drained");
      }),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);
    const syncing = bridge.syncOnce(0);
    await syncReady;
    const effect = vi.fn(async () => "safe");
    const barrier = bridge.withDrainedTransport(effect);

    expect(effect).not.toHaveBeenCalled();
    releaseSync();
    await syncing;
    await expect(barrier).resolves.toEqual({ drained: true, value: "safe" });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("drains 501 events and receipts in schema-safe prefixes and long-polls only on the final request", async () => {
    const { store, events } = await fixture();
    const expectedIds = Array.from({ length: 501 }, (_, index) => `event-${index}`);
    const expectedReceiptIds = Array.from({ length: 501 }, (_, index) => `receipt-${index}`);
    await store.updateState((state) => {
      state.pendingTransportEvents.push(...expectedIds.map((_, index) => queuedEvent(index)));
      state.pendingTransportReceipts.push(
        ...expectedReceiptIds.map((_, index) => queuedReceipt(index)),
      );
    });
    const payloads: DexSyncPayload[] = [];
    const command = verifiedCommand("batched-command");
    const sync = vi.fn(async (payload: DexSyncPayload) => {
      payloads.push(payload);
      const result = acceptedResult(payload, `cursor-${payloads.length}`, [command]);
      if (payloads.length === 1) {
        // An acknowledgement for an unsent item must not delete it from the durable queue.
        result.acceptedEventIds.push("event-500");
      }
      return result;
    });
    const client = { sync, health: () => ({ kind: "polling", survivesHostSleep: true }) } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);

    await expect(bridge.syncOnce(25_000)).resolves.toEqual([command]);

    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every(({ events, receipts }) => events.length <= 500 && receipts.length <= 500))
      .toBe(true);
    expect(payloads.flatMap(({ events }) => events.map(({ id }) => id))).toEqual(expectedIds);
    expect(payloads.flatMap(({ receipts }) => receipts.map(({ commandId }) => commandId)))
      .toEqual(expectedReceiptIds);
    expect(payloads.slice(0, -1).every(({ waitMs }) => waitMs === 0)).toBe(true);
    expect(payloads.at(-1)?.waitMs).toBe(25_000);
    expect((await store.read()).pendingTransportEvents).toEqual([]);
    expect((await store.read()).pendingTransportReceipts).toEqual([]);
  });

  it("keeps every sync body below the control-plane limit for over 1 MiB of aggregate text", async () => {
    const { store, events } = await fixture();
    const text = "x".repeat(7_900);
    const eventCount = 140;
    expect(text.length * eventCount).toBeGreaterThan(1024 * 1024);
    await store.updateState((state) => {
      state.pendingTransportEvents.push(
        ...Array.from({ length: eventCount }, (_, index) => queuedEvent(index, text)),
      );
    });
    const bodyBytes: number[] = [];
    const sync = vi.fn(async (payload: DexSyncPayload) => {
      bodyBytes.push(canonicalJsonBytes(payload).byteLength);
      return acceptedResult(payload, `cursor-${bodyBytes.length}`);
    });
    const client = { sync, health: () => ({ kind: "polling", survivesHostSleep: true }) } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);

    await bridge.syncOnce(0);

    expect(bodyBytes.length).toBeGreaterThan(1);
    expect(bodyBytes.every((bytes) => bytes < DEFAULT_CONTROL_PLANE_BODY_LIMIT)).toBe(true);
    expect((await store.read()).pendingTransportEvents).toEqual([]);
  });

  it("retries accepted prefixes, preserves unaccepted records, and returns each command once", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.pendingTransportEvents.push(...Array.from({ length: 3 }, (_, index) => queuedEvent(index)));
      state.pendingTransportReceipts.push(...Array.from({ length: 2 }, (_, index) => queuedReceipt(index)));
    });
    const firstCommand = verifiedCommand("command-1");
    const secondCommand = verifiedCommand("command-2");
    const payloads: DexSyncPayload[] = [];
    const sync = vi.fn(async (payload: DexSyncPayload) => {
      payloads.push(payload);
      const call = payloads.length;
      return {
        ...acceptedResult(payload, `cursor-${call}`, call === 1
          ? [firstCommand]
          : [firstCommand, secondCommand]),
        acceptedEventIds: call === 1
          ? [payload.events[0]!.id]
          : call === 2
            ? [payload.events[0]!.id]
            : [],
        acceptedReceiptIds: call <= 2 && payload.receipts[0]
          ? [payload.receipts[0].commandId]
          : [],
      };
    });
    const client = { sync, health: () => ({ kind: "polling", survivesHostSleep: true }) } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);

    await expect(bridge.syncOnce(25_000)).resolves.toEqual([firstCommand, secondCommand]);

    expect(payloads).toHaveLength(3);
    expect(payloads.map(({ waitMs }) => waitMs)).toEqual([25_000, 0, 0]);
    expect(payloads.map(({ events }) => events.map(({ id }) => id))).toEqual([
      ["event-0", "event-1", "event-2"],
      ["event-1", "event-2"],
      ["event-2"],
    ]);
    const state = await store.read();
    expect(state.pendingTransportEvents.map(({ id }) => id)).toEqual(["event-2"]);
    expect(state.pendingTransportReceipts).toEqual([]);
    expect(state.lastInboundCursor).toBe("cursor-3");
  });

  it("persists the unaccepted suffix across a mid-drain transport failure and restart", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.pendingTransportEvents.push(
        ...Array.from({ length: 12 }, (_, index) => queuedEvent(index, "x".repeat(7_900))),
      );
    });
    let attempts = 0;
    const failingClient = {
      sync: vi.fn(async (payload: DexSyncPayload) => {
        attempts += 1;
        if (attempts === 2) throw new Error("offline");
        return acceptedResult(payload, "cursor-before-failure");
      }),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    await expect(new DexCloudBridge(failingClient, store, events).syncOnce(0)).rejects.toThrow("offline");

    const afterFailure = await store.read();
    const persistedIds = afterFailure.pendingTransportEvents.map(({ id }) => id);
    expect(persistedIds.length).toBeGreaterThan(0);
    expect(persistedIds.length).toBeLessThan(12);
    expect(afterFailure.lastInboundCursor).toBe("cursor-before-failure");

    const restartedPayloads: DexSyncPayload[] = [];
    const restartedClient = {
      sync: vi.fn(async (payload: DexSyncPayload) => {
        restartedPayloads.push(payload);
        return acceptedResult(payload, `restart-${restartedPayloads.length}`);
      }),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    await new DexCloudBridge(restartedClient, store, events).syncOnce(0);

    expect(restartedPayloads.flatMap(({ events: queued }) => queued.map(({ id }) => id)))
      .toEqual(persistedIds);
    expect((await store.read()).pendingTransportEvents).toEqual([]);
  });

  it("quarantines only the rejected submitted event and drains its valid follower and receipt", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.pendingTransportEvents.push(queuedEvent(0, "invalid head"), queuedEvent(1, "valid follower"));
      state.pendingTransportReceipts.push(queuedReceipt(1));
    });
    const payloads: DexSyncPayload[] = [];
    const client = {
      sync: vi.fn(async (payload: DexSyncPayload) => {
        payloads.push(payload);
        if (payloads.length === 1) {
          throw new DexCloudProtocolError("invalid durable event", {
            status: 400,
            code: "invalid_transport_event",
            invalidEventId: "event-0",
          });
        }
        return acceptedResult(payload, "cursor-after-quarantine");
      }),
      health: () => ({
        kind: "polling" as const,
        survivesHostSleep: true as const,
        status: payloads.length === 1 ? "degraded" as const : "healthy" as const,
        consecutiveFailures: payloads.length === 1 ? 1 : 0,
        ...(payloads.length === 1 ? { lastError: "http" as const } : {}),
      }),
    } as unknown as DexCloudMessagingClient;

    await expect(new DexCloudBridge(client, store, events).syncOnce(0)).resolves.toEqual([]);

    expect(payloads.map(({ events: sent }) => sent.map(({ id }) => id))).toEqual([
      ["event-0", "event-1"],
      ["event-1"],
    ]);
    expect(payloads[1]?.receipts.map(({ commandId }) => commandId)).toEqual(["receipt-1"]);
    const state = await store.read();
    expect(state.pendingTransportEvents).toEqual([]);
    expect(state.pendingTransportReceipts).toEqual([]);
    expect(state.quarantinedTransportEvents).toEqual([{
      id: "event-0",
      timestamp: QUEUED_AT,
      type: "test.event",
      reason: "invalid_transport_event",
      quarantinedAt: expect.any(String),
    }]);
    expect(state.quarantinedTransportEvents[0]).not.toHaveProperty("payload");
  });

  it("rejects an invalid event identifier that was not in the submitted batch", async () => {
    const { store, events } = await fixture();
    await store.updateState((state) => {
      state.pendingTransportEvents.push(queuedEvent(0), queuedEvent(1));
      state.pendingTransportReceipts.push(queuedReceipt(1));
    });
    const rejection = new DexCloudProtocolError("unbound invalid event", {
      status: 400,
      code: "invalid_transport_event",
      invalidEventId: "event-not-submitted",
    });
    const client = {
      sync: vi.fn(async () => { throw rejection; }),
      health: () => ({
        kind: "polling" as const,
        survivesHostSleep: true as const,
        status: "degraded" as const,
        consecutiveFailures: 1,
        lastError: "http" as const,
      }),
    } as unknown as DexCloudMessagingClient;

    await expect(new DexCloudBridge(client, store, events).syncOnce(0)).rejects.toBe(rejection);

    const state = await store.read();
    expect(state.pendingTransportEvents.map(({ id }) => id)).toEqual(["event-0", "event-1"]);
    expect(state.pendingTransportReceipts.map(({ commandId }) => commandId)).toEqual(["receipt-1"]);
    expect(state.quarantinedTransportEvents).toEqual([]);
  });

  it("persists bounded non-secret health after failed and successful signed sync attempts", async () => {
    const { directory, store, events } = await fixture();
    const sensitiveFailure = new Error(
      "OPENAI_API_KEY=sk-secret payload={phone:+15555550123,body:private}",
    );
    const sync = vi.fn()
      .mockRejectedValueOnce(sensitiveFailure)
      .mockImplementationOnce(async (payload: DexSyncPayload) =>
        acceptedResult(payload, "cursor-recovered"));
    const client = {
      sync,
      health: () => ({
        kind: "polling" as const,
        survivesHostSleep: true as const,
        status: sync.mock.calls.length === 1 ? "degraded" as const : "healthy" as const,
        consecutiveFailures: sync.mock.calls.length === 1 ? 1 : 0,
        ...(sync.mock.calls.length === 1 ? { lastError: "network" as const } : {}),
      }),
    } as unknown as DexCloudMessagingClient;
    const clock = [
      new Date("2026-08-24T12:00:00.000Z"),
      new Date("2026-08-24T12:00:10.000Z"),
      new Date("2026-08-24T12:00:11.000Z"),
    ];
    const bridge = new DexCloudBridge(client, store, events, {
      now: () => clock.shift()!,
    });

    await expect(bridge.syncOnce(0)).rejects.toBe(sensitiveFailure);
    expect((await store.read()).signedTransportHealth).toEqual({
      status: "degraded",
      consecutiveFailures: 1,
      lastAttemptAt: "2026-08-24T12:00:00.000Z",
      lastError: "network",
    });
    expect(await readFile(path.join(directory, "state.json"), "utf8"))
      .not.toMatch(/sk-secret|15555550123|private|payload/i);

    await expect(bridge.syncOnce(0)).resolves.toEqual([]);
    expect((await store.read()).signedTransportHealth).toEqual({
      status: "healthy",
      consecutiveFailures: 0,
      lastAttemptAt: "2026-08-24T12:00:10.000Z",
      lastSuccessAt: "2026-08-24T12:00:11.000Z",
    });
  });

  it("preserves the original signed-sync error when degraded health cannot be persisted", async () => {
    const { store, events } = await fixture();
    const syncError = new Error("original transport failure");
    const persistenceError = new Error("health state unavailable");
    const update = vi.spyOn(store, "updateState").mockRejectedValueOnce(persistenceError);
    const client = {
      sync: vi.fn(async () => { throw syncError; }),
      health: () => ({
        kind: "polling" as const,
        survivesHostSleep: true as const,
        status: "degraded" as const,
        consecutiveFailures: 1,
        lastError: "network" as const,
      }),
    } as unknown as DexCloudMessagingClient;

    await expect(new DexCloudBridge(client, store, events).syncOnce(0)).rejects.toBe(syncError);
    expect(update).toHaveBeenCalledOnce();
  });

  it("fails closed when a successful signed sync cannot durably record health", async () => {
    const { store, events } = await fixture();
    const persistenceError = new Error("health state unavailable");
    vi.spyOn(store, "updateState").mockRejectedValueOnce(persistenceError);
    const client = {
      sync: vi.fn(async (payload: DexSyncPayload) => acceptedResult(payload, "cursor-success")),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;

    await expect(new DexCloudBridge(client, store, events).syncOnce(0))
      .rejects.toBe(persistenceError);
    expect((await store.read()).lastInboundCursor).toBeUndefined();
    expect((await store.read()).signedTransportHealth).toBeUndefined();
  });
});

describe("Modal monitor ownership acknowledgement", () => {
  it("retries one durable registration after an ambiguous retryable cloud error", async () => {
    let clock = 1_000;
    const wait = vi.fn(async (ms: number) => { clock += ms; });
    const sync = vi.fn()
      .mockRejectedValueOnce(new DexCloudProtocolError("dispatch ambiguous", {
        status: 500,
        code: "internal_error",
        retryable: true,
      }))
      .mockResolvedValueOnce([]);

    await expect(flushMonitorRegistration(sync, {
      timeoutMs: 5_000,
      retryDelayMs: 250,
      now: () => clock,
      wait,
    })).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it("does not retry a permanent monitor-registration rejection", async () => {
    const error = new DexCloudProtocolError("invalid event", {
      status: 400,
      code: "invalid_transport_event",
      retryable: false,
    });
    const sync = vi.fn(async () => { throw error; });
    await expect(flushMonitorRegistration(sync)).rejects.toBe(error);
    expect(sync).toHaveBeenCalledOnce();
  });
});

describe("local diagnostic control socket", () => {
  it("delivers a bounded typed demo battery command to the running daemon", async () => {
    const { directory } = await fixture();
    const socket = path.join(directory, "control.sock");
    const received: unknown[] = [];
    const server = await startControlSocket(socket, async (command) => { received.push(command); });
    try {
      await sendControlCommand(socket, { type: "demo.battery", percent: 8 });
      expect(received).toEqual([{ type: "demo.battery", percent: 8 }]);
    } finally {
      await server.close();
    }
  });

  it("delivers power restore to the running daemon", async () => {
    const { directory } = await fixture();
    const socket = path.join(directory, "control.sock");
    const received: unknown[] = [];
    const server = await startControlSocket(socket, async (command) => { received.push(command); });
    try {
      await sendControlCommand(socket, { type: "power.restore" });
      expect(received).toEqual([{ type: "power.restore" }]);
    } finally {
      await server.close();
    }
  });

  it("routes dex power restore through the live daemon control socket", async () => {
    const { directory } = await fixture();
    const socket = path.join(directory, "runtime", "control.sock");
    const received: unknown[] = [];
    const server = await startControlSocket(socket, async (command) => { received.push(command); });
    try {
      const result = await runFile(process.execPath, ["--import", "tsx", "src/cli.ts", "power", "restore"], {
        cwd: process.cwd(),
        env: { ...process.env, DEX_HOME: directory },
      });
      expect(received).toEqual([{ type: "power.restore" }]);
      expect(result.stdout).toContain("told the running Dex daemon");
    } finally {
      await server.close();
    }
  });

  it("discloses simulated battery provenance in dex watch", async () => {
    const { directory, store } = await fixture();
    await store.updateState((state) => {
      state.machine = {
        id: "device-1",
        hostname: "test-mac",
        batteryPercent: 8,
        batteryReadingSimulated: true,
        sleepPreventionActive: false,
        aggressiveLidModeActive: false,
        batteryAlertThresholds: [10],
        updatedAt: new Date().toISOString(),
      };
    });

    const result = await runFile(process.execPath, ["--import", "tsx", "src/cli.ts", "watch", "--once"], {
      cwd: process.cwd(),
      env: { ...process.env, DEX_HOME: directory },
    });
    expect(result.stdout).toContain("battery      8% (simulated)");
  });
});
