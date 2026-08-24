import {
  canonicalJsonBytes,
  createDexSyncPayload,
  DexCloudProtocolError,
  type DexCloudMessagingClient,
  type DexEventLike,
  type DexReceiptInput,
  type DexSyncPayload,
  type DexVerifiedCommand,
} from "../../cloud/messaging/index.js";
import { DEFAULT_CONTROL_PLANE_BODY_LIMIT } from "../../cloud/control-plane/http.js";
import type { NewDexEvent, EventLog } from "../../state/events.js";
import type { SignedTransportError } from "../../state/schemas.js";
import type { DexStateStore } from "../../state/store.js";
import { eventId } from "../../utils/ids.js";
import { redact, redactString } from "../../utils/redact.js";

const MAX_OUTBOUND_MESSAGE_CHARS = 7_900;
const MAX_SYNC_EVENTS = 500;
const MAX_SYNC_RECEIPTS = 500;
const MAX_SYNC_REQUEST_BYTES = DEFAULT_CONTROL_PLANE_BODY_LIMIT - 1;
const MAX_CURSOR_CHARS = 4_096;
const MAX_CONSECUTIVE_SYNC_FAILURES = 10_000;
const MAX_QUARANTINED_TRANSPORT_EVENTS = 1_000;

interface BoundedSyncBatch {
  payload: DexSyncPayload;
  eventCount: number;
  receiptCount: number;
  complete: boolean;
}

export interface PublishOptions {
  flush?: boolean;
  waitMs?: number;
}

export type DrainedTransportResult<T> =
  | { drained: true; value: T }
  | { drained: false };

export interface DexCloudBridgeOptions {
  now?: () => Date;
}

/**
 * Durable, serialized bridge between the local daemon and Dex Cloud. Events
 * are committed to state before network I/O and removed only after the cloud
 * acknowledges their stable IDs.
 */
