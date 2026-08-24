import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("falls back to global retrieval when a derived project label has no observations", async () => {
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
    })).resolves.toEqual(memories);
    expect(client.search).toHaveBeenNthCalledWith(1, expect.objectContaining({
      project: "worktree-derived-name",
    }));
    expect(client.search).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ project: expect.anything() }));
    expect(client.timeline).toHaveBeenCalledOnce();
    expect(client.timeline).toHaveBeenCalledWith(expect.objectContaining({ anchor: 100 }));
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
    expect(commands.find((command) => command.args[0] === "commit")?.args).toEqual([
      "commit",
      "-m",
      "checkpoint; echo nope",
    ]);
    expect(commands.find((command) => command.args[0] === "bundle")?.args).toContain(
      "branch; touch /tmp/nope",
    );
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
