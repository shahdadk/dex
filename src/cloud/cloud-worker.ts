import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

interface HandoffDocument {
  taskId: string;
  contentHash: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  repository: { workingBranch: string; headCommit: string };
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
const CODEX_WORKER_PROFILE = "modal-worker";
const CODEX_BOOTSTRAP_PROFILE = "modal-bootstrap";
const SECRET_ENVIRONMENT_NAME = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)(?:_|$)/i;
const SECRET_ENVIRONMENT_GREP = "(^|_)(TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)(_|$)";
const MAX_BOOTSTRAP_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_CODEX_AUTH_BYTES = 16 * 1024 * 1024;
const MAX_HANDOFF_KEY_BYTES = 4 * 1024;
const MAX_TERMINAL_SUMMARY_LENGTH = 500;
const MAX_FAILED_VALIDATION_COMMAND_LENGTH = 180;
const TRUSTED_CODEX_PACKAGE_ROOT = "/usr/local/lib/node_modules/@openai/codex";
const CODEX_ARG0_GENERATION = /^codex-arg0[A-Za-z0-9_-]{1,128}$/;
const CODEX_ARG0_REQUIRED_ENTRIES = [
  ".lock",
  "apply_patch",
  "applypatch",
  "codex-execve-wrapper",
] as const;
const CODEX_ARG0_OPTIONAL_ENTRIES = ["codex-linux-sandbox"] as const;

interface AuthCacheIdentity {
  dev: number;
  ino: number;
}

interface CodexRuntime {
  persistentHome: string;
  persistentAuthIdentity: AuthCacheIdentity;
  workerHome: string;
  sandboxHome: string;
}

interface AuthVolumePersistedEvidence {
  version: 1;
  method: "modal-volume-v2-sync";
  mountPath: "/codex-home";
  taskId: string;
  handoffSha256: string;
  authSha256: string;
  persistedAt: string;
}

interface TerminalResultDraft {
  taskId: string;
  handoffSha256: string;
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  validation: { commands: string[]; passed: boolean };
  git: {
    branch: string;
    commit: string;
    bundlePath?: string;
    bundleSha256?: string;
  };
}

let activeCodexRuntime: CodexRuntime | undefined;

