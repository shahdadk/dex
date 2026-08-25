import type {
  CloudTaskCompletionRecord,
  CloudTaskRecord,
  DeviceCommandOutboxRecord,
  DeviceRecord,
  DeviceSyncCommitInput,
  DeviceSyncCommitResult,
  InboundCommitResult,
  ModalMonitorRegistration,
  MonitorJobRecord,
  PairingChallengeRecord,
  PairingConsumeInput,
  PairingConsumeResult,
  SendblueOutboxRecord,
} from "./models.js";
import {
  MessageSentTransportPayloadSchema,
  ModalMonitorTransportPayloadSchema,
  TaskCreatedTransportPayloadSchema,
} from "./models.js";
import { sha256Hex } from "../messaging/index.js";
import { modalMonitorAttemptScope } from "../modal-monitor/index.js";

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export class StaleDeviceSequenceError extends Error {
  readonly expectedSequence: number;

  constructor(expectedSequence: number) {
    super("Device request sequence is stale");
    this.name = "StaleDeviceSequenceError";
    this.expectedSequence = expectedSequence;
  }
}

export class InvalidTransportEventError extends Error {
  readonly eventId: string;

  constructor(eventId: string, message: string) {
    super(message);
    this.name = "InvalidTransportEventError";
    this.eventId = eventId;
  }
}

export interface DurableTaskRepository {
  getTask(taskId: string): Promise<CloudTaskRecord | null>;
  registerModalMonitor(
    registration: ModalMonitorRegistration,
    now: string,
  ): Promise<{ task: CloudTaskRecord; created: boolean }>;
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
  }>;
}

export interface DurableOutboxRepository {
  listPendingDeviceCommands(
    deviceId: string,
    limit: number,
  ): Promise<DeviceCommandOutboxRecord[]>;
  listSendblueOutbox(): Promise<SendblueOutboxRecord[]>;
}

export interface DurableMonitorJobRepository {
  listPendingMonitorJobs(limit: number): Promise<MonitorJobRecord[]>;
  claimPendingMonitorJobs(
    limit: number,
    claimedAt: string,
    leaseMs: number,
  ): Promise<MonitorJobRecord[]>;
  markMonitorJobDispatched(jobId: string, dispatchedAt: string): Promise<boolean>;
  releaseMonitorJob(jobId: string): Promise<boolean>;
}

export interface PairingDeviceRepository {
  commitPairingChallenge(
    providerMessageId: string,
    challenge: PairingChallengeRecord,
    notification: SendblueOutboxRecord,
  ): Promise<InboundCommitResult>;
  consumePairingChallenge(input: PairingConsumeInput): Promise<PairingConsumeResult>;
  getPairingChallenge(challengeId: string): Promise<PairingChallengeRecord | null>;
  getDevice(deviceId: string): Promise<DeviceRecord | null>;
  findDeviceByAssociation(
    ownerId: string,
    conversationId: string,
  ): Promise<DeviceRecord | null>;
}

export interface InboundMessageRepository {
  hasProcessedInbound(providerMessageId: string): Promise<boolean>;
  commitEngineeringInbound(
    input: EngineeringInboundCommitInput,
  ): Promise<EngineeringInboundCommitResult>;
  commitEngineeringMessage(
    providerMessageId: string,
    task: CloudTaskRecord,
    command: DeviceCommandOutboxRecord,
  ): Promise<InboundCommitResult>;
  commitUnpairedMessage(
    providerMessageId: string,
    notification: SendblueOutboxRecord,
  ): Promise<InboundCommitResult>;
}

export interface EngineeringInboundCommitInput {
  providerMessageId: string;
  ownerId: string;
  conversationId: string;
  unpairedNotification: SendblueOutboxRecord;
  createForDevice: (device: DeviceRecord) => {
    task: CloudTaskRecord;
    command: DeviceCommandOutboxRecord;
  };
}

