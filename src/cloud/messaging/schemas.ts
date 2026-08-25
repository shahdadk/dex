import { z } from "zod";
import { DEX_SIGNATURE_ALGORITHM } from "./crypto.js";

const TimestampSchema = z.string().datetime({ offset: true });
const IdentifierSchema = z.string().trim().min(1).max(512);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const DexPairingPayloadSchema = z.object({
  version: z.literal(1),
  client: z.literal("dex"),
  pairingCode: z.string().trim().min(4).max(128),
  deviceName: z.string().trim().min(1).max(255),
  platform: z.literal("darwin"),
  keyId: IdentifierSchema,
  publicKeyAlgorithm: z.literal(DEX_SIGNATURE_ALGORITHM),
  publicKey: z.string().min(1),
  capabilities: z
    .array(z.enum(["commands", "events", "receipts", "polling"]))
    .min(1),
}).strict();
export type DexPairingPayload = z.infer<typeof DexPairingPayloadSchema>;

export const DexPairingResponseSchema = z.object({
  version: z.literal(1),
  deviceId: IdentifierSchema,
  keyId: IdentifierSchema,
  ownerId: IdentifierSchema,
  pairedConversationId: IdentifierSchema.optional(),
  cursor: z.string().max(4096).optional(),
  nextSequence: z.number().int().positive().optional(),
}).passthrough();
export type DexPairingResponse = z.infer<typeof DexPairingResponseSchema>;

export const DexOutboundEventSchema = z.object({
  id: IdentifierSchema,
  occurredAt: TimestampSchema,
  type: IdentifierSchema,
  taskId: IdentifierSchema.optional(),
  workerId: IdentifierSchema.optional(),
  payload: JsonObjectSchema,
}).strict();
export type DexOutboundEvent = z.infer<typeof DexOutboundEventSchema>;

export const DexCommandReceiptSchema = z.object({
  commandId: IdentifierSchema,
  status: z.enum(["processed", "rejected", "failed", "duplicate"]),
  occurredAt: TimestampSchema,
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type DexCommandReceipt = z.infer<typeof DexCommandReceiptSchema>;

export const DexCommandAuthoritySchema = z.object({
  kind: z.literal("verified_owner"),
  ownerId: IdentifierSchema,
  conversationId: IdentifierSchema.optional(),
  verified: z.literal(true),
}).passthrough();
export type DexCommandAuthority = z.infer<typeof DexCommandAuthoritySchema>;

export const DexCommandSignatureSchema = z.object({
  algorithm: z.literal(DEX_SIGNATURE_ALGORITHM),
  keyId: IdentifierSchema,
  value: z.string().min(1).max(2048),
}).strict();
export type DexCommandSignature = z.infer<typeof DexCommandSignatureSchema>;

export const DexSignedCommandSchema = z.object({
  id: IdentifierSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  command: z.object({
    type: IdentifierSchema,
    payload: JsonObjectSchema.default({}),
  }).passthrough(),
  authority: DexCommandAuthoritySchema,
  signature: DexCommandSignatureSchema,
}).passthrough();
export type DexSignedCommand = z.infer<typeof DexSignedCommandSchema>;

export const DexSyncPayloadSchema = z.object({
  version: z.literal(1),
  cursor: z.string().max(4096).optional(),
  events: z.array(DexOutboundEventSchema).max(500),
  receipts: z.array(DexCommandReceiptSchema).max(500),
  waitMs: z.number().int().min(0).max(60_000).optional(),
}).strict();
export type DexSyncPayload = z.infer<typeof DexSyncPayloadSchema>;

export const DexSyncResponseSchema = z.object({
  version: z.literal(1),
  cursor: z.string().max(4096),
  commands: z.array(DexSignedCommandSchema).max(500),
  acceptedEventIds: z.array(IdentifierSchema).max(500).default([]),
  acceptedReceiptIds: z.array(IdentifierSchema).max(500).default([]),
  rejectedReceiptIds: z.array(IdentifierSchema).max(500).default([]),
  retryAfterMs: z.number().int().min(0).max(300_000).optional(),
  nextSequence: z.number().int().positive().optional(),
}).passthrough();
export type DexSyncResponse = z.infer<typeof DexSyncResponseSchema>;

export interface DexEventLike {
  id: string;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
  taskId?: string;
  workerId?: string;
}

export interface DexPairingPayloadInput {
  pairingCode: string;
  deviceName: string;
  keyId: string;
  publicKey: string;
}

export function createDexPairingPayload(input: DexPairingPayloadInput): DexPairingPayload {
  return DexPairingPayloadSchema.parse({
    version: 1,
    client: "dex",
    pairingCode: input.pairingCode,
    deviceName: input.deviceName,
    platform: "darwin",
    keyId: input.keyId,
    publicKeyAlgorithm: DEX_SIGNATURE_ALGORITHM,
    publicKey: input.publicKey,
    capabilities: ["commands", "events", "receipts", "polling"],
  });
}

/** Converts a durable Dex event to the transport's normalized event shape. */
export function normalizeDexEvent(event: DexEventLike): DexOutboundEvent {
  return DexOutboundEventSchema.parse({
    id: event.id,
    occurredAt: event.timestamp,
    type: event.type,
    payload: event.payload,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.workerId === undefined ? {} : { workerId: event.workerId }),
  });
}

export interface DexReceiptInput {
  commandId: string;
  status: DexCommandReceipt["status"];
  occurredAt?: string;
  reason?: string;
}

export function normalizeDexReceipt(
  receipt: DexReceiptInput,
  now: () => number = Date.now,
): DexCommandReceipt {
  return DexCommandReceiptSchema.parse({
    commandId: receipt.commandId,
    status: receipt.status,
    occurredAt: receipt.occurredAt ?? new Date(now()).toISOString(),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  });
}

export interface DexSyncPayloadInput {
  cursor?: string;
  events?: readonly DexEventLike[];
  receipts?: readonly DexReceiptInput[];
  waitMs?: number;
}

export function createDexSyncPayload(
  input: DexSyncPayloadInput = {},
  now: () => number = Date.now,
): DexSyncPayload {
  return DexSyncPayloadSchema.parse({
    version: 1,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    events: (input.events ?? []).map(normalizeDexEvent),
    receipts: (input.receipts ?? []).map((receipt) => normalizeDexReceipt(receipt, now)),
    ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
  });
}
