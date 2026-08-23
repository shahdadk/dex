import { describe, expect, it, vi } from "vitest";
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