export async function runCloudWorker(): Promise<void> {
  let handoff: HandoffDocument | undefined;
  let failure: unknown;
  let terminalResult: TerminalResultDraft | undefined;
  let authPersistenceRequired = false;
  let authVolumePersisted: AuthVolumePersistedEvidence | undefined;
  try {
    handoff = JSON.parse(await readFile(path.join(root, "handoff.json"), "utf8")) as HandoffDocument;
    requireHandoff(handoff);
    await verifyHandoffIntegrity(handoff);
    // Older deployments supplied this through an environment secret. The
    // current worker accepts only the one-time file, but remove any inherited
    // legacy value before a tool or coding process can inspect the environment.
    delete process.env.DEX_HANDOFF_SIGNING_KEY;
    await mkdir(workspaceRoot(), { recursive: true, mode: 0o700 });
    activeCodexRuntime = await createCodexRuntime();
    authPersistenceRequired = true;
    await run(
      "codex",
      ["login", "status"],
      workspaceRoot(),
      true,
      codexEnvironment(activeCodexRuntime.workerHome),
    );
    await validateEphemeralCodexHome(activeCodexRuntime.workerHome);
    await installCodexPermissionProfile(
      activeCodexRuntime.workerHome,
      CODEX_WORKER_PROFILE,
      [activeCodexRuntime.persistentHome, activeCodexRuntime.workerHome],
      true,
      true,
      [path.join(activeCodexRuntime.workerHome, "tmp", "arg0")],
    );

    await runSafeHostGit(["clone", path.join(root, "repo.bundle"), project], workspaceRoot());
    await runSafeHostGit(["-C", project, "checkout", handoff.repository.workingBranch]);
    const checkedOutHead = (
      await runSafeHostGit(["-C", project, "rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    if (!safeEqual(checkedOutHead, handoff.repository.headCommit)) {
      throw new Error("Checked-out Git HEAD does not match the signed handoff commit");
    }
    await rejectProjectCodexConfig();
    await verifyCodexPermissionBoundary(CODEX_WORKER_PROFILE, project);
    await bootstrapDependencies();
    await rejectProjectCodexConfig();

    const worker = spawn("codex", [
      "--profile",
      CODEX_WORKER_PROFILE,
      "--ask-for-approval",
      "never",
      "exec",
      "--cd",
      project,
      "--strict-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "-",
    ], {
      cwd: project,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexEnvironment(activeCodexRuntime.workerHome),
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
      validations.push({
        argv: command,
        result: await runCredentialDenied(command[0]!, command.slice(1), project, false),
      });
    }
    const failedValidation = validations.find(({ result }) => result.exitCode !== 0);
    const validationPassed = failedValidation === undefined;
    const succeeded = exitCode === 0 && turnCompleted && validationPassed;
    if (succeeded) {
      // The worker's permission profile deliberately keeps .git read-only.
      // Once untrusted task execution and validation have ended, Dex inspects
      // local Git configuration and snapshots the changed tree through its
      // credential-free, hook-free trusted Git boundary.
      await assertSafeRepositoryGitConfiguration();
      const status = await runSafeHostGit(["-C", project, "status", "--porcelain=v1"]);
      if (status.stdout.trim()) {
        await runSafeHostGit(["-C", project, "add", "--all"]);
        await runSafeHostGit(["-C", project, "commit", "-m", "dex: complete cloud continuation"]);
      }
    }
    const commit = (await runCredentialDeniedGit(["rev-parse", "HEAD"])).stdout.trim();
    const resultBundlePath = path.join(root, "result.bundle");
    // The permission profile intentionally cannot write /dex. Git creates an
    // untrusted staging artifact in its workspace. The trusted parent opens
    // that artifact without following links, validates the descriptor, and
    // copies its bytes into a newly-created /dex file.
    const stagedResultBundlePath = path.join(project, ".dex-result.bundle");
    await runCredentialDeniedGit([
      "bundle",
      "create",
      stagedResultBundlePath,
      handoff.repository.workingBranch,
    ]);
    const resultBundleSha256 = await publishTrustedResultBundle(
      stagedResultBundlePath,
      resultBundlePath,
    );
    terminalResult = {
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      status: succeeded ? "succeeded" : "failed",
      summary: succeeded
        ? summary
        : failedValidation
          ? summarizeValidationFailure(failedValidation)
          : summarizeCodexFailure(exitCode, turnCompleted, stderr),
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
    };
    if (!succeeded) process.exitCode = 1;
  } catch (error) {
    failure = error;
  } finally {
    const runtime = activeCodexRuntime;
    if (runtime) {
      try {
        if (!handoff) throw new Error("Cannot bind auth persistence to a missing handoff");
        authVolumePersisted = await persistRefreshedCodexAuth(runtime, handoff);
      } catch (error) {
        failure ??= error;
      } finally {
        activeCodexRuntime = undefined;
        await Promise.all([
          rm(runtime.workerHome, { recursive: true, force: true }),
          rm(runtime.sandboxHome, { recursive: true, force: true }),
        ]);
      }
    }
  }
  if (terminalResult && authVolumePersisted) {
    await writeJsonAtomic(path.join(root, "result.json"), {
      ...terminalResult,
      authVolumePersisted,
    });
  }
  if (failure) {
    // Once a Codex runtime may have refreshed auth, result.json is itself a
    // terminal publication boundary. If explicit Modal v2 sync failed, leave
    // it absent so the monitor can rely only on sandbox termination evidence.
    if (handoff && (!authPersistenceRequired || authVolumePersisted)) {
      await writeJsonAtomic(path.join(root, "result.json"), {
        taskId: handoff.taskId,
        handoffSha256: handoff.contentHash,
        status: "failed",
        summary: bounded(redactText(failure instanceof Error ? failure.message : String(failure)), 500),
        validation: { commands: [], passed: false },
        git: { branch: handoff.repository.workingBranch, commit: "unavailable" },
        ...(authVolumePersisted ? { authVolumePersisted } : {}),
      }).catch(() => undefined);
    }
    throw failure;
  }
  if (!terminalResult || !authVolumePersisted) {
    throw new Error("Cloud worker did not publish terminal auth persistence evidence");
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
      // User-facing status should keep the beginning of the worker's semantic
      // result. The log accumulator below intentionally keeps the tail, but
      // applying that policy here turned "Fixed …" into "xed …" whenever a
      // response exceeded the 500-character result limit.
      summary = boundedStart(redactText(item.text.replace(/\s+/g, " ").trim()), 500);
    }
  }
  return { ...(threadId ? { threadId } : {}), turnCompleted, summary };
}

function buildCloudPrompt(handoff: HandoffDocument): string {
  const memory = handoff.memories.map((item) => `- [${item.id}] ${item.title}: ${(item.facts ?? []).join("; ") || item.narrative || ""}`).join("\n");
  const failures = handoff.failedApproaches.map((item) => `- DO NOT REPEAT: ${item.approach}. WHY: ${item.reason}`).join("\n");
  return `You are a fresh Codex coding worker continuing a durable Dex task.\n\nREPOSITORY:\n${project}\n\nTASK:\n${handoff.goal}\n\nCONSTRAINTS:\n${handoff.constraints.map((value) => `- ${value}`).join("\n")}\n\nACCEPTANCE CRITERIA:\n${handoff.acceptanceCriteria.map((value) => `- ${value}`).join("\n")}\n\nINHERITED MEMORY:\n${memory}\n\nFAILED APPROACHES:\n${failures}\n\nComplete the implementation in the repository above and run appropriate validation. Edit working-tree files directly. Do not run git add, git commit, git checkout, git reset, git clean, or any other command that mutates Git metadata; Dex will snapshot the working tree after validation. Read-only Git commands are allowed. Do not push, deploy, merge, or repeat a failed approach without new evidence.`;
}

async function run(
  command: string,
  args: string[],
  cwd?: string,
  reject = true,
  environment: NodeJS.ProcessEnv = nonSecretEnvironment(),
): Promise<CommandResult> {
  return new Promise((resolve, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
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

function credentialDeniedSandboxArgs(
  profile: string,
  command: string,
  args: readonly string[],
  cwd: string,
): string[] {
  return [
    "sandbox",
    "--profile",
    profile,
    "--permission-profile",
    profile,
    "--cd",
    cwd,
    "--",
    command,
    ...args,
  ];
}

/**
 * Runs commands whose executable or inputs may be controlled by the checked
 * out repository. The Codex sandbox launcher gets a profile-only home with no
 * account auth, while the child is denied credential homes, parent /proc
 * environments, secret-like environment names, and network access.
 */
async function runCredentialDenied(
  command: string,
  args: readonly string[],
  cwd: string,
  reject = true,
): Promise<CommandResult> {
  return runCredentialDeniedWithProfile(CODEX_WORKER_PROFILE, command, args, cwd, reject);
}

async function runCredentialDeniedWithProfile(
  profile: string,
  command: string,
  args: readonly string[],
  cwd: string,
  reject = true,
): Promise<CommandResult> {
  const runtime = requireActiveCodexRuntime();
  return run(
    "codex",
    credentialDeniedSandboxArgs(profile, command, args, cwd),
    cwd,
    reject,
    codexEnvironment(runtime.sandboxHome),
  );
}

const SAFE_GIT_CONFIGURATION = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.attributesFile=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "credential.helper=",
  "-c", "core.sshCommand=/usr/bin/false",
  "-c", "user.name=Dex Cloud",
  "-c", "user.email=dex@localhost",
] as const;

const UNSAFE_LOCAL_GIT_CONFIG = /^(?:include(?:if\..+)?\.path|core\.(?:hookspath|fsmonitor|worktree|sshcommand|pager|editor|gitproxy)|filter\..+|credential\..+|diff\.external|diff\..+\.command|difftool\..+\.cmd|merge\..+\.driver|mergetool\..+\.cmd|gpg\..+|user\.signingkey|commit\.gpgsign|tag\.gpgsign|pager\..+|sequence\.editor)$/i;

function safeGitEnvironment(readLocalConfiguration = false): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "/usr/bin/true",
    GIT_SEQUENCE_EDITOR: "/usr/bin/true",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  if (!readLocalConfiguration) environment.GIT_CONFIG = "/dev/null";
  if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
  return environment;
}

async function runSafeHostGit(
  args: readonly string[],
  cwd = project,
  reject = true,
): Promise<CommandResult> {
  return run(
    "/usr/bin/git",
    [...SAFE_GIT_CONFIGURATION, ...args],
    cwd,
    reject,
    safeGitEnvironment(),
  );
}

async function assertSafeRepositoryGitConfiguration(): Promise<void> {
  const result = await run(
    "/usr/bin/git",
    ["-C", project, "config", "--local", "--no-includes", "--name-only", "--null", "--list"],
    project,
    false,
    safeGitEnvironment(true),
  );
  if (result.exitCode !== 0) {
    throw new Error("Repository Git configuration could not be inspected safely");
  }
  const unsafe = result.stdout
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .find((name) => UNSAFE_LOCAL_GIT_CONFIG.test(name));
  if (unsafe) {
    throw new Error(`Repository Git configuration is unsafe for cloud result snapshotting: ${unsafe}`);
  }
}

async function runCredentialDeniedGit(
  args: readonly string[],
  reject = true,
): Promise<CommandResult> {
  return runCredentialDenied(
    "git",
    [...SAFE_GIT_CONFIGURATION, "-C", project, ...args],
    project,
    reject,
  );
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
  if (
    !value?.taskId
    || !value.goal
    || !value.contentHash
    || !value.repository?.workingBranch
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.repository.headCommit)
  ) {
    throw new Error("Invalid Dex handoff document");
  }
  if (!Array.isArray(value.memories) || value.memories.length < 5) {
    throw new Error("Dex handoff did not contain the minimum five memories");
  }
}

async function verifyHandoffIntegrity(handoff: HandoffDocument): Promise<void> {
  const key = await consumeHandoffSigningKey();
  try {
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
  } finally {
    key.fill(0);
  }
}

async function consumeHandoffSigningKey(): Promise<Buffer> {
  const keyPath = path.join(root, "handoff.key");
  let keyHandle;
  try {
    keyHandle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await keyHandle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("Dex handoff key must be one regular file");
    }
    assertCurrentOwner(metadata.uid, "Dex handoff key");
    if ((metadata.mode & 0o777) !== 0o600 || metadata.size < 16 || metadata.size > MAX_HANDOFF_KEY_BYTES) {
      throw new Error("Dex handoff key has invalid permissions or size");
    }
    return await keyHandle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Dex handoff key must not be a symbolic link");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Dex handoff key is unavailable");
    }
    throw error;
  } finally {
    await keyHandle?.close().catch(() => undefined);
    await unlink(keyPath).catch(() => undefined);
  }
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

