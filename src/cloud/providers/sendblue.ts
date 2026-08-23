import { z } from "zod";

export const SENDBLUE_API_BASE_URL = "https://api.sendblue.com";
export const SENDBLUE_MAX_TEXT_LENGTH = 18_996;
export const SENDBLUE_DEFAULT_TIMEOUT_MS = 10_000;
export const SENDBLUE_MAX_RECONCILIATION_WINDOW_MS = 24 * 60 * 60_000;

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RECONCILIATION_PAGES = 100;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const ProviderStatusSchema = z.enum([
  "REGISTERED",
  "PENDING",
  "SENT",
  "DELIVERED",
  "RECEIVED",
  "QUEUED",
  "ERROR",
  "DECLINED",
  "ACCEPTED",
  "SUCCESS",
]);

const IdentifierSchema = z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH);
const E164Schema = z.string().regex(E164_PATTERN);
const TimestampSchema = z.string().datetime({ offset: true });
const ContentSchema = z.string().min(1).max(SENDBLUE_MAX_TEXT_LENGTH);

const SendResponseSchema = z.object({
  message_handle: IdentifierSchema,
  status: ProviderStatusSchema,
  content: ContentSchema.optional(),
  from_number: E164Schema.optional(),
  number: E164Schema.optional(),
  is_outbound: z.boolean().optional(),
  date_created: TimestampSchema.optional(),
}).passthrough();

const ListedMessageSchema = z.object({
  message_handle: IdentifierSchema,
  content: ContentSchema,
  from_number: E164Schema,
  to_number: E164Schema,
  is_outbound: z.boolean(),
  status: ProviderStatusSchema,
  date_sent: TimestampSchema.nullish(),
  date_created: TimestampSchema.nullish(),
}).passthrough().superRefine((message, context) => {
  if (message.date_sent == null && message.date_created == null) {
    context.addIssue({
      code: "custom",
      message: "A provider message timestamp is required",
    });
  }
});

const PaginationSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean().optional(),
  has_more: z.boolean().optional(),
}).passthrough();

const MessageListResponseSchema = z.object({
  status: z.literal("OK"),
  data: z.array(ListedMessageSchema),
  pagination: PaginationSchema,
}).passthrough();

export type SendblueProviderStatus = z.infer<typeof ProviderStatusSchema>;

export type SendblueFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SendblueProviderOperation = "send" | "reconcile";

export type SendblueProviderErrorCode =
  | "invalid_request"
  | "request_timeout"
  | "network_failure"
  | "request_rejected"
  | "server_uncertain"
  | "invalid_response"
  | "reconciliation_too_broad";

interface ProviderErrorOptions {
  code: SendblueProviderErrorCode;
  operation: SendblueProviderOperation;
  message: string;
  httpStatus?: number;
  retryable: boolean;
  ambiguous: boolean;
}

/**
 * A deliberately sanitized provider error. It never retains response bodies,
 * request headers, credentials, or the original fetch error as a cause.
 */
export class SendblueProviderError extends Error {
  readonly code: SendblueProviderErrorCode;
  readonly operation: SendblueProviderOperation;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = "SendblueProviderError";
    this.code = options.code;
    this.operation = options.operation;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable;
    this.ambiguous = options.ambiguous;
  }
}

export class SendblueAmbiguousDeliveryError extends SendblueProviderError {
  constructor(options: Omit<ProviderErrorOptions, "operation" | "ambiguous">) {
    super({ ...options, operation: "send", ambiguous: true });
    this.name = "SendblueAmbiguousDeliveryError";
  }
}

export function isSendblueAmbiguousDeliveryError(
  error: unknown,
): error is SendblueAmbiguousDeliveryError {
  return error instanceof SendblueProviderError && error.ambiguous;
}

export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}

export interface SendblueClientOptions {
  apiKeyId: string;
  apiSecretKey: string;
  fetch: SendblueFetch;
  timeoutMs?: number;
  reconciliationPageSize?: number;
  reconciliationMaxPages?: number;
}

export interface SendblueSendMessageInput {
  number: string;
  fromNumber: string;
  content: string;
  statusCallback?: string;
}

