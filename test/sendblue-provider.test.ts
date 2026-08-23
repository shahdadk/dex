import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SENDBLUE_API_BASE_URL,
  SENDBLUE_MAX_TEXT_LENGTH,
  SendblueAmbiguousDeliveryError,
  SendblueClient,
  SendblueOutboxDispatcher,
  SendblueProviderError,
  type SendblueDeliveryStore,
  type SendblueOutboxClaim,
} from "../src/cloud/providers/index.js";

const API_KEY = "sendblue-key-id";
const API_SECRET = "sendblue-secret-key";
const FROM = "+14165550100";
const TO = "+14165550101";
const CONTENT = "Dex finished the task.";
const ATTEMPTED_AT = "2026-08-23T18:00:00.000Z";
const NOW = Date.parse(ATTEMPTED_AT);

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function sendResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    message_handle: "message-handle-1",
    status: "QUEUED",
    content: CONTENT,
    from_number: FROM,
    number: TO,
    is_outbound: true,
    date_created: ATTEMPTED_AT,
    ...overrides,
  });
}

function listedMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_handle: "message-handle-1",
    status: "SENT",
    content: CONTENT,
    from_number: FROM,
    to_number: TO,
    is_outbound: true,
    date_sent: ATTEMPTED_AT,
    ...overrides,
  };
}

function clientWith(fetch: ConstructorParameters<typeof SendblueClient>[0]["fetch"], options: {
  timeoutMs?: number;
  reconciliationPageSize?: number;
  reconciliationMaxPages?: number;
} = {}): SendblueClient {
  return new SendblueClient({
    apiKeyId: API_KEY,
    apiSecretKey: API_SECRET,
    fetch,
    ...options,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SendblueClient send-message adapter", () => {
  it("uses the current Sendblue endpoint, credential headers, and exact request body", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return sendResponse();
    });
    const client = clientWith(fetch);

    await expect(client.sendMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
      statusCallback: "https://dex.example.test/webhooks/sendblue/status",
    })).resolves.toEqual({
      messageHandle: "message-handle-1",
      status: "QUEUED",
      createdAt: ATTEMPTED_AT,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(String(call.input)).toBe(`${SENDBLUE_API_BASE_URL}/api/send-message`);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.redirect).toBe("error");
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(call.init?.headers)).toMatchObject(expect.any(Headers));
    const headers = new Headers(call.init?.headers);
    expect(headers.get("sb-api-key-id")).toBe(API_KEY);
    expect(headers.get("sb-api-secret-key")).toBe(API_SECRET);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      number: TO,
      from_number: FROM,
      content: CONTENT,
      status_callback: "https://dex.example.test/webhooks/sendblue/status",
    });
  });

  it("accepts the documented text boundary and rejects invalid input before fetch", async () => {
    const fetch = vi.fn(async () => sendResponse({
      content: "x".repeat(SENDBLUE_MAX_TEXT_LENGTH),
    }));
    const client = clientWith(fetch);

    await expect(client.sendMessage({
      number: TO,
      fromNumber: FROM,
      content: "x".repeat(SENDBLUE_MAX_TEXT_LENGTH),
    })).resolves.toMatchObject({ messageHandle: "message-handle-1" });

    const invalid = [
      { number: "4165550101", fromNumber: FROM, content: CONTENT },
      { number: TO, fromNumber: "+0123456789", content: CONTENT },
      { number: TO, fromNumber: FROM, content: "" },
      { number: TO, fromNumber: FROM, content: "x".repeat(SENDBLUE_MAX_TEXT_LENGTH + 1) },
      { number: TO, fromNumber: FROM, content: CONTENT, statusCallback: "file:///tmp/status" },
    ];
    for (const input of invalid) {
      await expect(client.sendMessage(input)).rejects.toMatchObject({
        code: "invalid_request",
        ambiguous: false,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats malformed successful responses as ambiguous after strict parsing", async () => {
    const responses = [
      new Response("not-json", { status: 200 }),
      jsonResponse({ status: "QUEUED" }),
      sendResponse({ status: "UNKNOWN" }),
      sendResponse({ number: "+14165550999" }),
      sendResponse({ is_outbound: false }),
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    const client = clientWith(fetch);

    for (let index = 0; index < 5; index += 1) {
      await expect(client.sendMessage({
        number: TO,
        fromNumber: FROM,
        content: CONTENT,
      })).rejects.toMatchObject({
        code: "invalid_response",
        ambiguous: true,
      });
    }
  });

  it("classifies network, timeout, and 5xx outcomes as ambiguous without leaking secrets", async () => {
    const leakingFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      throw new Error(`failed with ${headers.get("sb-api-key-id")} ${headers.get("sb-api-secret-key")}`);
    });
    const networkClient = clientWith(leakingFetch);
    const networkError = await networkClient.sendMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
    }).catch((error: unknown) => error);
    expect(networkError).toBeInstanceOf(SendblueAmbiguousDeliveryError);
    expect(networkError).toMatchObject({ code: "network_failure", ambiguous: true });
    expect(String(networkError)).not.toContain(API_KEY);
    expect(String(networkError)).not.toContain(API_SECRET);
    expect(JSON.stringify(networkError)).not.toContain(API_SECRET);

    const serverClient = clientWith(vi.fn(async () =>
      jsonResponse({ api_secret: API_SECRET }, { status: 503 })));
    const serverError = await serverClient.sendMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
    }).catch((error: unknown) => error);
    expect(serverError).toMatchObject({
      code: "server_uncertain",
      httpStatus: 503,
      ambiguous: true,
    });
    expect(String(serverError)).not.toContain(API_SECRET);

    vi.useFakeTimers();
    const timeoutClient = clientWith(
      vi.fn(() => new Promise<Response>(() => undefined)),
      { timeoutMs: 25 },
    );
    const timedOut = expect(timeoutClient.sendMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
    })).rejects.toMatchObject({
      code: "request_timeout",
      ambiguous: true,
    });
    await vi.advanceTimersByTimeAsync(26);
    await timedOut;
  });

  it("treats a 4xx response as a confirmed rejection", async () => {
    const client = clientWith(vi.fn(async () =>
      jsonResponse({ error: API_SECRET }, { status: 400 })));

    const error = await client.sendMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SendblueProviderError);
    expect(error).toMatchObject({
      code: "request_rejected",
      httpStatus: 400,
      ambiguous: false,
      retryable: false,
    });
    expect(String(error)).not.toContain(API_SECRET);
  });
});

