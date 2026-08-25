import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/state/events.js";
import { DexStateSchema, DexTaskSchema, emptyState } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { resolveDexPaths } from "../src/config/paths.js";
import { TaskManager } from "../src/tasks/task-manager.js";

describe("durable state", () => {
  it("rejects payloads and arbitrary secret text in signed transport health", () => {
    expect(() => DexStateSchema.parse({
      ...emptyState(),
      signedTransportHealth: {
        status: "degraded",
        consecutiveFailures: 1,
        lastAttemptAt: "2026-08-24T12:00:00.000Z",
        lastError: "OPENAI_API_KEY=sk-secret",
        payload: { text: "private message" },
      },
    })).toThrow();
  });

  it("keeps quarantined transport audit records metadata-only", () => {
    expect(() => DexStateSchema.parse({
      ...emptyState(),
      quarantinedTransportEvents: [{
        id: "event-invalid",
        timestamp: "2026-08-24T12:00:00.000Z",
        type: "message.sent",
        reason: "invalid_transport_event",
        quarantinedAt: "2026-08-24T12:00:01.000Z",
        payload: { text: "must not persist" },
      }],
    })).toThrow();
  });

  it("retains a bounded receipt quarantine without treating it as accepted", () => {
    expect(DexStateSchema.parse({
      ...emptyState(),
      quarantinedTransportReceipts: [{
        commandId: "unknown-command",
        status: "processed",
        occurredAt: "2026-08-24T12:00:00.000Z",
        disposition: "unknown_command",
        quarantinedAt: "2026-08-24T12:01:00.000Z",
      }],
    }).quarantinedTransportReceipts).toHaveLength(1);
  });

  it("atomically persists validated revisions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-state-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    await store.updateState((state) => {
      state.processedMessageIds.push("message-1");
    });
    const state = await store.read();
    expect(state.revision).toBe(1);
    expect(state.processedMessageIds).toEqual(["message-1"]);
  });

  it("redacts event payload secrets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-events-"));
    const file = path.join(directory, "events.jsonl");
    const log = new EventLog(file);
    await log.append({
      type: "worker.output",
      payload: { API_TOKEN: "secret", output: "Authorization: Bearer abc.def" },
    });
    const contents = await readFile(file, "utf8");
    expect(contents).not.toContain("abc.def");
    expect(contents).not.toContain('"secret"');
    expect(contents).toContain("[REDACTED]");
  });

  it("deduplicates a replayed event with the same durable ID", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-events-once-"));
    const file = path.join(directory, "events.jsonl");
    const log = new EventLog(file);
    const event = {
      id: "event-cloud-completion-1",
      timestamp: "2026-08-23T12:00:00.000Z",
      type: "task.completed" as const,
      taskId: "task-1",
      payload: { status: "succeeded" },
    };

    await log.append(event);
    await log.append(event);

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe(event.id);
  });

  it("repairs only a torn final JSONL append before writing the next event", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-events-torn-tail-"));
    const file = path.join(directory, "events.jsonl");
    const log = new EventLog(file);
    await log.append({
      id: "event-before-crash",
      type: "task.started",
      payload: {},
    });
    await appendFile(file, '{"id":"torn-after-crash"', "utf8");

    await log.append({
      id: "event-after-restart",
      type: "task.completed",
      payload: {},
    });

    const events = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map(({ id }) => id)).toEqual([
      "event-before-crash",
      "event-after-restart",
    ]);
  });

  it("can checkpoint a completed local investigation for an explicit cloud handoff", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-completed-handoff-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    const events = new EventLog(path.join(directory, "events.jsonl"));
    const timestamp = "2026-08-23T12:00:00.000Z";
    const task = DexTaskSchema.parse({
      id: "task-completed-investigation",
      projectId: "project-1",
      title: "checkout webhook ordering",
      originalRequest: "investigate checkout webhook ordering",
      repositoryPath: directory,
      baseBranch: "main",
      dexBranch: "dex/task-completed-investigation",
      worktreePath: directory,
      status: "completed",
      stage: "done",
      createdAt: timestamp,
      updatedAt: timestamp,
      workerHistory: ["worker-claude"],
      metadata: {},
    });
    await store.updateState((state) => {
      state.tasks[task.id] = task;
    });
    const tasks = new TaskManager(store, events, resolveDexPaths(directory));

    await expect(tasks.transition(task.id, "checkpointing", { stage: "checkpointing" })).resolves.toMatchObject({
      status: "checkpointing",
      stage: "checkpointing",
    });
  });

  it("commits local completion and its outbound message in one state revision", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-terminal-message-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    const events = new EventLog(path.join(directory, "events.jsonl"));
    const timestamp = "2026-08-23T12:00:00.000Z";
    const task = DexTaskSchema.parse({
      id: "task-local-completion",
      projectId: "project-1",
      title: "checkout",
      originalRequest: "fix checkout",
      repositoryPath: directory,
      baseBranch: "main",
      dexBranch: "dex/task-local-completion",
      worktreePath: directory,
      status: "running",
      stage: "testing",
      createdAt: timestamp,
      updatedAt: timestamp,
      currentWorkerId: "worker-local",
      workerHistory: ["worker-local"],
      metadata: {},
    });
    await store.updateState((state) => { state.tasks[task.id] = task; });
    const beforeRevision = (await store.read()).revision;
    const tasks = new TaskManager(store, events, resolveDexPaths(directory));

    await expect(tasks.completeIfCurrentWorkerWithNotification(
      task.id,
      "worker-local",
      "38 tests passing",
      "conversation-1",
      "checkout is done. 38 tests passing",
    )).resolves.toMatchObject({ status: "completed", stage: "done" });

    const state = await store.read();
    expect(state.revision).toBe(beforeRevision + 1);
    expect(state.tasks[task.id]).toMatchObject({
      status: "completed",
      metadata: {
        terminalNotificationEventId: expect.any(String),
        localTerminalEffects: {
          phase: "notification_pending",
          kind: "work_completed",
          eventId: expect.any(String),
        },
      },
    });
    expect(state.pendingTransportEvents).toHaveLength(1);
    expect(state.pendingTransportEvents[0]).toMatchObject({
      id: state.tasks[task.id]?.metadata.terminalNotificationEventId,
      type: "message.sent",
      taskId: task.id,
      payload: {
        conversationId: "conversation-1",
        text: "checkout is done. 38 tests passing",
      },
    });
  });

  it("keeps transient failure non-notifying, then atomically queues one final failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-terminal-failure-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    const events = new EventLog(path.join(directory, "events.jsonl"));
    const timestamp = "2026-08-23T12:00:00.000Z";
    const task = DexTaskSchema.parse({
      id: "task-local-failure",
      projectId: "project-1",
      title: "checkout",
      originalRequest: "fix checkout",
      repositoryPath: directory,
      baseBranch: "main",
      dexBranch: "dex/task-local-failure",
      worktreePath: directory,
      status: "running",
      stage: "testing",
      createdAt: timestamp,
      updatedAt: timestamp,
      currentWorkerId: "worker-local",
      workerHistory: ["worker-local"],
      metadata: {},
    });
    await store.updateState((state) => { state.tasks[task.id] = task; });
    const tasks = new TaskManager(store, events, resolveDexPaths(directory));

    await tasks.markRecoveryPendingIfCurrentWorker(
      task.id,
      "worker-local",
      { stage: "failed", latestSummary: "worker disconnected" },
      "deciding whether recovery is possible",
    );
    let state = await store.read();
    expect(state.tasks[task.id]?.metadata.localTerminalEffects).toMatchObject({ phase: "recovery_pending" });
    expect(state.pendingTransportEvents).toEqual([]);

    const input = {
      status: "failed" as const,
      stage: "failed" as const,
      summary: "recovery exhausted",
      blockedReason: "worker disconnected",
      conversationId: "conversation-1",
      text: "checkout failed. recovery exhausted",
      kind: "work_failed" as const,
      dedupeKey: "work-failed:worker-local",
    };
    await tasks.finalizeIfCurrentWorkerWithNotification(task.id, "worker-local", input);
    await tasks.finalizeIfCurrentWorkerWithNotification(task.id, "worker-local", input);

    state = await store.read();
    expect(state.tasks[task.id]).toMatchObject({
      status: "failed",
      metadata: { localTerminalEffects: { phase: "notification_pending", kind: "work_failed" } },
    });
    expect(state.pendingTransportEvents).toHaveLength(1);
    expect(state.pendingTransportEvents[0]?.payload.text).toBe("checkout failed. recovery exhausted");
  });
});
