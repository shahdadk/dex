import type { DexCloudMessagingClient, DexVerifiedCommand } from "../../cloud/messaging/index.js";
import { createDexSyncPayload } from "../../cloud/messaging/index.js";
import type { NewDexEvent, EventLog } from "../../state/events.js";
import type { DexStateStore } from "../../state/store.js";
import { redactString } from "../../utils/redact.js";

export interface PublishOptions {
  flush?: boolean;
  waitMs?: number;
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
  #tail: Promise<unknown> = Promise.resolve();

  constructor(client: DexCloudMessagingClient, store: DexStateStore, events: EventLog) {
    this.#client = client;
    this.#store = store;
    this.#events = events;
  }

  get health() {
    return this.#client.health();
  }

  async publish(input: NewDexEvent, options: PublishOptions = {}): Promise<string> {
    const event = await this.#events.append(input);
    await this.#store.updateState((state) => {
      if (state.pendingTransportEvents.some((candidate) => candidate.id === event.id)) return;
      state.pendingTransportEvents.push({
        id: event.id,
        timestamp: event.timestamp,
        type: event.type,
        payload: event.payload,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.workerId ? { workerId: event.workerId } : {}),
      });
    });
    if (options.flush) await this.syncOnce(options.waitMs ?? 0);
    return event.id;
  }

  async notify(conversationId: string, text: string, flush = true): Promise<void> {
    await this.publish({
      type: "message.sent",
      payload: { conversationId, text: redactString(text) },
    }, { flush });
  }

  async receipt(
    commandId: string,
    status: "processed" | "rejected" | "failed" | "duplicate",
    reason?: string,
  ): Promise<void> {
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
  }

  syncOnce(waitMs = 25_000): Promise<DexVerifiedCommand[]> {
    const operation = this.#tail.then(async () => {
      const before = await this.#store.read();
      const payload = createDexSyncPayload({
        ...(before.lastInboundCursor ? { cursor: before.lastInboundCursor } : {}),
        events: before.pendingTransportEvents.map((event) => ({
          id: event.id,
          timestamp: event.timestamp,
          type: event.type,
          payload: event.payload,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          ...(event.workerId === undefined ? {} : { workerId: event.workerId }),
        })),
        receipts: before.pendingTransportReceipts.map((receipt) => ({
          commandId: receipt.commandId,
          status: receipt.status,
          occurredAt: receipt.occurredAt,
          ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
        })),
        waitMs,
      });
      const result = await this.#client.sync(payload);
      const acceptedEvents = new Set(result.acceptedEventIds);
      const acceptedReceipts = new Set(result.acceptedReceiptIds);
      await this.#store.updateState((state) => {
        state.lastInboundCursor = result.cursor;
        state.pendingTransportEvents = state.pendingTransportEvents.filter(
          (event) => !acceptedEvents.has(event.id),
        );
        state.pendingTransportReceipts = state.pendingTransportReceipts.filter(
          (receipt) => !acceptedReceipts.has(receipt.commandId),
        );
      });
      return result.commands;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}