export type EngineeringInboundCommitResult =
  | { kind: "duplicate" }
  | { kind: "unpaired" }
  | { kind: "accepted"; taskId: string; commandId: string };

export interface ControlPlaneRepositorySnapshot {
  challenges: PairingChallengeRecord[];
  devices: DeviceRecord[];
  processedInbound: string[];
  tasks: CloudTaskRecord[];
  deviceCommands: DeviceCommandOutboxRecord[];
  sendblueOutbox: SendblueOutboxRecord[];
  monitorJobs: MonitorJobRecord[];
  acceptedEvents: string[];
}

export interface DeviceSyncRepository {
  commitDeviceSync(input: DeviceSyncCommitInput): Promise<DeviceSyncCommitResult>;
}

export interface ControlPlaneRepository
  extends DurableTaskRepository,
    DurableOutboxRepository,
    PairingDeviceRepository,
    InboundMessageRepository,
    DeviceSyncRepository,
    DurableMonitorJobRepository {}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function terminal(status: CloudTaskRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function sameMonitor(
  left: ModalMonitorRegistration,
  right: ModalMonitorRegistration,
): boolean {
  return left.taskId === right.taskId &&
    (left.workerId === undefined || right.workerId === undefined || left.workerId === right.workerId) &&
    left.sandboxId === right.sandboxId &&
    left.handoffSha256 === right.handoffSha256 &&
    left.startedAt === right.startedAt &&
    left.resultPath === right.resultPath;
}

function monitorJob(registration: ModalMonitorRegistration, createdAt: string): MonitorJobRecord {
  const scope = `${registration.taskId}:${registration.sandboxId}:${registration.handoffSha256}`;
  return {
    id: `monitor_job_${sha256Hex(scope).slice(0, 32)}`,
    idempotencyKey: `modal-monitor:${modalMonitorAttemptScope(registration.taskId, registration.handoffSha256)}:initial`,
    taskId: registration.taskId,
    registration: copy(registration),
    request: {
      taskId: registration.taskId,
      sandboxId: registration.sandboxId,
      handoffSha256: registration.handoffSha256,
      startedAt: registration.startedAt,
      resultPath: registration.resultPath,
      attempt: 0,
    },
    createdAt,
    availableAt: createdAt,
    dispatchAttempts: 0,
  };
}

function registerMonitorInMaps(
  tasks: Map<string, CloudTaskRecord>,
  jobs: Map<string, MonitorJobRecord>,
  registration: ModalMonitorRegistration,
  now: string,
): { task: CloudTaskRecord; created: boolean; jobEnqueued: boolean } {
  const task = tasks.get(registration.taskId);
  if (!task) throw new RepositoryConflictError("Task does not exist");
  let created = false;
  let updated = task;
  if (terminal(task.status)) {
    const previousCompletedAt = task.completion?.completedAt ?? task.updatedAt;
    if (
      task.monitor === undefined ||
      sameMonitor(task.monitor, registration) ||
      task.monitor.sandboxId === registration.sandboxId ||
      task.monitor.handoffSha256 === registration.handoffSha256 ||
      Date.parse(registration.startedAt) <= Date.parse(previousCompletedAt)
    ) {
      throw new RepositoryConflictError("A terminal task requires a newer, distinct Modal attempt");
    }
    const {
      completionKey: _completionKey,
      summary: _summary,
      completion: _completion,
      ...retryableTask
    } = task;
    created = true;
    updated = {
      ...retryableTask,
      status: "running",
      monitor: copy(registration),
      updatedAt: now,
    };
    tasks.set(task.id, updated);
  } else if (task.monitor !== undefined) {
    if (!sameMonitor(task.monitor, registration)) {
      throw new RepositoryConflictError("Task has a different Modal monitor");
    }
  } else {
    created = true;
    updated = {
      ...task,
      status: "running",
      monitor: copy(registration),
      updatedAt: now,
    };
    tasks.set(task.id, updated);
  }
  const job = monitorJob(registration, now);
  const existingJob = jobs.get(job.id);
  if (existingJob !== undefined && existingJob.idempotencyKey !== job.idempotencyKey) {
    throw new RepositoryConflictError("Modal monitor job identity conflicts");
  }
  const jobEnqueued = existingJob === undefined;
  if (jobEnqueued) jobs.set(job.id, job);
  return { task: copy(updated), created, jobEnqueued };
}

export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  readonly #challenges = new Map<string, PairingChallengeRecord>();
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #processedInbound = new Set<string>();
  readonly #tasks = new Map<string, CloudTaskRecord>();
  readonly #deviceCommands = new Map<string, DeviceCommandOutboxRecord>();
  readonly #sendblueOutbox = new Map<string, SendblueOutboxRecord>();
  readonly #sendblueDedupe = new Map<string, string>();
  readonly #monitorJobs = new Map<string, MonitorJobRecord>();
  readonly #acceptedEvents = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  static fromSnapshot(snapshot: ControlPlaneRepositorySnapshot): InMemoryControlPlaneRepository {
    const repository = new InMemoryControlPlaneRepository();
    const load = <T extends { id: string }>(
      target: Map<string, T>,
      values: readonly T[],
      label: string,
    ): void => {
      for (const value of values) {
        if (
          typeof value !== "object" ||
          value === null ||
          typeof value.id !== "string" ||
          value.id.length === 0
        ) {
          throw new RepositoryConflictError(`${label} snapshot contains an invalid record`);
        }
        if (target.has(value.id)) throw new RepositoryConflictError(`${label} snapshot has duplicate IDs`);
        target.set(value.id, copy(value));
      }
    };
    load(repository.#challenges, snapshot.challenges, "Pairing challenge");
    load(repository.#devices, snapshot.devices, "Device");
    load(repository.#tasks, snapshot.tasks, "Task");
    load(repository.#deviceCommands, snapshot.deviceCommands, "Device command");
    load(repository.#sendblueOutbox, snapshot.sendblueOutbox, "Sendblue outbox");
    load(repository.#monitorJobs, snapshot.monitorJobs, "Monitor job");
    for (const providerMessageId of snapshot.processedInbound) {
      if (typeof providerMessageId !== "string" || providerMessageId.length === 0) {
        throw new RepositoryConflictError("Processed-inbound snapshot contains an invalid ID");
      }
      repository.#processedInbound.add(providerMessageId);
    }
    for (const eventId of snapshot.acceptedEvents) {
      if (typeof eventId !== "string" || eventId.length === 0) {
        throw new RepositoryConflictError("Accepted-event snapshot contains an invalid ID");
      }
      repository.#acceptedEvents.add(eventId);
    }
    for (const message of repository.#sendblueOutbox.values()) {
      const existing = repository.#sendblueDedupe.get(message.dedupeKey);
      if (existing !== undefined && existing !== message.id) {
        throw new RepositoryConflictError("Sendblue snapshot has conflicting dedupe keys");
      }
      repository.#sendblueDedupe.set(message.dedupeKey, message.id);
    }
    return repository;
  }

  snapshot(): ControlPlaneRepositorySnapshot {
    const values = <T extends { id: string }>(source: Map<string, T>): T[] =>
      [...source.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(copy);
    return {
      challenges: values(this.#challenges),
      devices: values(this.#devices),
      processedInbound: [...this.#processedInbound].sort(),
      tasks: values(this.#tasks),
      deviceCommands: values(this.#deviceCommands),
      sendblueOutbox: values(this.#sendblueOutbox),
      monitorJobs: values(this.#monitorJobs),
      acceptedEvents: [...this.#acceptedEvents].sort(),
    };
  }

  async #locked<T>(work: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => gate, () => gate);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }

  hasProcessedInbound(providerMessageId: string): Promise<boolean> {
    return this.#locked(() => this.#processedInbound.has(providerMessageId));
  }

  commitEngineeringInbound(
    input: EngineeringInboundCommitInput,
  ): Promise<EngineeringInboundCommitResult> {
    return this.#locked(() => {
      if (this.#processedInbound.has(input.providerMessageId)) return { kind: "duplicate" };
      const device = [...this.#devices.values()]
        .filter((candidate) =>
          candidate.ownerId === input.ownerId &&
          candidate.conversationId === input.conversationId)
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      if (device === undefined) {
        this.#processedInbound.add(input.providerMessageId);
        this.#enqueueSendblue(input.unpairedNotification);
        return { kind: "unpaired" };
      }
      const created = input.createForDevice(copy(device));
      if (created.command.deviceId !== device.id) {
        throw new RepositoryConflictError("Command target does not match the paired device");
      }
      this.#processedInbound.add(input.providerMessageId);
      this.#tasks.set(created.task.id, copy(created.task));
      this.#enqueueDeviceCommand(created.command);
      return {
        kind: "accepted",
        taskId: created.task.id,
        commandId: created.command.command.id,
      };
    });
  }

  commitPairingChallenge(
    providerMessageId: string,
    challenge: PairingChallengeRecord,
    notification: SendblueOutboxRecord,
  ): Promise<InboundCommitResult> {
    return this.#locked(() => {
      if (this.#processedInbound.has(providerMessageId)) return { accepted: false };
      const existing = this.#challenges.get(challenge.id);
      if (existing !== undefined) {
        if (
          existing.ownerId !== challenge.ownerId ||
          existing.conversationId !== challenge.conversationId ||
          existing.phoneE164 !== challenge.phoneE164
        ) {
          throw new RepositoryConflictError("Pairing code is already bound to another owner");
        }
        this.#processedInbound.add(providerMessageId);
        return { accepted: false };
      }
      this.#processedInbound.add(providerMessageId);
      this.#challenges.set(challenge.id, copy(challenge));
      this.#enqueueSendblue(notification);
      return { accepted: true };
    });
  }

  consumePairingChallenge(input: PairingConsumeInput): Promise<PairingConsumeResult> {
    return this.#locked(() => {
      const challenge = this.#challenges.get(input.challengeId);
      if (!challenge) return { kind: "missing" };
      if (Date.parse(challenge.expiresAt) <= Date.parse(input.now)) return { kind: "expired" };
      if (challenge.consumedAt !== undefined) {
        const existing = challenge.consumedByDeviceId === undefined
          ? undefined
          : this.#devices.get(challenge.consumedByDeviceId);
        if (
          existing !== undefined &&
          existing.id === input.device.id &&
          existing.keyId === input.device.keyId &&
          challenge.codeDigest === input.codeDigest
        ) {
          const retried = {
            ...existing,
            lastSequence: Math.max(existing.lastSequence, input.device.lastSequence),
          };
          this.#devices.set(retried.id, retried);
          return { kind: "paired", device: copy(retried) };
        }
        return { kind: "consumed" };
      }
      if (challenge.attempts >= challenge.maxAttempts) return { kind: "attempts_exhausted" };
      const fail = (kind: "mismatch"): PairingConsumeResult => {
        this.#challenges.set(challenge.id, {
          ...challenge,
          attempts: challenge.attempts + 1,
        });
        return { kind };
      };
      if (challenge.codeDigest !== input.codeDigest) return fail("mismatch");
      if (
        input.device.ownerId !== challenge.ownerId ||
        input.device.conversationId !== challenge.conversationId ||
        input.device.phoneE164 !== challenge.phoneE164
      ) {
        return fail("mismatch");
      }

      const existing = this.#devices.get(input.device.id);
      if (
        existing !== undefined &&
        (existing.keyId !== input.device.keyId ||
          existing.ownerId !== input.device.ownerId ||
          existing.conversationId !== input.device.conversationId)
      ) {
        return fail("mismatch");
      }

      const device = existing === undefined
        ? copy(input.device)
        : { ...existing, lastSequence: Math.max(existing.lastSequence, input.device.lastSequence) };
      this.#devices.set(device.id, device);
      this.#challenges.set(challenge.id, {
        ...challenge,
        attempts: challenge.attempts + 1,
        consumedAt: input.now,
        consumedByDeviceId: device.id,
      });
      return { kind: "paired", device: copy(device) };
    });
  }

  getPairingChallenge(challengeId: string): Promise<PairingChallengeRecord | null> {
    return this.#locked(() => {
      const challenge = this.#challenges.get(challengeId);
      return challenge === undefined ? null : copy(challenge);
    });
  }

  getDevice(deviceId: string): Promise<DeviceRecord | null> {
    return this.#locked(() => {
      const device = this.#devices.get(deviceId);
      return device === undefined ? null : copy(device);
    });
  }

  findDeviceByAssociation(ownerId: string, conversationId: string): Promise<DeviceRecord | null> {
    return this.#locked(() => {
      const device = [...this.#devices.values()]
        .filter((candidate) =>
          candidate.ownerId === ownerId && candidate.conversationId === conversationId)
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      return device === undefined ? null : copy(device);
    });
  }

  commitEngineeringMessage(
    providerMessageId: string,
    task: CloudTaskRecord,
    command: DeviceCommandOutboxRecord,
  ): Promise<InboundCommitResult> {
    return this.#locked(() => {
      if (this.#processedInbound.has(providerMessageId)) return { accepted: false };
      if (!this.#devices.has(command.deviceId)) {
        throw new RepositoryConflictError("Command target is not paired");
      }
      this.#processedInbound.add(providerMessageId);
      this.#tasks.set(task.id, copy(task));
      if (![...this.#deviceCommands.values()].some(
        (record) => record.dedupeKey === command.dedupeKey,
      )) {
        this.#deviceCommands.set(command.id, copy(command));
      }
      return { accepted: true };
    });
  }

  commitUnpairedMessage(
    providerMessageId: string,
    notification: SendblueOutboxRecord,
  ): Promise<InboundCommitResult> {
    return this.#locked(() => {
      if (this.#processedInbound.has(providerMessageId)) return { accepted: false };
      this.#processedInbound.add(providerMessageId);
      this.#enqueueSendblue(notification);
      return { accepted: true };
    });
  }

  getTask(taskId: string): Promise<CloudTaskRecord | null> {
    return this.#locked(() => {
      const task = this.#tasks.get(taskId);
      return task === undefined ? null : copy(task);
    });
  }

  registerModalMonitor(
    registration: ModalMonitorRegistration,
    now: string,
  ): Promise<{ task: CloudTaskRecord; created: boolean }> {
    return this.#locked(() => {
      const result = registerMonitorInMaps(
        this.#tasks,
        this.#monitorJobs,
        registration,
        now,
      );
      return { task: result.task, created: result.created };
    });
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
    return this.#locked(() => {
      const task = this.#tasks.get(taskId);
      if (!task) throw new RepositoryConflictError("Task does not exist");
      if (terminal(task.status)) {
        if (task.completionKey !== completionKey) {
          throw new RepositoryConflictError("Task completed with another idempotency key");
        }
        if (task.status !== status) {
          throw new RepositoryConflictError("Task already completed with another status");
        }
        const enqueued = this.#enqueueSendblue(message);
        const commandEnqueued = command === undefined
          ? false
          : this.#enqueueDeviceCommand(command);
        return { task: copy(task), transitioned: false, enqueued, commandEnqueued };
      }
      const updated: CloudTaskRecord = {
        ...task,
        status,
        completionKey,
        summary,
        ...(completion === undefined ? {} : { completion: copy(completion) }),
        updatedAt: now,
      };
      this.#tasks.set(taskId, updated);
      const enqueued = this.#enqueueSendblue(message);
      const commandEnqueued = command === undefined
        ? false
        : this.#enqueueDeviceCommand(command);
      return { task: copy(updated), transitioned: true, enqueued, commandEnqueued };
    });
  }

  commitDeviceSync(input: DeviceSyncCommitInput): Promise<DeviceSyncCommitResult> {
    return this.#locked(() => {
      const device = this.#devices.get(input.deviceId);
      if (!device) throw new RepositoryConflictError("Device does not exist");
      const expectedSequence = device.lastSequence + 1;
      if (input.sequence !== expectedSequence) {
        throw new StaleDeviceSequenceError(expectedSequence);
      }
      // The signed anti-replay sequence is consumed even when a durable event
      // is rejected. The device keeps that event pending and retries it under
      // a fresh sequence; the event ID is not acknowledged until its effects
      // commit below.
      this.#devices.set(device.id, { ...device, lastSequence: input.sequence });

      // Stage every event-driven mutation first. No event ID or event-driven
      // side effect is committed unless all required events validate.
      const tasks = new Map([...this.#tasks].map(([id, task]) => [id, copy(task)]));
      const jobs = new Map([...this.#monitorJobs].map(([id, job]) => [id, copy(job)]));
      const commands = new Map(
        [...this.#deviceCommands].map(([id, command]) => [id, copy(command)]),
      );
      const messages = new Map(
        [...this.#sendblueOutbox].map(([id, message]) => [id, copy(message)]),
      );
      const messageDedupe = new Map(this.#sendblueDedupe);
      const acceptedEvents = new Set(this.#acceptedEvents);

      for (const event of input.events) {
        const eventKey = `${device.id}:${event.id}`;
        if (acceptedEvents.has(eventKey)) continue;

        if (event.type === "task.created") {
          if (!event.taskId) {
            throw new InvalidTransportEventError(event.id, "task.created requires taskId");
          }
          const payload = TaskCreatedTransportPayloadSchema.safeParse(event.payload);
          if (!payload.success || payload.data.conversationId !== device.conversationId) {
            throw new InvalidTransportEventError(
              event.id,
              "task.created does not match the paired conversation",
            );
          }
          let existing = tasks.get(event.taskId);
          if (existing === undefined) {
            const direct = payload.data.cloudTaskId === undefined
              ? undefined
              : tasks.get(payload.data.cloudTaskId);
            const candidates = direct === undefined
              ? [...tasks.values()].filter((candidate) =>
                candidate.id !== event.taskId &&
                candidate.origin === "cloud_ingress" &&
                candidate.status === "queued" &&
                candidate.monitor === undefined &&
                candidate.ownerId === device.ownerId &&
                candidate.conversationId === device.conversationId &&
                candidate.phoneE164 === device.phoneE164 &&
                candidate.request === payload.data.originalRequest &&
                (payload.data.sourceMessageId === undefined ||
                  candidate.sourceMessageId === payload.data.sourceMessageId))
              : [direct];
            if (payload.data.cloudTaskId !== undefined && direct === undefined) {
              throw new InvalidTransportEventError(
                event.id,
                "task.created references an unknown cloud ingress task",
              );
            }
            if (candidates.length === 1) {
              const ingress = candidates[0]!;
              if (
                ingress.origin !== "cloud_ingress" ||
                ingress.ownerId !== device.ownerId ||
                ingress.conversationId !== device.conversationId ||
                ingress.phoneE164 !== device.phoneE164 ||
                ingress.request !== payload.data.originalRequest
              ) {
                throw new InvalidTransportEventError(
                  event.id,
                  "task.created cloud ingress identity conflicts with the paired owner",
                );
              }
              tasks.delete(ingress.id);
              existing = {
                ...ingress,
                id: event.taskId,
                cloudIngressTaskId: ingress.id,
              };
            }
          }
          if (
            existing !== undefined &&
            (existing.ownerId !== device.ownerId ||
              existing.conversationId !== device.conversationId ||
              existing.phoneE164 !== device.phoneE164)
          ) {
            throw new InvalidTransportEventError(
              event.id,
              "task.created conflicts with the paired owner",
            );
          }
          tasks.set(event.taskId, {
            ...(existing ?? {
              id: event.taskId,
              ownerId: device.ownerId,
              conversationId: device.conversationId,
              phoneE164: device.phoneE164,
              sourceMessageId: event.id,
              status: "queued" as const,
              createdAt: event.occurredAt,
            }),
            origin: "device",
            title: payload.data.title,
            request: payload.data.originalRequest,
            updatedAt: event.occurredAt,
          });
        } else if (event.type === "modal.monitor.registered") {
          if (!event.taskId) {
            throw new InvalidTransportEventError(
              event.id,
              "modal.monitor.registered requires taskId",
            );
          }
          const payload = ModalMonitorTransportPayloadSchema.safeParse(event.payload);
          if (
            !payload.success ||
            payload.data.taskId !== event.taskId ||
            (event.workerId !== undefined &&
              payload.data.workerId !== undefined &&
              event.workerId !== payload.data.workerId)
          ) {
            throw new InvalidTransportEventError(
              event.id,
              "modal.monitor.registered payload is inconsistent",
            );
          }
          try {
            registerMonitorInMaps(tasks, jobs, payload.data, event.occurredAt);
          } catch (error) {
            throw new InvalidTransportEventError(
              event.id,
              error instanceof Error ? error.message : "Invalid Modal monitor registration",
            );
          }
        } else if (event.type === "message.sent") {
          const payload = MessageSentTransportPayloadSchema.safeParse(event.payload);
          if (!payload.success || payload.data.conversationId !== device.conversationId) {
            throw new InvalidTransportEventError(
              event.id,
              "message.sent does not match the paired conversation",
            );
          }
          const dedupeKey = `device-event:${device.id}:${event.id}`;
          if (!messageDedupe.has(dedupeKey)) {
            const id = `sendblue_out_${sha256Hex(dedupeKey).slice(0, 32)}`;
            messages.set(id, {
              id,
              dedupeKey,
              ownerId: device.ownerId,
              conversationId: device.conversationId,
              toPhone: device.phoneE164,
              text: payload.data.text,
              createdAt: event.occurredAt,
              ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
            });
            messageDedupe.set(dedupeKey, id);
          }
        }
        acceptedEvents.add(eventKey);
      }

      const acceptedReceiptIds: string[] = [];
      const rejectedReceiptIds: string[] = [];
      for (const receipt of input.receipts) {
        const record = [...commands.values()].find(
          (candidate) =>
            candidate.deviceId === device.id && candidate.command.id === receipt.commandId,
        );
        if (record !== undefined) {
          acceptedReceiptIds.push(receipt.commandId);
          if (record.acknowledgedAt === undefined) {
            commands.set(record.id, { ...record, acknowledgedAt: input.now });
          }
        } else {
          // A signed device may retain a receipt after cloud state was restored,
          // compacted, or a diagnostic command was injected locally. Give the
          // client a terminal disposition instead of making it retry forever.
          // Rejection is deliberately distinct from acknowledgement: callers
          // must never use it as proof that a power-critical command was accepted.
          rejectedReceiptIds.push(receipt.commandId);
        }
      }

      this.#tasks.clear();
      for (const [id, task] of tasks) this.#tasks.set(id, task);
      this.#monitorJobs.clear();
      for (const [id, job] of jobs) this.#monitorJobs.set(id, job);
      this.#deviceCommands.clear();
      for (const [id, command] of commands) this.#deviceCommands.set(id, command);
      this.#sendblueOutbox.clear();
      for (const [id, message] of messages) this.#sendblueOutbox.set(id, message);
      this.#sendblueDedupe.clear();
      for (const [key, id] of messageDedupe) this.#sendblueDedupe.set(key, id);
      this.#acceptedEvents.clear();
      for (const event of acceptedEvents) this.#acceptedEvents.add(event);

      const pendingCommands = [...commands.values()]
        .filter((record) => record.deviceId === device.id && record.acknowledgedAt === undefined)
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .slice(0, input.commandLimit)
        .map((record) => copy(record.command));
      return {
        commands: pendingCommands,
        acceptedEventIds: [...new Set(input.events.map((event) => event.id))],
        acceptedReceiptIds,
        rejectedReceiptIds,
        cursor: `device:${input.sequence}`,
        nextSequence: input.sequence + 1,
      };
    });
  }

  listPendingMonitorJobs(limit: number): Promise<MonitorJobRecord[]> {
    return this.#locked(() => [...this.#monitorJobs.values()]
      .filter((job) => job.dispatchedAt === undefined && job.claimedAt === undefined)
      .sort((left, right) =>
        left.availableAt.localeCompare(right.availableAt) || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, limit))
      .map(copy));
  }

  claimPendingMonitorJobs(
    limit: number,
    claimedAt: string,
    leaseMs: number,
  ): Promise<MonitorJobRecord[]> {
    return this.#locked(() => {
      const claimedAtMs = Date.parse(claimedAt);
      if (!Number.isFinite(claimedAtMs) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
        throw new RangeError("Invalid monitor job claim lease");
      }
      const candidates = [...this.#monitorJobs.values()]
        .filter((job) =>
          job.dispatchedAt === undefined &&
          (job.claimExpiresAt === undefined || Date.parse(job.claimExpiresAt) <= claimedAtMs) &&
          Date.parse(job.availableAt) <= claimedAtMs)
        .sort((left, right) =>
          left.availableAt.localeCompare(right.availableAt) || left.id.localeCompare(right.id))
        .slice(0, Math.max(0, limit));
      return candidates.map((job) => {
        const claimed: MonitorJobRecord = {
          ...job,
          dispatchAttempts: job.dispatchAttempts + 1,
          claimedAt,
          claimExpiresAt: new Date(claimedAtMs + leaseMs).toISOString(),
        };
        this.#monitorJobs.set(job.id, claimed);
        return copy(claimed);
      });
    });
  }

  markMonitorJobDispatched(jobId: string, dispatchedAt: string): Promise<boolean> {
    return this.#locked(() => {
      const job = this.#monitorJobs.get(jobId);
      if (!job || job.dispatchedAt !== undefined) return false;
      this.#monitorJobs.set(job.id, { ...job, dispatchedAt });
      return true;
    });
  }

  releaseMonitorJob(jobId: string): Promise<boolean> {
    return this.#locked(() => {
      const job = this.#monitorJobs.get(jobId);
      if (!job || job.dispatchedAt !== undefined || job.claimedAt === undefined) return false;
      const { claimedAt: _claimedAt, claimExpiresAt: _claimExpiresAt, ...released } = job;
      this.#monitorJobs.set(job.id, released);
      return true;
    });
  }

  listPendingDeviceCommands(
    deviceId: string,
    limit: number,
  ): Promise<DeviceCommandOutboxRecord[]> {
    return this.#locked(() => [...this.#deviceCommands.values()]
      .filter((record) => record.deviceId === deviceId && record.acknowledgedAt === undefined)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, limit))
      .map(copy));
  }

  listSendblueOutbox(): Promise<SendblueOutboxRecord[]> {
    return this.#locked(() => [...this.#sendblueOutbox.values()]
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(copy));
  }

  #enqueueSendblue(message: SendblueOutboxRecord): boolean {
    if (this.#sendblueDedupe.has(message.dedupeKey)) return false;
    this.#sendblueDedupe.set(message.dedupeKey, message.id);
    this.#sendblueOutbox.set(message.id, copy(message));
    return true;
  }

  #enqueueDeviceCommand(command: DeviceCommandOutboxRecord): boolean {
    if ([...this.#deviceCommands.values()].some(
      (record) => record.dedupeKey === command.dedupeKey,
    )) return false;
    this.#deviceCommands.set(command.id, copy(command));
    return true;
  }
}
