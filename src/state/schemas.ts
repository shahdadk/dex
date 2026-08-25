import { z } from "zod";

export const AgentKindSchema = z.enum(["claude", "codex"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const ExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), machineId: z.string().min(1) }),
  z.object({ kind: z.literal("modal"), sandboxId: z.string().min(1).optional() }),
]);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

export const TaskStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "waiting_user",
  "checkpointing",
  "handoff",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const WorkerStatusSchema = z.enum([
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
]);
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const SemanticStageSchema = z.enum([
  "queued",
  "investigating",
  "implementing",
  "testing",
  "reviewing",
  "waiting",
  "checkpointing",
  "handing_off",
  "done",
  "failed",
]);
export type SemanticStage = z.infer<typeof SemanticStageSchema>;

export const TestStatusSchema = z.object({
  command: z.string().optional(),
  passed: z.number().int().min(0).optional(),
  failed: z.number().int().min(0).optional(),
  summary: z.string().optional(),
});

export const DexTaskSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("dex").default("dex"),
  projectId: z.string().min(1),
  title: z.string().min(1),
  originalRequest: z.string().min(1),
  repositoryPath: z.string().min(1),
  repositoryRemote: z.string().optional(),
  baseBranch: z.string().min(1),
  dexBranch: z.string().min(1),
  worktreePath: z.string().min(1),
  status: TaskStatusSchema,
  stage: SemanticStageSchema.default("queued"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  currentWorkerId: z.string().optional(),
  preferredAgent: AgentKindSchema.optional(),
  executionPreference: z.enum(["local", "cloud"]).optional(),
  latestSummary: z.string().optional(),
  nextStep: z.string().optional(),
  blockedReason: z.string().optional(),
  testStatus: TestStatusSchema.optional(),
  workerHistory: z.array(z.string()).default([]),
  memoryQueries: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type DexTask = z.infer<typeof DexTaskSchema>;

export const WorkerSessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  agent: AgentKindSchema,
  purpose: z.enum(["work", "review"]).default("work"),
  target: ExecutionTargetSchema,
  status: WorkerStatusSchema,
  providerSessionId: z.string().optional(),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  lastMessage: z.string().optional(),
  lastEventAt: z.string().datetime().optional(),
  exitCode: z.number().int().optional(),
  eventsPath: z.string().optional(),
});
export type WorkerSession = z.infer<typeof WorkerSessionSchema>;

export const DexProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  remote: z.string().optional(),
  defaultBranch: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type DexProject = z.infer<typeof DexProjectSchema>;

export const MachineStateSchema = z.object({
  id: z.string().min(1),
  hostname: z.string().min(1),
  batteryPercent: z.number().min(0).max(100).optional(),
  batteryReadingSimulated: z.boolean().optional(),
  charging: z.boolean().optional(),
  powerSource: z.enum(["battery", "ac"]).optional(),
  sleepPreventionActive: z.boolean().default(false),
  aggressiveLidModeActive: z.boolean().default(false),
  batteryAlertThresholds: z.array(z.number().int().min(0).max(100)).default([]),
  updatedAt: z.string().datetime(),
});
export type MachineState = z.infer<typeof MachineStateSchema>;

export const PendingMachineActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sleep"),
    trigger: z.enum(["now", "all_tasks_complete"]),
    requestedAt: z.string().datetime(),
    conversationId: z.string().optional(),
    notificationEventId: z.string().min(1).max(512).optional(),
    phase: z.enum([
      "notification_pending",
      "notification_accepted",
      "sleep_claimed",
    ]).optional(),
  }),
  z.object({
    type: z.literal("restore"),
    trigger: z.literal("all_tasks_complete"),
    requestedAt: z.string().datetime(),
  }),
]);

