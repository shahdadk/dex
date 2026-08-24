import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverClaudeSessions,
  discoverCodexSessions,
  discoverSessions,
  findDiscoveredSessions,
} from "../src/agents/session-discovery.js";

describe("historical agent session discovery", () => {
  it("normalizes recent Claude transcripts and ignores subagent files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dex-claude-sessions-"));
    const project = path.join(root, "-tmp-project");
    await mkdir(path.join(project, "subagents"), { recursive: true });
    await writeFile(path.join(project, "session-1.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "claude-session", cwd: "/tmp/project", timestamp: "2026-08-23T12:00:00.000Z", message: { content: [{ type: "text", text: "Investigate the checkout race" }] } }),
      JSON.stringify({ type: "ai-title", sessionId: "claude-session", aiTitle: "Checkout race investigation" }),
      JSON.stringify({ type: "assistant", sessionId: "claude-session", cwd: "/tmp/project", timestamp: "2026-08-23T12:01:00.000Z", message: { content: [{ type: "text", text: "Found the ordering issue" }] } }),
    ].join("\n"));
    await writeFile(path.join(project, "subagents", "agent-hidden.jsonl"), JSON.stringify({ type: "user", sessionId: "hidden" }));

    await expect(discoverClaudeSessions({ claudeRoot: root, now: () => Date.parse("2026-08-23T12:02:00.000Z") })).resolves.toEqual([
      expect.objectContaining({
        provider: "claude",
        sessionId: "claude-session",
        cwd: "/tmp/project",
        updatedAt: "2026-08-23T12:01:00.000Z",
        summary: "Checkout race investigation",
        active: true,
      }),
    ]);
  });

  it("normalizes Codex rollout metadata and redacts summaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dex-codex-sessions-"));
    const day = path.join(root, "2026", "08", "23");
    await mkdir(day, { recursive: true });
    await writeFile(path.join(day, "rollout-2026-08-23T12-00-00-thread-fallback.jsonl"), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-23T12:00:00.000Z", payload: { id: "codex-thread", cwd: "/tmp/repo" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-23T12:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix auth with API_KEY=super-secret-value" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-23T12:01:00.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Implemented it" }] } }),
    ].join("\n"));

    const sessions = await discoverCodexSessions({ codexRoot: root, now: () => Date.parse("2026-08-23T13:00:00.000Z") });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ provider: "codex", sessionId: "codex-thread", cwd: "/tmp/repo", updatedAt: "2026-08-23T12:01:00.000Z", active: false });
    expect(sessions[0]?.summary).toContain("[REDACTED_ENV]");
    expect(sessions[0]?.summary).not.toContain("super-secret-value");
  });

  it("combines, sorts, limits, and fuzzily resolves sessions", async () => {
    const claudeRoot = await mkdtemp(path.join(os.tmpdir(), "dex-claude-combined-"));
    const codexRoot = await mkdtemp(path.join(os.tmpdir(), "dex-codex-combined-"));
    await writeFile(path.join(claudeRoot, "claude.jsonl"), JSON.stringify({ type: "user", sessionId: "claude-auth", cwd: "/repo/auth", timestamp: "2026-08-23T12:00:00.000Z", message: { content: [{ type: "text", text: "Auth callback" }] } }));
    await writeFile(path.join(codexRoot, "codex.jsonl"), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-23T13:00:00.000Z", payload: { id: "codex-checkout", cwd: "/repo/checkout" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-23T13:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Checkout webhook" }] } }),
    ].join("\n"));

    const sessions = await discoverSessions({ claudeRoot, codexRoot, maxSessions: 2 });
    expect(sessions.map((session) => session.sessionId)).toEqual(["codex-checkout", "claude-auth"]);
    expect(findDiscoveredSessions(sessions, "checkout", "codex").map((session) => session.sessionId)).toEqual(["codex-checkout"]);
    expect(findDiscoveredSessions(sessions, "missing")).toEqual([]);
  });
});