function boundedStart(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function boundedStartWithEllipsis(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function boundedEndWithEllipsis(value: string, max: number): string {
  return value.length > max ? `…${value.slice(value.length - max + 1)}` : value;
}

function summarizeValidationFailure(validation: {
  argv: string[];
  result: CommandResult;
}): string {
  const command = boundedStartWithEllipsis(
    redactText(JSON.stringify(validation.argv)),
    MAX_FAILED_VALIDATION_COMMAND_LENGTH,
  );
  const streams = [
    validation.result.stdout.trim() ? `stdout: ${validation.result.stdout.trim()}` : "",
    validation.result.stderr.trim() ? `stderr: ${validation.result.stderr.trim()}` : "",
  ].filter(Boolean);
  const usefulOutput = redactText(
    (streams.join(" ") || "output: no stdout or stderr was produced").replace(/\s+/g, " "),
  );
  const prefix = `Validation failed for command ${command} (exit ${validation.result.exitCode}). `;
  return `${prefix}${boundedEndWithEllipsis(
    usefulOutput,
    MAX_TERMINAL_SUMMARY_LENGTH - prefix.length,
  )}`;
}

function summarizeCodexFailure(exitCode: number, turnCompleted: boolean, stderr: string): string {
  const reason = exitCode !== 0
    ? `Codex failed with exit code ${exitCode}.`
    : turnCompleted
      ? "Cloud continuation failed."
      : "Codex failed to complete the cloud continuation.";
  const usefulOutput = redactText(stderr.trim().replace(/\s+/g, " "));
  if (!usefulOutput) return reason;
  const prefix = `${reason} stderr: `;
  return `${prefix}${boundedEndWithEllipsis(
    usefulOutput,
    MAX_TERMINAL_SUMMARY_LENGTH - prefix.length,
  )}`;
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
    !SECRET_ENVIRONMENT_NAME.test(name),
  ));
}

