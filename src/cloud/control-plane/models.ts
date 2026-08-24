import { z } from "zod";
import {
  DexCommandReceiptSchema,
  DexOutboundEventSchema,
  DexSignedCommandSchema,
} from "../messaging/index.js";
import { ModalResultArtifactSchema, Sha256Schema } from "../modal/index.js";

const IdentifierSchema = z.string().trim().min(1).max(512);
const E164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/);
const TimestampSchema = z.string().datetime({ offset: true });

export const SendblueInboundWebhookSchema = z.object({
  content: z.string().min(1).max(8_000),
  is_outbound: z.literal(false),
  message_handle: IdentifierSchema,
  date_sent: TimestampSchema,
  from_number: E164Schema,
  to_number: E164Schema,
  sendblue_number: E164Schema.nullish(),
  group_id: z.string().max(512).optional(),
  message_type: z.string().max(100).optional(),
}).passthrough();
export type SendblueInboundWebhook = z.infer<typeof SendblueInboundWebhookSchema>;

export interface VerifiedConversationAssociation {
  ownerId: string;
  conversationId: string;
  phoneE164: string;
}

export interface ConversationAssociationCandidate {
  provider: "sendblue";
  providerMessageId: string;
  fromPhone: string;
  toPhone: string;
  providerConversationId?: string;
}

export interface ConversationAssociationVerifier {
  verify(
    candidate: ConversationAssociationCandidate,
  ): Promise<VerifiedConversationAssociation | null>;
}

export type ParsedInboundMessage =
  | { kind: "pair"; setupCode?: string }
  | { kind: "engineering"; text: string };

export interface PairingChallengeRecord {
  id: string;
  codeDigest: string;
  issuedAt: string;
  expiresAt: string;
  ownerId: string;
  conversationId: string;
  phoneE164: string;
  sourceMessageId: string;
  attempts: number;
  maxAttempts: number;
  consumedAt?: string;
  consumedByDeviceId?: string;
}

export interface DeviceRecord {
  id: string;
  keyId: string;
  publicKey: string;
  ownerId: string;
  conversationId: string;
  phoneE164: string;
  deviceName: string;
  createdAt: string;
  lastSequence: number;
}

export type CloudTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ModalMonitorRegistration {
  taskId: string;
  workerId?: string | undefined;
  sandboxId: string;
  handoffSha256: string;
  startedAt: string;
  resultPath: string;
}

export interface MonitorJobRecord {
  id: string;
  idempotencyKey: string;
  taskId: string;
  registration: ModalMonitorRegistration;
  request: {
    taskId: string;
    sandboxId: string;
    handoffSha256: string;
    startedAt: string;
    resultPath: string;
    attempt: 0;
  };
  createdAt: string;
  availableAt: string;
  dispatchAttempts: number;
  claimedAt?: string;
  claimExpiresAt?: string;
  dispatchedAt?: string;
}

export interface CloudTaskRecord {
  id: string;
  ownerId: string;
  conversationId: string;
  phoneE164: string;
  sourceMessageId: string;
  title: string;
  request: string;
  status: CloudTaskStatus;
  createdAt: string;
  updatedAt: string;
  origin?: "cloud_ingress" | "device";
  cloudIngressTaskId?: string;
  monitor?: ModalMonitorRegistration;
  completionKey?: string;
  summary?: string;
  completion?: CloudTaskCompletionRecord;
}

export interface CloudTaskCompletionRecord {
  sandboxId: string;
  resultPath: string;
  handoffSha256: string;
  status: "succeeded" | "failed" | "cancelled";
  reason: "result" | "nonzero_exit" | "invalid_result" | "deadline_exceeded";
  exitCode: number | null;
  completedAt: string;
  sandboxRetentionExpiresAt?: string;
  result?: z.infer<typeof ModalResultArtifactSchema>;
  bundle?: {
    path: string;
    sha256?: string;
  };
}

export interface DeviceCommandOutboxRecord {
  id: string;
  dedupeKey: string;
  deviceId: string;
  ownerId: string;
  conversationId: string;
  command: z.infer<typeof DexSignedCommandSchema>;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface SendblueOutboxRecord {
  id: string;
  dedupeKey: string;
  ownerId: string;
  conversationId: string;
  toPhone: string;
  text: string;
  createdAt: string;
  taskId?: string;
}

export const ModalMonitorRegistrationSchema = z.object({
  taskId: IdentifierSchema,
  workerId: IdentifierSchema.optional(),
  sandboxId: IdentifierSchema,
  handoffSha256: Sha256Schema,
  startedAt: TimestampSchema,
  resultPath: z.string().startsWith("/").max(1_024).default("/dex/result.json"),
}).strict();

export const TaskCreatedTransportPayloadSchema = z.object({
  title: z.string().trim().min(1).max(500),
  originalRequest: z.string().trim().min(1).max(20_000),
  conversationId: IdentifierSchema,
  projectId: IdentifierSchema.optional(),
  cloudTaskId: IdentifierSchema.optional(),
  sourceMessageId: IdentifierSchema.optional(),
}).passthrough();

export const MessageSentTransportPayloadSchema = z.object({
  conversationId: IdentifierSchema,
  text: z.string().trim().min(1).max(8_000),
}).passthrough();

export const ModalMonitorTransportPayloadSchema = ModalMonitorRegistrationSchema;

export const ModalTerminalInputSchema = z.object({
  taskId: IdentifierSchema,
  sandboxId: IdentifierSchema,
  completionKey: IdentifierSchema,
  status: z.enum(["succeeded", "failed", "cancelled"]),
  reason: z.enum(["result", "nonzero_exit", "invalid_result", "deadline_exceeded"]),
  exitCode: z.number().int().nullable(),
  result: ModalResultArtifactSchema.optional(),
  sandboxRetentionExpiresAt: TimestampSchema.optional(),
  error: z.string().max(2_000).optional(),
}).strict();
export type ModalTerminalInput = z.infer<typeof ModalTerminalInputSchema>;

export interface DeviceSyncCommitInput {
  deviceId: string;
  sequence: number;
  events: readonly z.infer<typeof DexOutboundEventSchema>[];
  receipts: readonly z.infer<typeof DexCommandReceiptSchema>[];
  commandLimit: number;
  now: string;
}

export interface DeviceSyncCommitResult {
  commands: Array<z.infer<typeof DexSignedCommandSchema>>;
  acceptedEventIds: string[];
  acceptedReceiptIds: string[];
  cursor: string;
  nextSequence: number;
}

export interface InboundCommitResult {
  accepted: boolean;
}

export interface PairingConsumeInput {
  challengeId: string;
  codeDigest: string;
  now: string;
  device: DeviceRecord;
}

export type PairingConsumeResult =
  | { kind: "paired"; device: DeviceRecord }
  | { kind: "missing" | "expired" | "consumed" | "mismatch" | "attempts_exhausted" };

export const DeviceCommandRecordSchema = DexSignedCommandSchema;