export class DexCloudBridge {
  readonly #client: DexCloudMessagingClient;
  readonly #store: DexStateStore;
  readonly #events: EventLog;
  readonly #now: () => Date;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    client: DexCloudMessagingClient,
    store: DexStateStore,
    events: EventLog,
    options: DexCloudBridgeOptions = {},
  ) {
    this.#client = client;
    this.#store = store;
    this.#events = events;
    this.#now = options.now ?? (() => new Date());
  }

  get health() {
    return this.#client.health();
  }

  async publish(input: NewDexEvent, options: PublishOptions = {}): Promise<string> {
    const prepared = {
      id: input.id ?? eventId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      payload: redact(input.payload),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    };
    assertEventFitsTransport(prepared);
    return this.#serialize(async () => {
      await this.#store.updateState((state) => {
        if (state.pendingTransportEvents.some((candidate) => candidate.id === prepared.id)) return;
        state.pendingTransportEvents.push({
          id: prepared.id,
          timestamp: prepared.timestamp,
          type: prepared.type,
          payload: prepared.payload,
          ...(prepared.taskId ? { taskId: prepared.taskId } : {}),
          ...(prepared.workerId ? { workerId: prepared.workerId } : {}),
        });
      });
      // The state outbox is the delivery source of truth. Append the diagnostic
      // log only after that atomic commit, and never make callers retry with a
      // new event ID merely because diagnostics are temporarily unavailable.
      await this.#events.append(prepared).catch(() => undefined);
      if (options.flush) await this.#syncSnapshot(options.waitMs ?? 0);
      return prepared.id;
    });
  }

  async notify(
    conversationId: string,
    text: string,
    flush = true,
    stableEventId?: string,
  ): Promise<void> {
    await this.publish({
      ...(stableEventId === undefined ? {} : { id: stableEventId }),
      type: "message.sent",
      payload: { conversationId, text: boundedOutboundText(text) },
    }, { flush });
  }

  async receipt(
    commandId: string,
    status: "processed" | "rejected" | "failed" | "duplicate",
    reason?: string,
  ): Promise<void> {
    await this.#serialize(async () => {
      await this.#store.updateState((state) => {
        const existing = state.pendingTransportReceipts.find((item) => item.commandId === commandId);
        if (existing) {
          existing.status = status;
          existing.occurredAt = new Date().toISOString();
          if (reason) existing.reason = redactString(reason).slice(0, 1000);
          return;
        }
        state.pendingTransportReceipts.push({
          commandId,
          status,
          occurredAt: new Date().toISOString(),
          ...(reason ? { reason: redactString(reason).slice(0, 1000) } : {}),
        });
      });
    });
  }

  syncOnce(waitMs = 25_000): Promise<DexVerifiedCommand[]> {
    return this.#serialize(() => this.#syncSnapshot(waitMs));
  }

  /**
   * Runs a power-critical effect only after every bridge operation that has
   * already started is durable and the transport outbox is empty. The bridge
   * lock remains held for the effect, so a concurrent publication or receipt
   * cannot race between the empty check and the external power call.
   *
   * This deliberately does not perform a sync itself: doing so could consume
   * inbound commands that only the daemon runtime is allowed to dispatch.
   */
  withDrainedTransport<T>(
    effect: () => Promise<T>,
  ): Promise<DrainedTransportResult<T>> {
    return this.#serialize(async () => {
      const state = await this.#store.read();
      if (
        state.pendingTransportEvents.length > 0 ||
        state.pendingTransportReceipts.length > 0
      ) {
        return { drained: false };
      }
      return { drained: true, value: await effect() };
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #syncSnapshot(waitMs: number): Promise<DexVerifiedCommand[]> {
    const before = await this.#store.read();
    let cursor = before.lastInboundCursor;
    let pendingEvents: DexEventLike[] = before.pendingTransportEvents.map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      payload: event.payload,
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(event.workerId === undefined ? {} : { workerId: event.workerId }),
    }));
    let pendingReceipts: DexReceiptInput[] = before.pendingTransportReceipts.map((receipt) => ({
      commandId: receipt.commandId,
      status: receipt.status,
      occurredAt: receipt.occurredAt,
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
    }));
    const commands = new Map<string, DexVerifiedCommand>();
    let completedPoll = false;

    for (;;) {
      const pendingCount = pendingEvents.length + pendingReceipts.length;
      const desiredWaitMs = completedPoll ? 0 : waitMs;
      let batch = boundedSyncBatch(cursor, pendingEvents, pendingReceipts, desiredWaitMs);
      let completesPoll = batch.complete && !completedPoll;

      if (pendingCount > 0 && !batch.complete) {
        batch = boundedSyncBatch(cursor, pendingEvents, pendingReceipts, 0);
        completesPoll = batch.complete && !completedPoll && waitMs === 0;
      }
      if (pendingCount > 0 && batch.eventCount + batch.receiptCount === 0) {
        throw new RangeError(
          `A durable transport record exceeds the ${MAX_SYNC_REQUEST_BYTES}-byte request limit`,
        );
      }

      const submittedEventIds = new Set(batch.payload.events.map(({ id }) => id));
      const submittedReceiptIds = new Set(
        batch.payload.receipts.map(({ commandId }) => commandId),
      );
      const submittedReceipts = new Map(
        batch.payload.receipts.map((receipt) => [receipt.commandId, receipt]),
      );
      const attemptAt = this.#now().toISOString();
      let result: Awaited<ReturnType<DexCloudMessagingClient["sync"]>>;
      try {
        result = await this.#client.sync(batch.payload);
      } catch (syncError) {
        const invalidEventId = syncError instanceof DexCloudProtocolError &&
            syncError.status === 400 &&
            syncError.code === "invalid_transport_event"
          ? syncError.invalidEventId
          : undefined;
        const rejectedEvent = invalidEventId === undefined || !submittedEventIds.has(invalidEventId)
          ? undefined
          : pendingEvents.find((event) => event.id === invalidEventId);
        if (rejectedEvent !== undefined) {
          await this.#quarantineInvalidEvent(rejectedEvent, attemptAt);
          pendingEvents = pendingEvents.filter((event) => event.id !== rejectedEvent.id);
          continue;
        }
        // A failed signed request remains the primary error even if the disk is
        // also unhealthy. Persist only a bounded category: provider messages,
        // payloads, request signatures, and credentials never enter state.
        await this.#recordSyncFailure(attemptAt, safeSyncError(this.#client, syncError))
          .catch(() => undefined);
        throw syncError;
      }
      const acceptedEvents = new Set(
        result.acceptedEventIds.filter((id) => submittedEventIds.has(id)),
      );
      const acceptedReceipts = new Set(
        result.acceptedReceiptIds.filter((id) => submittedReceiptIds.has(id)),
      );

      for (const command of result.commands) {
        if (!commands.has(command.id)) commands.set(command.id, command);
      }
      await this.#store.updateState((state) => {
        state.lastInboundCursor = result.cursor;
        state.pendingTransportEvents = state.pendingTransportEvents.filter(
          (event) => !acceptedEvents.has(event.id),
        );
        state.pendingTransportReceipts = state.pendingTransportReceipts.filter(
          (receipt) => {
            if (!acceptedReceipts.has(receipt.commandId)) return true;
            const submitted = submittedReceipts.get(receipt.commandId);
            return submitted === undefined || !sameReceiptRevision(receipt, submitted);
          },
        );
        state.signedTransportHealth = {
          status: "healthy",
          consecutiveFailures: 0,
          lastAttemptAt: attemptAt,
          lastSuccessAt: this.#now().toISOString(),
        };
      });

      cursor = result.cursor;
      pendingEvents = pendingEvents.filter((event) => !acceptedEvents.has(event.id));
      pendingReceipts = pendingReceipts.filter(
        (receipt) => !acceptedReceipts.has(receipt.commandId),
      );
      if (completesPoll) completedPoll = true;

      if (pendingEvents.length === 0 && pendingReceipts.length === 0) {
        if (completedPoll) break;
        continue;
      }
      if (acceptedEvents.size === 0 && acceptedReceipts.size === 0) break;
    }

    return [...commands.values()];
  }

  async #quarantineInvalidEvent(event: DexEventLike, attemptAt: string): Promise<void> {
    const quarantinedAt = this.#now().toISOString();
    await this.#store.updateState((state) => {
      const pending = state.pendingTransportEvents.find((candidate) => candidate.id === event.id);
      if (!pending) {
        throw new Error(`Rejected transport event disappeared before quarantine: ${event.id}`);
      }
      state.pendingTransportEvents = state.pendingTransportEvents.filter(
        (candidate) => candidate.id !== event.id,
      );
      if (!state.quarantinedTransportEvents.some((candidate) => candidate.id === event.id)) {
        state.quarantinedTransportEvents.push({
          id: pending.id,
          timestamp: pending.timestamp,
          type: pending.type,
          ...(pending.taskId === undefined ? {} : { taskId: pending.taskId }),
          ...(pending.workerId === undefined ? {} : { workerId: pending.workerId }),
          reason: "invalid_transport_event",
          quarantinedAt,
        });
        if (state.quarantinedTransportEvents.length > MAX_QUARANTINED_TRANSPORT_EVENTS) {
          state.quarantinedTransportEvents.splice(
            0,
            state.quarantinedTransportEvents.length - MAX_QUARANTINED_TRANSPORT_EVENTS,
          );
        }
      }
      const previous = state.signedTransportHealth;
      state.signedTransportHealth = {
        status: "degraded",
        consecutiveFailures: Math.min(
          MAX_CONSECUTIVE_SYNC_FAILURES,
          (previous?.consecutiveFailures ?? 0) + 1,
        ),
        lastAttemptAt: attemptAt,
        ...(previous?.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: previous.lastSuccessAt }),
        lastError: "http",
      };
    });
  }

  async #recordSyncFailure(
    attemptAt: string,
    lastError: SignedTransportError,
  ): Promise<void> {
    await this.#store.updateState((state) => {
      const previous = state.signedTransportHealth;
      state.signedTransportHealth = {
        status: "degraded",
        consecutiveFailures: Math.min(
          MAX_CONSECUTIVE_SYNC_FAILURES,
          (previous?.consecutiveFailures ?? 0) + 1,
        ),
        lastAttemptAt: attemptAt,
        ...(previous?.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: previous.lastSuccessAt }),
        lastError,
      };
    });
  }
}

