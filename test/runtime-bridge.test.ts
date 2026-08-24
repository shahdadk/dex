import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DexCloudProtocolError,
  type DexCloudMessagingClient,
  type DexVerifiedCommand,
} from "../src/cloud/messaging/index.js";
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

  it("retains durable outbox events when transport fails", async () => {
    const { store, events } = await fixture();
    const client = {
      sync: vi.fn(async () => { throw new Error("offline"); }),
      health: () => ({ kind: "polling", survivesHostSleep: true }),
    } as unknown as DexCloudMessagingClient;
    const bridge = new DexCloudBridge(client, store, events);
    await bridge.notify("chat-1", "queued result", false);
    await expect(bridge.syncOnce(0)).rejects.toThrow("offline");
    expect((await store.read()).pendingTransportEvents).toHaveLength(1);
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
