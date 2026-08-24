import { describe, expect, it, vi } from "vitest";
import {
  DexCloudMessagingClient,
  DexCommandVerifier,
  canonicalJson,
  canonicalJsonBytes,
  dexRequestSigningBytes,
  generateDexDeviceKeyPair,
  normalizeDexEvent,
  normalizeDexReceipt,
  sha256Hex,
  signDexBytes,
  verifyDexSignature,
  type DexPairingPayload,
  type DexSignedCommand,
} from "../src/cloud/messaging/index.js";
import {
  DexPairingService,
  MacOSDexKeychain,
  type DexDeviceKeychain,
  type DexStoredDeviceKey,
} from "../src/local/pairing/index.js";

const ISO = "2026-08-23T12:00:00.000Z";
const NOW = Date.parse(ISO);

function pairingPayload(keyPair = generateDexDeviceKeyPair()): DexPairingPayload {
  return {
    version: 1,
    client: "dex",
    pairingCode: "DEX-1234",
    deviceName: "Shahdad's Mac",
    platform: "darwin",
    keyId: keyPair.keyId,
    publicKeyAlgorithm: "ed25519",
    publicKey: keyPair.publicKey,
    capabilities: ["commands", "events", "receipts", "polling"],
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function requestHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

describe("Dex cloud request signing", () => {
  it("posts canonical JSON with a verifiable Ed25519 proof and internal compatibility headers", async () => {
    const keyPair = generateDexDeviceKeyPair();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return jsonResponse({
        version: 1,
        deviceId: "device-1",
        keyId: keyPair.keyId,
        ownerId: "owner-1",
      });
    });
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.example/base-that-must-not-leak",
      keyPair,
      fetch,
      now: () => NOW,
      nonce: (sequence) => `nonce-${sequence}`,
    });
    const payload = pairingPayload(keyPair);

    await expect(client.pair(payload)).resolves.toMatchObject({ deviceId: "device-1" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://cloud.dex.example/v1/device/pair");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe(canonicalJson(payload));

    const headers = requestHeaders(call.init);
    const digest = sha256Hex(String(call.init?.body));
    expect(headers.get("x-appfi-client")).toBe("dex");
    expect(headers.get("x-appfi-content-sha256")).toBe(digest);
    expect(headers.get("x-appfi-body-sha256")).toBe(digest);
    expect(headers.get("x-appfi-sequence")).toBe("1");
    expect(headers.get("x-appfi-nonce")).toBe("nonce-1");
    expect(headers.get("x-appfi-timestamp")).toBe(String(NOW));
    expect(headers.has("x-appfi-device-id")).toBe(false);
    expect(
      verifyDexSignature(
        dexRequestSigningBytes({
          method: "POST",
          path: "/v1/device/pair",
          keyId: keyPair.keyId,
          sequence: 1,
          nonce: "nonce-1",
          timestamp: NOW,
          contentSha256: digest,
        }),
        headers.get("x-appfi-signature")!,
        keyPair.publicKey,
      ),
    ).toBe(true);
  });

  it("recovers once from a server sequence floor with fresh monotonic metadata", async () => {
    const deviceKeys = generateDexDeviceKeyPair();
    const serverKeys = generateDexDeviceKeyPair();
    const unsignedCommand = {
      id: "command-1",
      issuedAt: ISO,
      expiresAt: "2026-08-23T12:05:00.000Z",
      command: { type: "message.received", payload: { text: "status?" } },
      authority: {
        kind: "verified_owner",
        ownerId: "owner-1",
        conversationId: "conversation-1",
        verified: true,
      },
    } as const;
    const command: DexSignedCommand = {
      ...unsignedCommand,
      signature: {
        algorithm: "ed25519",
        keyId: "server-1",
        value: signDexBytes(canonicalJsonBytes(unsignedCommand), serverKeys.privateKey),
      },
    };
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init!);
      if (requests.length === 1) {
        return jsonResponse(
          { code: "stale_sequence", expectedSequence: 40 },
          { status: 409 },
        );
      }
      return jsonResponse({
        version: 1,
        cursor: "cursor-2",
        commands: [command],
        acceptedEventIds: ["event-1"],
        acceptedReceiptIds: ["command-0"],
        nextSequence: 41,
      });
    });
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.example",
      deviceId: "device-1",
      ownerId: "owner-1",
      keyPair: deviceKeys,
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: "server-1",
        publicKey: serverKeys.publicKey,
      }],
      fetch,
      now: () => NOW,
      nonce: (sequence) => `nonce-${sequence}`,
    });
    const event = normalizeDexEvent({
      id: "event-1",
      timestamp: ISO,
      type: "task.completed",
      taskId: "task-1",
      payload: { z: true, a: "normalized" },
    });
    const receipt = normalizeDexReceipt({
      commandId: "command-0",
      status: "processed",
    }, () => NOW);

    const result = await client.poll({
      version: 1,
      cursor: "cursor-1",
      events: [event],
      receipts: [receipt],
      waitMs: 30_000,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => requestHeaders(request).get("x-appfi-sequence")))
      .toEqual(["1", "40"]);
    expect(requests.map((request) => requestHeaders(request).get("x-appfi-nonce")))
      .toEqual(["nonce-1", "nonce-40"]);
    expect(requests.map((request) => requestHeaders(request).get("x-appfi-timestamp")))
      .toEqual([String(NOW), String(NOW + 1)]);
    expect(requestHeaders(requests[1]).get("x-appfi-device-id")).toBe("device-1");
    expect(requests[0]!.body).toBe(requests[1]!.body);
    expect(result.commands).toMatchObject([{
      id: "command-1",
      verified: true,
      signingKeyId: "server-1",
      authority: { ownerId: "owner-1", verified: true },
    }]);
    expect(result.transport).toMatchObject({
      kind: "polling",
      status: "healthy",
      survivesHostSleep: true,
      consecutiveFailures: 0,
    });
  });

  it("recovers when the process-local sequence is ahead of the durable cloud sequence", async () => {
    const deviceKeys = generateDexDeviceKeyPair();
    const serverKeys = generateDexDeviceKeyPair();
    const sequences: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const sequence = requestHeaders(init).get("x-appfi-sequence") ?? "";
      sequences.push(sequence);
      if (sequences.length === 1) {
        return jsonResponse(
          { code: "stale_sequence", expectedSequence: 40 },
          {
            status: 409,
            headers: { "x-appfi-expected-sequence": "40" },
          },
        );
      }
      return jsonResponse({
        version: 1,
        cursor: "device:40",
        commands: [],
        acceptedEventIds: [],
        acceptedReceiptIds: [],
        nextSequence: 41,
      });
    });
    const client = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.example",
      deviceId: "device-1",
      ownerId: "owner-1",
      keyPair: deviceKeys,
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: "server-1",
        publicKey: serverKeys.publicKey,
      }],
      initialSequence: 99,
      fetch,
      now: () => NOW,
      nonce: (sequence) => `nonce-ahead-${sequence}`,
    });

    await expect(client.sync({
      version: 1,
      cursor: "device:39",
      events: [],
      receipts: [],
      waitMs: 0,
    })).resolves.toMatchObject({ cursor: "device:40", nextSequence: 41 });

    expect(sequences).toEqual(["100", "40"]);
  });

  it("retains only a bounded event identifier from an invalid-event rejection", async () => {
    const keyPair = generateDexDeviceKeyPair();
    const payload = {
      version: 1 as const,
      events: [normalizeDexEvent({
        id: "event-invalid",
        timestamp: ISO,
        type: "task.completed",
        payload: {},
      })],
      receipts: [],
      waitMs: 0,
    };
    const valid = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.example",
      deviceId: "device-1",
      keyPair,
      fetch: async () => jsonResponse({
        code: "invalid_transport_event",
        eventId: "event-invalid",
      }, { status: 400 }),
      now: () => NOW,
    });
    await expect(valid.sync(payload)).rejects.toMatchObject({
      status: 400,
      code: "invalid_transport_event",
      invalidEventId: "event-invalid",
    });

    const oversized = new DexCloudMessagingClient({
      baseUrl: "https://cloud.dex.example",
      deviceId: "device-1",
      keyPair,
      fetch: async () => jsonResponse({
        code: "invalid_transport_event",
        eventId: "x".repeat(513),
      }, { status: 400 }),
      now: () => NOW,
    });
    await expect(oversized.sync(payload)).rejects.toMatchObject({
      status: 400,
      code: "invalid_transport_event",
      invalidEventId: undefined,
    });
  });
});

