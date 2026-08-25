import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeMemClient,
  MemoryContinuity,
  assertNoSecrets,
  buildGitCheckpointCommands,
  collectClaudeMemMemories,
  createGitCheckpoint,
  discoverClaudeMem,
  extractObservationIds,
  listTrackedFiles,
  readTrackedTextFilesAtRevision,
  redactMemoryValue,
  scanForSecrets,
  selectMemories,
  taskKnowledgeToMemories,
  type MemoryObservation,
  type MemoryClient,
} from "../src/memory/index.js";
import { DexTaskSchema, WorkerSessionSchema } from "../src/state/schemas.js";
import { DexStateStore } from "../src/state/store.js";
import {
  createHandoff,
  readHandoff,
  verifyHandoff,
  writeHandoff,
} from "../src/tasks/handoff.js";

const execFile = promisify(execFileCallback);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Claude-Mem integration", () => {
  it("retries discovery after a temporary Claude-Mem outage", async () => {
    let clock = 1_000;
    let attempts = 0;
    const recovered: MemoryClient = {
      recordObservation: vi.fn(async () => ({ status: "stored" as const })),
      summarizeSession: vi.fn(async () => ({ status: "stored" as const })),
      search: vi.fn(async () => ({ content: [] })),
      timeline: vi.fn(async () => ({ content: [] })),
      getObservations: vi.fn(async () => []),
    };
    const continuity = new MemoryContinuity({
      discover: async () => (++attempts === 1 ? null : recovered),
      discoveryRetryMs: 100,
      now: () => clock,
    });

    await expect(continuity.client()).resolves.toBeNull();
    clock += 99;
    await expect(continuity.client()).resolves.toBeNull();
    expect(attempts).toBe(1);
    clock += 1;
    await expect(continuity.client()).resolves.toBe(recovered);
    expect(attempts).toBe(2);
  });

  it("persists fallback task knowledge before relying on Claude-Mem", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-memory-state-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    const task = DexTaskSchema.parse({
      id: "checkout-a1b2",
      projectId: "project-1",
      title: "checkout race",
      originalRequest: "investigate checkout",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/checkout-a1b2",
      worktreePath: "/repo-worktree",
      status: "running",
      stage: "investigating",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const worker = WorkerSessionSchema.parse({
      id: "worker-1",
      taskId: task.id,
      agent: "claude",
      target: { kind: "local", machineId: "mac-1" },
      status: "running",
      startedAt: new Date().toISOString(),
    });
    await store.updateState((state) => {
      state.tasks[task.id] = task;
      state.workers[worker.id] = worker;
    });

    const continuity = new MemoryContinuity({ client: null, store });
    await continuity.observe(task, worker, {
      type: "message",
      provider: "claude",
      workerId: worker.id,
      timestamp: new Date().toISOString(),
      role: "assistant",
      text: "Do not move idempotency after the charge; it duplicates webhook processing.",
      delta: false,
      raw: { type: "assistant" },
    });

    const persisted = (await store.read()).tasks[task.id]?.metadata.taskKnowledge;
    expect(persisted).toMatchObject({
      learnedFacts: ["Do not move idempotency after the charge; it duplicates webhook processing."],
    });
  });

  it("materializes an explicitly reported failed approach from a worker summary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-memory-failed-summary-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    const now = new Date().toISOString();
    const task = DexTaskSchema.parse({
      id: "checkout-failed-summary",
      projectId: "project-1",
      title: "checkout ordering",
      originalRequest: "fix checkout ordering",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/checkout-failed-summary",
      worktreePath: "/repo-worktree",
      status: "running",
      stage: "testing",
      createdAt: now,
      updatedAt: now,
    });
    const worker = WorkerSessionSchema.parse({
      id: "worker-failed-summary",
      taskId: task.id,
      agent: "codex",
      target: { kind: "local", machineId: "mac-1" },
      status: "running",
      startedAt: now,
    });
    await store.updateState((state) => {
      state.tasks[task.id] = task;
      state.workers[worker.id] = worker;
    });

    const continuity = new MemoryContinuity({ client: null, store });
    await continuity.observe(task, worker, {
      type: "message",
      provider: "codex",
      workerId: worker.id,
      timestamp: now,
      role: "assistant",
      text: "Validation passed. Failed approach: the original throw-on-missing-subscription behavior broke retryable delivery. No remaining issues identified.",
      delta: false,
      raw: { type: "item.completed", item: { type: "agent_message" } },
    });

    const persisted = (await store.read()).tasks[task.id]?.metadata.taskKnowledge;
    expect(persisted).toMatchObject({
      failedApproaches: [{
        approach: "the original throw-on-missing-subscription behavior",
        reason: "broke retryable delivery",
        failed: true,
        shouldRetry: false,
      }],
    });

    const handoff = await createHandoff({
      taskId: task.id,
      goal: task.originalRequest,
      repository: { baseCommit: "abc123", workingBranch: task.dexBranch },
      taskKnowledge: persisted,
    }, { discoverMemory: false });
    expect(handoff.failedApproaches).toContainEqual({
      approach: "the original throw-on-missing-subscription behavior",
      reason: "broke retryable delivery",
      doNotRepeat: true,
    });

    const legacyHandoff = await createHandoff({
      taskId: "legacy-checkout-summary",
      goal: task.originalRequest,
      repository: { baseCommit: "abc123", workingBranch: task.dexBranch },
      taskKnowledge: {
        learnedFacts: [
          "Fixed checkout. Failed approach: the original throw-on-missing-subscription behavior broke retryable delivery. No remaining issues identified.",
        ],
      },
    }, { discoverMemory: false });
    expect(legacyHandoff.failedApproaches).toContainEqual({
      approach: "the original throw-on-missing-subscription behavior",
      reason: "broke retryable delivery",
      doNotRepeat: true,
    });
  });

  it.each(["claude", "codex"] as const)(
    "extracts a canonical failed approach from a %s assistant event and hands it off",
    async (provider) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), `dex-memory-${provider}-failure-`));
      const store = new DexStateStore(path.join(directory, "state.json"));
      const now = new Date().toISOString();
      const task = DexTaskSchema.parse({
        id: `checkout-${provider}-failure`,
        projectId: "project-1",
        title: "checkout ordering",
        originalRequest: "fix checkout ordering",
        repositoryPath: "/repo",
        baseBranch: "main",
        dexBranch: `dex/checkout-${provider}-failure`,
        worktreePath: "/repo-worktree",
        status: "running",
        stage: "testing",
        createdAt: now,
        updatedAt: now,
      });
      const worker = WorkerSessionSchema.parse({
        id: `worker-${provider}-failure`,
        taskId: task.id,
        agent: provider,
        target: { kind: "local", machineId: "mac-1" },
        status: "running",
        startedAt: now,
      });
      await store.updateState((state) => {
        state.tasks[task.id] = task;
        state.workers[worker.id] = worker;
      });

      const summary = "FAILED APPROACH: moving idempotency after charging; WHY: duplicate deliveries charged twice.";
      const continuity = new MemoryContinuity({ client: null, store });
      await continuity.observe(task, worker, {
        type: "message",
        provider,
        workerId: worker.id,
        timestamp: now,
        role: "assistant",
        text: summary,
        delta: false,
        raw: provider === "claude"
          ? {
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: summary }] },
            }
          : {
              type: "item.completed",
              item: { type: "agent_message", text: summary },
            },
      });

      const persisted = (await store.read()).tasks[task.id]?.metadata.taskKnowledge;
      expect(persisted?.failedApproaches).toEqual([{
        approach: "moving idempotency after charging",
        reason: "duplicate deliveries charged twice",
        failed: true,
        shouldRetry: false,
      }]);

      const handoff = await createHandoff({
        taskId: task.id,
        goal: task.originalRequest,
        repository: { baseCommit: "abc123", workingBranch: task.dexBranch },
        taskKnowledge: persisted,
      }, { discoverMemory: false });
      expect(handoff.failedApproaches).toEqual([{
        approach: "moving idempotency after charging",
        reason: "duplicate deliveries charged twice",
        doNotRepeat: true,
      }]);
    },
  );

  it("promotes a canonical legacy learned fact into the handoff", async () => {
    const handoff = await createHandoff({
      taskId: "legacy-failed-approach",
      goal: "fix checkout ordering",
      repository: { baseCommit: "abc123", workingBranch: "dex/legacy-failure" },
      taskKnowledge: {
        learnedFacts: [
          "FAILED APPROACH: moving idempotency after charging; WHY: duplicate deliveries charged twice.",
        ],
      },
    }, { discoverMemory: false });

    expect(handoff.failedApproaches).toEqual([{
      approach: "moving idempotency after charging",
      reason: "duplicate deliveries charged twice",
      doNotRepeat: true,
    }]);
  });

  it("deduplicates a failed approach present in both structured knowledge and a summary", async () => {
    const handoff = await createHandoff({
      taskId: "duplicate-failed-approach",
      goal: "fix checkout ordering",
      repository: { baseCommit: "abc123", workingBranch: "dex/duplicate-failure" },
      taskKnowledge: {
        learnedFacts: [
          "FAILED APPROACH: moving idempotency after charging; WHY: duplicate deliveries charged twice.",
        ],
        failedApproaches: [{
          approach: "moving idempotency after charging",
          reason: "duplicate deliveries charged twice",
          failed: true,
          shouldRetry: false,
        }],
      },
    }, { discoverMemory: false });

    expect(handoff.failedApproaches).toEqual([{
      approach: "moving idempotency after charging",
      reason: "duplicate deliveries charged twice",
      doNotRepeat: true,
    }]);
  });

  it("ignores empty failure labels and unlabeled causal prose", async () => {
    const handoff = await createHandoff({
      taskId: "no-failed-approach",
      goal: "fix checkout ordering",
      repository: { baseCommit: "abc123", workingBranch: "dex/no-failure" },
      taskKnowledge: {
        learnedFacts: [
          "Failed approach: none",
          "Moving idempotency after charging caused duplicate deliveries.",
        ],
      },
    }, { discoverMemory: false });

    expect(handoff.failedApproaches).toEqual([]);
  });

  it("discovers a configured worker without starting a session", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dex-memory-discovery-"));
    const data = path.join(home, ".claude-mem");
    await mkdir(data, { recursive: true });
    await writeFile(
      path.join(data, "settings.json"),
      JSON.stringify({
        CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
        CLAUDE_MEM_WORKER_PORT: "39876",
      }),
    );
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse({ status: "ok" });
    }) as unknown as typeof fetch;

    const discovery = await discoverClaudeMem({
      homeDirectory: home,
      env: {},
      fetch: fetchMock,
    });

    expect(discovery).toMatchObject({
      available: true,
      source: "settings",
      baseUrl: "http://127.0.0.1:39876",
    });
    expect(urls).toEqual(["http://127.0.0.1:39876/api/health"]);
    expect(urls.every((url) => !url.includes("/init"))).toBe(true);
  });

  it("writes direct observations with both session identity names and redaction", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return jsonResponse({ status: "queued" });
    }) as unknown as typeof fetch;
    const client = new ClaudeMemClient({ baseUrl: "http://127.0.0.1:37777", fetch: fetchMock });

    await expect(
      client.recordObservation({
        claudeSessionId: "claude-session-1",
        content: "Bearer super-secret-token",
        title: "Found checkout cause",
        cwd: "/repo",
      }),
    ).resolves.toEqual({ status: "queued" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:37777/api/sessions/observations");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      claudeSessionId: "claude-session-1",
      contentSessionId: "claude-session-1",
      tool_name: "dex_memory_observation",
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-token");
  });

  it("finalizes an auto-created session without calling the obsolete init endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return jsonResponse({ status: "queued" });
    }) as unknown as typeof fetch;
    const client = new ClaudeMemClient({ baseUrl: "http://memory", fetch: fetchMock });

    await expect(client.summarizeSession({
      contentSessionId: "dex:checkout:worker-1",
      lastAssistantMessage: "Bearer private-summary-token",
      platformSource: "codex",
    })).resolves.toEqual({ status: "queued" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://memory/api/sessions/summarize");
    expect(requests[0]?.url).not.toContain("/init");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      contentSessionId: "dex:checkout:worker-1",
      platformSource: "codex",
    });
    expect(JSON.stringify(body)).not.toContain("private-summary-token");
  });

  it("uses stable Dex session IDs and progressive retrieval for a fresh worker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-memory-progressive-"));
    const store = new DexStateStore(path.join(directory, "state.json"));
    const now = new Date().toISOString();
    const task = DexTaskSchema.parse({
      id: "checkout-a1b2",
      projectId: "project-1",
      title: "checkout race",
      originalRequest: "investigate checkout",
      repositoryPath: "/repo/dex",
      baseBranch: "main",
      dexBranch: "dex/checkout-a1b2",
      worktreePath: "/repo-worktree",
      status: "running",
      stage: "investigating",
      createdAt: now,
      updatedAt: now,
    });
    const worker = WorkerSessionSchema.parse({
      id: "worker-1",
      taskId: task.id,
      agent: "claude",
      target: { kind: "local", machineId: "mac-1" },
      status: "running",
      providerSessionId: "provider-session-must-not-be-memory-identity",
      startedAt: now,
    });
    await store.updateState((state) => {
      state.tasks[task.id] = task;
      state.workers[worker.id] = worker;
    });

    const memories = Array.from({ length: 5 }, (_, index): MemoryObservation => ({
      id: index + 1,
      source: "claude-mem",
      project: "dex",
      type: index === 0 ? "failed-approach" : "discovery",
      title: index === 0 ? "Do not charge before idempotency" : `Checkout fact ${index}`,
      narrative: index === 0
        ? "The previous worker proved this can charge twice."
        : `Useful checkout context ${index}`,
      facts: [],
      concepts: ["checkout"],
      filesRead: [],
      filesModified: [],
    }));
    const client: MemoryClient = {
      recordObservation: vi.fn(async () => ({ status: "queued" as const })),
      summarizeSession: vi.fn(async () => ({ status: "queued" as const })),
      search: vi.fn(async () => ({ content: [{ type: "text", text: "#1 #2 #3 #4 #5" }] })),
      timeline: vi.fn(async () => ({ content: [{ type: "text", text: "#1 #2 #3 #4 #5" }] })),
      getObservations: vi.fn(async () => memories),
    };
    const continuity = new MemoryContinuity({ client, store });
    await continuity.observe(task, worker, {
      type: "message",
      provider: "claude",
      workerId: worker.id,
      timestamp: now,
      role: "assistant",
      text: "The webhook can arrive before the subscription write.",
      delta: false,
      raw: { type: "assistant" },
    });
    await continuity.summarize(worker, "Investigation complete");
    const inherited = await continuity.query(task, "checkout idempotency race");

    expect(client.recordObservation).toHaveBeenCalledWith(expect.objectContaining({
      claudeSessionId: "dex:checkout-a1b2:worker-1",
      contentSessionId: "dex:checkout-a1b2:worker-1",
      platformSource: "claude-code",
      cwd: "/repo/dex",
    }));
    expect(client.summarizeSession).toHaveBeenCalledWith(expect.objectContaining({
      contentSessionId: "dex:checkout-a1b2:worker-1",
    }));
    expect(client.search).toHaveBeenCalledOnce();
    expect(client.timeline).toHaveBeenCalledWith(expect.objectContaining({ anchor: 1 }));
    expect(client.getObservations).toHaveBeenCalledOnce();
    expect(inherited.length).toBeGreaterThanOrEqual(5);
    expect(inherited.length).toBeLessThanOrEqual(15);
    expect(inherited.join("\n")).toContain("Do not charge before idempotency");
    expect((await store.read()).tasks[task.id]?.memoryQueries).toContain("checkout idempotency race");
  });

  it("supports search, timeline ID extraction, and one batch detail request", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/api/search?")) {
        return jsonResponse({ content: [{ type: "text", text: "| #12 | fix |\n| #9 | decision |" }] });
      }
      if (url.includes("/api/timeline?")) {
        return jsonResponse({ content: [{ type: "text", text: "#8 then #12 then #13" }] });
      }
      return jsonResponse([
        {
          id: 12,
          project: "dex",
          type: "bugfix",
          title: "Fix",
          narrative: "Use the durable outbox.",
          facts: '["Cloud Tasks is at-least-once"]',
          concepts: '["idempotency"]',
          files_read: "[]",
          files_modified: '["src/task.ts"]',
        },
      ]);
    }) as unknown as typeof fetch;
    const client = new ClaudeMemClient({ baseUrl: "http://memory", fetch: fetchMock });

    const search = await client.search({ query: "checkout", project: "dex", limit: 20 });
    const timeline = await client.timeline({ anchor: 12, depthBefore: 2, depthAfter: 2 });
    expect(extractObservationIds(search)).toEqual([12, 9]);
    expect(extractObservationIds(timeline)).toEqual([8, 12, 13]);
    const observations = await client.getObservations([12, 9, 8, 13]);

    expect(observations).toEqual([
      expect.objectContaining({
        id: 12,
        source: "claude-mem",
        facts: ["Cloud Tasks is at-least-once"],
        filesModified: ["src/task.ts"],
      }),
    ]);
    expect(requests.filter((request) => request.url.endsWith("/api/observations/batch"))).toHaveLength(1);
  });

  it("never falls back to global retrieval when a scoped project has no observations", async () => {
    const memories = Array.from({ length: 5 }, (_, index): MemoryObservation => ({
      id: 100 + index,
      source: "claude-mem",
      project: "normalized-parent-project",
      type: index === 0 ? "failed-approach" : "discovery",
      title: index === 0 ? "Do not charge before idempotency" : `Checkout fact ${index}`,
      narrative: `Durable checkout context ${index}`,
      facts: [],
      concepts: ["checkout"],
      filesRead: [],
      filesModified: [],
    }));
    const client: MemoryClient = {
      recordObservation: vi.fn(async () => ({ status: "queued" as const })),
      summarizeSession: vi.fn(async () => ({ status: "queued" as const })),
      search: vi.fn(async (options) => options.project
        ? { content: [{ type: "text", text: "No results found" }] }
        : { content: [{ type: "text", text: "#100 #101 #102 #103 #104" }] }),
      timeline: vi.fn(async (options) => "project" in options
        ? { content: [] }
        : { content: [{ type: "text", text: "#100 #101 #102 #103 #104" }] }),
      getObservations: vi.fn(async (options) => options.project ? [] : memories),
    };

    await expect(collectClaudeMemMemories(client, {
      query: "checkout idempotency",
      project: "worktree-derived-name",
    })).resolves.toEqual([]);
    expect(client.search).toHaveBeenCalledOnce();
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({
      project: "worktree-derived-name",
    }));
    expect(client.timeline).not.toHaveBeenCalled();
    expect(client.getObservations).not.toHaveBeenCalled();
  });

  it("rejects cross-project observations returned by a scoped Claude-Mem batch", async () => {
    const client: MemoryClient = {
      recordObservation: vi.fn(async () => ({ status: "queued" as const })),
      summarizeSession: vi.fn(async () => ({ status: "queued" as const })),
      search: vi.fn(async () => ({ content: [{ type: "text", text: "#1 #2" }] })),
      timeline: vi.fn(async () => ({ content: [{ type: "text", text: "#1 #2" }] })),
      getObservations: vi.fn(async () => [
        {
          id: 1,
          source: "claude-mem",
          project: "dex",
          type: "discovery",
          title: "Checkout ordering",
          narrative: "invoice.paid may arrive first",
          facts: [],
          concepts: ["checkout"],
          filesRead: [],
          filesModified: [],
        },
        {
          id: 2,
          source: "claude-mem",
          project: "private-client-report",
          type: "failed-approach",
          title: "Unrelated private failure",
          narrative: "must never enter this handoff",
          facts: [],
          concepts: ["checkout"],
          filesRead: [],
          filesModified: [],
        },
      ]),
    };

    await expect(collectClaudeMemMemories(client, {
      query: "checkout ordering",
      project: "dex",
    })).resolves.toEqual([
      expect.objectContaining({ id: 1, project: "dex" }),
    ]);
    expect(client.getObservations).toHaveBeenCalledWith(expect.objectContaining({ project: "dex" }));
  });
});