/** A Codex subprocess receives only its assigned CODEX_HOME and no environment credentials. */
function codexEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...nonSecretEnvironment(),
    CODEX_HOME: home,
    GIT_OPTIONAL_LOCKS: "0",
    NO_COLOR: "1",
  };
  delete environment.CODEX_API_KEY;
  delete environment.OPENAI_API_KEY;
  return environment;
}

async function verifyCodexAuthentication(home: string): Promise<AuthCacheIdentity> {
  const resolvedHome = path.resolve(home);
  if (!path.isAbsolute(home)) {
    throw new Error("The configured CODEX_HOME must be an absolute directory");
  }
  const authPath = path.join(resolvedHome, "auth.json");
  if (path.dirname(authPath) !== resolvedHome) {
    throw new Error("Codex account authentication escaped the configured CODEX_HOME");
  }

  const directoryHandle = await open(
    resolvedHome,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const homeMetadata = await directoryHandle.stat();
    if (!homeMetadata.isDirectory()) throw new Error("The configured CODEX_HOME is not a directory");
    assertCurrentOwner(homeMetadata.uid, "CODEX_HOME");
    await directoryHandle.chmod(0o700);
    if (((await directoryHandle.stat()).mode & 0o777) !== 0o700) {
      throw new Error("Codex account authentication directory permissions could not be secured");
    }
  } finally {
    await directoryHandle.close();
  }

  let authHandle;
  try {
    authHandle = await open(authPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error("Codex account authentication cache must not be a symbolic link");
    }
    if (code === "ENOENT") {
      throw new Error("Codex account authentication is missing from the configured CODEX_HOME");
    }
    throw error;
  }
  try {
    const metadata = await authHandle.stat();
    if (!metadata.isFile()) throw new Error("Codex account authentication cache is not a regular file");
    if (metadata.nlink !== 1) throw new Error("Codex account authentication cache must not be hard-linked");
    assertCurrentOwner(metadata.uid, "Codex account authentication cache");
    await authHandle.chmod(0o600);
    const securedAuth = await authHandle.stat();
    if (!securedAuth.isFile() || securedAuth.nlink !== 1 || (securedAuth.mode & 0o777) !== 0o600) {
      throw new Error("Codex account authentication permissions could not be secured");
    }
    if (securedAuth.size > MAX_CODEX_AUTH_BYTES) {
      throw new Error("Codex account authentication cache exceeds the allowed size");
    }
    return { dev: securedAuth.dev, ino: securedAuth.ino };
  } finally {
    await authHandle.close();
  }
}

function assertCurrentOwner(actualUid: number, label: string): void {
  if (typeof process.getuid === "function" && actualUid !== process.getuid()) {
    throw new Error(`${label} must be owned by the cloud worker user`);
  }
}

function workspaceRoot(): string {
  return path.dirname(project);
}

function codexHome(): string {
  const value = process.env.CODEX_HOME;
  if (!value) throw new Error("Codex requires a persistent CODEX_HOME account login");
  return value;
}

function requireActiveCodexRuntime(): CodexRuntime {
  if (!activeCodexRuntime) throw new Error("Codex runtime isolation is unavailable");
  return activeCodexRuntime;
}

/**
 * Accepts only the credential plus Codex's transient arg0 helper tree.
 * Nothing below `tmp/` is persisted: only a separately revalidated auth.json
 * is copied back to the private Modal Volume after the serialized worker ends.
 */