describe("signed command authority", () => {
  it("fails closed for tampering, an unpinned key, or the wrong paired owner", () => {
    const server = generateDexDeviceKeyPair();
    const unsigned = {
      id: "command-1",
      issuedAt: ISO,
      command: { type: "SLEEP", payload: { when: "now" } },
      authority: { kind: "verified_owner", ownerId: "owner-1", verified: true },
    } as const;
    const signed = {
      ...unsigned,
      signature: {
        algorithm: "ed25519" as const,
        keyId: "server-1",
        value: signDexBytes(canonicalJsonBytes(unsigned), server.privateKey),
      },
    };
    const verifier = new DexCommandVerifier({
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: "server-1",
        publicKey: server.publicKey,
      }],
      ownerId: "owner-1",
      now: () => NOW,
    });

    expect(verifier.verify(signed)).toMatchObject({ verified: true, signingKeyId: "server-1" });
    expect(() => verifier.verify({
      ...signed,
      command: { ...signed.command, payload: { when: "tasks_complete" } },
    })).toThrow("signature verification failed");
    expect(() => verifier.verify({
      ...signed,
      signature: { ...signed.signature, keyId: "server-2" },
    })).toThrow("pinned server key");
    expect(() => new DexCommandVerifier({
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: "server-1",
        publicKey: server.publicKey,
      }],
      ownerId: "owner-2",
      now: () => NOW,
    }).verify(signed)).toThrow("paired owner");
  });
});

