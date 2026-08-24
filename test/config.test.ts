import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  modalCodexAuthVolumeForDevice,
} from "../src/config/config.js";
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

  it("derives stable, distinct, safe Modal auth Volume names without exposing device IDs", () => {
    const first = modalCodexAuthVolumeForDevice("mac:owner@example.test:Shahdad's MacBook Pro");
    const repeated = modalCodexAuthVolumeForDevice("mac:owner@example.test:Shahdad's MacBook Pro");
    const second = modalCodexAuthVolumeForDevice("mac:owner@example.test:Home Mac Mini");

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^dex-codex-auth-[a-f0-9]{20}$/);
    expect(first).not.toContain("owner");
    expect(first.length).toBeLessThanOrEqual(63);
  });

  it("fails paired legacy configs closed until setup migrates and exports the exact device Volume", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dex-config-paired-"));
    directories.push(directory);
    vi.stubEnv("DEX_MODAL_CODEX_AUTH_VOLUME", "");
    const paths = resolveDexPaths(directory);
    await writeFile(paths.config, JSON.stringify({ version: 1, deviceId: "device-legacy" }), "utf8");

    await expect(loadConfig(paths)).rejects.toThrow("run dex setup to migrate");
    const migrated = await loadConfig(paths, { allowLegacyPairedModalAuthVolume: true });
    const expected = modalCodexAuthVolumeForDevice("device-legacy");
    expect(migrated.modalCodexAuthVolume).toBe(expected);
    expect(process.env.DEX_MODAL_CODEX_AUTH_VOLUME).toBe(expected);

    await writeFile(paths.config, JSON.stringify({
      version: 1,
      deviceId: "device-legacy",
      modalCodexAuthVolume: expected,
    }), "utf8");
    await expect(loadConfig(paths)).resolves.toMatchObject({ modalCodexAuthVolume: expected });
  });
});
