import { describe, expect, it, vi } from "vitest";
import type { DiscoveredSession } from "../src/agents/session-discovery.js";
import { GeminiRouter, normalizeGeminiActions } from "../src/dex/gemini.js";
import { MessageRouter } from "../src/dex/router.js";

describe("MessageRouter", () => {
  const router = new MessageRouter({ gemini: new GeminiRouter({ apiKey: "" }) });

  it("routes exact status without a model", async () => {
    await expect(router.route("status?")).resolves.toEqual({
      actions: [{ type: "STATUS" }],
      source: "deterministic",
    });
  });

  it("lists recent sessions without turning the request into a task", async () => {
    await expect(router.route("what sessions do I have?")).resolves.toEqual({
      actions: [{ type: "LIST_SESSIONS" }],
      source: "deterministic",
    });
    await expect(router.route("show my recent Claude sessions")).resolves.toEqual({
      actions: [{ type: "LIST_SESSIONS", provider: "claude" }],
      source: "deterministic",
    });
  });

  it("resolves a discovered session before emitting an adoption request", async () => {
    const sessions: DiscoveredSession[] = [
      {
        provider: "claude",
        sessionId: "claude-auth-new",
        cwd: "/repo/auth",
        updatedAt: "2026-08-23T13:00:00.000Z",
        summary: "New auth work",
        active: false,
        sourcePath: "/transcripts/new.jsonl",
      },
      {
        provider: "claude",
        sessionId: "claude-auth-old",
        cwd: "/repo/auth",
        updatedAt: "2026-08-20T13:00:00.000Z",
        summary: "Old auth work",
        active: false,
        sourcePath: "/transcripts/old.jsonl",
      },
    ];
    const sessionDiscovery = vi.fn(async () => sessions);
    const adoptionRouter = new MessageRouter({
      gemini: new GeminiRouter({ apiKey: "" }),
      sessionDiscovery,
    });

    await expect(adoptionRouter.route("continue that old auth session with claude")).resolves.toEqual({
      actions: [{
        type: "ADOPT_SESSION",
        provider: "claude",
        sessionId: "claude-auth-old",
        cwd: "/repo/auth",
        updatedAt: "2026-08-20T13:00:00.000Z",
        summary: "Old auth work",
        active: false,
      }],
      source: "deterministic",
    });
    expect(sessionDiscovery).toHaveBeenCalledWith("claude");
  });

  it("validates an explicit provider/session ID against discovery", async () => {
    const sessionDiscovery = vi.fn(async () => [{
      provider: "codex" as const,
      sessionId: "codex-thread-9",
      cwd: "/repo/checkout",
      updatedAt: "2026-08-23T13:00:00.000Z",
      active: false,
      sourcePath: "/transcripts/codex.jsonl",
    }]);
    const adoptionRouter = new MessageRouter({
      gemini: new GeminiRouter({ apiKey: "" }),
      sessionDiscovery,
    });

    const result = await adoptionRouter.route("continue codex session codex-thread-9");
    expect(result.actions).toEqual([expect.objectContaining({
      type: "ADOPT_SESSION",
      provider: "codex",
      sessionId: "codex-thread-9",
    })]);
  });

  it("preserves exact Dex task continuation routing", async () => {
    await expect(router.route("continue checkout")).resolves.toEqual({
      actions: [{ type: "RESUME_TASK", taskQuery: "checkout" }],
      source: "deterministic",
    });
  });

  it("recognizes memory questions with a typographic apostrophe", async () => {
    await expect(router.route("didn’t we hit this webhook issue before?")).resolves.toEqual({
      actions: [{ type: "MEMORY_QUERY", query: "didn't we hit this webhook issue before?" }],
      source: "deterministic",
    });
  });

  it("creates multiple independent tasks", async () => {
    const result = await router.route("fix signup, investigate checkout, add dark mode");
    expect(result.actions).toHaveLength(3);
    expect(result.actions.every((action) => action.type === "CREATE_TASK")).toBe(true);
  });

  it("preserves per-task agent choices in one text", async () => {
    const result = await router.route("fix auth with codex and have claude investigate checkout");
    expect(result.actions).toEqual([
      expect.objectContaining({ type: "CREATE_TASK", preferredAgent: "codex", description: "fix auth" }),
      expect.objectContaining({ type: "CREATE_TASK", preferredAgent: "claude", description: "investigate checkout" }),
    ]);
  });

  it("does not let Gemini reinterpret explicit agent assignments", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify([
        { type: "CREATE_TASK", description: "wrong model task" },
      ]) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const explicitRouter = new MessageRouter({ gemini: new GeminiRouter({ apiKey: "secret-key", fetchImpl }) });

    await expect(explicitRouter.route("have claude investigate checkout")).resolves.toEqual({
      actions: [{ type: "CREATE_TASK", description: "investigate checkout", preferredAgent: "claude" }],
      source: "deterministic",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("changes the worker without creating a duplicate task", async () => {
    await expect(router.route("use claude for checkout")).resolves.toEqual({
      actions: [{ type: "CHANGE_AGENT", taskQuery: "checkout", agent: "claude" }],
      source: "deterministic",
    });
  });

  it("routes cloud movement and sleep as typed actions", async () => {
    const result = await router.route("move auth to the cloud and use codex, then sleep my mac when everything is done");
    expect(result.actions).toContainEqual({
      type: "MOVE_TASK",
      taskQuery: "auth",
      destination: "cloud",
      preferredAgent: "codex",
    });
    expect(result.actions).toContainEqual({ type: "SLEEP", when: "tasks_complete" });
  });

  it("sleeps after a cloud handoff unless the user explicitly says when done", async () => {
    const result = await router.route("move checkout to the cloud and use codex, then sleep my mac");
    expect(result.actions).toContainEqual({ type: "SLEEP", when: "now" });
  });
});

describe("GeminiRouter", () => {
  it("uses a secret header, structured schema, and the requested thinking tier", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify([
          { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
        ]) }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const router = new GeminiRouter({ apiKey: "secret-key", fetchImpl });

    await expect(router.route("fix auth", "brain")).resolves.toEqual([
      { type: "CREATE_TASK", description: "fix auth", preferredAgent: "codex" },
    ]);
    expect(requests[0]?.url).toContain("gemini-3.7-flash:generateContent");
    expect(requests[0]?.url).not.toContain("secret-key");
    expect(new Headers(requests[0]?.init?.headers).get("x-goog-api-key")).toBe("secret-key");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "low" },
      },
    });
    expect((body.generationConfig as Record<string, unknown>).responseJsonSchema).toBeTruthy();
  });

  it("keeps Fast Lane on Flash-Lite with minimal thinking", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), ...(init ? { init } : {}) };
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify([
          { type: "CREATE_TASK", description: "fix auth" },
        ]) }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await new GeminiRouter({ apiKey: "secret-key", fetchImpl }).route("fix auth", "fast");
    expect(request?.url).toContain("gemini-3.5-flash-lite:generateContent");
    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
  });

  it("normalizes harmless provider aliases before strict DexAction validation", () => {
    expect(normalizeGeminiActions([
      { type: "create_task", description: "investigate checkout", agent: "claude" },
    ])).toEqual([
      {
        type: "CREATE_TASK",
        description: "investigate checkout",
        agent: "claude",
        preferredAgent: "claude",
      },
    ]);
  });
});
