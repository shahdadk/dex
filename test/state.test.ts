import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/state/events.js";
import { DexStateStore } from "../src/state/store.js";

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
});
