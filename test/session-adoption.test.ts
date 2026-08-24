import { describe, expect, it } from "vitest";
import {
  parseSessionAdoptionIntent,
  resolveSessionAdoption,
  SessionAdoptionRequestSchema,
} from "../src/agents/session-adoption.js";
import type { DiscoveredSession } from "../src/agents/session-discovery.js";

describe("discovered session adoption", () => {
  it("parses fuzzy and explicit provider/session selectors without shell semantics", () => {
    expect(parseSessionAdoptionIntent("continue that old auth session with claude")).toEqual({
      provider: "claude",
      query: "auth",
      recency: "oldest",
    });
    expect(parseSessionAdoptionIntent("continue codex session codex-thread-9")).toEqual({
      provider: "codex",
      sessionId: "codex-thread-9",
    });
    expect(parseSessionAdoptionIntent("continue auth")).toBeUndefined();
  });

  it("resolves normalized discovery records to a concrete adoption request", () => {
    const request = resolveSessionAdoption([
      discovered({ sessionId: "claude-auth-new", updatedAt: "2026-08-23T13:00:00.000Z" }),
      discovered({ sessionId: "claude-auth-old", updatedAt: "2026-08-20T13:00:00.000Z" }),
      discovered({ provider: "codex", sessionId: "codex-auth", updatedAt: "2026-08-19T13:00:00.000Z" }),
    ], {
      provider: "claude",
      query: "auth",
      recency: "oldest",
    });

    expect(request).toEqual({
      type: "ADOPT_SESSION",
      provider: "claude",
      sessionId: "claude-auth-old",
      cwd: "/repo/auth",
      updatedAt: "2026-08-20T13:00:00.000Z",
      summary: "Auth callback investigation",
      active: false,
    });
    expect(request).not.toHaveProperty("sourcePath");
  });

  it("requires disambiguation instead of adopting an arbitrary transcript", () => {
    expect(() => resolveSessionAdoption([
      discovered({ sessionId: "claude-auth-one" }),
      discovered({ sessionId: "claude-auth-two", updatedAt: "2026-08-22T13:00:00.000Z" }),
    ], { provider: "claude", query: "auth" })).toThrow(/multiple discovered sessions/i);
  });

  it("rejects TTY paths, shell-like IDs, and extra executable fields", () => {
    const base = {
      type: "ADOPT_SESSION",
      provider: "codex",
      sessionId: "codex-thread-9",
      cwd: "/repo/auth",
      updatedAt: "2026-08-23T13:00:00.000Z",
      active: false,
    } as const;

    expect(SessionAdoptionRequestSchema.safeParse({
      type: "ADOPT_SESSION",
      provider: "codex",
      sessionId: "codex-thread-9",
    }).success).toBe(true);
    expect(SessionAdoptionRequestSchema.safeParse({ ...base, sessionId: "thread;bash" }).success).toBe(false);
    expect(SessionAdoptionRequestSchema.safeParse({ ...base, cwd: "../../dev/tty" }).success).toBe(false);
    expect(SessionAdoptionRequestSchema.safeParse({ ...base, cwd: "/dev/ttys001" }).success).toBe(false);
    expect(SessionAdoptionRequestSchema.safeParse({ ...base, command: "screen -r 123" }).success).toBe(false);
    expect(SessionAdoptionRequestSchema.safeParse({ ...base, tty: "/dev/ttys001" }).success).toBe(false);
  });
});

function discovered(overrides: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    provider: "claude",
    sessionId: "claude-auth",
    cwd: "/repo/auth",
    updatedAt: "2026-08-21T13:00:00.000Z",
    summary: "Auth callback investigation",
    active: false,
    sourcePath: "/normalized/transcript.jsonl",
    ...overrides,
  };
}
