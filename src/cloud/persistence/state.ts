import type {
  DeviceCommandOutboxRecord,
  DeviceSyncCommitInput,
  ModalMonitorRegistration,
  PairingChallengeRecord,
  PairingConsumeInput,
  SendblueOutboxRecord,
} from "../control-plane/index.js";
import type {
  SendblueProviderErrorCode,
  SendblueProviderStatus,
} from "../providers/index.js";
import type { ParsedModalMonitorRequest } from "../modal-monitor/index.js";

export type ControlPlaneOperation =
  | {
      kind: "commit_pairing_challenge";
      providerMessageId: string;
      challenge: PairingChallengeRecord;
      notification: SendblueOutboxRecord;
    }
  | { kind: "consume_pairing_challenge"; input: PairingConsumeInput }
  | {
      kind: "commit_engineering_message";
      providerMessageId: string;
      task: import("../control-plane/index.js").CloudTaskRecord;
      command: DeviceCommandOutboxRecord;
    }
  | {
      kind: "commit_unpaired_message";
      providerMessageId: string;
      notification: SendblueOutboxRecord;
    }
  | {
      kind: "register_modal_monitor";
      registration: ModalMonitorRegistration;
      now: string;
    }
  | {
      kind: "complete_modal_task";
      taskId: string;
      completionKey: string;
      status: "succeeded" | "failed" | "cancelled";
      summary: string;
      message: SendblueOutboxRecord;
      now: string;
    }
  | {
      kind: "commit_device_sync";
      input: DeviceSyncCommitInput;
      expectedInvalidEvent?: { eventId: string; message: string };
    }
  | {
      kind: "claim_monitor_jobs";
      limit: number;
      claimedAt: string;
      leaseMs: number;
    }
  | { kind: "mark_monitor_job_dispatched"; jobId: string; dispatchedAt: string }
  | { kind: "release_monitor_job"; jobId: string };

export interface SendblueDeliveryState {
  outboxId: string;
  attemptStartedAt: string;
  claimCount: number;
  claimTokens: string[];
  claimToken?: string;
  claimedBy?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  nextAttemptAt?: string;
  state: "claimed" | "ambiguous" | "reconciling" | "delivered" | "rejected";
  providerHandle?: string;
  providerStatus?: SendblueProviderStatus;
  resolvedAt?: string;
  resolution?: "send" | "reconciled";
  lastErrorCode?: SendblueProviderErrorCode;
  rejectedAt?: string;
  retryable?: boolean;
  httpStatus?: number;
  reconciliationReason?: "not_found" | "multiple_matches" | "lookup_failed";
  candidateHandles?: string[];
}

export interface ScheduledMonitorJobState {
  id: string;
  idempotencyKey: string;
  request: ParsedModalMonitorRequest;
  createdAt: string;
  availableAt: string;
  attempts: number;
  claimToken?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  completedAt?: string;
}

export interface MonitorEffectState {
  state: "running" | "completed";
  claimToken: string;
  claimedAt: string;
  claimExpiresAt: string;
  completedAt?: string;
}

export interface DexCloudStateDocument {
  version: 1;
  controlPlaneOperations: ControlPlaneOperation[];
  sendblueDeliveries: Record<string, SendblueDeliveryState>;
  scheduledMonitorJobs: Record<string, ScheduledMonitorJobState>;
  monitorEffects: Record<string, MonitorEffectState>;
}

export function emptyDexCloudState(): DexCloudStateDocument {
  return {
    version: 1,
    controlPlaneOperations: [],
    sendblueDeliveries: {},
    scheduledMonitorJobs: {},
    monitorEffects: {},
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects incompatible/corrupt roots before repository code consumes them. */
export function parseDexCloudState(value: unknown): DexCloudStateDocument {
  if (!record(value) || value.version !== 1) {
    throw new Error("Dex cloud persistence contains an unsupported state document");
  }
  if (
    !Array.isArray(value.controlPlaneOperations) ||
    !record(value.sendblueDeliveries) ||
    !record(value.scheduledMonitorJobs) ||
    !record(value.monitorEffects)
  ) {
    throw new Error("Dex cloud persistence contains a malformed state document");
  }
  return structuredClone(value) as unknown as DexCloudStateDocument;
}
