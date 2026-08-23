import {
  DexPairingPayloadSchema,
  DexSyncPayloadSchema,
  dexKeyId,
  type DexDeviceKeyPair,
  type DexPairingResponse,
  type DexSyncResponse,
} from "../messaging/index.js";
import { createEngineeringTaskAndCommand, deterministicControlPlaneId } from "./commands.js";
import { ControlPlaneError } from "./errors.js";
import {
  ModalMonitorRegistrationSchema,
  ModalTerminalInputSchema,
  type DeviceRecord,
  type ModalTerminalInput,
  type SendblueOutboxRecord,
  type VerifiedConversationAssociation,
  type ConversationAssociationVerifier,
} from "./models.js";
import { SetupCodePairingChallengeService } from "./pairing.js";
import {
  InvalidTransportEventError,
  RepositoryConflictError,
  StaleDeviceSequenceError,
  type ControlPlaneRepository,
} from "./repository.js";
import { verifyDexRequestProof } from "./request-verification.js";
import {
  constantTimeSecretEqual,
  headerValue,
  parseInboundMessage,
  parseSendblueInboundWebhook,
  verifySendblueWebhookSecret,
  type HeaderSource,
} from "./sendblue.js";

export interface DexControlPlaneOptions {
  repository: ControlPlaneRepository;
  associationVerifier: ConversationAssociationVerifier;
  signingKey: DexDeviceKeyPair;
  sendblueWebhookSecret: string;
  internalSecret: string;
  now?: () => number;
  pairingChallengeTtlMs?: number;
  pairingChallengeMaxAttempts?: number;
  maxRequestAgeMs?: number;
}

export type SendblueWebhookOutcome =
  | { kind: "duplicate"; providerMessageId: string }
  | { kind: "pairing_challenge"; providerMessageId: string; challengeId: string }
  | { kind: "pairing_instructions"; providerMessageId: string }
  | { kind: "engineering_command"; providerMessageId: string; taskId: string; commandId: string }
  | { kind: "pairing_required"; providerMessageId: string };

export interface DeviceRequestInput {
  body: string;
  headers: HeaderSource;
  json: unknown;
}

function validAssociation(
  association: VerifiedConversationAssociation | null,
  fromPhone: string,
): association is VerifiedConversationAssociation {
  return association !== null &&
    association.ownerId.trim().length > 0 && association.ownerId.length <= 512 &&
    association.conversationId.trim().length > 0 && association.conversationId.length <= 512 &&
    association.phoneE164 === fromPhone;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function safeSummary(value: string): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ").trim();
  return (clean || "No completion summary was provided.").slice(0, 1_000);
}

function completionText(
  title: string,
  status: "succeeded" | "failed" | "cancelled",
  summary: string,
): string {
  const label = status === "succeeded" ? "completed" : status;
  return `Dex ${label} “${title}”: ${summary}`.slice(0, 1_500);
}

export class DexControlPlaneService {
  readonly #repository: ControlPlaneRepository;
  readonly #associationVerifier: ConversationAssociationVerifier;
  readonly #signingKey: DexDeviceKeyPair;
  readonly #sendblueWebhookSecret: string;
  readonly #internalSecret: string;
  readonly #now: () => number;
  readonly #maxRequestAgeMs: number;
  readonly #challenges: SetupCodePairingChallengeService;

