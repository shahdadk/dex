import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { resolveDexPaths } from "../src/config/paths.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Dex configuration", () => {
  it("accepts the existing Appfi Sendblue line name and prefers the Dex override", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dex-config-"));
    directories.push(directory);
    vi.stubEnv("SENDBLUE_NUMBER", "+14165550100");
    expect((await loadConfig(resolveDexPaths(directory))).sendblueLine).toBe("+14165550100");

    vi.stubEnv("DEX_SENDBLUE_LINE", "+14165550200");
    expect((await loadConfig(resolveDexPaths(directory))).sendblueLine).toBe("+14165550200");
  });
});
