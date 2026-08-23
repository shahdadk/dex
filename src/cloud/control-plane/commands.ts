import {
  canonicalJsonBytes,
  sha256Hex,
  signDexBytes,
  type DexDeviceKeyPair,
  type DexSignedCommand,
} from "../messaging/index.js";
import type {
  CloudTaskRecord,
  DeviceCommandOutboxRecord,
  DeviceRecord,
  SendblueInboundWebhook,
  VerifiedConversationAssociation,
} from "./models.js";
import { conciseTaskTitle } from "./sendblue.js";

export function deterministicControlPlaneId(prefix: string, scope: string): string {
  return `${prefix}_${sha256Hex(scope).slice(0, 32)}`;
}

export interface EngineeringCommandInput {
  message: SendblueInboundWebhook;
  text: string;
  association: VerifiedConversationAssociation;
  device: DeviceRecord;
  signingKey: DexDeviceKeyPair;
}

export function createEngineeringTaskAndCommand(input: EngineeringCommandInput): {
  task: CloudTaskRecord;
  outbox: DeviceCommandOutboxRecord;
} {
  const taskId = deterministicControlPlaneId(
    "task",
    `sendblue:${input.message.message_handle}`,
  );
  const commandId = deterministicControlPlaneId(
    "cmd",
    `sendblue:${input.message.message_handle}`,
  );
  const unsigned = {
    id: commandId,
    issuedAt: input.message.date_sent,
    command: {
      type: "message.received",
      payload: {
        taskId,
        text: input.text,
        conversationId: input.association.conversationId,
        messageId: input.message.message_handle,
        provider: "sendblue",
        providerMessageId: input.message.message_handle,
      },
    },
    authority: {
      kind: "verified_owner" as const,
      ownerId: input.association.ownerId,
      conversationId: input.association.conversationId,
      verified: true as const,
    },
  };
  const command: DexSignedCommand = {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      keyId: input.signingKey.keyId,
      value: signDexBytes(canonicalJsonBytes(unsigned), input.signingKey.privateKey),
    },
  };
  const task: CloudTaskRecord = {
    id: taskId,
    ownerId: input.association.ownerId,
    conversationId: input.association.conversationId,
    phoneE164: input.association.phoneE164,
    sourceMessageId: input.message.message_handle,
    title: conciseTaskTitle(input.text),
    request: input.text,
    status: "queued",
    createdAt: input.message.date_sent,
    updatedAt: input.message.date_sent,
  };
  return {
    task,
    outbox: {
      id: deterministicControlPlaneId("device_out", commandId),
      dedupeKey: `device-command:${commandId}`,
      deviceId: input.device.id,
      ownerId: input.association.ownerId,
      conversationId: input.association.conversationId,
      command,
      createdAt: input.message.date_sent,
    },
  };
}