export async function validateEphemeralCodexHome(
  home: string,
  trustedPackageRoot = TRUSTED_CODEX_PACKAGE_ROOT,
): Promise<void> {
  await verifyCodexAuthentication(home);
  const rootEntries = (await readdir(home)).sort();
  if (rootEntries.length === 1 && rootEntries[0] === "auth.json") return;
  if (rootEntries.length !== 2 || rootEntries[0] !== "auth.json" || rootEntries[1] !== "tmp") {
    throw new Error("Temporary Codex account home contains an unrecognized root entry");
  }

  const temporaryRoot = path.join(home, "tmp");
  const arg0Root = path.join(temporaryRoot, "arg0");
  await validateOwnedDirectory(temporaryRoot, "Codex temporary directory");
  if (!sameEntries(await readdir(temporaryRoot), ["arg0"])) {
    throw new Error("Temporary Codex account home contains an unrecognized tmp entry");
  }
  await validateOwnedDirectory(arg0Root, "Codex arg0 directory");
  const generations = await readdir(arg0Root);
  if (generations.length !== 1 || !CODEX_ARG0_GENERATION.test(generations[0]!)) {
    throw new Error("Temporary Codex account home contains an invalid arg0 generation");
  }

  const generationRoot = path.join(arg0Root, generations[0]!);
  await validateOwnedDirectory(generationRoot, "Codex arg0 generation");
  const generationEntries = (await readdir(generationRoot)).sort();
  const requiredEntries = [...CODEX_ARG0_REQUIRED_ENTRIES];
  const allowedEntries = new Set<string>([
    ...requiredEntries,
    ...CODEX_ARG0_OPTIONAL_ENTRIES,
  ]);
  if (
    !requiredEntries.every((entry) => generationEntries.includes(entry))
    || generationEntries.some((entry) => !allowedEntries.has(entry))
  ) {
    throw new Error("Temporary Codex account home contains an invalid arg0 helper set");
  }

  const lockPath = path.join(generationRoot, ".lock");
  let lockHandle;
  try {
    lockHandle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Codex arg0 lock must not be a symbolic link");
    }
    throw error;
  }
  try {
    const metadata = await lockHandle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== 0) {
      throw new Error("Codex arg0 lock must be one empty regular file");
    }
    assertTrustedFileOwner(metadata.uid, "Codex arg0 lock");
    if ((metadata.mode & 0o133) !== 0) {
      throw new Error("Codex arg0 lock has unsafe permissions");
    }
  } finally {
    await lockHandle.close();
  }

  const trustedRoot = await validateTrustedCodexPackageRoot(trustedPackageRoot);
  let trustedExecutable: string | undefined;
  for (const alias of generationEntries.filter((entry) => entry !== ".lock")) {
    const aliasPath = path.join(generationRoot, alias);
    const aliasMetadata = await lstat(aliasPath);
    if (!aliasMetadata.isSymbolicLink()) {
      throw new Error(`Codex arg0 helper ${alias} must be a symbolic link`);
    }
    assertTrustedFileOwner(aliasMetadata.uid, `Codex arg0 helper ${alias}`);
    const resolvedTarget = await realpath(aliasPath);
    if (!isDescendant(trustedRoot, resolvedTarget) || path.basename(resolvedTarget) !== "codex") {
      throw new Error(`Codex arg0 helper ${alias} points outside the trusted Codex package`);
    }
    const targetMetadata = await stat(resolvedTarget);
    if (!targetMetadata.isFile() || (targetMetadata.mode & 0o111) === 0) {
      throw new Error(`Codex arg0 helper ${alias} does not target an executable file`);
    }
    assertTrustedFileOwner(targetMetadata.uid, `Codex arg0 helper target ${alias}`);
    if ((targetMetadata.mode & 0o022) !== 0) {
      throw new Error(`Codex arg0 helper target ${alias} is writable by another user`);
    }
    if (trustedExecutable !== undefined && trustedExecutable !== resolvedTarget) {
      throw new Error("Codex arg0 helpers do not resolve to the same executable");
    }
    trustedExecutable = resolvedTarget;
  }
}

