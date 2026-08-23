import { access, appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryObservation } from "../src/memory/index.js";
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
  promptPath: string;
  environmentPath: string;
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

async function createWorkerFixture(): Promise<WorkerFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dex-cloud-worker-"));
  temporaryDirectories.push(directory);
  const repositoryPath = path.join(directory, "source");
  const cloudRoot = path.join(directory, "cloud-root");
  const projectPath = path.join(directory, "workspace", "project");
  const bundlePath = path.join(cloudRoot, "repo.bundle");
  const handoffPath = path.join(cloudRoot, "handoff.json");
  const promptPath = path.join(directory, "codex-prompt.txt");
  const environmentPath = path.join(directory, "codex-environment.json");
  await Promise.all([mkdir(repositoryPath), mkdir(cloudRoot), mkdir(path.dirname(projectPath))]);
  await mustExec("git", ["init", "-b", "main"], repositoryPath);
  await mustExec("git", ["config", "user.name", "Dex Test"], repositoryPath);
  await mustExec("git", ["config", "user.email", "dex@example.test"], repositoryPath);
  await writeFile(path.join(repositoryPath, "README.md"), "cloud checkpoint\n", "utf8");
  await mustExec("git", ["add", "README.md"], repositoryPath);
  await mustExec("git", ["commit", "-m", "initial checkpoint"], repositoryPath);
  const baseCommit = await mustExec("git", ["rev-parse", "HEAD"], repositoryPath);
  await mustExec("git", ["checkout", "-b", "dex/cloud-worker"], repositoryPath);

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
      },
      memories: Array.from({ length: 5 }, (_, index) => memory(index + 1)),
      validation: { commands: [], expectedEvidence: ["Worker completes."] },
      createdAt: "2026-08-23T12:00:00.000Z",
    },
    {
      discoverMemory: false,
      gitCheckpoint: { bundlePath, commitDirty: true },
      signingKey: SIGNING_KEY,
      signingKeyId: "worker-test-key",
    },
  );
  await writeHandoff(handoffPath, handoff);
  return { directory, cloudRoot, projectPath, promptPath, environmentPath, handoff };
}

async function installFakeCodex(directory: string): Promise<string> {
  const binaryDirectory = path.join(directory, "bin");
  const binaryPath = path.join(binaryDirectory, "codex");
  await mkdir(binaryDirectory);
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_CODEX_PROMPT_PATH, prompt, "utf8");
  fs.writeFileSync(process.env.FAKE_CODEX_ENV_PATH, JSON.stringify({
    codexHome: process.env.CODEX_HOME,
    handoffSigningKey: process.env.DEX_HANDOFF_SIGNING_KEY,
    modalToken: process.env.MODAL_TOKEN_SECRET,
  }), "utf8");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-cloud-123" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Cloud work completed. DEX_HANDOFF_SIGNING_KEY=must-not-persist" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
});
`,
    "utf8",
  );
  await chmod(binaryPath, 0o755);
  return binaryDirectory;
}

async function runWorker(fixture: WorkerFixture) {
  const binaryDirectory = await installFakeCodex(fixture.directory);
  const codexHome = path.join(fixture.directory, "codex-home");
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }), { mode: 0o600 });
  return execFile(process.execPath, ["--import", "tsx", CLOUD_WORKER], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      DEX_CLOUD_ROOT: fixture.cloudRoot,
      DEX_CLOUD_PROJECT: fixture.projectPath,
      DEX_HANDOFF_SIGNING_KEY: SIGNING_KEY,
      MODAL_TOKEN_SECRET: "modal-test-secret",
      CODEX_HOME: codexHome,
      FAKE_CODEX_PROMPT_PATH: fixture.promptPath,
      FAKE_CODEX_ENV_PATH: fixture.environmentPath,
    },
  });
}

async function expectMissing(file: string): Promise<void> {
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("Modal cloud worker", () => {
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
    expect(JSON.parse(await readFile(fixture.environmentPath, "utf8"))).toEqual({
      codexHome: path.join(fixture.directory, "codex-home"),
    });
    expect(JSON.parse(await readFile(path.join(fixture.cloudRoot, "result.json"), "utf8"))).toMatchObject({
      status: "succeeded",
      summary: "Cloud work completed. DEX_HANDOFF_SIGNING_KEY=[REDACTED]",
    });
  });
});
