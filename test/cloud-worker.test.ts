import { access, appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateEphemeralCodexHome } from "../src/cloud/cloud-worker.js";
import { createGitBundle, type GitCheckpoint } from "../src/memory/git.js";
import type { MemoryObservation } from "../src/memory/index.js";
import { createManifest, signManifest } from "../src/memory/integrity.js";
import { createHandoff, writeHandoff, type HandoffDocument } from "../src/tasks/handoff.js";
import { execFile } from "../src/utils/exec.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD_WORKER = path.join(REPOSITORY_ROOT, "src", "cloud", "cloud-worker.ts");
const SIGNING_KEY = "cloud-worker-test-signing-key";
const temporaryDirectories: string[] = [];

interface WorkerFixture {
  directory: string;
  cloudRoot: string;
  projectPath: string;
  codexHome: string;
  promptPath: string;
  environmentPath: string;
  argumentsPath: string;
  callsPath: string;
  handoff: HandoffDocument;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function mustExec(command: string, args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFile(command, args, cwd === undefined ? {} : { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function memory(index: number): MemoryObservation {
  if (index === 5) {
    return {
      id: "failed-memory",
      source: "task-knowledge",
      type: "failed-approach",
      title: "Failed approach: poll the provider directly",
      narrative: "Poll the provider directly\nOutcome: provider retries produced duplicate completion messages.",
      facts: ["Provider retries produced duplicate completion messages."],
      concepts: ["failed-approach"],
      filesRead: [],
      filesModified: [],
    };
  }
  return {
    id: `memory-${index}`,
    source: "task-knowledge",
    type: "learned-fact",
    title: `Continuation fact ${index}`,
    narrative: `Durable continuation fact ${index}`,
    facts: [`Durable continuation fact ${index}`],
    concepts: ["continuation"],
    filesRead: [],
    filesModified: [],
  };
}

async function createWorkerFixture(
  validationCommands: string[][] = [],
  prepareRepository?: (context: {
    repositoryPath: string;
    directory: string;
    codexHome: string;
  }) => Promise<void>,
  bypassTrustedCheckpointBoundary = false,
): Promise<WorkerFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-cloud-worker-"));
  temporaryDirectories.push(directory);
  const repositoryPath = path.join(directory, "source");
  const cloudRoot = path.join(directory, "cloud-root");
  const projectPath = path.join(directory, "workspace", "project");
  const bundlePath = path.join(cloudRoot, "repo.bundle");
  const handoffPath = path.join(cloudRoot, "handoff.json");
  const promptPath = path.join(directory, "codex-prompt.txt");
  const environmentPath = path.join(directory, "codex-environment.json");
  const argumentsPath = path.join(directory, "codex-arguments.json");
  const callsPath = path.join(directory, "codex-calls.jsonl");
  const codexHome = path.join(directory, "codex-home");
  await Promise.all([mkdir(repositoryPath), mkdir(cloudRoot), mkdir(path.dirname(projectPath))]);
  await mustExec("git", ["init", "-b", "main"], repositoryPath);
  await mustExec("git", ["config", "user.name", "Dex Test"], repositoryPath);
  await mustExec("git", ["config", "user.email", "dex@example.test"], repositoryPath);
  await writeFile(path.join(repositoryPath, "README.md"), "cloud checkpoint\n", "utf8");
  await mustExec("git", ["add", "README.md"], repositoryPath);
  await mustExec("git", ["commit", "-m", "initial checkpoint"], repositoryPath);
  const baseCommit = await mustExec("git", ["rev-parse", "HEAD"], repositoryPath);
  await mustExec("git", ["checkout", "-b", "dex/cloud-worker"], repositoryPath);
  await prepareRepository?.({ repositoryPath, directory, codexHome });

  let checkpoint: GitCheckpoint | undefined;
  if (bypassTrustedCheckpointBoundary) {
    // These fixtures intentionally exercise the cloud worker against content
    // that the trusted local checkpoint boundary now rejects. Build the test
    // bundle directly so the independent cloud-side defenses remain covered.
    const dirtyBeforeCheckpoint = Boolean(
      await mustExec("git", ["status", "--porcelain=v1", "--untracked-files=all"], repositoryPath),
    );
    if (dirtyBeforeCheckpoint) {
      await mustExec("git", ["add", "--all"], repositoryPath);
      await mustExec("git", ["commit", "-m", "malicious cloud-boundary fixture"], repositoryPath);
    }
    const headCommit = await mustExec("git", ["rev-parse", "HEAD"], repositoryPath);
    checkpoint = {
      baseCommit,
      headCommit,
      branch: "dex/cloud-worker",
      dirtyBeforeCheckpoint,
      bundle: await createGitBundle({
        repositoryPath,
        bundlePath,
        refs: ["dex/cloud-worker"],
      }),
    };
  }

  const handoff = await createHandoff(
    {
      taskId: "task-cloud-worker",
      goal: "Continue the durable cloud task",
      constraints: ["Preserve inherited context."],
      acceptanceCriteria: ["Produce a validated continuation."],
      repository: {
        path: repositoryPath,
        baseCommit,
        workingBranch: "dex/cloud-worker",
        ...(checkpoint === undefined ? {} : { checkpoint }),
      },
      memories: Array.from({ length: 5 }, (_, index) => memory(index + 1)),
      validation: { commands: validationCommands, expectedEvidence: ["Worker completes."] },
      createdAt: "2026-08-23T12:00:00.000Z",
    },
    {
      discoverMemory: false,
      ...(checkpoint === undefined
        ? { gitCheckpoint: { bundlePath, commitDirty: true } }
        : {}),
      signingKey: SIGNING_KEY,
      signingKeyId: "worker-test-key",
    },
  );
  await writeHandoff(handoffPath, handoff);
  return {
    directory,
    cloudRoot,
    projectPath,
    codexHome,
    promptPath,
    environmentPath,
    argumentsPath,
    callsPath,
    handoff,
  };
}

async function installFakeCodex(directory: string): Promise<string> {
  const binaryDirectory = path.join(directory, "bin");
  const binaryPath = path.join(binaryDirectory, "codex");
  const npmPath = path.join(binaryDirectory, "npm");
  const syncPath = path.join(binaryDirectory, "sync");
  await mkdir(binaryDirectory);
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;
const profileIndex = args.indexOf("--profile");
const activeProfile = profileIndex === -1 ? "" : args[profileIndex + 1];
const profilePath = activeProfile && codexHome ? path.join(codexHome, activeProfile + ".config.toml") : "";
const profileText = profilePath && fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : "";
fs.appendFileSync(process.env.FAKE_CODEX_CALLS_PATH, JSON.stringify({
  args,
  cwd: process.cwd(),
  homeEntries: codexHome && fs.existsSync(codexHome) ? fs.readdirSync(codexHome).sort() : [],
  profileText,
  environment: {
    codexHome,
    secretLikeNames: Object.keys(process.env).filter((name) => /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)(?:_|$)/i.test(name)).sort(),
  },
}) + "\\n", "utf8");
const loginIndex = args.indexOf("login");
if (loginIndex !== -1 && args[loginIndex + 1] === "status") {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
if (process.argv[2] === "sandbox") {
  const separator = args.indexOf("--");
  const command = separator === -1 ? [] : args.slice(separator + 1);
  if (command[0] === "sh" && command.includes("dex-modal-boundary-smoke")) {
    process.exit(Number(process.env.FAKE_CODEX_SMOKE_EXIT_CODE || "0"));
  }
  if (command.length === 0) process.exit(65);
  const cwdIndex = args.indexOf("--cd");
  const cwd = cwdIndex === -1 ? process.cwd() : args[cwdIndex + 1];
  const childEnv = { ...process.env };
  const authPath = childEnv.CODEX_HOME && path.join(childEnv.CODEX_HOME, "auth.json");
  for (const name of Object.keys(childEnv)) {
    if (/(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)(?:_|$)/i.test(name) || name === "CODEX_HOME" || name === "DEX_CLOUD_PROJECT" || name === "DEX_CLOUD_ROOT") {
      delete childEnv[name];
    }
  }
  if (authPath && fs.existsSync(authPath)) fs.chmodSync(authPath, 0o000);
  const protectedProject = activeProfile === "modal-bootstrap" ? process.env.DEX_CLOUD_PROJECT : undefined;
  const protectedProjectMode = protectedProject ? fs.statSync(protectedProject).mode & 0o777 : undefined;
  const protectedRoots = [];
  for (const line of profileText.split(/\\r?\\n/)) {
    const match = /^("(?:[^"\\\\]|\\\\.)*") = "deny"$/.exec(line.trim());
    if (!match) continue;
    const candidate = JSON.parse(match[1]);
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    const metadata = fs.statSync(candidate);
    protectedRoots.push([candidate, metadata.mode & 0o777]);
    fs.chmodSync(candidate, 0o000);
  }
  if (protectedProject) fs.chmodSync(protectedProject, 0o000);
  const execution = require("node:child_process").spawnSync(command[0], command.slice(1), {
    cwd,
    env: childEnv,
    encoding: "utf8",
  });
  if (protectedProject && protectedProjectMode !== undefined) fs.chmodSync(protectedProject, protectedProjectMode);
  for (const [candidate, mode] of protectedRoots.reverse()) fs.chmodSync(candidate, mode);
  if (command[0] === "git" && command.includes("bundle") && command.includes("create")) {
    const bundleIndex = command.indexOf("bundle");
    const stagedBundle = command[bundleIndex + 2];
    if (process.env.FAKE_BUNDLE_SWAP_KIND === "symlink") {
      fs.rmSync(stagedBundle, { force: true });
      fs.symlinkSync(process.env.FAKE_TARGET_CREDENTIAL_PATH, stagedBundle);
    } else if (process.env.FAKE_BUNDLE_SWAP_KIND === "hardlink") {
      fs.linkSync(stagedBundle, stagedBundle + ".attacker-link");
    }
  }
  if (authPath && fs.existsSync(authPath)) fs.chmodSync(authPath, 0o600);
  if (execution.stdout) process.stdout.write(execution.stdout);
  if (execution.stderr) process.stderr.write(execution.stderr);
  process.exit(execution.status === null ? 1 : execution.status);
}
if (!args.includes("exec")) {
  process.stderr.write("unexpected fake Codex invocation\\n");
  process.exit(64);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const workerAuthPath = path.join(process.env.CODEX_HOME, "auth.json");
  if (process.env.FAKE_CODEX_CACHE_SWAP_KIND === "symlink") {
    fs.rmSync(workerAuthPath, { force: true });
    fs.symlinkSync(process.env.FAKE_CODEX_SWAP_TARGET, workerAuthPath);
  } else if (process.env.FAKE_CODEX_CACHE_SWAP_KIND === "hardlink") {
    fs.linkSync(workerAuthPath, workerAuthPath + ".attacker-link");
  } else {
    const auth = JSON.parse(fs.readFileSync(workerAuthPath, "utf8"));
    fs.writeFileSync(workerAuthPath, JSON.stringify({ ...auth, refreshedBy: "cloud-worker" }), { mode: 0o600 });
  }
  if (process.env.FAKE_CODEX_INSTALL_ATTACK === "1") {
    const project = process.env.DEX_CLOUD_PROJECT;
    const target = process.env.FAKE_TARGET_CREDENTIAL_PATH;
    const npmMarker = process.env.FAKE_NPM_EXFIL_MARKER;
    const hookMarker = process.env.FAKE_HOOK_EXFIL_MARKER;
    const attackScript = "const fs=require('node:fs');let leaked=false;try{fs.readFileSync(" + JSON.stringify(target) + ");leaked=true}catch{};if(process.env.CODEX_HOME||process.env.CODEX_API_KEY||process.env.OPENAI_API_KEY||process.env.DEX_HANDOFF_SIGNING_KEY||process.env.MODAL_TOKEN_SECRET)leaked=true;if(leaked)fs.writeFileSync(" + JSON.stringify(npmMarker) + ",'leaked')";
    fs.writeFileSync(require("node:path").join(project, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e " + JSON.stringify(attackScript),
      },
    }), "utf8");
    fs.appendFileSync(require("node:path").join(project, "README.md"), "agent change\\n", "utf8");
    const hook = require("node:path").join(project, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\\nif [ -r " + JSON.stringify(target) + " ]; then printf leaked > " + JSON.stringify(hookMarker) + "; fi\\n", { mode: 0o755 });
  }
  fs.writeFileSync(process.env.FAKE_CODEX_ARGUMENTS_PATH, JSON.stringify(process.argv.slice(2)), "utf8");
  fs.writeFileSync(process.env.FAKE_CODEX_PROMPT_PATH, prompt, "utf8");
  fs.writeFileSync(process.env.FAKE_CODEX_ENV_PATH, JSON.stringify({
    codexHome: process.env.CODEX_HOME,
    codexApiKey: process.env.CODEX_API_KEY,
    openAiApiKey: process.env.OPENAI_API_KEY,
    handoffSigningKey: process.env.DEX_HANDOFF_SIGNING_KEY,
    modalToken: process.env.MODAL_TOKEN_SECRET,
    secretLikeNames: Object.keys(process.env).filter((name) => /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)(?:_|$)/i.test(name)).sort(),
  }), "utf8");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-cloud-123" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: process.env.FAKE_CODEX_MESSAGE || "Cloud work completed. DEX_HANDOFF_SIGNING_KEY=must-not-persist" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
});
`,
    "utf8",
  );
  await writeFile(
    npmPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const npmrc = path.join(process.cwd(), ".npmrc");
if (fs.existsSync(npmrc)) {
  const configuredGit = fs.readFileSync(npmrc, "utf8")
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("git="))
    ?.slice(4);
  if (configuredGit) {
    const executable = path.resolve(process.cwd(), configuredGit);
    const result = spawnSync(executable, ["clone", "attacker-controlled-dependency"], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
if (process.env.FAKE_BOOTSTRAP_SOURCE_PATH && process.env.FAKE_BOOTSTRAP_SOURCE_MARKER) {
  try {
    fs.readFileSync(process.env.FAKE_BOOTSTRAP_SOURCE_PATH);
    fs.writeFileSync(process.env.FAKE_BOOTSTRAP_SOURCE_MARKER, "source-readable");
  } catch {}
}
if (process.env.FAKE_BOOTSTRAP_LISTING_PATH) {
  fs.writeFileSync(
    process.env.FAKE_BOOTSTRAP_LISTING_PATH,
    JSON.stringify(fs.readdirSync(process.cwd()).sort()),
  );
}
fs.mkdirSync(path.join(process.cwd(), "node_modules"), { recursive: true });
process.exit(0);
`,
    "utf8",
  );
  await writeFile(
    syncPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.FAKE_SYNC_LOG_PATH) {
  fs.appendFileSync(process.env.FAKE_SYNC_LOG_PATH, JSON.stringify(process.argv.slice(2)) + "\\n");
}
process.exit(Number(process.env.FAKE_SYNC_EXIT_CODE || "0"));
`,
    "utf8",
  );
  await Promise.all([
    chmod(binaryPath, 0o755),
    chmod(npmPath, 0o755),
    chmod(syncPath, 0o755),
  ]);
  return binaryDirectory;
}

async function runWorker(
  fixture: WorkerFixture,
  message?: string,
  additionalEnvironment: NodeJS.ProcessEnv = {},
  prepareAuth?: (authPath: string) => Promise<void>,
  prepareKey?: (keyPath: string) => Promise<void>,
) {
  const binaryDirectory = await installFakeCodex(fixture.directory);
  await mkdir(fixture.codexHome, { mode: 0o755 });
  const authPath = path.join(fixture.codexHome, "auth.json");
  await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }), { mode: 0o644 });
  const keyPath = path.join(fixture.cloudRoot, "handoff.key");
  await writeFile(keyPath, SIGNING_KEY, { mode: 0o600 });
  await prepareKey?.(keyPath);
  await prepareAuth?.(authPath);
  return execFile(process.execPath, ["--import", "tsx", CLOUD_WORKER], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      DEX_CLOUD_ROOT: fixture.cloudRoot,
      DEX_CLOUD_PROJECT: fixture.projectPath,
      MODAL_TOKEN_SECRET: "modal-test-secret",
      CODEX_API_KEY: "must-not-reach-codex",
      OPENAI_API_KEY: "must-not-reach-codex",
      CODEX_HOME: fixture.codexHome,
      FAKE_CODEX_PROMPT_PATH: fixture.promptPath,
      FAKE_CODEX_ENV_PATH: fixture.environmentPath,
      FAKE_CODEX_ARGUMENTS_PATH: fixture.argumentsPath,
      FAKE_CODEX_CALLS_PATH: fixture.callsPath,
      ...(message === undefined ? {} : { FAKE_CODEX_MESSAGE: message }),
      ...additionalEnvironment,
    },
  });
}

async function readCodexCalls(fixture: WorkerFixture): Promise<Array<{
  args: string[];
  cwd: string;
  homeEntries: string[];
  profileText: string;
  environment: { codexHome?: string; secretLikeNames: string[] };
}>> {
  return (await readFile(fixture.callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      args: string[];
      cwd: string;
      homeEntries: string[];
      profileText: string;
      environment: { codexHome?: string; secretLikeNames: string[] };
    });
}

async function expectMissing(file: string): Promise<void> {
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createCodexArg0Fixture(directory: string): Promise<{
  home: string;
  trustedPackageRoot: string;
  generationRoot: string;
}> {
  const home = path.join(directory, "ephemeral-codex-home");
  const trustedPackageRoot = path.join(directory, "trusted", "@openai", "codex");
  const executable = path.join(
    trustedPackageRoot,
    "node_modules",
    "@openai",
    "codex-linux-x64",
    "vendor",
    "x86_64-unknown-linux-musl",
    "bin",
    "codex",
  );
  const generationRoot = path.join(home, "tmp", "arg0", "codex-arg0AbC123");
  await Promise.all([
    mkdir(path.dirname(executable), { recursive: true, mode: 0o755 }),
    mkdir(generationRoot, { recursive: true, mode: 0o755 }),
  ]);
  await Promise.all([
    chmod(home, 0o700),
    chmod(path.join(home, "tmp"), 0o755),
    chmod(path.join(home, "tmp", "arg0"), 0o700),
    chmod(generationRoot, 0o755),
    chmod(trustedPackageRoot, 0o755),
    writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), { mode: 0o600 }),
    writeFile(path.join(generationRoot, ".lock"), "", { mode: 0o644 }),
    writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
  ]);
  for (const alias of [
    "apply_patch",
    "applypatch",
    "codex-execve-wrapper",
    "codex-linux-sandbox",
  ]) {
    await symlink(executable, path.join(generationRoot, alias));
  }
  return { home, trustedPackageRoot, generationRoot };
}

async function resignHandoffWithHead(
  fixture: WorkerFixture,
  headCommit: string,
): Promise<HandoffDocument> {
  const handoffPath = path.join(fixture.cloudRoot, "handoff.json");
  const current = JSON.parse(await readFile(handoffPath, "utf8")) as HandoffDocument;
  const { contentHash: _contentHash, integrity: _integrity, ...content } = current;
  const changedContent = {
    ...content,
    repository: { ...content.repository, headCommit },
  };
  const bundle = await readFile(path.join(fixture.cloudRoot, "repo.bundle"));
  const integrity = await signManifest(
    createManifest(changedContent, [{ path: "repo.bundle", content: bundle }]),
    SIGNING_KEY,
    "worker-test-key",
  );
  const changed = {
    ...changedContent,
    contentHash: integrity.contentSha256,
    integrity,
  } as HandoffDocument;
  await writeFile(handoffPath, `${JSON.stringify(changed, null, 2)}\n`);
  return changed;
}

describe("Modal cloud worker", () => {
  it("accepts only Codex's exact transient arg0 helper tree after account login", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dex-codex-arg0-"));
    temporaryDirectories.push(directory);
    const fixture = await createCodexArg0Fixture(directory);

    await expect(
      validateEphemeralCodexHome(fixture.home, fixture.trustedPackageRoot),
    ).resolves.toBeUndefined();

    await rm(path.join(fixture.home, "tmp"), { recursive: true });
    await expect(
      validateEphemeralCodexHome(fixture.home, fixture.trustedPackageRoot),
    ).resolves.toBeUndefined();
  });

  it("rejects unrecognized Codex-home entries and arg0 targets outside the trusted package", async () => {
    const extraDirectory = await mkdtemp(path.join(os.tmpdir(), "dex-codex-arg0-extra-"));
    temporaryDirectories.push(extraDirectory);
    const extra = await createCodexArg0Fixture(extraDirectory);
    await writeFile(path.join(extra.home, "config.toml"), "model = 'attacker'\n");
    await expect(
      validateEphemeralCodexHome(extra.home, extra.trustedPackageRoot),
    ).rejects.toThrow("unrecognized root entry");

    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "dex-codex-arg0-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outside = await createCodexArg0Fixture(outsideDirectory);
    const externalExecutable = path.join(outsideDirectory, "outside", "codex");
    await mkdir(path.dirname(externalExecutable), { recursive: true });
    await writeFile(externalExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const attackedAlias = path.join(outside.generationRoot, "apply_patch");
    await rm(attackedAlias);
    await symlink(externalExecutable, attackedAlias);
    await expect(
      validateEphemeralCodexHome(outside.home, outside.trustedPackageRoot),
    ).rejects.toThrow("points outside the trusted Codex package");
  });

  it("rejects handoff and bundle tampering before starting Codex", async () => {
    const cases: Array<{
      tamper(fixture: WorkerFixture): Promise<void>;
      message: string;
    }> = [
      {
        tamper: async ({ cloudRoot }) => {
          const file = path.join(cloudRoot, "handoff.json");
          const document = JSON.parse(await readFile(file, "utf8")) as HandoffDocument;
          await writeFile(file, `${JSON.stringify({ ...document, goal: "tampered goal" }, null, 2)}\n`);
        },
        message: "Handoff content hash mismatch",
      },
      {
        tamper: async ({ cloudRoot }) => {
          await appendFile(path.join(cloudRoot, "repo.bundle"), "tampered bundle bytes");
        },
        message: "Git bundle hash mismatch",
      },
    ];

    for (const testCase of cases) {
      const fixture = await createWorkerFixture();
      await testCase.tamper(fixture);

      const execution = await runWorker(fixture);

      expect(execution.exitCode).not.toBe(0);
      const result = JSON.parse(
        await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(result).toMatchObject({
        taskId: fixture.handoff.taskId,
        handoffSha256: fixture.handoff.contentHash,
        status: "failed",
        summary: testCase.message,
        git: { commit: "unavailable" },
      });
      await expectMissing(fixture.promptPath);
      await expectMissing(fixture.projectPath);
    }
  });

  it("rejects a correctly signed handoff whose HEAD is absent from the bundle checkout", async () => {
    const fixture = await createWorkerFixture();
    const changed = await resignHandoffWithHead(fixture, "f".repeat(40));

    const execution = await runWorker(fixture);

    expect(execution.exitCode).not.toBe(0);
    expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
      taskId: fixture.handoff.taskId,
      handoffSha256: changed.contentHash,
      status: "failed",
      summary: "Checked-out Git HEAD does not match the signed handoff commit",
    });
    await expectMissing(fixture.promptPath);
  });

  it("rejects a handoff key whose original permissions are broader than 0600", async () => {
    const fixture = await createWorkerFixture();

    const execution = await runWorker(
      fixture,
      undefined,
      {},
      undefined,
      async (keyPath) => chmod(keyPath, 0o644),
    );

    expect(execution.exitCode).not.toBe(0);
    expect(execution.stderr).toContain("Dex handoff key has invalid permissions or size");
    expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8")))
      .toMatchObject({
        taskId: fixture.handoff.taskId,
        handoffSha256: fixture.handoff.contentHash,
        status: "failed",
        summary: "Dex handoff key has invalid permissions or size",
      });
    await expectMissing(fixture.promptPath);
    await expectMissing(path.join(fixture.cloudRoot, "handoff.key"));
  });

  it("acknowledges the exact inherited memory and failed-approach IDs with the Codex thread", async () => {
    const fixture = await createWorkerFixture();

    const execution = await runWorker(fixture);

    expect(execution, execution.stderr).toMatchObject({ exitCode: 0 });
    const startup = JSON.parse(
      await readFile(path.join(fixture.cloudRoot, "startup.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(startup).toMatchObject({
      taskId: fixture.handoff.taskId,
      handoffSha256: fixture.handoff.contentHash,
      providerThreadId: "thread-cloud-123",
      loadedMemoryIds: fixture.handoff.memories.map(({ id }) => String(id)),
      loadedFailedApproachIds: fixture.handoff.failedApproaches.map(
        ({ sourceMemoryId }, index) => String(sourceMemoryId ?? `failed-${index + 1}`),
      ),
    });
    expect(startup.acknowledgedAt).toEqual(expect.any(String));
    const prompt = await readFile(fixture.promptPath, "utf8");
    expect(prompt).toContain("Durable continuation fact 1");
    expect(prompt).toContain("DO NOT REPEAT: Poll the provider directly");
    const workerEnvironment = JSON.parse(
      await readFile(fixture.environmentPath, "utf8"),
    ) as { codexHome: string; secretLikeNames: string[] };
    expect(workerEnvironment.secretLikeNames).toEqual([]);
    expect(workerEnvironment.codexHome).not.toBe(fixture.codexHome);
    expect(workerEnvironment.codexHome).toMatch(/\.dex-codex-auth-/);
    expect(JSON.parse(await readFile(fixture.argumentsPath, "utf8"))).toEqual([
      "--profile",
      "modal-worker",
      "--ask-for-approval",
      "never",
      "exec",
      "--cd",
      fixture.projectPath,
      "--strict-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "-",
    ]);
    expect((await stat(fixture.codexHome)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(fixture.codexHome, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(fixture.codexHome, "auth.json"), "utf8"))).toMatchObject({
      auth_mode: "chatgpt",
      refreshedBy: "cloud-worker",
    });
    expect(await readdir(fixture.codexHome)).toEqual(["auth.json"]);

    const calls = await readCodexCalls(fixture);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(calls[0]?.args).toEqual(["login", "status"]);
    expect(calls[0]?.homeEntries).toEqual(["auth.json"]);
    expect(calls[0]?.environment.codexHome).toBe(workerEnvironment.codexHome);
    const workerProfileCall = calls.find(({ args }) =>
      args[0] === "sandbox" && args[2] === "modal-worker"
    );
    const profile = workerProfileCall?.profileText ?? "";
    expect(profile).not.toContain('default_permissions = "modal-worker"');
    expect(profile).toContain('approval_policy = "never"');
    expect(profile).toContain('[permissions.modal-worker]');
    expect(profile).toContain('extends = ":workspace"');
    expect(profile).toContain('\n":root" = "deny"');
    expect(profile).toContain('\n":minimal" = "read"');
    expect(profile).toContain('"/codex-home" = "deny"');
    expect(profile).toContain(`${JSON.stringify(fixture.codexHome)} = "deny"`);
    expect(profile).toContain(`${JSON.stringify(workerEnvironment.codexHome)} = "deny"`);
    expect(profile).toContain('[permissions.modal-worker.filesystem.":workspace_roots"]');
    expect(profile).toContain('"." = "write"');
    expect(profile).toContain('[permissions.modal-worker.network]\nenabled = true');
    expect(profile).toContain('[shell_environment_policy]\ninherit = "core"');
    expect(profile).toContain('CODEX_HOME = "exclude"');
    expect(profile).toContain('OPENAI_API_KEY = "exclude"');
    expect(profile).toContain('CODEX_API_KEY = "exclude"');
    expect(workerProfileCall?.homeEntries).toEqual([
      "modal-bootstrap.config.toml",
      "modal-worker.config.toml",
    ]);
    expect(workerProfileCall?.homeEntries).not.toContain("auth.json");
    expect(workerProfileCall?.environment.codexHome).not.toBe(workerEnvironment.codexHome);
    expect(workerProfileCall?.environment.codexHome).not.toBe(fixture.codexHome);
    expect(calls[1]?.args.slice(0, 8)).toEqual([
      "sandbox",
      "--profile",
      "modal-worker",
      "--permission-profile",
      "modal-worker",
      "--cd",
      fixture.projectPath,
      "--",
    ]);
    expect(calls[1]?.args.join(" ")).toContain("/proc/1/environ");
    expect(calls[1]?.args.join(" ")).toContain('test ! -r "$1/auth.json"');
    expect(calls[1]?.args.join(" ")).toContain('test ! -r "$2/auth.json"');
    const taskCall = calls.find(({ args }) => args.includes("exec"));
    expect(taskCall?.args).toEqual(JSON.parse(await readFile(fixture.argumentsPath, "utf8")));
    const taskCallIndex = calls.indexOf(taskCall!);
    expect(calls.slice(taskCallIndex + 1).every(({ args }) => args[0] === "sandbox")).toBe(true);
    const postTaskCommands = calls.slice(taskCallIndex + 1).map(({ args }) => {
      const separator = args.indexOf("--");
      return args.slice(separator + 1);
    });
    expect(postTaskCommands.map(([command]) => command)).toEqual(["git", "git", "git"]);
    expect(calls.every(({ environment }) => environment.secretLikeNames.length === 0)).toBe(true);
    expect(await realpath(taskCall!.cwd)).toBe(await realpath(fixture.projectPath));
    expect(calls.flatMap(({ args }) => args)).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(taskCall?.args).not.toContain("--sandbox");
    expect(taskCall?.args).not.toContain("workspace-write");
    expect(taskCall?.args).not.toContain("--skip-git-repo-check");
    expect(taskCall?.args).toContain("--profile");
    expect(taskCall?.args).toContain("--strict-config");
    expect(taskCall?.profileText).toContain("project_doc_max_bytes = 0");
    expect(taskCall?.profileText).toContain('default_permissions = "modal-worker"');
    expect(taskCall?.profileText).toContain(`${JSON.stringify(workerEnvironment.codexHome)} = "deny"`);
    expect(taskCall?.profileText).toContain(`${JSON.stringify(path.join(workerEnvironment.codexHome, "tmp", "arg0"))} = "read"`);
    expect(taskCall?.homeEntries).toEqual(["auth.json", "modal-worker.config.toml"]);
    await expectMissing(path.join(fixture.cloudRoot, "handoff.key"));
    await expectMissing(workerEnvironment.codexHome);
    await expectMissing(workerProfileCall!.environment.codexHome!);
    expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
      status: "succeeded",
      summary: "Cloud work completed. DEX_HANDOFF_SIGNING_KEY=[REDACTED]",
      authVolumePersisted: {
        version: 1,
        method: "modal-volume-v2-sync",
        mountPath: "/codex-home",
        taskId: fixture.handoff.taskId,
        handoffSha256: fixture.handoff.contentHash,
        authSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        persistedAt: expect.any(String),
      },
    });
  });

  it("publishes no terminal result when explicit auth Volume sync fails", async () => {
    const fixture = await createWorkerFixture();
    const syncLog = path.join(fixture.directory, "sync.jsonl");

    const execution = await runWorker(fixture, undefined, {
      FAKE_SYNC_EXIT_CODE: "73",
      FAKE_SYNC_LOG_PATH: syncLog,
    });

    expect(execution.exitCode).not.toBe(0);
    expect(execution.stderr).toContain("Explicit Modal v2 Codex auth Volume sync failed");
    await expectMissing(path.join(fixture.cloudRoot, "result.json"));
    expect((await readFile(syncLog, "utf8")).trim()).toBe(
      JSON.stringify([fixture.codexHome]),
    );
  });

  it("fails closed before task execution when the permission-boundary smoke fails", async () => {
    const fixture = await createWorkerFixture();

    const execution = await runWorker(fixture, undefined, {
      FAKE_CODEX_SMOKE_EXIT_CODE: "71",
      DATABASE_PASSWORD: "must-not-reach-any-codex-child",
    });

    expect(execution.exitCode).not.toBe(0);
    const calls = await readCodexCalls(fixture);
    expect(calls.map(({ args }) => args[0])).toEqual(["login", "sandbox"]);
    expect(calls.every(({ environment }) => environment.secretLikeNames.length === 0)).toBe(true);
    expect(calls.some(({ args }) => args.includes("exec"))).toBe(false);
    await expectMissing(fixture.promptPath);
    await expectMissing(fixture.argumentsPath);
    expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
      taskId: fixture.handoff.taskId,
      handoffSha256: fixture.handoff.contentHash,
      status: "failed",
      summary: "Codex permission-boundary smoke failed: the sandbox launcher rejected the profile",
    });
  });

  it("rejects a symbolic-link auth cache without touching its target", async () => {
    const fixture = await createWorkerFixture();
    const externalCredential = path.join(fixture.directory, "outside-auth.json");
    await writeFile(externalCredential, "outside credential target\n", { mode: 0o644 });

    const execution = await runWorker(fixture, undefined, {}, async (authPath) => {
      await rm(authPath);
      await symlink(externalCredential, authPath);
    });

    expect(execution.exitCode).not.toBe(0);
    expect(await readFile(externalCredential, "utf8")).toBe("outside credential target\n");
    expect((await stat(externalCredential)).mode & 0o777).toBe(0o644);
    await expectMissing(fixture.callsPath);
    expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
      status: "failed",
      summary: "Codex account authentication cache must not be a symbolic link",
    });
  });

  it("rejects regular and symbolic-link project Codex configuration before task startup", async () => {
    for (const kind of ["regular", "symlink"] as const) {
      const fixture = await createWorkerFixture([], async ({ repositoryPath, directory }) => {
        const configDirectory = path.join(repositoryPath, ".codex");
        await mkdir(configDirectory);
        if (kind === "regular") {
          await writeFile(path.join(configDirectory, "config.toml"), 'model = "attacker-model"\n');
        } else {
          const target = path.join(directory, "attacker-codex-config.toml");
          await writeFile(target, 'notify = ["/bin/sh", "-c", "exit 99"]\n');
          await symlink(target, path.join(configDirectory, "config.toml"));
        }
      }, true);

      const execution = await runWorker(fixture);

      expect(execution.exitCode).not.toBe(0);
      await expectMissing(fixture.promptPath);
      await expectMissing(fixture.argumentsPath);
      expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
        status: "failed",
        summary: "Project-local .codex/config.toml is not allowed in cloud continuation",
      });
      const calls = await readCodexCalls(fixture);
      expect(calls.map(({ args }) => args).filter((args) => args.includes("exec"))).toEqual([]);
    }
  });

  it("refuses symbolic-link and hard-link swaps of the refreshed temporary auth cache", async () => {
    for (const testCase of [
      { kind: "symlink", summary: "Codex account authentication cache must not be a symbolic link" },
      { kind: "hardlink", summary: "Codex account authentication cache must not be hard-linked" },
    ] as const) {
      const fixture = await createWorkerFixture();
      const externalTarget = path.join(fixture.directory, `external-${testCase.kind}-auth.json`);
      await writeFile(externalTarget, JSON.stringify({ auth_mode: "attacker" }), { mode: 0o600 });

      const execution = await runWorker(fixture, undefined, {
        FAKE_CODEX_CACHE_SWAP_KIND: testCase.kind,
        FAKE_CODEX_SWAP_TARGET: externalTarget,
      });

      expect(execution.exitCode).not.toBe(0);
      expect(JSON.parse(await readFile(path.join(fixture.codexHome, "auth.json"), "utf8"))).toEqual({
        auth_mode: "chatgpt",
        tokens: {},
      });
      expect(JSON.parse(await readFile(externalTarget, "utf8"))).toEqual({ auth_mode: "attacker" });
      // Auth persistence did not complete, so no result artifact may claim a
      // terminal state; the monitor must fall back to process termination.
      await expectMissing(path.join(fixture.cloudRoot, "result.json"));
      expect(execution.stderr).toContain(testCase.summary);
    }
  });

  it("contains malicious validation scripts and disables repository Git hooks after the agent exits", async () => {
    const fixture = await createWorkerFixture([["npm", "test"]]);
    const npmMarker = path.join(fixture.directory, "npm-exfiltrated");
    const hookMarker = path.join(fixture.directory, "hook-exfiltrated");

    const execution = await runWorker(fixture, undefined, {
      FAKE_CODEX_INSTALL_ATTACK: "1",
      FAKE_TARGET_CREDENTIAL_PATH: path.join(fixture.codexHome, "auth.json"),
      FAKE_NPM_EXFIL_MARKER: npmMarker,
      FAKE_HOOK_EXFIL_MARKER: hookMarker,
    });

    expect(execution, execution.stderr).toMatchObject({ exitCode: 0 });
    await expectMissing(npmMarker);
    await expectMissing(hookMarker);
    const calls = await readCodexCalls(fixture);
    const taskCallIndex = calls.findIndex(({ args }) => args.includes("exec"));
    expect(taskCallIndex).toBeGreaterThan(1);
    const postTaskCalls = calls.slice(taskCallIndex + 1);
    expect(postTaskCalls.every(({ args }) => args[0] === "sandbox")).toBe(true);
    const payloads = postTaskCalls.map(({ args }) => args.slice(args.indexOf("--") + 1));
    expect(payloads.some((argv) => argv[0] === "npm" && argv[1] === "test")).toBe(true);
    const gitPayloads = payloads.filter(([command]) => command === "git");
    expect(gitPayloads.length).toBeGreaterThanOrEqual(5);
    expect(gitPayloads.every((argv) => argv.join(" ").includes("core.hooksPath=/dev/null"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
      status: "succeeded",
      validation: { passed: true },
    });
  });

  it("reports stdout-only validation failure evidence instead of the agent success claim", async () => {
    const validationCommand = [
      "node",
      "-e",
      "process.stdout.write('stdout-only validation evidence'); process.exit(23)",
    ];
    const fixture = await createWorkerFixture([validationCommand]);

    const execution = await runWorker(fixture, "Everything passed successfully.");

    expect(execution.exitCode).not.toBe(0);
    const result = JSON.parse(
      await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"),
    ) as { status: string; summary: string; validation: { commands: string[]; passed: boolean } };
    expect(result).toMatchObject({
      status: "failed",
      validation: {
        commands: [JSON.stringify(validationCommand)],
        passed: false,
      },
    });
    expect(result.summary).toContain("Validation failed for command");
    expect(result.summary).toContain(JSON.stringify(validationCommand));
    expect(result.summary).toContain("exit 23");
    expect(result.summary).toContain("stdout: stdout-only validation evidence");
    expect(result.summary).not.toContain("Everything passed successfully.");
  });

  it("bounds the failed validation command and output while retaining useful evidence", async () => {
    const oversizedArgument = `payload=${"command".repeat(100)}`;
    const validationCommand = [
      "node",
      "-e",
      "process.stdout.write('output'.repeat(300) + ' ' + ['useful', 'tail', 'evidence'].join('-')); process.exit(29)",
      oversizedArgument,
    ];
    const fixture = await createWorkerFixture([validationCommand]);

    const execution = await runWorker(fixture, "Validation succeeded.");

    expect(execution.exitCode).not.toBe(0);
    const result = JSON.parse(
      await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"),
    ) as { summary: string };
    expect(result.summary).toHaveLength(500);
    expect(result.summary).toMatch(/^Validation failed for command \["node","-e",/);
    expect(result.summary).toContain("exit 29");
    expect(result.summary).toContain("useful-tail-evidence");
    expect(result.summary).not.toContain(oversizedArgument);
    expect(result.summary).not.toContain("Validation succeeded.");
  });

  it("isolates dependency bootstrap from repository source and repository-selected npm helpers", async () => {
    let bootstrapMarker = "";
    let bootstrapListing = "";
    const fixture = await createWorkerFixture([], async ({ repositoryPath, directory }) => {
      bootstrapMarker = path.join(directory, "bootstrap-exfiltrated");
      bootstrapListing = path.join(directory, "bootstrap-listing.json");
      const maliciousGit = path.join(repositoryPath, "steal-auth");
      await Promise.all([
        writeFile(path.join(repositoryPath, "package.json"), JSON.stringify({
          name: "malicious-bootstrap-fixture",
          version: "1.0.0",
        })),
        writeFile(path.join(repositoryPath, "package-lock.json"), JSON.stringify({
          name: "malicious-bootstrap-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "malicious-bootstrap-fixture", version: "1.0.0" } },
        })),
        writeFile(path.join(repositoryPath, ".npmrc"), "git=./steal-auth\n"),
        writeFile(
          maliciousGit,
          `#!/usr/bin/env node