describe("memory selection and safety", () => {
  it("uses TaskKnowledge fallback and enforces the 5-15 handoff range", () => {
    const fallback = taskKnowledgeToMemories({
      learnedFacts: ["The checkout failure is caused by an idempotency race."],
      decisions: ["Use a task-level completion key."],
      failedApproaches: [
        { approach: "Retry the message send", reason: "It duplicates terminal messages." },
      ],
      constraints: ["Do not use a model for polling."],
      nextSteps: ["Add an atomic completion transition."],
      filesChanged: ["src/tasks/monitor.ts"],
    });

    const selected = selectMemories([], { query: "checkout idempotency", fallback });
    expect(selected.length).toBeGreaterThanOrEqual(5);
    expect(selected.length).toBeLessThanOrEqual(15);
    expect(selected.some((memory) => memory.type === "failed-approach")).toBe(true);

    const many = Array.from({ length: 20 }, (_, index): MemoryObservation => ({
      id: index,
      source: "claude-mem",
      type: "discovery",
      title: `Observation ${index}`,
      narrative: `Checkout detail ${index}`,
      facts: [],
      concepts: [],
      filesRead: [],
      filesModified: [],
    }));
    expect(selectMemories(many, { query: "checkout" })).toHaveLength(15);
  });

  it("does not let unrelated historical failures crowd topical task memory out", () => {
    const relevant: MemoryObservation = {
      id: 6044,
      source: "claude-mem",
      type: "discovery",
      title: "Checkout webhook idempotency",
      narrative: "invoice.paid ordering requires idempotency before charging",
      facts: ["External charge before idempotency risks duplicate checkout charges"],
      concepts: ["checkout", "idempotency"],
      filesRead: [],
      filesModified: [],
    };
    const unrelated = Array.from({ length: 12 }, (_, index): MemoryObservation => ({
      id: 1_000 + index,
      source: "claude-mem",
      type: "failed-approach",
      title: `Unrelated deployment failure ${index}`,
      narrative: "Do not repeat this release pipeline approach because validation failed.",
      facts: ["A different application release was unsuccessful"],
      concepts: ["deployment"],
      filesRead: [],
      filesModified: [],
    }));
    const fallback = taskKnowledgeToMemories({
      learnedFacts: ["Checkout receives invoice.paid before subscription creation."],
      decisions: ["Keep checkout idempotency before external charges."],
      failedApproaches: [{
        approach: "Charge before idempotency",
        reason: "Duplicate checkout delivery charges twice.",
      }],
      constraints: ["Preserve webhook ordering independence."],
      nextSteps: ["Run the checkout regression test."],
    });

    const selected = selectMemories([relevant, ...unrelated], {
      query: "checkout invoice.paid idempotency duplicate charge",
      fallback,
    });

    expect(selected).toContainEqual(expect.objectContaining({ id: 6044 }));
    expect(selected.some((memory) =>
      typeof memory.id === "number" && memory.id >= 1_000 && memory.id < 1_100)).toBe(false);
  });

  it("redacts known secret forms and fails closed when a raw secret remains", () => {
    const raw = {
      API_TOKEN: "plain-secret",
      output: "Authorization: Bearer abcdefghijklmnop and ghp_1234567890123456789012345",
    };
    const redacted = redactMemoryValue(raw);
    expect(JSON.stringify(redacted)).not.toContain("plain-secret");
    expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnop");
    expect(scanForSecrets(redacted)).toEqual([]);
    expect(() => assertNoSecrets({ output: "Bearer abcdefghijklmnop" })).toThrow(
      /Secret scan rejected/,
    );
  });

  it("builds Git checkpoint commands as explicit argv entries", () => {
    const commands = buildGitCheckpointCommands({
      repositoryPath: "/repo with spaces",
      bundlePath: "/tmp/handoff bundle.gitbundle",
      refs: ["branch; touch /tmp/nope"],
      dirty: true,
      commitDirty: true,
      commitMessage: "checkpoint; echo nope",
    });

    expect(commands.every((command) => command.command === "git")).toBe(true);
    expect(commands[0]?.args).toEqual([
      "config",
      "--local",
      "--no-includes",
      "--name-only",
      "--null",
      "--list",
    ]);
    const commit = commands.find((command) => command.args.includes("commit"));
    expect(commit?.args.slice(commit.args.indexOf("commit"))).toEqual([
      "commit", "-m", "checkpoint; echo nope",
    ]);
    expect(commit?.args).toContain("core.hooksPath=/dev/null");
    expect(commit?.args).toContain("core.fsmonitor=false");
    expect(commit?.args).toContain("core.attributesFile=/dev/null");
    expect(commands.find((command) => command.args.includes("bundle"))?.args).toContain(
      "branch; touch /tmp/nope",
    );
  });

  it.each([
    {
      label: "secret-bearing filename",
      trackedPath: ".env",
      content: "APP_MODE=development\n",
      expected: /secret scan rejected filename.*\.env/i,
    },
    {
      label: "secret token content",
      trackedPath: "config.txt",
      content: "Bearer mF_9.B5f-4.1JqM8vX2zL0pR7tN6\n",
      expected: /secret scan rejected content.*config\.txt.*bearer-token/i,
    },
    {
      label: "structured secret content",
      trackedPath: "config.json",
      content: JSON.stringify({ apiKey: "ordinary-but-private-value" }),
      expected: /secret scan rejected content.*config\.json.*sensitive-field/i,
    },
  ])("rejects $label before creating a checkpoint bundle", async ({
    trackedPath,
    content,
    expected,
  }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-secret-scan-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "README.md"), "base\n");
    await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "base"],
      { cwd: repositoryPath },
    );
    await writeFile(path.join(repositoryPath, trackedPath), content);

    await expect(createGitCheckpoint({
      repositoryPath,
      bundlePath,
      commitDirty: true,
    })).rejects.toThrow(expected);
    await expect(access(bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a secret blob deleted from HEAD but still reachable in bundled history", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-history-secret-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    const secret = "Bearer h8Q_4vM2.zR7pN5xL9tC3kW6s";
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "temporary-config.txt"), `${secret}\n`);
    await execFile("git", ["add", "temporary-config.txt"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "add temporary config"],
      { cwd: repositoryPath },
    );
    await execFile("git", ["rm", "temporary-config.txt"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "README.md"), "secret removed from tip\n");
    await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "remove temporary config"],
      { cwd: repositoryPath },
    );
    await expect(access(path.join(repositoryPath, "temporary-config.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const error = await createGitCheckpoint({ repositoryPath, bundlePath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(
      /secret scan rejected content.*temporary-config\.txt.*bearer-token/i,
    );
    expect(String(error)).not.toContain(secret);
    await expect(access(bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("scans committed object bytes instead of a concurrently changed worktree file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-immutable-scan-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    const trackedPath = path.join(repositoryPath, "config.txt");
    const secret = "Bearer Q7x_2pL9.vN4mK8sR5tW1zC6b";
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(trackedPath, `${secret}\n`);
    await execFile("git", ["add", "config.txt"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "base"],
      { cwd: repositoryPath },
    );
    let replacedWorktree = false;

    const error = await createGitCheckpoint({
      repositoryPath,
      bundlePath,
      runner: async (_command, args, options) => {
        const result = await execFile("/usr/bin/git", [...args], {
          cwd: options.cwd,
          env: options.env,
        });
        if (!replacedWorktree && args.includes("status")) {
          replacedWorktree = true;
          await writeFile(trackedPath, "safe worktree replacement\n");
        }
        return {
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
          exitCode: 0,
        };
      },
    }).catch((caught: unknown) => caught);

    expect(replacedWorktree).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/secret scan rejected content.*config\.txt/i);
    expect(String(error)).not.toContain(secret);
    await expect(access(bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["binary", "symlink"])(
    "rejects an unsafe %s tree blob before creating a bundle",
    async (kind) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-unsafe-blob-"));
      const repositoryPath = path.join(directory, "repo");
      const bundlePath = path.join(directory, "checkpoint.bundle");
      await mkdir(repositoryPath);
      await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
      await writeFile(path.join(repositoryPath, "README.md"), "base\n");
      if (kind === "binary") {
        await writeFile(
          path.join(repositoryPath, "artifact.bin"),
          Buffer.from([0x00, 0x01, 0x02, 0xff]),
        );
      } else {
        await execFile("ln", ["-s", "README.md", path.join(repositoryPath, "linked-readme")]);
      }
      await execFile("git", ["add", "--all"], { cwd: repositoryPath });
      await execFile(
        "git",
        ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "base"],
        { cwd: repositoryPath },
      );

      await expect(createGitCheckpoint({ repositoryPath, bundlePath })).rejects.toThrow(
        kind === "binary" ? /unsafe binary blob.*artifact\.bin/i : /non-regular blob.*linked-readme/i,
      );
      await expect(access(bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("allows a non-secret environment template filename", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-env-template-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, ".env.example"), "API_KEY=\n");
    await execFile("git", ["add", ".env.example"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "base"],
      { cwd: repositoryPath },
    );

    await expect(createGitCheckpoint({ repositoryPath, bundlePath })).resolves.toMatchObject({
      bundle: { path: bundlePath },
    });
  });

  it("scans duplicate reachable blob content once per immutable object ID", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-deduped-scan-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "one.txt"), "shared safe content\n");
    await writeFile(path.join(repositoryPath, "two.txt"), "shared safe content\n");
    await execFile("git", ["add", "one.txt", "two.txt"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "base"],
      { cwd: repositoryPath },
    );
    let blobContentReads = 0;

    await expect(createGitCheckpoint({
      repositoryPath,
      bundlePath,
      runner: async (_command, args, options) => {
        const catFileIndex = args.indexOf("cat-file");
        if (catFileIndex >= 0 && args[catFileIndex + 1] === "blob") blobContentReads += 1;
        const result = await execFile("/usr/bin/git", [...args], {
          cwd: options.cwd,
          env: options.env,
        });
        return {
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
          exitCode: 0,
        };
      },
    })).resolves.toMatchObject({ bundle: { path: bundlePath } });
    expect(blobContentReads).toBe(1);
  });

  it("refuses to bundle a branch other than the scanned checkpoint commit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-branch-fence-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "README.md"), "main\n");
    await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "main"],
      { cwd: repositoryPath },
    );
    await execFile("git", ["branch", "other"], { cwd: repositoryPath });
    await execFile("git", ["checkout", "other"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "README.md"), "other\n");
    await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "other"],
      { cwd: repositoryPath },
    );
    await execFile("git", ["checkout", "main"], { cwd: repositoryPath });

    await expect(createGitCheckpoint({
      repositoryPath,
      bundlePath,
      branch: "other",
    })).rejects.toThrow(/branch does not reference the scanned immutable commit/i);
    await expect(access(bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a branch that moves after scanning but before bundle creation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-ref-race-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    const secret = "Bearer r7V_2nK9.xQ4mL8sT5pW1cZ6b";
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "README.md"), "safe checkpoint\n");
    await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "safe"],
      { cwd: repositoryPath },
    );
    let movedRef = false;

    const error = await createGitCheckpoint({
      repositoryPath,
      bundlePath,
      runner: async (_command, args, options) => {
        const result = await execFile("/usr/bin/git", [...args], {
          cwd: options.cwd,
          env: options.env,
        });
        if (
          !movedRef
          && args.includes("rev-parse")
          && args.some((argument) => argument.endsWith("^{commit}"))
        ) {
          movedRef = true;
          await writeFile(path.join(repositoryPath, "late-secret.txt"), `${secret}\n`);
          await execFile("git", ["add", "late-secret.txt"], { cwd: repositoryPath });
          await execFile(
            "git",
            ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "move ref after scan"],
            { cwd: repositoryPath },
          );
        }
        return {
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
          exitCode: 0,
        };
      },
    }).catch((caught: unknown) => caught);

    expect(movedRef).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/bundle branch does not reference the scanned immutable commit/i);
    expect(String(error)).not.toContain(secret);
    await expect(access(bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disables default hooks and strips inherited secrets from every checkpoint Git process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-safe-process-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "checkpoint.bundle");
    const hookMarker = path.join(directory, "hook-ran");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "README.md"), "base\n");
    await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "base"],
      { cwd: repositoryPath },
    );
    const hookPath = path.join(repositoryPath, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`);
    await chmod(hookPath, 0o755);
    await writeFile(path.join(repositoryPath, "README.md"), "changed\n");
    const environments: NodeJS.ProcessEnv[] = [];

    const checkpoint = await createGitCheckpoint({
      repositoryPath,
      bundlePath,
      commitDirty: true,
      runner: async (_command, args, options) => {
        environments.push(options.env);
        const result = await execFile("/usr/bin/git", [...args], {
          cwd: options.cwd,
          env: options.env,
        });
        return {
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
          exitCode: 0,
        };
      },
    });

    expect(checkpoint.dirtyBeforeCheckpoint).toBe(true);
    await expect(access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(environments.length).toBeGreaterThan(0);
    expect(environments.every((environment) =>
      environment.OPENAI_API_KEY === undefined
      && environment.CODEX_API_KEY === undefined
      && environment.DEX_HANDOFF_SIGNING_KEY === undefined
      && environment.SSH_AUTH_SOCK === undefined
      && environment.HOME === undefined
      && environment.GIT_CONFIG_GLOBAL === "/dev/null"
      && environment.GIT_CONFIG_NOSYSTEM === "1"
      && (
        environment.GIT_CONFIG === "/dev/null"
        || environment.GIT_CONFIG === undefined
      )
    )).toBe(true);
    expect(environments.some((environment) => environment.GIT_CONFIG === "/dev/null")).toBe(true);
    expect(environments.some((environment) => environment.GIT_CONFIG === undefined)).toBe(true);
  });

  it("rejects local fsmonitor, include, and filter helpers before staging dirty source", async () => {
    const unsafeKeys = [
      ["core.fsmonitor", "./steal-source"],
      ["include.path", "../attacker.gitconfig"],
      ["filter.exfil.clean", "./steal-source"],
    ] as const;
    for (const [key, value] of unsafeKeys) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-unsafe-config-"));
      const repositoryPath = path.join(directory, "repo");
      const marker = path.join(directory, "helper-ran");
      await mkdir(repositoryPath);
      await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
      await writeFile(path.join(repositoryPath, "README.md"), "base\n");
      await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
      await execFile(
        "git",
        ["-c", "user.name=Dex Test", "-c", "user.email=dex@example.test", "commit", "-m", "base"],
        { cwd: repositoryPath },
      );
      const helper = path.join(repositoryPath, "steal-source");
      await writeFile(helper, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ncat\n`);
      await chmod(helper, 0o755);
      await execFile("git", ["config", "--local", key, value], { cwd: repositoryPath });
      if (key.startsWith("filter.")) {
        await writeFile(path.join(repositoryPath, ".gitattributes"), "README.md filter=exfil\n");
      }
      await writeFile(path.join(repositoryPath, "README.md"), "dirty source\n");

      await expect(createGitCheckpoint({
        repositoryPath,
        bundlePath: path.join(directory, "checkpoint.bundle"),
        commitDirty: true,
      })).rejects.toThrow(/unsafe for checkpointing/i);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("lists repository instructions through the hardened Git boundary", async () => {
    const runner = vi.fn(async (
      _command: string,
      args: readonly string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => {
      if (args[0] === "config") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      expect(args).toContain("core.fsmonitor=false");
      expect(args).toContain("core.hooksPath=/dev/null");
      expect(args).toContain("ls-files");
      expect(options.env).toMatchObject({
        GIT_CONFIG: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      });
      return {
        stdout: "AGENTS.md\0src/AGENTS.md\0",
        stderr: "",
        exitCode: 0,
      };
    });

    await expect(listTrackedFiles({
      repositoryPath: "/approved/repository",
      pathspecs: ["AGENTS.md", ":(glob)**/AGENTS.md"],
      runner,
    })).resolves.toEqual(["AGENTS.md", "src/AGENTS.md"]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("reads repository instructions from the immutable checkpoint instead of the mutable worktree", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-instructions-revision-"));
    const repositoryPath = path.join(directory, "repo");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "AGENTS.md"), "checkpoint instructions\n");
    await mkdir(path.join(repositoryPath, "src"));
    await writeFile(
      path.join(repositoryPath, "src", "AGENTS.md"),
      "checkpoint scoped instructions\n",
    );
    await execFile("git", ["add", "AGENTS.md", "src/AGENTS.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Dex Test",
        "-c",
        "user.email=dex@example.test",
        "commit",
        "-m",
        "checkpoint instructions",
      ],
      { cwd: repositoryPath },
    );
    const { stdout: revisionOutput } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: repositoryPath,
    });
    const revision = revisionOutput.trim();

    await writeFile(path.join(repositoryPath, "AGENTS.md"), "later worktree mutation\n");
    await writeFile(path.join(repositoryPath, "src", "AGENTS.md"), "later scoped mutation\n");
    await mkdir(path.join(repositoryPath, "other"));
    await writeFile(path.join(repositoryPath, "other", "AGENTS.md"), "untracked instructions\n");

    await expect(readTrackedTextFilesAtRevision({
      repositoryPath,
      revision,
      pathspecs: ["AGENTS.md"],
      maxFiles: 8,
      maxFileBytes: 4_096,
      maxTotalBytes: 8_192,
    })).resolves.toEqual([
      {
        path: "AGENTS.md",
        content: "checkpoint instructions",
        bytes: Buffer.byteLength("checkpoint instructions\n"),
      },
      {
        path: "src/AGENTS.md",
        content: "checkpoint scoped instructions",
        bytes: Buffer.byteLength("checkpoint scoped instructions\n"),
      },
    ]);
  });

  it("rejects non-regular repository instruction blobs at the checkpoint", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-instructions-symlink-"));
    const repositoryPath = path.join(directory, "repo");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await execFile("ln", ["-s", "README.md", path.join(repositoryPath, "AGENTS.md")]);
    await writeFile(path.join(repositoryPath, "README.md"), "not instructions\n");
    await execFile("git", ["add", "AGENTS.md", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Dex Test",
        "-c",
        "user.email=dex@example.test",
        "commit",
        "-m",
        "symlink instructions",
      ],
      { cwd: repositoryPath },
    );
    const { stdout: revisionOutput } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: repositoryPath,
    });

    await expect(readTrackedTextFilesAtRevision({
      repositoryPath,
      revision: revisionOutput.trim(),
      pathspecs: ["AGENTS.md"],
      maxFiles: 8,
      maxFileBytes: 4_096,
      maxTotalBytes: 8_192,
    })).rejects.toThrow("regular tracked text blobs");
  });

  it("creates and verifies a reconstructable Git bundle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-git-checkpoint-"));
    const repositoryPath = path.join(directory, "repo");
    const bundlePath = path.join(directory, "artifacts", "checkpoint.bundle");
    await mkdir(repositoryPath);
    await execFile("git", ["init", "-b", "main"], { cwd: repositoryPath });
    await writeFile(path.join(repositoryPath, "README.md"), "checkpoint\n");
    await execFile("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Dex Test",
        "-c",
        "user.email=dex@example.test",
        "commit",
        "-m",
        "initial",
      ],
      { cwd: repositoryPath },
    );

    const checkpoint = await createGitCheckpoint({ repositoryPath, bundlePath });

    expect(checkpoint).toMatchObject({
      branch: "main",
      dirtyBeforeCheckpoint: false,
      bundle: { path: bundlePath, refs: ["main"] },
    });
    expect(checkpoint.headCommit).toBe(checkpoint.baseCommit);
    expect(checkpoint.bundle.bytes).toBeGreaterThan(0);
    expect(checkpoint.bundle.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("handoff package", () => {
  it("uses concrete worker discoveries to retrieve the task-specific Claude-Mem failure", async () => {
    const observations = Array.from({ length: 5 }, (_, index): MemoryObservation => ({
      id: index === 0 ? 6044 : 6100 + index,
      source: "claude-mem",
      type: index === 0 ? "discovery" : "bugfix",
      title: index === 0
        ? "Webhook event ordering cannot be assumed for idempotency handling"
        : `Checkout context ${index}`,
      narrative: index === 0
        ? "The prior checkout worker recorded a dangerous ordering assumption."
        : `Relevant invoice webhook context ${index}`,
      facts: index === 0
        ? ["Performing the external charge before the idempotency lookup risks duplicate charges on duplicate delivery"]
        : [`invoice.paid checkout fact ${index}`],
      concepts: ["checkout", "invoice.paid", "idempotency"],
      filesRead: [],
      filesModified: [],
    }));
    const client: MemoryClient = {
      recordObservation: vi.fn(async () => ({ status: "queued" as const })),
      summarizeSession: vi.fn(async () => ({ status: "queued" as const })),
      search: vi.fn(async () => ({
        content: [{ type: "text", text: observations.map((item) => `#${item.id}`).join(" ") }],
      })),
      timeline: vi.fn(async () => ({ content: [] })),
      getObservations: vi.fn(async () => observations),
    };

    const handoff = await createHandoff({
      taskId: "checkout-specific-memory",
      goal: "fix checkout",
      repository: { baseCommit: "abc123", workingBranch: "dex/checkout" },
      taskKnowledge: {
        learnedFacts: [
          "An early invoice.paid event currently throws; preserve idempotency before external charges.",
        ],
      },
    }, { memoryClient: client });

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining("invoice.paid"),
    }));
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining("idempotency"),
    }));
    expect(handoff.memories).toContainEqual(expect.objectContaining({ id: 6044 }));
    expect(handoff.failedApproaches).toContainEqual({
      approach: "Performing the external charge before the idempotency lookup",
      reason: "risks duplicate charges on duplicate delivery",
      doNotRepeat: true,
      sourceMemoryId: 6044,
    });
  });

  it("materializes an explicit failed approach even when Claude-Mem classifies it as a discovery", async () => {
    const memories = Array.from({ length: 5 }, (_, index): MemoryObservation => ({
      id: 6000 + index,
      source: "claude-mem",
      type: "discovery",
      title: index === 0 ? "Webhook ordering constraint" : `Checkout context ${index}`,
      narrative: `Durable checkout observation ${index}`,
      facts: index === 0
        ? ["Performing the external charge before the idempotency lookup risks duplicate charges on duplicate delivery"]
        : index === 1
          ? ["The checkout flow had a race condition which caused failed webhook processing and inconsistent state"]
          : [`Checkout fact ${index}`],
      concepts: ["checkout"],
      filesRead: [],
      filesModified: [],
    }));

    const handoff = await createHandoff({
      taskId: "checkout-memory-classification",
      goal: "Fix checkout webhook ordering",
      repository: { baseCommit: "abc123", workingBranch: "dex/checkout-memory" },
      memories,
    }, { discoverMemory: false });

    expect(handoff.failedApproaches).toContainEqual({
      approach: "Performing the external charge before the idempotency lookup",
      reason: "risks duplicate charges on duplicate delivery",
      doNotRepeat: true,
      sourceMemoryId: 6000,
    });
    expect(handoff.failedApproaches).toHaveLength(1);
  });

  it("creates, signs, writes, and verifies a memory-complete package", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-handoff-"));
    const file = path.join(directory, "handoff.json");
    const signingKey = "test-only-signing-key";
    const handoff = await createHandoff(
      {
        taskId: "checkout-1",
        goal: "Fix checkout completion delivery",
        constraints: ["Polling must be deterministic."],
        acceptanceCriteria: ["Exactly one terminal message is delivered."],
        repository: {
          url: "git@example.test:dex.git",
          path: "/repo/dex",
          baseCommit: "abc123",
          workingBranch: "dex/checkout",
        },
        validation: {
          commands: [["npm", "test"], "npm run typecheck"],
          expectedEvidence: ["All tests pass."],
        },
        taskKnowledge: {
          learnedFacts: ["The outbox is at-least-once."],
          failedApproaches: [
            {
              approach: "Send directly from the monitor",
              reason: "Retries can duplicate the message.",
              failed: true,
            },
          ],
        },
        metadata: { API_TOKEN: "must-not-leak" },
        createdAt: "2026-08-23T12:00:00.000Z",
      },
      { discoverMemory: false, signingKey, signingKeyId: "test-key" },
    );

    expect(handoff.memories.length).toBeGreaterThanOrEqual(5);
    expect(handoff.memories.length).toBeLessThanOrEqual(15);
    expect(handoff.failedApproaches).toEqual([
      expect.objectContaining({
        approach: "Send directly from the monitor",
        reason: "Retries can duplicate the message.",
        doNotRepeat: true,
      }),
    ]);
    expect(handoff.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(handoff.integrity.signature).toMatchObject({
      algorithm: "hmac-sha256",
      keyId: "test-key",
    });
    expect(JSON.stringify(handoff)).not.toContain("must-not-leak");
    await expect(verifyHandoff(handoff, signingKey)).resolves.toBe(true);

    await writeHandoff(file, handoff);
    await expect(readHandoff(file, signingKey)).resolves.toEqual(handoff);
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);

    const tampered = { ...handoff, goal: "tampered" };
    await expect(verifyHandoff(tampered, signingKey)).resolves.toBe(false);
  });
});