export const PendingConversationPromptSchema = z.object({
  id: z.string().min(1),
  type: z.literal("battery.low"),
  conversationId: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1),
  taskSnapshots: z.array(z.object({
    taskId: z.string().min(1),
    workerId: z.string().min(1),
    lifecycleGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type PendingConversationPrompt = z.infer<typeof PendingConversationPromptSchema>;

export const ListedProviderSessionSchema = z.object({
  provider: AgentKindSchema,
  sessionId: z.string().min(1).max(512),
  cwd: z.string().min(1).max(4096).optional(),
  updatedAt: z.string().datetime(),
  summary: z.string().min(1).max(180).optional(),
  active: z.boolean(),
}).strict();

export const PendingSessionSelectionSchema = z.object({
  conversationId: z.string().min(1),
  sessions: z.array(ListedProviderSessionSchema).min(1).max(50),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export type PendingSessionSelection = z.infer<typeof PendingSessionSelectionSchema>;

export const PendingTransportEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  type: z.string().min(1),
  taskId: z.string().optional(),
  workerId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const PendingTransportReceiptSchema = z.object({
  commandId: z.string().min(1),
  status: z.enum(["processed", "rejected", "failed", "duplicate"]),
  occurredAt: z.string().datetime(),
  reason: z.string().max(1000).optional(),
});

export const QuarantinedTransportEventSchema = z.object({
  id: z.string().min(1).max(512),
  timestamp: z.string().datetime(),
  type: z.string().min(1).max(512),
  taskId: z.string().min(1).max(512).optional(),
  workerId: z.string().min(1).max(512).optional(),
  reason: z.literal("invalid_transport_event"),
  quarantinedAt: z.string().datetime(),
}).strict();

export const SignedTransportErrorSchema = z.enum([
  "network",
  "http",
  "protocol",
  "verification",
  "unknown",
]);
export type SignedTransportError = z.infer<typeof SignedTransportErrorSchema>;

export const SignedTransportHealthSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("healthy"),
    consecutiveFailures: z.literal(0),
    lastAttemptAt: z.string().datetime(),
    lastSuccessAt: z.string().datetime(),
  }).strict(),
  z.object({
    status: z.literal("degraded"),
    consecutiveFailures: z.number().int().min(1).max(10_000),
    lastAttemptAt: z.string().datetime(),
    lastSuccessAt: z.string().datetime().optional(),
    lastError: SignedTransportErrorSchema,
  }).strict(),
]);
export type SignedTransportHealth = z.infer<typeof SignedTransportHealthSchema>;

export const DexStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0),
  projects: z.record(z.string(), DexProjectSchema),
  tasks: z.record(z.string(), DexTaskSchema),
  workers: z.record(z.string(), WorkerSessionSchema),
  machine: MachineStateSchema.optional(),
  pendingMachineActions: z.array(PendingMachineActionSchema),
  pendingConversationPrompts: z.array(PendingConversationPromptSchema).max(100).default([]),
  pendingSessionSelections: z.record(z.string(), PendingSessionSelectionSchema).default({}),
  processedMessageIds: z.array(z.string()).max(5000),
  lastInboundCursor: z.string().optional(),
  pendingTransportEvents: z.array(PendingTransportEventSchema).max(5000).default([]),
  pendingTransportReceipts: z.array(PendingTransportReceiptSchema).max(5000).default([]),
  quarantinedTransportEvents: z.array(QuarantinedTransportEventSchema).max(1000).default([]),
  signedTransportHealth: SignedTransportHealthSchema.optional(),
});
export type DexState = z.infer<typeof DexStateSchema>;

export function emptyState(): DexState {
  return {
    version: 1,
    revision: 0,
    projects: {},
    tasks: {},
    workers: {},
    pendingMachineActions: [],
    pendingConversationPrompts: [],
    pendingSessionSelections: {},
    processedMessageIds: [],
    pendingTransportEvents: [],
    pendingTransportReceipts: [],
    quarantinedTransportEvents: [],
  };
}

export const DexEventTypeSchema = z.enum([
  "message.received",
  "message.sent",
  "task.created",
  "task.started",
  "task.completed",
  "task.failed",
  "task.blocked",
  "worker.started",
  "worker.output",
  "worker.file_changed",
  "worker.command",
  "worker.completed",
  "worker.failed",
  "memory.observation",
  "handoff.started",
  "handoff.completed",
  "battery.low",
  "power.keep_awake_enabled",
  "power.keep_awake_disabled",
  "power.sleep_requested",
  "modal.monitor.registered",
]);

export const DexEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  taskId: z.string().optional(),
  workerId: z.string().optional(),
  type: DexEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type DexEvent = z.infer<typeof DexEventSchema>;