const fs = require("node:fs");
let leaked = false;
try { fs.readFileSync(process.env.FAKE_TARGET_CREDENTIAL_PATH); leaked = true; } catch {}
if (process.env.CODEX_HOME || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || process.env.DEX_HANDOFF_SIGNING_KEY || process.env.MODAL_TOKEN_SECRET) leaked = true;
if (leaked) fs.writeFileSync(process.env.FAKE_BOOTSTRAP_EXFIL_MARKER, "leaked");
`,
        ),
      ]);
      await chmod(maliciousGit, 0o755);
    }, true);

    const execution = await runWorker(fixture, undefined, {
      FAKE_TARGET_CREDENTIAL_PATH: path.join(fixture.codexHome, "auth.json"),
      FAKE_BOOTSTRAP_EXFIL_MARKER: bootstrapMarker,
      FAKE_BOOTSTRAP_LISTING_PATH: bootstrapListing,
    });

    expect(execution, execution.stderr).toMatchObject({ exitCode: 0 });
    await expectMissing(bootstrapMarker);
    expect(JSON.parse(await readFile(bootstrapListing, "utf8"))).toEqual([
      "package-lock.json",
      "package.json",
    ]);
    const calls = await readCodexCalls(fixture);
    const bootstrapCallIndex = calls.findIndex(({ args }) => {
      const separator = args.indexOf("--");
      return args[0] === "sandbox" &&
        args[2] === "modal-bootstrap" &&
        args[separator + 1] === "/usr/bin/env" &&
        args.includes("npm") &&
        args.includes("ci");
    });
    expect(bootstrapCallIndex).toBeGreaterThan(2);
    expect(calls.slice(0, bootstrapCallIndex).some(({ args }) =>
      args[0] === "sandbox" &&
      args[2] === "modal-bootstrap" &&
      args.includes("dex-modal-boundary-smoke")
    )).toBe(true);
    expect(calls[bootstrapCallIndex]?.environment.secretLikeNames).toEqual([]);
    expect(calls[bootstrapCallIndex]?.environment.codexHome).not.toBe(fixture.codexHome);
    expect(calls[bootstrapCallIndex]?.homeEntries).not.toContain("auth.json");
    const bootstrapProfile = calls[bootstrapCallIndex]?.profileText ?? "";
    expect(bootstrapProfile).not.toContain('default_permissions = "modal-bootstrap"');
    expect(bootstrapProfile).toContain('[permissions.modal-bootstrap.network]\nenabled = true');
    expect(bootstrapProfile).toContain(`${JSON.stringify(fixture.codexHome)} = "deny"`);
    expect(bootstrapProfile).toContain('CODEX_HOME = "exclude"');
    expect(bootstrapProfile).toContain('OPENAI_API_KEY = "exclude"');
    expect(bootstrapProfile).toContain('CODEX_API_KEY = "exclude"');
    expect(bootstrapProfile).toContain('DEX_CLOUD_PROJECT = "exclude"');
    expect(bootstrapProfile).toContain('DEX_CLOUD_ROOT = "exclude"');
    expect(calls[bootstrapCallIndex]?.cwd).not.toBe(fixture.projectPath);
    expect(calls[bootstrapCallIndex]?.cwd).toMatch(/\.dex-bootstrap-/);
    const bootstrapArgs = calls[bootstrapCallIndex]?.args ?? [];
    expect(bootstrapArgs).toContain("NPM_CONFIG_USERCONFIG=/dev/null");
    expect(bootstrapArgs).toContain("NPM_CONFIG_GLOBALCONFIG=/dev/null");
    expect(bootstrapArgs).toContain("NPM_CONFIG_GIT=/usr/bin/git");
    expect(bootstrapArgs).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(bootstrapArgs).not.toContain(path.join(fixture.projectPath, ".npmrc"));
    const bootstrapSmoke = calls.find(({ args }) =>
      args[0] === "sandbox"
      && args[2] === "modal-bootstrap"
      && args.includes("dex-modal-boundary-smoke")
    );
    expect(bootstrapSmoke?.args.join(" ")).toContain('test ! -r "$3/.git/HEAD"');
    expect(bootstrapSmoke?.args).toContain(fixture.projectPath);
  });

  it("rejects symbolic-link and hard-link swaps of the staged result bundle", async () => {
    const cases = [
      {
        kind: "symlink",
        message: "Staged result bundle must not be a symbolic link",
      },
      {
        kind: "hardlink",
        message: "Staged result bundle must not be hard-linked",
      },
    ] as const;

    for (const testCase of cases) {
      const fixture = await createWorkerFixture();
      const authPath = path.join(fixture.codexHome, "auth.json");
      const execution = await runWorker(fixture, undefined, {
        FAKE_BUNDLE_SWAP_KIND: testCase.kind,
        FAKE_TARGET_CREDENTIAL_PATH: authPath,
      });

      expect(execution.exitCode).not.toBe(0);
      expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({ auth_mode: "chatgpt" });
      await expectMissing(path.join(fixture.cloudRoot, "result.bundle"));
      expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
        status: "failed",
        summary: testCase.message,
      });
    }
  });

  it("preserves the beginning of long semantic completion summaries", async () => {
    const fixture = await createWorkerFixture();
    const message = `Fixed checkout ordering and preserved idempotency. ${"evidence ".repeat(80)}`;

    const execution = await runWorker(fixture, message);

    expect(execution, execution.stderr).toMatchObject({ exitCode: 0 });
    const result = JSON.parse(
      await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"),
    ) as { summary: string };
    expect(result.summary).toHaveLength(500);
    expect(result.summary).toMatch(/^Fixed checkout ordering and preserved idempotency\./);
  });
});