async function validateOwnedDirectory(directory: string, label: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} must not be a symbolic link`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error(`${label} is not a directory`);
    assertTrustedFileOwner(metadata.uid, label);
    if ((metadata.mode & 0o022) !== 0) throw new Error(`${label} is writable by another user`);
  } finally {
    await handle.close();
  }
}

async function validateTrustedCodexPackageRoot(packageRoot: string): Promise<string> {
  await validateOwnedDirectory(packageRoot, "Trusted Codex package root");
  return realpath(packageRoot);
}

function assertTrustedFileOwner(actualUid: number, label: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (actualUid !== 0 && currentUid !== undefined && actualUid !== currentUid) {
    throw new Error(`${label} must be owned by root or the cloud worker user`);
  }
}

function sameEntries(actual: string[], expected: string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function isDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function createCodexRuntime(): Promise<CodexRuntime> {
  const configuredHome = codexHome();
  const persistentHome = path.resolve(configuredHome);
  const persistentAuthIdentity = await verifyCodexAuthentication(persistentHome);
  const workerHome = await mkdtemp(path.join(workspaceRoot(), ".dex-codex-auth-"));
  const sandboxHome = await mkdtemp(path.join(workspaceRoot(), ".dex-codex-sandbox-"));
  await Promise.all([chmod(workerHome, 0o700), chmod(sandboxHome, 0o700)]);
  try {
    await copyTrustedAuthCache(
      path.join(persistentHome, "auth.json"),
      path.join(workerHome, "auth.json"),
    );
    await verifyCodexAuthentication(workerHome);
    const deniedCredentialRoots = [persistentHome, workerHome];
    await installCodexPermissionProfile(
      sandboxHome,
      CODEX_WORKER_PROFILE,
      deniedCredentialRoots,
      true,
    );
    await installCodexPermissionProfile(
      sandboxHome,
      CODEX_BOOTSTRAP_PROFILE,
      deniedCredentialRoots,
      true,
    );
    return { persistentHome, persistentAuthIdentity, workerHome, sandboxHome };
  } catch (error) {
    await Promise.all([
      rm(workerHome, { recursive: true, force: true }),
      rm(sandboxHome, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

async function copyTrustedAuthCache(
  sourcePath: string,
  destinationPath: string,
): Promise<AuthCacheIdentity> {
  let source;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Codex account authentication cache must not be a symbolic link");
    }
    throw error;
  }
  let destination;
  let destinationCreated = false;
  try {
    const before = await source.stat();
    assertTrustedAuthCache(before);
    if (before.size > MAX_CODEX_AUTH_BYTES) {
      throw new Error("Codex account authentication cache exceeds the allowed size");
    }
    const contents = await source.readFile();
    const after = await source.stat();
    assertTrustedAuthCache(after);
    if (!sameFileVersion(before, after)) {
      throw new Error("Codex account authentication cache changed while being copied");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch (error) {
      throw new Error("Codex account authentication cache is not valid JSON", { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Codex account authentication cache must contain a JSON object");
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    destinationCreated = true;
    await destination.writeFile(contents);
    await destination.sync();
    const copied = await destination.stat();
    assertTrustedAuthCache(copied);
    if ((copied.mode & 0o777) !== 0o600 || copied.size !== contents.length) {
      throw new Error("Copied Codex account authentication cache is not secure");
    }
    return { dev: copied.dev, ino: copied.ino };
  } catch (error) {
    if (destinationCreated) await unlink(destinationPath).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([
      source.close().catch(() => undefined),
      destination?.close().catch(() => undefined),
    ]);
  }
}

function assertTrustedAuthCache(metadata: Stats): void {
  if (!metadata.isFile()) throw new Error("Codex account authentication cache is not a regular file");
  if (metadata.nlink !== 1) throw new Error("Codex account authentication cache must not be hard-linked");
  assertCurrentOwner(metadata.uid, "Codex account authentication cache");
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function persistRefreshedCodexAuth(
  runtime: CodexRuntime,
  handoff: HandoffDocument,
): Promise<AuthVolumePersistedEvidence> {
  const persistentAuthPath = path.join(runtime.persistentHome, "auth.json");
  const currentIdentity = await verifyCodexAuthentication(runtime.persistentHome);
  if (
    currentIdentity.dev !== runtime.persistentAuthIdentity.dev
    || currentIdentity.ino !== runtime.persistentAuthIdentity.ino
  ) {
    throw new Error("Persistent Codex account authentication changed during the serialized run");
  }

  const pendingPath = path.join(runtime.persistentHome, `.auth.${randomUUID()}.tmp`);
  let pendingIdentity: AuthCacheIdentity | undefined;
  try {
    pendingIdentity = await copyTrustedAuthCache(
      path.join(runtime.workerHome, "auth.json"),
      pendingPath,
    );
    await rename(pendingPath, persistentAuthPath);
    const installedIdentity = await verifyCodexAuthentication(runtime.persistentHome);
    if (
      installedIdentity.dev !== pendingIdentity.dev
      || installedIdentity.ino !== pendingIdentity.ino
    ) {
      throw new Error("Persisted Codex account authentication lost inode continuity");
    }
    const directory = await open(
      runtime.persistentHome,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const syncResult = await run(
      "sync",
      [runtime.persistentHome],
      workspaceRoot(),
      false,
      nonSecretEnvironment(),
    );
    if (syncResult.exitCode !== 0) {
      throw new Error("Explicit Modal v2 Codex auth Volume sync failed");
    }
    const persisted = await readFile(persistentAuthPath);
    return {
      version: 1,
      method: "modal-volume-v2-sync",
      mountPath: "/codex-home",
      taskId: handoff.taskId,
      handoffSha256: handoff.contentHash,
      authSha256: sha256(persisted),
      persistedAt: new Date().toISOString(),
    };
  } finally {
    await unlink(pendingPath).catch(() => undefined);
  }
}

async function rejectProjectCodexConfig(): Promise<void> {
  const directoryPath = path.join(project, ".codex");
  let directory;
  try {
    directory = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error("Project-local .codex/config.toml is not allowed in cloud continuation");
    }
    throw error;
  }
  try {
    const configPath = path.join(directoryPath, "config.toml");
    let config;
    try {
      config = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "ELOOP") {
        throw new Error("Project-local .codex/config.toml is not allowed in cloud continuation");
      }
      throw error;
    }
    await config.close();
    throw new Error("Project-local .codex/config.toml is not allowed in cloud continuation");
  } finally {
    await directory.close();
  }
}

function codexPermissionProfile(
  profile: string,
  deniedCredentialRoots: readonly string[],
  networkEnabled: boolean,
  selectByDefault = false,
  readOnlyRoots: readonly string[] = [],
): string {
  const deniedRoots = [...new Set(["/codex-home", ...deniedCredentialRoots])]
    .map((value) => `${JSON.stringify(value)} = "deny"`)
    .join("\n");
  const readableRoots = [...new Set(readOnlyRoots)]
    .map((value) => `${JSON.stringify(value)} = "read"`)
    .join("\n");
  return `${selectByDefault ? `project_doc_max_bytes = 0\ndefault_permissions = "${profile}"\n` : ""}approval_policy = "never"

