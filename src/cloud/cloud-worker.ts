import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { access, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

interface HandoffDocument {
  taskId: string;
  contentHash: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  repository: { workingBranch: string };
  memories: Array<{ id: string | number; title: string; facts?: string[]; narrative?: string }>;
  learnedFacts: string[];
  failedApproaches: Array<{ approach: string; reason: string; sourceMemoryId?: string | number }>;
  validation: { commands: Array<string | string[]>; expectedEvidence: string[] };
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const root = process.env.DEX_CLOUD_ROOT ?? "/dex";
const project = process.env.DEX_CLOUD_PROJECT ?? "/workspace/project";

export async function runCloudWorker(): Promise<void> {
  let handoff: HandoffDocument | undefined;
  try {
    handoff = JSON.parse(await readFile(path.join(root, "handoff.json"), "utf8")) as HandoffDocument;
    requireHandoff(handoff);
    await verifyHandoffIntegrity(handoff);
    await run("git", ["clone", path.join(root, "repo.bundle"), project]);
    await run("git", ["-C", project, "checkout", handoff.repository.workingBranch]);
    await run("git", ["-C", project, "config", "user.name", "Dex Cloud"]);
    await run("git", ["-C", project, "config", "user.email", "dex@localhost"]);
    if (await exists(path.join(project, "package-lock.json"))) {
      await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], project);
    }

    const worker = spawn("codex", [
      "-C",
      project,
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--color",
      "never",
      "--ignore-user-config",
      "-",
    ], {
      cwd: project,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexEnvironment(),
    });
    worker.stdin.end(buildCloudPrompt(handoff), "utf8");
    let stderr = "";
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (chunk: string) => {
      stderr = bounded(`${stderr}${redactText(chunk)}`, 16_000);
    });
    const output = consumeCodexOutput(worker.stdout, handoff);
    const exitCodePromise = new Promise<number>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", (code) => resolve(code ?? 1));
    });
    const [exitCode, codex] = await Promise.all([exitCodePromise, output]);
    const { threadId, turnCompleted, summary } = codex;
    if (!threadId) throw new Error("Codex never acknowledged a cloud thread");

    const validations: Array<{ argv: string[]; result: CommandResult }> = [];
    for (const command of handoff.validation.commands) {
      if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
        throw new Error("Cloud validation commands must be non-empty argv arrays");
      }
      validations.push({ argv: command, result: await run(command[0]!, command.slice(1), project, false) });
    }
    const validationPassed = validations.every(({ result }) => result.exitCode === 0);
    const succeeded = exitCode === 0 && turnCompleted && validationPassed;
    if (succeeded) {
      const status = await run("git", ["-C", project, "status", "--porcelain=v1"], undefined, false);
      if (status.stdout.trim()) {
        await run("git", ["-C", project, "add", "--all"]);
        await run("git", ["-C", project, "commit", "-m", "dex: complete cloud continuation"]);
      }
    }
    const commit = (await run("git", ["-C", project, "rev-parse", "HEAD"])).stdout.trim();
    const resultBundlePath = path.join(root, "result.bundle");
    await run("git", ["-C", project, "bundle", "create", resultBundlePath, handoff.repository.workingBranch]);
    const resultBundleSha256 = sha256(await readFile(resultBundlePath));
    await writeJsonAtomic(path.join(root, "result.json"), {
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      status: succeeded ? "succeeded" : "failed",
      summary: redactText(
        succeeded ? summary : bounded(stderr || summary || `Codex exited ${exitCode}`, 500),
      ),
      validation: {
        commands: validations.map(({ argv }) => JSON.stringify(argv)),
        passed: validationPassed,
      },
      git: {
        branch: handoff.repository.workingBranch,
        commit,
        bundlePath: "/dex/result.bundle",
        bundleSha256: resultBundleSha256,
      },
    });
    if (!succeeded) process.exitCode = 1;
  } catch (error) {
    if (handoff) {
      await writeJsonAtomic(path.join(root, "result.json"), {
        taskId: handoff.taskId,
        handoffSha256: handoff.contentHash,
        status: "failed",
        summary: bounded(redactText(error instanceof Error ? error.message : String(error)), 500),
        validation: { commands: [], passed: false },
        git: { branch: handoff.repository.workingBranch, commit: "unavailable" },
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function consumeCodexOutput(
  stream: NodeJS.ReadableStream,
  handoff: HandoffDocument,
): Promise<{ threadId?: string; turnCompleted: boolean; summary: string }> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let threadId: string | undefined;
  let turnCompleted = false;
  let summary = "Codex completed the cloud continuation.";
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > 8 * 1024 * 1024) {
      throw new Error("Codex emitted an oversized JSONL event");
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      if (threadId && threadId !== event.thread_id) throw new Error("Codex changed thread IDs during one run");
      threadId = event.thread_id;
      await writeJsonAtomic(path.join(root, "startup.json"), {
        taskId: handoff.taskId,
        handoffSha256: handoff.contentHash,
        providerThreadId: threadId,
        loadedMemoryIds: handoff.memories.map((memory) => String(memory.id)),
        loadedFailedApproachIds: handoff.failedApproaches.map((failure, index) => String(failure.sourceMemoryId ?? `failed-${index + 1}`)),
        acknowledgedAt: new Date().toISOString(),
      });
    }
    if (event.type === "turn.completed") turnCompleted = true;
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      summary = bounded(redactText(item.text.replace(/\s+/g, " ").trim()), 500);
    }
  }
  return { ...(threadId ? { threadId } : {}), turnCompleted, summary };
}

