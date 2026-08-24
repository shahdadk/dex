import {
  InMemoryControlPlaneRepository,
  InvalidTransportEventError,
  RepositoryConflictError,
  type CloudTaskRecord,
  type CloudTaskCompletionRecord,
  type ControlPlaneRepository,
  type DeviceCommandOutboxRecord,
  type DeviceRecord,
  type DeviceSyncCommitInput,
  type DeviceSyncCommitResult,
  type InboundCommitResult,
  type ModalMonitorRegistration,
  type MonitorJobRecord,
  type PairingChallengeRecord,
  type PairingConsumeInput,
  type PairingConsumeResult,
  type SendblueOutboxRecord,
} from "../control-plane/index.js";
import { sha256Hex } from "../messaging/index.js";
import type {
  SendblueAmbiguousSettlement,
  SendblueDeliveryStore,
  SendblueOutboxClaim,
  SendblueOutboxClaimInput,
  SendblueProviderHandleSettlement,
  SendblueReconciliationPendingSettlement,
  SendblueRejectedSettlement,
} from "../providers/index.js";
import type {
  ModalMonitorSchedule,
  ParsedModalMonitorRequest,
} from "../modal-monitor/index.js";
import type { DexCloudStateBackend } from "./backend.js";
import type {
  ControlPlaneOperation,
  DexCloudStateDocument,
  ScheduledMonitorJobState,
  SendblueDeliveryState,
} from "./state.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function finiteTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} must be an ISO timestamp`);
  return parsed;
}

async function applyOperation(
  repository: InMemoryControlPlaneRepository,
  operation: ControlPlaneOperation,
): Promise<void> {
  switch (operation.kind) {
    case "commit_pairing_challenge":
      await repository.commitPairingChallenge(
        operation.providerMessageId,
        operation.challenge,
        operation.notification,
      );
      return;
    case "consume_pairing_challenge":
      await repository.consumePairingChallenge(operation.input);
      return;
    case "commit_engineering_message":
      await repository.commitEngineeringMessage(
        operation.providerMessageId,
        operation.task,
        operation.command,
      );
      return;
    case "commit_unpaired_message":
      await repository.commitUnpairedMessage(
        operation.providerMessageId,
        operation.notification,
      );
      return;
    case "register_modal_monitor":
      await repository.registerModalMonitor(operation.registration, operation.now);
      return;
    case "complete_modal_task":
      await repository.completeModalTaskAndEnqueue(
        operation.taskId,
        operation.completionKey,
        operation.status,
        operation.summary,
        operation.message,
        operation.now,
        operation.command,
        operation.completion,
      );
      return;
    case "commit_device_sync":
      if (operation.expectedInvalidEvent === undefined) {
        await repository.commitDeviceSync(operation.input);
        return;
      }
      try {
        await repository.commitDeviceSync(operation.input);
      } catch (error) {
        if (
          error instanceof InvalidTransportEventError &&
          error.eventId === operation.expectedInvalidEvent.eventId
        ) {
          return;
        }
        throw error;
      }
      throw new Error("A persisted rejected device event no longer rejects during replay");
    case "claim_monitor_jobs":
      await repository.claimPendingMonitorJobs(
        operation.limit,
        operation.claimedAt,
        operation.leaseMs,
      );
      return;
    case "mark_monitor_job_dispatched":
      await repository.markMonitorJobDispatched(operation.jobId, operation.dispatchedAt);
      return;
    case "release_monitor_job":
      await repository.releaseMonitorJob(operation.jobId);
  }
}

async function hydrate(state: DexCloudStateDocument): Promise<InMemoryControlPlaneRepository> {
  const repository = new InMemoryControlPlaneRepository();
  for (const operation of state.controlPlaneOperations) {
    await applyOperation(repository, operation);
  }
  return repository;
}

function append(state: DexCloudStateDocument, operation: ControlPlaneOperation): void {
  state.controlPlaneOperations.push(copy(operation));
}

export interface DurableDexCloudRepositoryOptions {
  backend: DexCloudStateBackend;
  sendblueReconciliationRetryMs?: number;
  sendblueRetryMs?: number;
}

export interface ScheduledMonitorClaim {
  claimToken: string;
  job: ScheduledMonitorJobState;
}

/**
 * Durable adapter around the existing, already-tested control-plane state
 * machine. Persisting its operation history keeps that implementation fixed
 * while the JSONB row supplies atomicity and process-crash recovery.
 */