describe("macOS pairing", () => {
  it("uses security(1) with argv and never includes key material in errors", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const keychain = new MacOSDexKeychain({
      platform: "darwin",
      runner: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: `failure ${args.at(-1) ?? ""}`, exitCode: 1 };
      },
    });
    const key = generateDexDeviceKeyPair();

    let error: unknown;
    try {
      await keychain.save({ version: 1, ...key });
    } catch (caught) {
      error = caught;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/usr/bin/security",
      args: ["add-generic-password", "-U", "-s", "com.dex.device.ed25519", "-a", "device", "-w", expect.any(String)],
    });
    expect(String(error)).toBe("Error: Could not save the Dex device key to macOS Keychain");
    expect(String(error)).not.toContain(key.privateKey);
  });

  it("generates one key, pairs over the Dex interface, and persists the identity", async () => {
    let stored: DexStoredDeviceKey | null = null;
    const saves: DexStoredDeviceKey[] = [];
    const keychain: DexDeviceKeychain = {
      load: async () => stored,
      save: async (value) => {
        stored = structuredClone(value);
        saves.push(structuredClone(value));
      },
    };
    const server = generateDexDeviceKeyPair();
    let requestBody = "";
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body);
      const body = JSON.parse(requestBody) as DexPairingPayload;
      return jsonResponse({
        version: 1,
        deviceId: "device-1",
        keyId: body.keyId,
        ownerId: "owner-1",
        pairedConversationId: "conversation-1",
        cursor: "cursor-1",
        nextSequence: 8,
      });
    });
    const pairing = new DexPairingService({
      baseUrl: "https://cloud.dex.example",
      keychain,
      pinnedServerKeys: [{
        algorithm: "ed25519",
        keyId: "server-1",
        publicKey: server.publicKey,
      }],
      fetch,
      now: () => NOW,
      nonce: (sequence) => `nonce-${sequence}`,
    });

    await expect(pairing.pair({
      pairingCode: "DEX-1234",
      deviceName: "Shahdad's Mac",
    })).resolves.toEqual({
      deviceId: "device-1",
      keyId: expect.stringMatching(/^dex_[a-f0-9]{32}$/),
      ownerId: "owner-1",
      pairedConversationId: "conversation-1",
      cursor: "cursor-1",
    });
    expect(saves).toHaveLength(2);
    expect(saves[0]!.keyId).toBe(saves[1]!.keyId);
    expect(saves[1]).toMatchObject({
      deviceId: "device-1",
      ownerId: "owner-1",
      nextSequence: 8,
    });
    expect(requestBody).not.toContain("PRIVATE KEY");
    expect(await pairing.loadIdentity()).toMatchObject({ deviceId: "device-1" });
  });
});