[permissions.${profile}]
extends = ":workspace"

[permissions.${profile}.filesystem]
":root" = "deny"
":minimal" = "read"
${deniedRoots}
${readableRoots}

[permissions.${profile}.filesystem.":workspace_roots"]
"." = "write"

[permissions.${profile}.network]
enabled = ${networkEnabled ? "true" : "false"}

[shell_environment_policy]
inherit = "core"
set = { GIT_OPTIONAL_LOCKS = "0" }

[shell_environment_policy.filters]
CODEX_HOME = "exclude"
OPENAI_API_KEY = "exclude"
CODEX_API_KEY = "exclude"
DEX_HANDOFF_SIGNING_KEY = "exclude"
DEX_CLOUD_PROJECT = "exclude"
DEX_CLOUD_ROOT = "exclude"
`;
}

async function installCodexPermissionProfile(
  sandboxHome: string,
  profile: string,
  deniedCredentialRoots: readonly string[],
  networkEnabled: boolean,
  selectByDefault = false,
  readOnlyRoots: readonly string[] = [],
): Promise<void> {
  const profilePath = path.join(sandboxHome, `${profile}.config.toml`);
  await writeTextAtomic(
    profilePath,
    codexPermissionProfile(
      profile,
      deniedCredentialRoots,
      networkEnabled,
      selectByDefault,
      readOnlyRoots,
    ),
  );
  await chmod(profilePath, 0o600);
  if (((await stat(profilePath)).mode & 0o777) !== 0o600) {
    throw new Error("Codex Modal worker profile permissions could not be secured");
  }
}

async function verifyCodexPermissionBoundary(
  profile: string,
  cwd: string,
  deniedRepositoryPath?: string,
): Promise<void> {
  const runtime = requireActiveCodexRuntime();
  const smokeScript = [
    'test ! -r "$1/auth.json" || exit 41',
    'test ! -r "$2/auth.json" || exit 42',
    'test -z "${CODEX_HOME-}${OPENAI_API_KEY-}${CODEX_API_KEY-}${DEX_HANDOFF_SIGNING_KEY-}" || exit 43',
    `if env | cut -d= -f1 | grep -Eiq '${SECRET_ENVIRONMENT_GREP}'; then exit 44; fi`,
    `if test -r /proc/1/environ && tr '\\0' '\\n' </proc/1/environ | cut -d= -f1 | grep -Eiq '${SECRET_ENVIRONMENT_GREP}'; then exit 45; fi`,
    ...(deniedRepositoryPath ? ['test ! -r "$3/.git/HEAD" || exit 46'] : []),
  ].join("; ");
  const smoke = await run("codex", credentialDeniedSandboxArgs(
    profile,
    "sh",
    [
      "-ceu",
      smokeScript,
      "dex-modal-boundary-smoke",
      runtime.persistentHome,
      runtime.workerHome,
      ...(deniedRepositoryPath ? [deniedRepositoryPath] : []),
    ],
    cwd,
  ), cwd, false, codexEnvironment(runtime.sandboxHome));
  if (smoke.exitCode !== 0) {
    const reason = ({
      41: "persistent account cache remained readable",
      42: "ephemeral worker account cache remained readable",
      43: "credential environment reached the child",
      44: "a secret-like environment name reached the child",
      45: "the parent process environment remained readable",
      46: "the denied repository remained readable during dependency bootstrap",
    } as Record<number, string>)[smoke.exitCode] ?? "the sandbox launcher rejected the profile";
    throw new Error(`Codex permission-boundary smoke failed: ${reason}`);
  }
}

async function bootstrapDependencies(): Promise<void> {
  const lockPath = path.join(project, "package-lock.json");
  if (!(await exists(lockPath))) return;
  const bootstrapDirectory = await mkdtemp(path.join(workspaceRoot(), ".dex-bootstrap-"));
  await chmod(bootstrapDirectory, 0o700);
  try {
    await Promise.all([
      copyTrustedBootstrapManifest(
        path.join(project, "package.json"),
        path.join(bootstrapDirectory, "package.json"),
      ),
      copyTrustedBootstrapManifest(
        lockPath,
        path.join(bootstrapDirectory, "package-lock.json"),
      ),
    ]);
    await verifyCodexPermissionBoundary(
      CODEX_BOOTSTRAP_PROFILE,
      bootstrapDirectory,
      project,
    );
    const npmCache = path.join(bootstrapDirectory, ".npm-cache");
    await runCredentialDeniedWithProfile(
      CODEX_BOOTSTRAP_PROFILE,
      "/usr/bin/env",
      [
        "NPM_CONFIG_USERCONFIG=/dev/null",
        "NPM_CONFIG_GLOBALCONFIG=/dev/null",
        "NPM_CONFIG_GIT=/usr/bin/git",
        "NPM_CONFIG_IGNORE_SCRIPTS=true",
        "NPM_CONFIG_AUDIT=false",
        "NPM_CONFIG_FUND=false",
        `NPM_CONFIG_CACHE=${npmCache}`,
        "GIT_CONFIG_NOSYSTEM=1",
        "GIT_CONFIG_SYSTEM=/dev/null",
        "GIT_CONFIG_GLOBAL=/dev/null",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_ASKPASS=/usr/bin/false",
        "SSH_ASKPASS=/usr/bin/false",
        "GIT_SSH_COMMAND=/usr/bin/false",
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      bootstrapDirectory,
    );
    const installedModules = path.join(bootstrapDirectory, "node_modules");
    const modulesHandle = await open(
      installedModules,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await modulesHandle.stat();
      if (!metadata.isDirectory()) throw new Error("Dependency bootstrap did not create node_modules");
      assertCurrentOwner(metadata.uid, "Dependency bootstrap node_modules");
    } finally {
      await modulesHandle.close();
    }
    await rename(installedModules, path.join(project, "node_modules"));
  } finally {
    await rm(bootstrapDirectory, { recursive: true, force: true });
  }
}

async function copyTrustedBootstrapManifest(sourcePath: string, destinationPath: string): Promise<void> {
  let source;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Dependency bootstrap manifest must not be a symbolic link");
    }
    throw error;
  }
  let destination;
  try {
    const before = await source.stat();
    assertTrustedBootstrapManifest(before);
    if (before.size > MAX_BOOTSTRAP_MANIFEST_BYTES) {
      throw new Error("Dependency bootstrap manifest exceeds the allowed size");
    }
    const contents = await source.readFile();
    const after = await source.stat();
    assertTrustedBootstrapManifest(after);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Dependency bootstrap manifest changed while being copied");
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await destination.writeFile(contents);
    await destination.sync();
  } finally {
    await Promise.all([
      source.close().catch(() => undefined),
      destination?.close().catch(() => undefined),
    ]);
  }
}

function assertTrustedBootstrapManifest(metadata: Stats): void {
  if (!metadata.isFile()) throw new Error("Dependency bootstrap manifest is not a regular file");
  if (metadata.nlink !== 1) throw new Error("Dependency bootstrap manifest must not be hard-linked");
  assertCurrentOwner(metadata.uid, "Dependency bootstrap manifest");
}

async function publishTrustedResultBundle(
  stagedPath: string,
  trustedPath: string,
): Promise<string> {
  let source;
  try {
    source = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Staged result bundle must not be a symbolic link");
    }
    throw error;
  }

  let destination;
  let destinationCreated = false;
  try {
    const sourceBefore = await source.stat();
    assertTrustedResultFile(sourceBefore, "Staged result bundle");
    destination = await open(
      trustedPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    destinationCreated = true;

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Trusted result bundle copy made no forward progress");
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.sync();

    const [sourceAfter, trustedMetadata] = await Promise.all([
      source.stat(),
      destination.stat(),
    ]);
    assertTrustedResultFile(sourceAfter, "Staged result bundle");
    assertTrustedResultFile(trustedMetadata, "Trusted result bundle");
    if (
      sourceBefore.dev !== sourceAfter.dev ||
      sourceBefore.ino !== sourceAfter.ino ||
      sourceBefore.size !== sourceAfter.size ||
      sourceBefore.mtimeMs !== sourceAfter.mtimeMs ||
      sourceBefore.ctimeMs !== sourceAfter.ctimeMs
    ) {
      throw new Error("Staged result bundle changed while it was being copied");
    }
    return digest.digest("hex");
  } catch (error) {
    if (destinationCreated) {
      await unlink(trustedPath).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all([
      source.close().catch(() => undefined),
      destination?.close().catch(() => undefined),
    ]);
    await unlink(stagedPath).catch(() => undefined);
  }
}

function assertTrustedResultFile(
  metadata: Stats,
  label: string,
): void {
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
  if (metadata.nlink !== 1) throw new Error(`${label} must not be hard-linked`);
  assertCurrentOwner(metadata.uid, label);
}

async function writeTextAtomic(file: string, value: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
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