function buildCloudPrompt(handoff: HandoffDocument): string {
  const memory = handoff.memories.map((item) => `- [${item.id}] ${item.title}: ${(item.facts ?? []).join("; ") || item.narrative || ""}`).join("\n");
  const failures = handoff.failedApproaches.map((item) => `- DO NOT REPEAT: ${item.approach}. WHY: ${item.reason}`).join("\n");
  return `You are a fresh Codex coding worker continuing a durable Dex task.\n\nTASK:\n${handoff.goal}\n\nCONSTRAINTS:\n${handoff.constraints.map((value) => `- ${value}`).join("\n")}\n\nACCEPTANCE CRITERIA:\n${handoff.acceptanceCriteria.map((value) => `- ${value}`).join("\n")}\n\nINHERITED MEMORY:\n${memory}\n\nFAILED APPROACHES:\n${failures}\n\nComplete the implementation, run appropriate validation, and do not push, deploy, merge, or repeat a failed approach without new evidence.`;
}

async function run(command: string, args: string[], cwd?: string, reject = true): Promise<CommandResult> {
  return new Promise((resolve, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: nonSecretEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = bounded(`${stdout}${redactText(chunk)}`, 128_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = bounded(`${stderr}${redactText(chunk)}`, 128_000);
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (reject && result.exitCode !== 0) rejectPromise(new Error(`${command} failed: ${stderr || stdout}`));
      else resolve(result);
    });
  });
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  await handle.sync();
  await handle.close();
  await rename(temporary, file);
}

function requireHandoff(value: HandoffDocument): void {
  if (!value?.taskId || !value.goal || !value.contentHash || !value.repository?.workingBranch) {
    throw new Error("Invalid Dex handoff document");
  }
  if (!Array.isArray(value.memories) || value.memories.length < 5) {
    throw new Error("Dex handoff did not contain the minimum five memories");
  }
}

async function verifyHandoffIntegrity(handoff: HandoffDocument): Promise<void> {
  const key = process.env.DEX_HANDOFF_SIGNING_KEY;
  if (!key) throw new Error("Modal secret DEX_HANDOFF_SIGNING_KEY is unavailable");
  const record = handoff as unknown as Record<string, unknown>;
  const { contentHash: _contentHash, integrity, ...content } = record;
  if (!integrity || typeof integrity !== "object") throw new Error("Handoff integrity manifest is missing");
  const manifest = integrity as Record<string, unknown>;
  const signature = manifest.signature as Record<string, unknown> | undefined;
  const actualContentHash = sha256(canonicalJson(content));
  if (!safeEqual(actualContentHash, handoff.contentHash)) throw new Error("Handoff content hash mismatch");
  if (manifest.contentSha256 !== handoff.contentHash) throw new Error("Handoff manifest content hash mismatch");
  if (signature?.algorithm !== "hmac-sha256" || typeof signature.value !== "string") {
    throw new Error("Handoff HMAC signature is missing or unsupported");
  }
  const { signature: _signature, ...unsignedManifest } = manifest;
  const expected = createHmac("sha256", key).update(canonicalJson(unsignedManifest)).digest("hex");
  if (!safeEqual(expected, signature.value)) throw new Error("Handoff HMAC signature is invalid");
  const bundle = await readFile(path.join(root, "repo.bundle"));
  const artifact = Array.isArray(manifest.artifacts)
    ? (manifest.artifacts as Array<Record<string, unknown>>).find((item) => item.path === "repo.bundle")
    : undefined;
  if (!artifact || artifact.sha256 !== sha256(bundle)) throw new Error("Git bundle hash mismatch");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number in handoff");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`Unsupported handoff value: ${typeof value}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function nonSecretEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)(?:_|$)/i.test(name),
  ));
}

/**
 * The coding worker receives only its model credential. Handoff signing and
 * Modal control credentials remain outside the worker trust boundary.
 */
function codexEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...nonSecretEnvironment(),
    NO_COLOR: "1",
  };
  if (process.env.OPENAI_API_KEY) {
    environment.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  return environment;
}

function redactText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sb|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)[A-Za-z0-9_]*)\s*([=:])\s*([^\s,;]+)/gi,
      "$1$2[REDACTED]",
    );
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  await runCloudWorker().catch((error) => {
    process.stderr.write(
      `${redactText(error instanceof Error ? error.stack ?? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
}