  constructor(options: DexControlPlaneOptions) {
    if (!options.sendblueWebhookSecret || !options.internalSecret) {
      throw new TypeError("Control-plane webhook and internal secrets are required");
    }
    if (
      options.signingKey.algorithm !== "ed25519" ||
      dexKeyId(options.signingKey.publicKey) !== options.signingKey.keyId
    ) {
      throw new TypeError("Control-plane signing key is invalid");
    }
    this.#repository = options.repository;
    this.#associationVerifier = options.associationVerifier;
    this.#signingKey = options.signingKey;
    this.#sendblueWebhookSecret = options.sendblueWebhookSecret;
    this.#internalSecret = options.internalSecret;
    this.#now = options.now ?? Date.now;
    this.#maxRequestAgeMs = options.maxRequestAgeMs ?? 5 * 60_000;
    if (
      !Number.isSafeInteger(this.#maxRequestAgeMs) ||
      this.#maxRequestAgeMs < 1_000 ||
      this.#maxRequestAgeMs > 15 * 60_000
    ) {
      throw new RangeError("Dex request age must be between one and fifteen minutes");
    }
    this.#challenges = new SetupCodePairingChallengeService({
      secret: options.internalSecret,
      ...(options.pairingChallengeTtlMs === undefined
        ? {}
        : { ttlMs: options.pairingChallengeTtlMs }),
      ...(options.pairingChallengeMaxAttempts === undefined
        ? {}
        : { maxAttempts: options.pairingChallengeMaxAttempts }),
    });
  }

  verifyInternalRequest(headers: HeaderSource): void {
    if (!constantTimeSecretEqual(headerValue(headers, "x-dex-internal-secret"), this.#internalSecret)) {
      throw new ControlPlaneError(401, "unauthorized", "Unauthorized");
    }
  }

  verifySendblueRequest(headers: HeaderSource): void {
    if (!verifySendblueWebhookSecret(headers, this.#sendblueWebhookSecret)) {
      throw new ControlPlaneError(401, "invalid_sendblue_secret", "Unauthorized");
    }
  }

  async processSendblueWebhook(
    input: unknown,
    headers: HeaderSource,
  ): Promise<SendblueWebhookOutcome> {
    this.verifySendblueRequest(headers);
    const message = parseSendblueInboundWebhook(input);
    if (await this.#repository.hasProcessedInbound(message.message_handle)) {
      return { kind: "duplicate", providerMessageId: message.message_handle };
    }
    const providerConversationId = message.group_id?.trim();
    const association = await this.#associationVerifier.verify({
      provider: "sendblue",
      providerMessageId: message.message_handle,
      fromPhone: message.from_number,
      toPhone: message.to_number,
      ...(providerConversationId ? { providerConversationId } : {}),
    });
    if (!validAssociation(association, message.from_number)) {
      throw new ControlPlaneError(403, "unverified_owner", "Owner association is not verified");
    }
    const parsed = parseInboundMessage(message.content);
    const now = this.#now();

    if (parsed.kind === "pair") {
      if (parsed.setupCode === undefined) {
        const notification: SendblueOutboxRecord = {
          id: deterministicControlPlaneId("sendblue_out", `pair-help:${message.message_handle}`),
          dedupeKey: `sendblue:pair-help:${message.message_handle}`,
          ownerId: association.ownerId,
          conversationId: association.conversationId,
          toPhone: association.phoneE164,
          text: "Run dex setup on your Mac, then text the complete PAIR setup code it displays.",
          createdAt: iso(now),
        };
        const committed = await this.#repository.commitUnpairedMessage(
          message.message_handle,
          notification,
        );
        return committed.accepted
          ? { kind: "pairing_instructions", providerMessageId: message.message_handle }
          : { kind: "duplicate", providerMessageId: message.message_handle };
      }
      const challenge = this.#challenges.issue(
        parsed.setupCode,
        association,
        message.message_handle,
        now,
      );
      const notification: SendblueOutboxRecord = {
        id: deterministicControlPlaneId("sendblue_out", `pair:${message.message_handle}`),
        dedupeKey: `sendblue:pair:${message.message_handle}`,
        ownerId: association.ownerId,
        conversationId: association.conversationId,
        toPhone: association.phoneE164,
        text: "Dex verified this setup code. Your Mac can now finish pairing.",
        createdAt: iso(now),
      };
      let committed;
      try {
        committed = await this.#repository.commitPairingChallenge(
          message.message_handle,
          challenge,
          notification,
        );
      } catch (error) {
        if (error instanceof RepositoryConflictError) {
          throw new ControlPlaneError(409, "pairing_code_conflict", "Pairing code is already bound");
        }
        throw error;
      }
      if (!committed.accepted) {
        return { kind: "duplicate", providerMessageId: message.message_handle };
      }
      return {
        kind: "pairing_challenge",
        providerMessageId: message.message_handle,
        challengeId: challenge.id,
      };
    }

    const device = await this.#repository.findDeviceByAssociation(
      association.ownerId,
      association.conversationId,
    );
    if (!device) {
      const notification: SendblueOutboxRecord = {
        id: deterministicControlPlaneId("sendblue_out", `unpaired:${message.message_handle}`),
        dedupeKey: `sendblue:unpaired:${message.message_handle}`,
        ownerId: association.ownerId,
        conversationId: association.conversationId,
        toPhone: association.phoneE164,
        text: "Dex needs a paired Mac before it can accept engineering work. Run dex setup to begin.",
        createdAt: iso(now),
      };
      const committed = await this.#repository.commitUnpairedMessage(
        message.message_handle,
        notification,
      );
      return committed.accepted
        ? { kind: "pairing_required", providerMessageId: message.message_handle }
        : { kind: "duplicate", providerMessageId: message.message_handle };
    }

    const created = createEngineeringTaskAndCommand({
      message,
      text: parsed.text,
      association,
      device,
      signingKey: this.#signingKey,
    });
    const committed = await this.#repository.commitEngineeringMessage(
      message.message_handle,
      created.task,
      created.outbox,
    );
    if (!committed.accepted) {
      return { kind: "duplicate", providerMessageId: message.message_handle };
    }
    return {
      kind: "engineering_command",
      providerMessageId: message.message_handle,
      taskId: created.task.id,
      commandId: created.outbox.command.id,
    };
  }

  async pairDevice(request: DeviceRequestInput): Promise<DexPairingResponse> {
    const parsed = DexPairingPayloadSchema.safeParse(request.json);
    if (!parsed.success) {
      throw new ControlPlaneError(400, "invalid_pairing_request", "Invalid pairing request");
    }
    let actualKeyId: string;
    try {
      actualKeyId = dexKeyId(parsed.data.publicKey);
    } catch {
      throw new ControlPlaneError(400, "invalid_device_key", "Invalid device key");
    }
    if (actualKeyId !== parsed.data.keyId) {
      throw new ControlPlaneError(400, "invalid_device_key", "Invalid device key");
    }
    const now = this.#now();
    const proof = verifyDexRequestProof({
      path: "/v1/device/pair",
      body: request.body,
      headers: request.headers,
      publicKey: parsed.data.publicKey,
      expectedKeyId: parsed.data.keyId,
      now,
      maxRequestAgeMs: this.#maxRequestAgeMs,
    });
    const challengeProof = this.#challenges.identify(parsed.data.pairingCode);
    const challenge = await this.#repository.getPairingChallenge(challengeProof.challengeId);
    if (!challenge) {
      throw new ControlPlaneError(401, "invalid_pairing_code", "Invalid pairing code");
    }
    const deviceId = deterministicControlPlaneId("device", parsed.data.keyId);
    const device: DeviceRecord = {
      id: deviceId,
      keyId: parsed.data.keyId,
      publicKey: parsed.data.publicKey,
      ownerId: challenge.ownerId,
      conversationId: challenge.conversationId,
      phoneE164: challenge.phoneE164,
      deviceName: parsed.data.deviceName,
      createdAt: iso(now),
      lastSequence: proof.sequence,
    };
    const consumed = await this.#repository.consumePairingChallenge({
      challengeId: challengeProof.challengeId,
      codeDigest: challengeProof.codeDigest,
      now: iso(now),
      device,
    });
    if (consumed.kind !== "paired") {
      const code = consumed.kind === "expired" ? "pairing_code_expired" :
        consumed.kind === "consumed" ? "pairing_code_consumed" :
        consumed.kind === "attempts_exhausted" ? "pairing_attempts_exhausted" :
        "invalid_pairing_code";
      throw new ControlPlaneError(
        consumed.kind === "consumed" ? 409 : consumed.kind === "attempts_exhausted" ? 429 : 401,
        code,
        "Pairing challenge cannot be used",
      );
    }
    return {
      version: 1,
      deviceId: consumed.device.id,
      keyId: consumed.device.keyId,
      ownerId: consumed.device.ownerId,
      pairedConversationId: consumed.device.conversationId,
      cursor: "device:0",
      nextSequence: proof.sequence + 1,
    };
  }

  async syncDevice(request: DeviceRequestInput): Promise<DexSyncResponse> {
    const parsed = DexSyncPayloadSchema.safeParse(request.json);
    if (!parsed.success) {
      throw new ControlPlaneError(400, "invalid_sync_request", "Invalid sync request");
    }
    const deviceId = headerValue(request.headers, "x-appfi-device-id");
    if (!deviceId) throw new ControlPlaneError(401, "invalid_request_signature", "Invalid Dex request proof");
    const device = await this.#repository.getDevice(deviceId);
    if (!device) throw new ControlPlaneError(401, "unknown_device", "Unknown Dex device");
    const now = this.#now();
    const proof = verifyDexRequestProof({
      path: "/v1/device/sync",
      body: request.body,
      headers: request.headers,
      publicKey: device.publicKey,
      expectedKeyId: device.keyId,
      expectedDeviceId: device.id,
      now,
      maxRequestAgeMs: this.#maxRequestAgeMs,
    });
    try {
      const committed = await this.#repository.commitDeviceSync({
        deviceId: device.id,
        sequence: proof.sequence,
        events: parsed.data.events,
        receipts: parsed.data.receipts,
        commandLimit: 500,
        now: iso(now),
      });
      return { version: 1, ...committed };
    } catch (error) {
      if (error instanceof StaleDeviceSequenceError) {
        throw new ControlPlaneError(409, "stale_sequence", "Device request sequence is stale", {
          expectedSequence: error.expectedSequence,
        });
      }
      if (error instanceof InvalidTransportEventError) {
        throw new ControlPlaneError(400, "invalid_transport_event", "Invalid durable transport event", {
          eventId: error.eventId,
        });
      }
      if (error instanceof RepositoryConflictError) {
        throw new ControlPlaneError(409, "sync_conflict", error.message);
      }
      throw error;
    }
  }

  async registerModalMonitor(input: unknown): Promise<{
    taskId: string;
    created: boolean;
    status: "running";
  }> {
    const parsed = ModalMonitorRegistrationSchema.safeParse(input);
    if (!parsed.success) {
      throw new ControlPlaneError(400, "invalid_monitor_registration", "Invalid monitor registration");
    }
    try {
      const result = await this.#repository.registerModalMonitor(parsed.data, iso(this.#now()));
      return { taskId: result.task.id, created: result.created, status: "running" };
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        throw new ControlPlaneError(409, "monitor_registration_conflict", error.message);
      }
      throw error;
    }
  }

  async handleModalTerminal(input: unknown): Promise<{
    taskId: string;
    status: "succeeded" | "failed" | "cancelled";
    transitioned: boolean;
    completionEnqueued: boolean;
  }> {
    const parsed = ModalTerminalInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ControlPlaneError(400, "invalid_modal_result", "Invalid Modal terminal result");
    }
    const terminal: ModalTerminalInput = parsed.data;
    const task = await this.#repository.getTask(terminal.taskId);
    if (!task || !task.monitor) {
      throw new ControlPlaneError(409, "modal_result_conflict", "Task monitor is not registered");
    }
    const expectedCompletionKey = `modal-monitor:${task.id}:terminal`;
    if (
      terminal.completionKey !== expectedCompletionKey ||
      terminal.sandboxId !== task.monitor.sandboxId
    ) {
      throw new ControlPlaneError(409, "modal_result_conflict", "Modal result does not match the monitor");
    }
    if (terminal.result !== undefined) {
      if (
        terminal.result.taskId !== task.id ||
        terminal.result.handoffSha256 !== task.monitor.handoffSha256 ||
        terminal.result.status !== terminal.status ||
        (terminal.status === "succeeded" && !terminal.result.validation.passed)
      ) {
        throw new ControlPlaneError(409, "modal_result_conflict", "Modal result evidence does not match the task");
      }
    } else if (terminal.status === "succeeded") {
      throw new ControlPlaneError(409, "modal_result_conflict", "Successful completion requires result evidence");
    }

    const summary = safeSummary(terminal.result?.summary ?? terminal.error ?? terminal.reason);
    const now = iso(this.#now());
    const message: SendblueOutboxRecord = {
      id: deterministicControlPlaneId("sendblue_out", expectedCompletionKey),
      dedupeKey: expectedCompletionKey,
      ownerId: task.ownerId,
      conversationId: task.conversationId,
      toPhone: task.phoneE164,
      text: completionText(task.title, terminal.status, summary),
      createdAt: now,
      taskId: task.id,
    };
    try {
      const result = await this.#repository.completeModalTaskAndEnqueue(
        task.id,
        expectedCompletionKey,
        terminal.status,
        summary,
        message,
        now,
      );
      return {
        taskId: task.id,
        status: terminal.status,
        transitioned: result.transitioned,
        completionEnqueued: result.enqueued,
      };
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        throw new ControlPlaneError(409, "modal_result_conflict", error.message);
      }
      throw error;
    }
  }

  modalTerminalHandler(): (input: unknown) => Promise<void> {
    return async (input: unknown) => {
      await this.handleModalTerminal(input);
    };
  }
}

export function createDexControlPlaneService(options: DexControlPlaneOptions): DexControlPlaneService {
  return new DexControlPlaneService(options);
}
