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
  ModalTerminalInput,
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
        cloudTaskId: taskId,
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
    origin: "cloud_ingress",
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

export interface TaskCloudCompletedCommandInput {
  task: CloudTaskRecord;
  device: DeviceRecord;
  terminal: ModalTerminalInput;
  summary: string;
  issuedAt: string;
  signingKey: DexDeviceKeyPair;
}

/** Builds the deterministic device-side half of a terminal completion transaction. */
export function createTaskCloudCompletedCommand(
  input: TaskCloudCompletedCommandInput,
): DeviceCommandOutboxRecord {
  const commandId = deterministicControlPlaneId(
    "cmd",
    `task.cloud.completed:${input.terminal.completionKey}`,
  );
  const git = input.terminal.result?.git;
  const bundle = git?.bundlePath === undefined
    ? undefined
    : {
        path: git.bundlePath,
        ...(git.bundleSha256 === undefined ? {} : { sha256: git.bundleSha256 }),
      };
  const commands = input.terminal.result?.validation.commands ?? [];
  const validationPassed = input.terminal.result?.validation.passed;
  const unsigned = {
    id: commandId,
    issuedAt: input.issuedAt,
    command: {
      type: "task.cloud.completed",
      payload: {
        taskId: input.task.id,
        ...(input.task.monitor?.workerId === undefined
          ? {}
          : { workerId: input.task.monitor.workerId }),
        status: input.terminal.status,
        summary: input.summary,
        exitCode: input.terminal.exitCode,
        reason: input.terminal.reason,
        sandboxId: input.terminal.sandboxId,
        sandbox: {
          id: input.terminal.sandboxId,
          resultPath: input.task.monitor?.resultPath ?? "/dex/result.json",
          ...(input.terminal.sandboxRetentionExpiresAt === undefined
            ? {}
            : { retainedUntil: input.terminal.sandboxRetentionExpiresAt }),
        },
        handoffSha256: input.task.monitor?.handoffSha256,
        ...(input.terminal.sandboxTerminal === undefined
          ? {}
          : { sandboxTerminal: input.terminal.sandboxTerminal }),
        resultPath: input.task.monitor?.resultPath ?? "/dex/result.json",
        ...(input.terminal.sandboxRetentionExpiresAt === undefined
          ? {}
          : { sandboxRetentionExpiresAt: input.terminal.sandboxRetentionExpiresAt }),
        ...(input.terminal.result === undefined ? {} : { result: input.terminal.result }),
        ...(bundle === undefined ? {} : { bundle }),
        ...(validationPassed === undefined ? {} : {
          tests: {
            command: commands.join(" && "),
            passed: validationPassed ? commands.length : 0,
            failed: validationPassed ? 0 : Math.max(1, commands.length),
            summary: validationPassed ? "Cloud validation passed." : "Cloud validation failed.",
          },
        }),
      },
    },
    authority: {
      kind: "verified_owner" as const,
      ownerId: input.task.ownerId,
      conversationId: input.task.conversationId,
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
  return {
    id: deterministicControlPlaneId("device_out", commandId),
    dedupeKey: `device-command:${commandId}`,
    deviceId: input.device.id,
    ownerId: input.task.ownerId,
    conversationId: input.task.conversationId,
    command,
    createdAt: input.issuedAt,
  };
}
