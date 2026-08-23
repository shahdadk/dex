import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/state/events.js";
import { DexTaskSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import { resolveDexPaths } from "../src/config/paths.js";
import { TaskManager } from "../src/tasks/task-manager.js";

describe("durable state", () => {
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
});