export interface SendblueSendMessageResult {
  messageHandle: string;
  status: SendblueProviderStatus;
  createdAt?: string;
}

export interface SendblueReconciliationInput {
  number: string;
  fromNumber: string;
  content: string;
  windowStart: string;
  windowEnd: string;
}

export interface SendblueReconciledMessage {
  messageHandle: string;
  number: string;
  fromNumber: string;
  content: string;
  status: SendblueProviderStatus;
  timestamp: string;
}

export type SendblueReconciliationResult =
  | { kind: "not_found" }
  | { kind: "matched"; message: SendblueReconciledMessage }
  | { kind: "multiple_matches"; messages: readonly SendblueReconciledMessage[] };

interface RawProviderResponse {
  ok: boolean;
  status: number;
  text: string;
}

class ResponseReadFailure extends Error {}

function validateCredential(value: string): boolean {
  return value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000\r\n]/.test(value);
}

function invalidRequest(operation: SendblueProviderOperation): SendblueProviderError {
  return new SendblueProviderError({
    code: "invalid_request",
    operation,
    message: "Invalid Sendblue request",
    retryable: false,
    ambiguous: false,
  });
}

function providerFailure(
  operation: SendblueProviderOperation,
  code: "request_timeout" | "network_failure" | "invalid_response" | "reconciliation_too_broad",
): SendblueProviderError {
  return new SendblueProviderError({
    code,
    operation,
    message: operation === "send"
      ? "Sendblue did not return a confirmed send response"
      : "Sendblue reconciliation could not be completed",
    retryable: true,
    ambiguous: false,
  });
}

function ambiguousFailure(
  code: "request_timeout" | "network_failure" | "server_uncertain" | "invalid_response",
  httpStatus?: number,
): SendblueAmbiguousDeliveryError {
  return new SendblueAmbiguousDeliveryError({
    code,
    message: "Sendblue delivery outcome is ambiguous",
    ...(httpStatus === undefined ? {} : { httpStatus }),
    retryable: true,
  });
}

function rejectedFailure(status: number): SendblueProviderError {
  return new SendblueProviderError({
    code: "request_rejected",
    operation: "send",
    message: "Sendblue rejected the send request",
    httpStatus: status,
    retryable: status === 429,
    ambiguous: false,
  });
}

function reconcileHttpFailure(status: number): SendblueProviderError {
  return new SendblueProviderError({
    code: "request_rejected",
    operation: "reconcile",
    message: "Sendblue rejected the reconciliation request",
    httpStatus: status,
    retryable: status >= 500 || status === 429,
    ambiguous: false,
  });
}

function validateCallbackUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function validateSendInput(input: SendblueSendMessageInput): void {
  if (
    !E164Schema.safeParse(input.number).success ||
    !E164Schema.safeParse(input.fromNumber).success ||
    !ContentSchema.safeParse(input.content).success ||
    (input.statusCallback !== undefined && !validateCallbackUrl(input.statusCallback))
  ) {
    throw invalidRequest("send");
  }
}

function validateReconciliationInput(input: SendblueReconciliationInput): {
  start: number;
  end: number;
} {
  if (
    !E164Schema.safeParse(input.number).success ||
    !E164Schema.safeParse(input.fromNumber).success ||
    !ContentSchema.safeParse(input.content).success ||
    !TimestampSchema.safeParse(input.windowStart).success ||
    !TimestampSchema.safeParse(input.windowEnd).success
  ) {
    throw invalidRequest("reconcile");
  }
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (start > end || end - start > SENDBLUE_MAX_RECONCILIATION_WINDOW_MS) {
    throw invalidRequest("reconcile");
  }
  return { start, end };
}