function safeSyncError(
  client: DexCloudMessagingClient,
  error: unknown,
): SignedTransportError {
  try {
    const category = client.health().lastError;
    if (
      category === "network" ||
      category === "http" ||
      category === "protocol" ||
      category === "verification"
    ) return category;
  } catch {
    // Health reporting is best-effort; classification below remains bounded.
  }
  if (error instanceof DexCloudProtocolError) {
    if (error.status !== undefined) return "http";
    if (/verif/i.test(error.code)) return "verification";
    return "protocol";
  }
  return error instanceof TypeError ? "network" : "unknown";
}

function assertEventFitsTransport(event: DexEventLike): void {
  const payload = createDexSyncPayload({
    cursor: "x".repeat(MAX_CURSOR_CHARS),
    events: [event],
    receipts: [],
    waitMs: 60_000,
  });
  if (canonicalJsonBytes(payload).byteLength > MAX_SYNC_REQUEST_BYTES) {
    throw new RangeError(
      `Transport event exceeds the ${MAX_SYNC_REQUEST_BYTES}-byte request limit`,
    );
  }
}

function sameReceiptRevision(
  current: ReceiptRevision,
  submitted: ReceiptRevision,
): boolean {
  return current.commandId === submitted.commandId
    && current.status === submitted.status
    && current.occurredAt === submitted.occurredAt
    && current.reason === submitted.reason;
}