export class DurableDexCloudRepository
implements ControlPlaneRepository, SendblueDeliveryStore {
  readonly #backend: DexCloudStateBackend;
  readonly #sendblueReconciliationRetryMs: number;
  readonly #sendblueRetryMs: number;

  constructor(options: DurableDexCloudRepositoryOptions) {
    const retryMs = options.sendblueReconciliationRetryMs ?? 10_000;
    const sendRetryMs = options.sendblueRetryMs ?? 10_000;
    if (!Number.isSafeInteger(retryMs) || retryMs < 1_000 || retryMs > 60 * 60_000) {
      throw new RangeError("Sendblue reconciliation retry must be between one second and one hour");
    }
    if (!Number.isSafeInteger(sendRetryMs) || sendRetryMs < 1_000 || sendRetryMs > 60 * 60_000) {
      throw new RangeError("Sendblue retry must be between one second and one hour");
    }
    this.#backend = options.backend;
    this.#sendblueReconciliationRetryMs = retryMs;
    this.#sendblueRetryMs = sendRetryMs;
  }

  hasProcessedInbound(providerMessageId: string): Promise<boolean> {
    return this.#read((repository) => repository.hasProcessedInbound(providerMessageId));
  }

  commitPairingChallenge(
    providerMessageId: string,
    challenge: PairingChallengeRecord,
    notification: SendblueOutboxRecord,
  ): Promise<InboundCommitResult> {
    const operation: ControlPlaneOperation = {
      kind: "commit_pairing_challenge",
      providerMessageId,
      challenge,
      notification,
    };
    return this.#mutate(operation, (repository) =>
      repository.commitPairingChallenge(providerMessageId, challenge, notification));
  }

  consumePairingChallenge(input: PairingConsumeInput): Promise<PairingConsumeResult> {
    return this.#mutate(
      { kind: "consume_pairing_challenge", input },
      (repository) => repository.consumePairingChallenge(input),
    );
  }

  getPairingChallenge(challengeId: string): Promise<PairingChallengeRecord | null> {
    return this.#read((repository) => repository.getPairingChallenge(challengeId));
  }

  getDevice(deviceId: string): Promise<DeviceRecord | null> {
    return this.#read((repository) => repository.getDevice(deviceId));
  }

  findDeviceByAssociation(ownerId: string, conversationId: string): Promise<DeviceRecord | null> {
    return this.#read((repository) =>
      repository.findDeviceByAssociation(ownerId, conversationId));
  }

  commitEngineeringMessage(
    providerMessageId: string,
    task: CloudTaskRecord,
    command: DeviceCommandOutboxRecord,
  ): Promise<InboundCommitResult> {
    return this.#mutate(
      { kind: "commit_engineering_message", providerMessageId, task, command },
      (repository) => repository.commitEngineeringMessage(providerMessageId, task, command),
    );
  }

  commitUnpairedMessage(
    providerMessageId: string,
    notification: SendblueOutboxRecord,
  ): Promise<InboundCommitResult> {
    return this.#mutate(
      { kind: "commit_unpaired_message", providerMessageId, notification },
      (repository) => repository.commitUnpairedMessage(providerMessageId, notification),
    );
  }

  getTask(taskId: string): Promise<CloudTaskRecord | null> {
    return this.#read((repository) => repository.getTask(taskId));
  }

  registerModalMonitor(
    registration: ModalMonitorRegistration,
    now: string,
  ): Promise<{ task: CloudTaskRecord; created: boolean }> {
    return this.#mutate(
      { kind: "register_modal_monitor", registration, now },
      (repository) => repository.registerModalMonitor(registration, now),
    );
  }

  completeModalTaskAndEnqueue(
    taskId: string,
    completionKey: string,
    status: "succeeded" | "failed" | "cancelled",
    summary: string,
    message: SendblueOutboxRecord,
    now: string,
    command?: DeviceCommandOutboxRecord,
    completion?: CloudTaskCompletionRecord,
  ): Promise<{
    task: CloudTaskRecord;
    transitioned: boolean;
    enqueued: boolean;
    commandEnqueued: boolean;
  }> {
    return this.#mutate(
      {
        kind: "complete_modal_task",
        taskId,
        completionKey,
        status,
        summary,
        message,
        now,
        ...(command === undefined ? {} : { command }),
        ...(completion === undefined ? {} : { completion }),
      },
      (repository) => repository.completeModalTaskAndEnqueue(
        taskId,
        completionKey,
        status,
        summary,
        message,
        now,
        command,
        completion,
      ),
    );
  }

  async commitDeviceSync(input: DeviceSyncCommitInput): Promise<DeviceSyncCommitResult> {
    const outcome = await this.#backend.mutate(async (state) => {
      const repository = await hydrate(state);
      try {
        const result = await repository.commitDeviceSync(input);
        append(state, { kind: "commit_device_sync", input });
        return { kind: "accepted" as const, result };
      } catch (error) {
        if (!(error instanceof InvalidTransportEventError)) throw error;
        append(state, {
          kind: "commit_device_sync",
          input,
          expectedInvalidEvent: { eventId: error.eventId, message: error.message },
        });
        return {
          kind: "invalid_event" as const,
          eventId: error.eventId,
          message: error.message,
        };
      }
    });
    if (outcome.kind === "invalid_event") {
      throw new InvalidTransportEventError(outcome.eventId, outcome.message);
    }
    return copy(outcome.result);
  }

  listPendingMonitorJobs(limit: number): Promise<MonitorJobRecord[]> {
    return this.#read((repository) => repository.listPendingMonitorJobs(limit));
  }

  claimPendingMonitorJobs(
    limit: number,
    claimedAt: string,
    leaseMs: number,
  ): Promise<MonitorJobRecord[]> {
    return this.#mutate(
      { kind: "claim_monitor_jobs", limit, claimedAt, leaseMs },
      (repository) => repository.claimPendingMonitorJobs(limit, claimedAt, leaseMs),
    );
  }

  markMonitorJobDispatched(jobId: string, dispatchedAt: string): Promise<boolean> {
    return this.#mutate(
      { kind: "mark_monitor_job_dispatched", jobId, dispatchedAt },
      (repository) => repository.markMonitorJobDispatched(jobId, dispatchedAt),
    );
  }

  releaseMonitorJob(jobId: string): Promise<boolean> {
    return this.#mutate(
      { kind: "release_monitor_job", jobId },
      (repository) => repository.releaseMonitorJob(jobId),
    );
  }

  listPendingDeviceCommands(
    deviceId: string,
    limit: number,
  ): Promise<DeviceCommandOutboxRecord[]> {
    return this.#read((repository) => repository.listPendingDeviceCommands(deviceId, limit));
  }

  listSendblueOutbox(): Promise<SendblueOutboxRecord[]> {
    return this.#read((repository) => repository.listSendblueOutbox());
  }

  async claimNext(input: SendblueOutboxClaimInput): Promise<SendblueOutboxClaim | null> {
    const claimedAtMs = finiteTimestamp(input.claimedAt, "Sendblue claim time");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000) {
      throw new RangeError("Sendblue claim lease is invalid");
    }
    return this.#backend.mutate(async (state) => {
      const repository = await hydrate(state);
      const items = await repository.listSendblueOutbox();
      for (const item of items) {
        const current = state.sendblueDeliveries[item.id];
        if (current?.state === "delivered" || current?.state === "rejected") continue;
        if (
          current?.claimExpiresAt !== undefined &&
          Date.parse(current.claimExpiresAt) > claimedAtMs
        ) continue;
        if (
          current?.nextAttemptAt !== undefined &&
          Date.parse(current.nextAttemptAt) > claimedAtMs
        ) continue;

        const action = current === undefined || current.state === "retrying"
          ? "send" as const
          : "reconcile" as const;
        const claimCount = (current?.claimCount ?? 0) + 1;
        const claimToken = `sendblue_claim_${sha256Hex(
          `${item.id}:${claimCount}:${input.workerId}:${input.claimedAt}`,
        ).slice(0, 32)}`;
        const attemptStartedAt = action === "send"
          ? input.claimedAt
          : current!.attemptStartedAt;
        const sendAttempts = (current?.sendAttempts ?? (current === undefined ? 0 : 1)) +
          (action === "send" ? 1 : 0);
        const reconciliationAttempts = action === "reconcile"
          ? (current?.reconciliationAttempts ?? 0) + 1
          : 0;
        const delivery: SendblueDeliveryState = {
          ...(current ?? {
            outboxId: item.id,
            attemptStartedAt,
            claimCount: 0,
            claimTokens: [],
            state: "claimed" as const,
          }),
          claimCount,
          sendAttempts,
          reconciliationAttempts,
          claimTokens: [...(current?.claimTokens ?? []), claimToken].slice(-128),
          claimToken,
          claimedBy: input.workerId,
          claimedAt: input.claimedAt,
          claimExpiresAt: new Date(claimedAtMs + input.leaseMs).toISOString(),
          state: action === "send" ? "claimed" : "reconciling",
        };
        delete delivery.nextAttemptAt;
        state.sendblueDeliveries[item.id] = delivery;
        return {
          claimToken,
          item: {
            id: item.id,
            dedupeKey: item.dedupeKey,
            toPhone: item.toPhone,
            text: item.text,
            createdAt: item.createdAt,
          },
          action,
          attemptStartedAt,
          sendAttempt: sendAttempts,
          reconciliationAttempt: reconciliationAttempts,
        };
      }
      return null;
    });
  }

  recordProviderHandle(input: SendblueProviderHandleSettlement): Promise<void> {
    return this.#backend.mutate((state) => {
      const delivery = this.#deliveryForSettlement(state, input.outboxId, input.claimToken);
      if (delivery.state === "delivered") {
        if (delivery.providerHandle !== input.providerHandle) {
          throw new RepositoryConflictError("Sendblue outbox resolved to conflicting handles");
        }
        return;
      }
      if (delivery.state === "rejected") {
        throw new RepositoryConflictError("Sendblue outbox was already rejected");
      }
      state.sendblueDeliveries[input.outboxId] = {
        ...delivery,
        state: "delivered",
        providerHandle: input.providerHandle,
        providerStatus: input.providerStatus,
        resolvedAt: input.resolvedAt,
        resolution: input.resolution,
      };
      this.#clearClaim(state.sendblueDeliveries[input.outboxId]!);
    });
  }

  recordAmbiguous(input: SendblueAmbiguousSettlement): Promise<void> {
    return this.#backend.mutate((state) => {
      const delivery = this.#deliveryForSettlement(state, input.outboxId, input.claimToken);
      if (delivery.state === "delivered" || delivery.state === "rejected") return;
      if (delivery.claimToken !== input.claimToken) return;
      delivery.state = "ambiguous";
      delivery.lastErrorCode = input.reason;
      delivery.nextAttemptAt = new Date(
        finiteTimestamp(input.observedAt, "Sendblue observation time") +
        this.#sendblueReconciliationRetryMs,
      ).toISOString();
      this.#clearClaim(delivery);
    });
  }

  recordRejected(input: SendblueRejectedSettlement): Promise<void> {
    return this.#backend.mutate((state) => {
      const delivery = this.#deliveryForSettlement(state, input.outboxId, input.claimToken);
      if (delivery.state === "delivered") return;
      if (delivery.state === "rejected") return;
      if (delivery.claimToken !== input.claimToken) return;
      delivery.lastErrorCode = input.reason;
      delivery.retryable = input.retryable;
      if (input.httpStatus !== undefined) delivery.httpStatus = input.httpStatus;
      if (input.retryable) {
        delivery.state = "retrying";
        delivery.nextAttemptAt = new Date(
          finiteTimestamp(input.rejectedAt, "Sendblue rejection time") +
          (input.retryAfterMs ?? this.#sendblueRetryMs),
        ).toISOString();
        delete delivery.rejectedAt;
      } else {
        delivery.state = "rejected";
        delivery.rejectedAt = input.rejectedAt;
        delete delivery.nextAttemptAt;
      }
      this.#clearClaim(delivery);
    });
  }

  recordReconciliationPending(input: SendblueReconciliationPendingSettlement): Promise<void> {
    return this.#backend.mutate((state) => {
      const delivery = this.#deliveryForSettlement(state, input.outboxId, input.claimToken);
      if (delivery.state === "delivered" || delivery.state === "rejected") return;
      if (delivery.claimToken !== input.claimToken) return;
      delivery.state = "reconciling";
      delivery.reconciliationReason = input.reason;
      if (input.errorCode !== undefined) delivery.lastErrorCode = input.errorCode;
      if (input.candidateHandles !== undefined) {
        delivery.candidateHandles = [...input.candidateHandles].sort();
      }
      delivery.nextAttemptAt = new Date(
        finiteTimestamp(input.checkedAt, "Sendblue reconciliation time") +
        (input.retryAfterMs ?? this.#sendblueReconciliationRetryMs),
      ).toISOString();
      this.#clearClaim(delivery);
    });
  }

  getSendblueDelivery(outboxId: string): Promise<SendblueDeliveryState | null> {
    return this.#backend.read((state) => {
      const delivery = state.sendblueDeliveries[outboxId];
      return delivery === undefined ? null : copy(delivery);
    });
  }

  enqueueScheduledMonitor(schedule: ModalMonitorSchedule, scheduledAt: string): Promise<boolean> {
    const scheduledAtMs = finiteTimestamp(scheduledAt, "Monitor schedule time");
    if (!Number.isSafeInteger(schedule.delayMs) || schedule.delayMs < 0) {
      throw new RangeError("Monitor schedule delay is invalid");
    }
    return this.#backend.mutate((state) => {
      const id = `scheduled_monitor_${sha256Hex(schedule.idempotencyKey).slice(0, 32)}`;
      const existing = state.scheduledMonitorJobs[id];
      if (existing !== undefined) {
        if (
          existing.idempotencyKey !== schedule.idempotencyKey ||
          JSON.stringify(existing.request) !== JSON.stringify(schedule.request)
        ) {
          throw new RepositoryConflictError("Scheduled monitor identity conflicts");
        }
        return false;
      }
      state.scheduledMonitorJobs[id] = {
        id,
        idempotencyKey: schedule.idempotencyKey,
        request: copy(schedule.request),
        createdAt: scheduledAt,
        availableAt: new Date(scheduledAtMs + schedule.delayMs).toISOString(),
        attempts: 0,
      };
      return true;
    });
  }

  claimScheduledMonitors(
    limit: number,
    claimedAt: string,
    leaseMs: number,
  ): Promise<ScheduledMonitorClaim[]> {
    const claimedAtMs = finiteTimestamp(claimedAt, "Monitor claim time");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Scheduled monitor claim limit must be between one and 500");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
      throw new RangeError("Scheduled monitor claim lease is invalid");
    }
    return this.#backend.mutate((state) => Object.values(state.scheduledMonitorJobs)
      .filter((job) =>
        job.completedAt === undefined &&
        Date.parse(job.availableAt) <= claimedAtMs &&
        (job.claimExpiresAt === undefined || Date.parse(job.claimExpiresAt) <= claimedAtMs))
      .sort((left, right) =>
        left.availableAt.localeCompare(right.availableAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((job) => {
        const attempts = job.attempts + 1;
        const claimToken = `monitor_claim_${sha256Hex(
          `${job.id}:${attempts}:${claimedAt}`,
        ).slice(0, 32)}`;
        const claimed: ScheduledMonitorJobState = {
          ...job,
          attempts,
          claimToken,
          claimedAt,
          claimExpiresAt: new Date(claimedAtMs + leaseMs).toISOString(),
        };
        state.scheduledMonitorJobs[job.id] = claimed;
        return { claimToken, job: copy(claimed) };
      }));
  }

  settleScheduledMonitor(
    jobId: string,
    claimToken: string,
    completedAt: string,
  ): Promise<boolean> {
    finiteTimestamp(completedAt, "Monitor completion time");
    return this.#backend.mutate((state) => {
      const job = state.scheduledMonitorJobs[jobId];
      if (!job || job.completedAt !== undefined) return false;
      if (job.claimToken !== claimToken) return false;
      job.completedAt = completedAt;
      delete job.claimToken;
      delete job.claimedAt;
      delete job.claimExpiresAt;
      return true;
    });
  }

  releaseScheduledMonitor(jobId: string, claimToken: string): Promise<boolean> {
    return this.#backend.mutate((state) => {
      const job = state.scheduledMonitorJobs[jobId];
      if (!job || job.completedAt !== undefined || job.claimToken !== claimToken) return false;
      delete job.claimToken;
      delete job.claimedAt;
      delete job.claimExpiresAt;
      return true;
    });
  }

  async #read<T>(
    reader: (repository: InMemoryControlPlaneRepository) => Promise<T>,
  ): Promise<T> {
    return this.#backend.read(async (state) => copy(await reader(await hydrate(state))));
  }

  async #mutate<T>(
    operation: ControlPlaneOperation,
    mutation: (repository: InMemoryControlPlaneRepository) => Promise<T>,
  ): Promise<T> {
    return this.#backend.mutate(async (state) => {
      const result = await mutation(await hydrate(state));
      append(state, operation);
      return copy(result);
    });
  }

  #deliveryForSettlement(
    state: DexCloudStateDocument,
    outboxId: string,
    claimToken: string,
  ): SendblueDeliveryState {
    const delivery = state.sendblueDeliveries[outboxId];
    if (!delivery || !delivery.claimTokens.includes(claimToken)) {
      throw new RepositoryConflictError("Sendblue delivery claim is stale or unknown");
    }
    return delivery;
  }

  #clearClaim(delivery: SendblueDeliveryState): void {
    delete delivery.claimToken;
    delete delivery.claimedBy;
    delete delivery.claimedAt;
    delete delivery.claimExpiresAt;
  }
}