async function readBoundedUtf8(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new ResponseReadFailure();
    }
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ResponseReadFailure();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    throw new ResponseReadFailure();
  } finally {
    reader.releaseLock();
  }
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) throw new ResponseReadFailure();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResponseReadFailure();
  }
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class SendblueClient {
  readonly #apiKeyId: string;
  readonly #apiSecretKey: string;
  readonly #fetch: SendblueFetch;
  readonly #timeoutMs: number;
  readonly #reconciliationPageSize: number;
  readonly #reconciliationMaxPages: number;

  constructor(options: SendblueClientOptions) {
    if (
      !validateCredential(options.apiKeyId) ||
      !validateCredential(options.apiSecretKey) ||
      typeof options.fetch !== "function"
    ) {
      throw new TypeError("Valid Sendblue credentials and fetch implementation are required");
    }
    const timeoutMs = options.timeoutMs ?? SENDBLUE_DEFAULT_TIMEOUT_MS;
    const pageSize = options.reconciliationPageSize ?? 100;
    const maxPages = options.reconciliationMaxPages ?? MAX_RECONCILIATION_PAGES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError("Sendblue timeout must be between 1 and 120000 milliseconds");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RangeError("Sendblue reconciliation page size must be between 1 and 100");
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_RECONCILIATION_PAGES) {
      throw new RangeError("Sendblue reconciliation page count must be between 1 and 100");
    }
    this.#apiKeyId = options.apiKeyId;
    this.#apiSecretKey = options.apiSecretKey;
    this.#fetch = options.fetch;
    this.#timeoutMs = timeoutMs;
    this.#reconciliationPageSize = pageSize;
    this.#reconciliationMaxPages = maxPages;
  }

  async sendMessage(input: SendblueSendMessageInput): Promise<SendblueSendMessageResult> {
    validateSendInput(input);
    const body: {
      number: string;
      from_number: string;
      content: string;
      status_callback?: string;
    } = {
      number: input.number,
      from_number: input.fromNumber,
      content: input.content,
    };
    if (input.statusCallback !== undefined) body.status_callback = input.statusCallback;

    let response: RawProviderResponse;
    try {
      response = await this.#request("send", new URL("/api/send-message", SENDBLUE_API_BASE_URL), {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (!(error instanceof SendblueProviderError)) throw error;
      throw ambiguousFailure(
        error.code === "request_timeout" ? "request_timeout" : "network_failure",
      );
    }

    if (!response.ok) {
      if (response.status >= 500) {
        throw ambiguousFailure("server_uncertain", response.status);
      }
      throw rejectedFailure(response.status);
    }

    let parsed: z.infer<typeof SendResponseSchema>;
    try {
      const result = SendResponseSchema.safeParse(parseJson(response.text));
      if (!result.success) throw new ResponseReadFailure();
      parsed = result.data;
    } catch {
      throw ambiguousFailure("invalid_response");
    }
    if (
      (parsed.number !== undefined && parsed.number !== input.number) ||
      (parsed.from_number !== undefined && parsed.from_number !== input.fromNumber) ||
      (parsed.content !== undefined && parsed.content !== input.content) ||
      parsed.is_outbound === false
    ) {
      throw ambiguousFailure("invalid_response");
    }
    return {
      messageHandle: parsed.message_handle,
      status: parsed.status,
      ...(parsed.date_created === undefined ? {} : { createdAt: parsed.date_created }),
    };
  }

  async reconcileMessage(
    input: SendblueReconciliationInput,
  ): Promise<SendblueReconciliationResult> {
    const window = validateReconciliationInput(input);
    const matches = new Map<string, SendblueReconciledMessage>();
    let offset = 0;

    for (let page = 0; page < this.#reconciliationMaxPages; page += 1) {
      const url = new URL("/api/v2/messages", SENDBLUE_API_BASE_URL);
      url.searchParams.set("limit", String(this.#reconciliationPageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order_by", "createdAt");
      url.searchParams.set("order_direction", "asc");
      url.searchParams.set("is_outbound", "true");
      url.searchParams.set("from_number", input.fromNumber);
      url.searchParams.set("to_number", input.number);
      url.searchParams.set("created_at_gte", input.windowStart);
      url.searchParams.set("created_at_lte", input.windowEnd);

      const response = await this.#request("reconcile", url, { method: "GET" });
      if (!response.ok) throw reconcileHttpFailure(response.status);

      let parsed: z.infer<typeof MessageListResponseSchema>;
      try {
        const result = MessageListResponseSchema.safeParse(parseJson(response.text));
        if (!result.success || result.data.pagination.offset !== offset) {
          throw new ResponseReadFailure();
        }
        parsed = result.data;
      } catch {
        throw providerFailure("reconcile", "invalid_response");
      }

      for (const message of parsed.data) {
        const timestamp = message.date_sent ?? message.date_created;
        if (timestamp === null || timestamp === undefined) continue;
        const occurredAt = Date.parse(timestamp);
        if (
          message.is_outbound &&
          message.from_number === input.fromNumber &&
          message.to_number === input.number &&
          message.content === input.content &&
          occurredAt >= window.start &&
          occurredAt <= window.end
        ) {
          matches.set(message.message_handle, {
            messageHandle: message.message_handle,
            number: message.to_number,
            fromNumber: message.from_number,
            content: message.content,
            status: message.status,
            timestamp,
          });
        }
      }

      const pagination = parsed.pagination;
      const nextOffset = pagination.offset + pagination.limit;
      const hasMore = pagination.hasMore ?? pagination.has_more ?? nextOffset < pagination.total;
      if (!hasMore || nextOffset >= pagination.total) break;
      if (nextOffset <= offset || parsed.data.length === 0) {
        throw providerFailure("reconcile", "invalid_response");
      }
      offset = nextOffset;

      if (page === this.#reconciliationMaxPages - 1) {
        throw providerFailure("reconcile", "reconciliation_too_broad");
      }
    }

    const ordered = [...matches.values()].sort((left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
      lexicalCompare(left.messageHandle, right.messageHandle)
    );
    if (ordered.length === 0) return { kind: "not_found" };
    if (ordered.length === 1) return { kind: "matched", message: ordered[0]! };
    return { kind: "multiple_matches", messages: ordered };
  }

  async #request(
    operation: SendblueProviderOperation,
    url: URL,
    init: { method: "GET" | "POST"; body?: string },
  ): Promise<RawProviderResponse> {
    const headers = new Headers({
      accept: "application/json",
      "sb-api-key-id": this.#apiKeyId,
      "sb-api-secret-key": this.#apiSecretKey,
    });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ResponseReadFailure());
      }, this.#timeoutMs);
    });
    const request = (async (): Promise<RawProviderResponse> => {
      const response = await this.#fetch(url, {
        method: init.method,
        headers,
        redirect: "error",
        signal: controller.signal,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, status: response.status, text: "" };
      }
      return {
        ok: true,
        status: response.status,
        text: await readBoundedUtf8(response),
      };
    })();

    try {
      return await Promise.race([request, timeout]);
    } catch {
      throw providerFailure(
        operation,
        timedOut ? "request_timeout" : "network_failure",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export interface SendblueOutboxItem {
  id: string;
  dedupeKey: string;
  toPhone: string;
  text: string;
  createdAt: string;
}

export interface SendblueOutboxClaim {
  claimToken: string;
  item: SendblueOutboxItem;
  action: "send" | "reconcile";
  attemptStartedAt: string;
}

export interface SendblueOutboxClaimInput {
  workerId: string;
  claimedAt: string;
  leaseMs: number;
}

export interface SendblueProviderHandleSettlement {
  outboxId: string;
  claimToken: string;
  providerHandle: string;
  providerStatus: SendblueProviderStatus;
  resolvedAt: string;
  resolution: "send" | "reconciled";
}

export interface SendblueAmbiguousSettlement {
  outboxId: string;
  claimToken: string;
  attemptStartedAt: string;
  observedAt: string;
  reason: SendblueProviderErrorCode;
}

export interface SendblueRejectedSettlement {
  outboxId: string;
  claimToken: string;
  rejectedAt: string;
  reason: SendblueProviderErrorCode;
  httpStatus?: number;
  retryable: boolean;
}

export interface SendblueReconciliationPendingSettlement {
  outboxId: string;
  claimToken: string;
  checkedAt: string;
  reason: "not_found" | "multiple_matches" | "lookup_failed";
  errorCode?: SendblueProviderErrorCode;
  candidateHandles?: readonly string[];
}

/**
 * Durable storage boundary for at-most-one POST per outbox item.
 *
 * claimNext must atomically lease the item and persist attemptStartedAt before
 * returning an action of "send". If that lease expires without settlement,
 * every later claim for the item must use "reconcile", never "send". Settlement
 * methods must be idempotent for the same outbox ID, claim token, and handle.
 */
export interface SendblueDeliveryStore {
  claimNext(input: SendblueOutboxClaimInput): Promise<SendblueOutboxClaim | null>;
  recordProviderHandle(input: SendblueProviderHandleSettlement): Promise<void>;
  recordAmbiguous(input: SendblueAmbiguousSettlement): Promise<void>;
  recordRejected(input: SendblueRejectedSettlement): Promise<void>;
  recordReconciliationPending(
    input: SendblueReconciliationPendingSettlement,
  ): Promise<void>;
}

export interface SendblueOutboxDispatcherOptions {
  client: SendblueClient;
  store: SendblueDeliveryStore;
  fromNumber: string;
  workerId: string;
  statusCallback?: string;
  now?: () => number;
  claimLeaseMs?: number;
  reconciliationLookbackMs?: number;
  reconciliationLookaheadMs?: number;
}

export type SendblueDispatchResult =
  | { kind: "idle" }
  | {
    kind: "delivered";
    outboxId: string;
    providerHandle: string;
    reconciled: boolean;
  }
  | { kind: "ambiguous"; outboxId: string; reason: SendblueProviderErrorCode }
  | {
    kind: "rejected";
    outboxId: string;
    reason: SendblueProviderErrorCode;
    httpStatus?: number;
  }
  | {
    kind: "reconciliation_pending";
    outboxId: string;
    reason: "not_found" | "multiple_matches" | "lookup_failed";
  };

function positiveDuration(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isoTimestamp(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Dispatcher clock returned an invalid time");
  return new Date(value).toISOString();
}

export class SendblueOutboxDispatcher {
  readonly #client: SendblueClient;
  readonly #store: SendblueDeliveryStore;
  readonly #fromNumber: string;
  readonly #workerId: string;
  readonly #statusCallback: string | undefined;
  readonly #now: () => number;
  readonly #claimLeaseMs: number;
  readonly #reconciliationLookbackMs: number;
  readonly #reconciliationLookaheadMs: number;

  constructor(options: SendblueOutboxDispatcherOptions) {
    const claimLeaseMs = options.claimLeaseMs ?? 30_000;
    const lookbackMs = options.reconciliationLookbackMs ?? 30_000;
    const lookaheadMs = options.reconciliationLookaheadMs ?? 5 * 60_000;
    if (
      !isE164(options.fromNumber) ||
      options.workerId.trim().length === 0 ||
      options.workerId.length > MAX_IDENTIFIER_LENGTH ||
      (options.statusCallback !== undefined && !validateCallbackUrl(options.statusCallback)) ||
      !positiveDuration(claimLeaseMs, 60 * 60_000) || claimLeaseMs === 0 ||
      !positiveDuration(lookbackMs, SENDBLUE_MAX_RECONCILIATION_WINDOW_MS) ||
      !positiveDuration(lookaheadMs, SENDBLUE_MAX_RECONCILIATION_WINDOW_MS) ||
      lookbackMs + lookaheadMs > SENDBLUE_MAX_RECONCILIATION_WINDOW_MS
    ) {
      throw new TypeError("Invalid Sendblue dispatcher configuration");
    }
    this.#client = options.client;
    this.#store = options.store;
    this.#fromNumber = options.fromNumber;
    this.#workerId = options.workerId;
    this.#statusCallback = options.statusCallback;
    this.#now = options.now ?? Date.now;
    this.#claimLeaseMs = claimLeaseMs;
    this.#reconciliationLookbackMs = lookbackMs;
    this.#reconciliationLookaheadMs = lookaheadMs;
  }

  async dispatchNext(): Promise<SendblueDispatchResult> {
    const claimedAt = isoTimestamp(this.#now());
    const claim = await this.#store.claimNext({
      workerId: this.#workerId,
      claimedAt,
      leaseMs: this.#claimLeaseMs,
    });
    if (claim === null) return { kind: "idle" };

    if (!TimestampSchema.safeParse(claim.attemptStartedAt).success) {
      const rejectedAt = isoTimestamp(this.#now());
      await this.#store.recordRejected({
        outboxId: claim.item.id,
        claimToken: claim.claimToken,
        rejectedAt,
        reason: "invalid_request",
        retryable: false,
      });
      return { kind: "rejected", outboxId: claim.item.id, reason: "invalid_request" };
    }

    if (claim.action === "reconcile") return this.#reconcile(claim);
    return this.#send(claim);
  }

  async #send(claim: SendblueOutboxClaim): Promise<SendblueDispatchResult> {
    try {
      const sent = await this.#client.sendMessage({
        number: claim.item.toPhone,
        fromNumber: this.#fromNumber,
        content: claim.item.text,
        ...(this.#statusCallback === undefined ? {} : { statusCallback: this.#statusCallback }),
      });
      await this.#store.recordProviderHandle({
        outboxId: claim.item.id,
        claimToken: claim.claimToken,
        providerHandle: sent.messageHandle,
        providerStatus: sent.status,
        resolvedAt: isoTimestamp(this.#now()),
        resolution: "send",
      });
      return {
        kind: "delivered",
        outboxId: claim.item.id,
        providerHandle: sent.messageHandle,
        reconciled: false,
      };
    } catch (error) {
      if (!(error instanceof SendblueProviderError)) throw error;
      if (error.ambiguous) {
        await this.#store.recordAmbiguous({
          outboxId: claim.item.id,
          claimToken: claim.claimToken,
          attemptStartedAt: claim.attemptStartedAt,
          observedAt: isoTimestamp(this.#now()),
          reason: error.code,
        });
        return { kind: "ambiguous", outboxId: claim.item.id, reason: error.code };
      }
      const settlement: SendblueRejectedSettlement = {
        outboxId: claim.item.id,
        claimToken: claim.claimToken,
        rejectedAt: isoTimestamp(this.#now()),
        reason: error.code,
        retryable: error.retryable,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      };
      await this.#store.recordRejected(settlement);
      return {
        kind: "rejected",
        outboxId: claim.item.id,
        reason: error.code,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      };
    }
  }

  async #reconcile(claim: SendblueOutboxClaim): Promise<SendblueDispatchResult> {
    const attemptedAt = Date.parse(claim.attemptStartedAt);
    const windowStart = isoTimestamp(attemptedAt - this.#reconciliationLookbackMs);
    const windowEnd = isoTimestamp(attemptedAt + this.#reconciliationLookaheadMs);
    let result: SendblueReconciliationResult;
    try {
      result = await this.#client.reconcileMessage({
        number: claim.item.toPhone,
        fromNumber: this.#fromNumber,
        content: claim.item.text,
        windowStart,
        windowEnd,
      });
    } catch (error) {
      if (!(error instanceof SendblueProviderError)) throw error;
      await this.#store.recordReconciliationPending({
        outboxId: claim.item.id,
        claimToken: claim.claimToken,
        checkedAt: isoTimestamp(this.#now()),
        reason: "lookup_failed",
        errorCode: error.code,
      });
      return {
        kind: "reconciliation_pending",
        outboxId: claim.item.id,
        reason: "lookup_failed",
      };
    }

    if (result.kind === "matched") {
      await this.#store.recordProviderHandle({
        outboxId: claim.item.id,
        claimToken: claim.claimToken,
        providerHandle: result.message.messageHandle,
        providerStatus: result.message.status,
        resolvedAt: isoTimestamp(this.#now()),
        resolution: "reconciled",
      });
      return {
        kind: "delivered",
        outboxId: claim.item.id,
        providerHandle: result.message.messageHandle,
        reconciled: true,
      };
    }

    const pending: SendblueReconciliationPendingSettlement = {
      outboxId: claim.item.id,
      claimToken: claim.claimToken,
      checkedAt: isoTimestamp(this.#now()),
      reason: result.kind,
      ...(result.kind === "multiple_matches"
        ? { candidateHandles: result.messages.map((message) => message.messageHandle) }
        : {}),
    };
    await this.#store.recordReconciliationPending(pending);
    return {
      kind: "reconciliation_pending",
      outboxId: claim.item.id,
      reason: result.kind,
    };
  }
}