interface ReceiptRevision {
  commandId: string;
  status: DexReceiptInput["status"];
  occurredAt?: string | undefined;
  reason?: string | undefined;
}

function boundedSyncBatch(
  cursor: string | undefined,
  events: readonly DexEventLike[],
  receipts: readonly DexReceiptInput[],
  waitMs: number,
): BoundedSyncBatch {
  const eventLimit = Math.min(events.length, MAX_SYNC_EVENTS);
  const receiptLimit = Math.min(receipts.length, MAX_SYNC_RECEIPTS);
  const payload = (eventCount: number, receiptCount: number): DexSyncPayload =>
    createDexSyncPayload({
      ...(cursor === undefined ? {} : { cursor }),
      events: events.slice(0, eventCount),
      receipts: receipts.slice(0, receiptCount),
      waitMs,
    });
  const fits = (eventCount: number, receiptCount: number): boolean =>
    canonicalJsonBytes(payload(eventCount, receiptCount)).byteLength <= MAX_SYNC_REQUEST_BYTES;
  const eventCount = largestFittingPrefix(eventLimit, (count) => fits(count, 0));
  const receiptCount = largestFittingPrefix(
    receiptLimit,
    (count) => fits(eventCount, count),
  );

  return {
    payload: payload(eventCount, receiptCount),
    eventCount,
    receiptCount,
    complete: eventCount === events.length && receiptCount === receipts.length,
  };
}

function largestFittingPrefix(limit: number, fits: (count: number) => boolean): number {
  let lower = 0;
  let upper = limit;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    if (fits(candidate)) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function boundedOutboundText(value: string): string {
  const text = redactString(value);
  return text.length > MAX_OUTBOUND_MESSAGE_CHARS
    ? `${text.slice(0, MAX_OUTBOUND_MESSAGE_CHARS - 1)}…`
    : text;
}