describe("Sendblue deterministic reconciliation", () => {
  it("paginates GET /api/v2/messages and returns only exact matches in stable order", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const pages = [
      jsonResponse({
        status: "OK",
        data: [
          listedMessage({ message_handle: "irrelevant", content: "another message" }),
          listedMessage({
            message_handle: "handle-b",
            date_sent: "2026-08-23T18:00:02.000Z",
          }),
        ],
        pagination: { limit: 2, offset: 0, total: 3, hasMore: true },
      }),
      jsonResponse({
        status: "OK",
        data: [listedMessage({
          message_handle: "handle-a",
          date_sent: "2026-08-23T18:00:01.000Z",
        })],
        pagination: { limit: 2, offset: 2, total: 3, hasMore: false },
      }),
    ];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), ...(init === undefined ? {} : { init }) });
      return pages.shift()!;
    });
    const client = clientWith(fetch, { reconciliationPageSize: 2 });

    await expect(client.reconcileMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
      windowStart: "2026-08-23T17:59:30.000Z",
      windowEnd: "2026-08-23T18:05:00.000Z",
    })).resolves.toMatchObject({
      kind: "multiple_matches",
      messages: [
        { messageHandle: "handle-a", timestamp: "2026-08-23T18:00:01.000Z" },
        { messageHandle: "handle-b", timestamp: "2026-08-23T18:00:02.000Z" },
      ],
    });

    expect(calls).toHaveLength(2);
    expect(calls.map(({ url }) => url.origin + url.pathname)).toEqual([
      `${SENDBLUE_API_BASE_URL}/api/v2/messages`,
      `${SENDBLUE_API_BASE_URL}/api/v2/messages`,
    ]);
    expect(calls.map(({ url }) => url.searchParams.get("offset"))).toEqual(["0", "2"]);
    for (const { url, init } of calls) {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(url.searchParams.get("is_outbound")).toBe("true");
      expect(url.searchParams.get("from_number")).toBe(FROM);
      expect(url.searchParams.get("to_number")).toBe(TO);
      expect(url.searchParams.get("created_at_gte")).toBe("2026-08-23T17:59:30.000Z");
      expect(url.searchParams.get("created_at_lte")).toBe("2026-08-23T18:05:00.000Z");
      expect(new Headers(init?.headers).get("sb-api-secret-key")).toBe(API_SECRET);
    }
  });

  it("rejects malformed list responses and invalid or unbounded windows", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      status: "OK",
      data: [listedMessage({ message_handle: "" })],
      pagination: { limit: 100, offset: 0, total: 1 },
    }));
    const client = clientWith(fetch);

    await expect(client.reconcileMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
      windowStart: "2026-08-23T17:59:00.000Z",
      windowEnd: "2026-08-23T18:01:00.000Z",
    })).rejects.toMatchObject({ code: "invalid_response", operation: "reconcile" });

    await expect(client.reconcileMessage({
      number: TO,
      fromNumber: FROM,
      content: CONTENT,
      windowStart: "2026-08-22T17:59:00.000Z",
      windowEnd: "2026-08-23T18:01:00.000Z",
    })).rejects.toMatchObject({ code: "invalid_request", operation: "reconcile" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("SendblueOutboxDispatcher", () => {
  function outboxClaim(
    action: SendblueOutboxClaim["action"],
    claimToken: string,
  ): SendblueOutboxClaim {
    return {
      claimToken,
      action,
      attemptStartedAt: ATTEMPTED_AT,
      item: {
        id: "outbox-1",
        dedupeKey: "sendblue:task:1",
        toPhone: TO,
        text: CONTENT,
        createdAt: ATTEMPTED_AT,
      },
    };
  }

  function fakeStore(claims: SendblueOutboxClaim[]) {
    const store: SendblueDeliveryStore = {
      claimNext: vi.fn(async () => claims.shift() ?? null),
      recordProviderHandle: vi.fn(async () => undefined),
      recordAmbiguous: vi.fn(async () => undefined),
      recordRejected: vi.fn(async () => undefined),
      recordReconciliationPending: vi.fn(async () => undefined),
    };
    return store;
  }

  it("never blindly retries an uncertain POST and resolves it through GET reconciliation", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      if (requests.length === 1) throw new Error("socket reset after request write");
      return jsonResponse({
        status: "OK",
        data: [listedMessage({ message_handle: "reconciled-handle" })],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      });
    });
    const store = fakeStore([
      outboxClaim("send", "claim-1"),
      outboxClaim("reconcile", "claim-2"),
    ]);
    const dispatcher = new SendblueOutboxDispatcher({
      client: clientWith(fetch),
      store,
      fromNumber: FROM,
      workerId: "worker-1",
      now: () => NOW,
    });

    await expect(dispatcher.dispatchNext()).resolves.toEqual({
      kind: "ambiguous",
      outboxId: "outbox-1",
      reason: "network_failure",
    });
    await expect(dispatcher.dispatchNext()).resolves.toEqual({
      kind: "delivered",
      outboxId: "outbox-1",
      providerHandle: "reconciled-handle",
      reconciled: true,
    });

    expect(requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(store.recordAmbiguous).toHaveBeenCalledWith({
      outboxId: "outbox-1",
      claimToken: "claim-1",
      attemptStartedAt: ATTEMPTED_AT,
      observedAt: ATTEMPTED_AT,
      reason: "network_failure",
    });
    expect(store.recordProviderHandle).toHaveBeenCalledWith({
      outboxId: "outbox-1",
      claimToken: "claim-2",
      providerHandle: "reconciled-handle",
      providerStatus: "SENT",
      resolvedAt: ATTEMPTED_AT,
      resolution: "reconciled",
    });
  });

  it("records a provider handle on success and a definitive rejection on 4xx", async () => {
    const successStore = fakeStore([outboxClaim("send", "claim-success")]);
    const success = new SendblueOutboxDispatcher({
      client: clientWith(vi.fn(async () => sendResponse())),
      store: successStore,
      fromNumber: FROM,
      workerId: "worker-success",
      now: () => NOW,
    });
    await expect(success.dispatchNext()).resolves.toMatchObject({
      kind: "delivered",
      providerHandle: "message-handle-1",
      reconciled: false,
    });
    expect(successStore.recordProviderHandle).toHaveBeenCalledWith(expect.objectContaining({
      claimToken: "claim-success",
      providerHandle: "message-handle-1",
      resolution: "send",
    }));

    const rejectedStore = fakeStore([outboxClaim("send", "claim-rejected")]);
    const rejected = new SendblueOutboxDispatcher({
      client: clientWith(vi.fn(async () => jsonResponse({}, { status: 422 }))),
      store: rejectedStore,
      fromNumber: FROM,
      workerId: "worker-rejected",
      now: () => NOW,
    });
    await expect(rejected.dispatchNext()).resolves.toEqual({
      kind: "rejected",
      outboxId: "outbox-1",
      reason: "request_rejected",
      httpStatus: 422,
    });
    expect(rejectedStore.recordRejected).toHaveBeenCalledWith(expect.objectContaining({
      claimToken: "claim-rejected",
      reason: "request_rejected",
      httpStatus: 422,
      retryable: false,
    }));
  });

  it("keeps no-match and multiple-match reconciliation pending without another send", async () => {
    const responses = [
      jsonResponse({
        status: "OK",
        data: [],
        pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
      }),
      jsonResponse({
        status: "OK",
        data: [
          listedMessage({ message_handle: "candidate-2", date_sent: ATTEMPTED_AT }),
          listedMessage({ message_handle: "candidate-1", date_sent: ATTEMPTED_AT }),
        ],
        pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
      }),
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    const store = fakeStore([
      outboxClaim("reconcile", "claim-missing"),
      outboxClaim("reconcile", "claim-multiple"),
    ]);
    const dispatcher = new SendblueOutboxDispatcher({
      client: clientWith(fetch),
      store,
      fromNumber: FROM,
      workerId: "worker-reconcile",
      now: () => NOW,
    });

    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      kind: "reconciliation_pending",
      reason: "not_found",
    });
    await expect(dispatcher.dispatchNext()).resolves.toMatchObject({
      kind: "reconciliation_pending",
      reason: "multiple_matches",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.recordProviderHandle).not.toHaveBeenCalled();
    expect(store.recordReconciliationPending).toHaveBeenLastCalledWith({
      outboxId: "outbox-1",
      claimToken: "claim-multiple",
      checkedAt: ATTEMPTED_AT,
      reason: "multiple_matches",
      candidateHandles: ["candidate-1", "candidate-2"],
    });
  });
});
