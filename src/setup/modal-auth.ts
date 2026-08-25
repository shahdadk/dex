import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ModalAdapter } from "../cloud/modal/adapter.js";
import { ModalCodexAuthVolumeNameSchema } from "../config/config.js";
import { resolveDexPaths } from "../config/paths.js";
import { execFile, type ExecResult } from "../utils/exec.js";

export const DEFAULT_MODAL_CODEX_AUTH_VOLUME = "dex-codex-auth";
export const MODAL_CODEX_HOME = "/codex-home";

const ChatGptAuthSchema = z.object({
  auth_mode: z.literal("chatgpt"),
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().min(1),
  }).passthrough(),
}).passthrough();

const CodexAuthLeaseSchema = z.object({
  version: z.literal(1),
  taskId: z.string().trim().min(1).max(512),
  workerId: z.string().trim().min(1).max(512).optional(),
  operationToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const CODEX_AUTH_LEASE_BUSY = "CODEX_AUTH_LEASE_BUSY";
const SETUP_SANDBOX_TIMEOUT_MS = 120_000;
const SETUP_SANDBOX_TERMINAL_GRACE_MS = 120_000;

/** A queueable capacity condition: another account-auth worker still owns the shared cache. */
export class CodexAuthLeaseBusyError extends Error {
  readonly code = CODEX_AUTH_LEASE_BUSY;
  readonly taskId: string;
  readonly ownerTaskId: string | undefined;

  constructor(taskId: string, ownerTaskId?: string) {
    super("Another Modal Codex worker holds the shared account-auth lease");
    this.name = "CodexAuthLeaseBusyError";
    this.taskId = taskId;
    this.ownerTaskId = ownerTaskId;
  }
}

export function isCodexAuthLeaseBusyError(error: unknown): error is CodexAuthLeaseBusyError {
  return error instanceof CodexAuthLeaseBusyError || (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === CODEX_AUTH_LEASE_BUSY
  );
}

export interface AcquireCodexAuthLeaseOptions {
  workerId?: string;
  operationToken?: string;
  /** Recovery may reclaim only the exact persisted operation's existing lease. */
  adoptExisting?: boolean;
  /** Test-only fault boundary after the durable prepare and before publication. */
  beforePublish?(preparedPath: string): void | Promise<void>;
}

export interface ReleaseCodexAuthLeaseOptions {
  /** Test-only synchronization boundary after atomic capture and before validation. */
  afterCapture?(capturedPath: string): void | Promise<void>;
}

/**
 * Evidence that the mounted auth Volume can no longer be mutated by this
 * Sandbox. Callers that merely observed result.json intentionally cannot
 * release the lease.
 */
export type CodexAuthLeaseReleaseEvidence =
  | {
      kind: "terminal-poll";
      sandboxId: string;
      exitCode: number;
      operationToken: string;
    }
  | {
      kind: "terminate-wait";
      sandboxId: string;
      volumePersisted: true;
      operationToken: string;
    }
  | {
      kind: "auth-volume-sync";
      sandboxId: string;
      handoffSha256: string;
      authSha256: string;
      persistedAt: string;
      operationToken: string;
    }
  | {
      kind: "sandbox-not-created";
      operationToken: string;
    }
  | {
      kind: "setup-operation-expired";
      operationToken: string;
      terminalAfter: string;
      observedAt: string;
    };

const ModalVolumeEntriesSchema = z.array(z.object({
  filename: z.string(),
  type: z.string(),
}).passthrough());

const SetupAuthOperationJournalSchema = z.object({
  version: z.literal(1),
  volumeName: ModalCodexAuthVolumeNameSchema,
  leaseTaskId: z.string().min(1),
  operationToken: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["prepared", "create_started", "sandbox_created", "terminated"]),
  sandboxId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  terminalAfter: z.string().datetime(),
}).strict();

type SetupAuthOperationJournal = z.infer<typeof SetupAuthOperationJournalSchema>;

type Runner = (command: string, args: readonly string[]) => Promise<ExecResult>;

export interface SeedModalCodexAuthOptions {
  authPath?: string;
  volumeName?: string;
  leasePath?: string;
  journalPath?: string;
  operationToken?: string;
  now?: () => Date;
  runner?: Runner;
  modal?: ModalAdapter;
  /** Test-only crash boundary after durable journal publication and before lease acquisition. */
  afterJournalPublished?(journalPath: string): void | Promise<void>;
  report?(result: SeedModalCodexAuthResult): void;
}

export interface SeedModalCodexAuthResult {
  volumeName: string;
  disposition: "seeded" | "reused";
}

export async function validateLocalCodexAuth(authPath = path.join(os.homedir(), ".codex", "auth.json")): Promise<void> {
  let handle;
  try {
    handle = await open(authPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Codex auth cache must be a regular file, not a symbolic link");
    }
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Codex auth cache must be a regular file");
    if (metadata.nlink !== 1) throw new Error("Codex auth cache must not be hard-linked");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Codex auth cache must be owned by the current user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Codex auth cache permissions are too broad; run chmod 600 ~/.codex/auth.json");
    }
    if (metadata.size < 2 || metadata.size > 1024 * 1024) {
      throw new Error("Codex auth cache has an invalid size");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      throw new Error("Codex auth cache is not valid JSON", { cause: error });
    }
    if (!ChatGptAuthSchema.safeParse(parsed).success) {
      throw new Error("Codex auth cache is not a ChatGPT account login");
    }
  } finally {
    await handle.close();
  }
}

/** Seeds auth directly from the user's home directory only when absent; no credential enters the repository. */
export async function seedModalCodexAuth(options: SeedModalCodexAuthOptions = {}): Promise<SeedModalCodexAuthResult> {
  const authPath = options.authPath ?? path.join(os.homedir(), ".codex", "auth.json");
  const requestedVolume = options.volumeName ?? process.env.DEX_MODAL_CODEX_AUTH_VOLUME;
  if (!requestedVolume) {
    throw new Error("A paired device-specific Modal Codex auth Volume is required; run dex setup");
  }
  const volumeName = ModalCodexAuthVolumeNameSchema.parse(
    requestedVolume,
  );
  const leasePath = options.leasePath ?? path.join(
    resolveDexPaths().handoffs,
    ".codex-account-auth.lease",
  );
  const journalPath = options.journalPath ?? `${leasePath}.setup-operation.json`;
  const leaseTaskId = `setup:${volumeName}`;
  const operationToken = options.operationToken ?? randomBytes(32).toString("hex");
  const runner = options.runner ?? execFile;
  let hasRemoteAuth = false;
  const modal = options.modal ?? new ModalAdapter();
  const now = options.now ?? (() => new Date());
  let sandbox: Awaited<ReturnType<ModalAdapter["create"]>> | undefined;
  let leaseAcquired = false;
  let sandboxCreationAttempted = false;
  let operationFailure: unknown;
  let cleanupFailure: unknown;
  try {
    await recoverSetupAuthOperation({
      journalPath,
      leasePath,
      volumeName,
      modal,
      now,
    });
    const createdAt = now();
    let journal: SetupAuthOperationJournal = SetupAuthOperationJournalSchema.parse({
      version: 1,
      volumeName,
      leaseTaskId,
      operationToken,
      phase: "prepared",
      createdAt: createdAt.toISOString(),
      terminalAfter: new Date(
        createdAt.getTime() + SETUP_SANDBOX_TIMEOUT_MS + SETUP_SANDBOX_TERMINAL_GRACE_MS,
      ).toISOString(),
    });
    // Persist intent before acquiring the lease. A crash can therefore leave
    // either no state, or a journal that the next setup can safely adopt; it
    // can never leave an ownerless lease with no recovery identity.
    await createSetupAuthOperationJournal(journalPath, journal);
    await options.afterJournalPublished?.(journalPath);
    await acquireCodexAuthLease(leasePath, leaseTaskId, {
      workerId: "setup-auth-verifier",
      operationToken,
    });
    leaseAcquired = true;
    await validateLocalCodexAuth(authPath);
    const created = await runner("modal", ["volume", "create", "--version=2", volumeName]);
    if (created.exitCode !== 0 && !/already exists/i.test(`${created.stdout}\n${created.stderr}`)) {
      throw new Error("Could not create the private Modal Codex auth Volume");
    }
    const existing = await runner("modal", ["volume", "ls", "--json", volumeName, "auth.json"]);
    if (existing.exitCode === 0) {
      let entries: z.infer<typeof ModalVolumeEntriesSchema>;
      try {
        entries = ModalVolumeEntriesSchema.parse(JSON.parse(existing.stdout));
      } catch (error) {
        throw new Error("Could not validate the private Modal Codex auth Volume listing", { cause: error });
      }
      hasRemoteAuth = entries.some((entry) => entry.filename === "auth.json" && entry.type === "file");
      if (!hasRemoteAuth) {
        throw new Error("The Modal Codex auth path exists but is not a regular auth.json file");
      }
    } else if (!(
      /no such file or directory/i.test(`${existing.stdout}\n${existing.stderr}`) ||
      /path\s+["']?\/auth\.json["']?\s+does not exist/i.test(`${existing.stdout}\n${existing.stderr}`)
    )) {
      throw new Error("Could not inspect the private Modal Codex auth Volume");
    }
    if (!hasRemoteAuth) {
      const uploaded = await runner("modal", [
        "volume", "put", volumeName, authPath, "auth.json",
      ]);
      if (uploaded.exitCode !== 0) {
        throw new Error("Could not seed the Codex auth cache in the private Modal Volume");
      }
    }

    journal = { ...journal, phase: "create_started" };
    await writeSetupAuthOperationJournal(journalPath, journal);
    sandboxCreationAttempted = true;
    try {
      sandbox = await modal.create({
        appName: "dex-auth-setup",
        image: "node:22-bookworm",
        imageCommands: ["RUN npm install --global @openai/codex@0.149.1"],
        volumeNames: { [MODAL_CODEX_HOME]: volumeName },
        params: {
          timeoutMs: SETUP_SANDBOX_TIMEOUT_MS,
          command: ["sleep", String(SETUP_SANDBOX_TIMEOUT_MS / 1000)],
          name: `dex-auth-setup-${operationToken.slice(0, 16)}`,
          tags: setupAuthOperationTags(volumeName, operationToken),
        },
      });
    } catch (createError) {
      const discovered = await discoverSetupAuthOperationSandboxes(
        modal,
        volumeName,
        operationToken,
      ).catch(() => []);
      if (discovered.length !== 1) throw createError;
      sandbox = await modal.fromId(discovered[0]!);
    }
    journal = {
      ...journal,
      phase: "sandbox_created",
      sandboxId: sandbox.sandboxId,
    };
    await writeSetupAuthOperationJournal(journalPath, journal);
    const accountEnvironment = {
      CODEX_HOME: MODAL_CODEX_HOME,
      OPENAI_API_KEY: "",
      CODEX_API_KEY: "",
    };
    const keyCheck = await sandbox.exec([
      "node",
      "-e",
      "if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) process.exit(1)",
    ], { env: accountEnvironment });
    if (await keyCheck.wait() !== 0) throw new Error("Modal Codex account verification exposed an API key");
    const modeCheck = await sandbox.exec([
      "node",
      "-e",
      remoteCodexAuthValidationScript(),
      MODAL_CODEX_HOME,
    ], { env: accountEnvironment });
    if (await modeCheck.wait() !== 0) {
      throw new Error("Modal Codex auth cache is not a ChatGPT account login");
    }
    const status = await sandbox.exec(["codex", "login", "status"], { env: accountEnvironment });
    if (await status.wait() !== 0) throw new Error("Codex did not accept the Modal ChatGPT account login");
    const persisted = await sandbox.exec(["sync", MODAL_CODEX_HOME], { env: accountEnvironment });
    if (await persisted.wait() !== 0) {
      throw new Error(
        "The Modal Codex auth Volume is not v2-compatible or explicit sync failed; configure a new per-device v2 Volume",
      );
    }
  } catch (error) {
    operationFailure = error;
  } finally {
    try {
      if (leaseAcquired && sandbox) {
        await sandbox.terminate({ wait: true });
        const existingJournal = await readSetupAuthOperationJournal(journalPath);
        if (!existingJournal || existingJournal.operationToken !== operationToken) {
          throw new Error("Dex lost ownership of the Modal auth setup operation journal");
        }
        await writeSetupAuthOperationJournal(journalPath, {
          ...existingJournal,
          phase: "terminated",
          sandboxId: sandbox.sandboxId,
        });
        await releaseCodexAuthLease(leasePath, leaseTaskId, {
          kind: "terminate-wait",
          sandboxId: sandbox.sandboxId,
          volumePersisted: true,
          operationToken,
        });
        await unlinkSetupAuthOperationJournal(journalPath);
      } else if (leaseAcquired && !sandboxCreationAttempted) {
        await releaseCodexAuthLease(leasePath, leaseTaskId, {
          kind: "sandbox-not-created",
          operationToken,
        });
        await unlinkSetupAuthOperationJournal(journalPath);
      }
    } catch (error) {
      cleanupFailure = error;
    } finally {
      try {
        await modal.close();
      } catch (error) {
        cleanupFailure = cleanupFailure
          ? new AggregateError([cleanupFailure, error], "Modal auth setup cleanup failed")
          : error;
      }
    }
  }
  if (operationFailure && cleanupFailure) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      "Modal Codex auth setup failed and terminal cleanup was not confirmed",
      { cause: operationFailure },
    );
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  const result = { volumeName } as SeedModalCodexAuthResult;
  // Keep the legacy enumerable shape ({ volumeName }) while exposing an idempotency report to callers.
  Object.defineProperty(result, "disposition", {
    value: hasRemoteAuth ? "reused" : "seeded",
    enumerable: false,
  });
  options.report?.(result);
  return result;
}

function setupAuthOperationTags(
  volumeName: string,
  operationToken: string,
): Record<string, string> {
  return {
    product: "dex",
    purpose: "codex-auth-setup",
    volume: volumeName,
    operation: operationToken,
  };
}

async function discoverSetupAuthOperationSandboxes(
  modal: ModalAdapter,
  volumeName: string,
  operationToken: string,
): Promise<string[]> {
  const client = await modal.client();
  const service = client.sandboxes as typeof client.sandboxes & {
    list?: (params: { tags: Record<string, string> }) => AsyncIterable<{
      sandboxId: string;
      getTags?: () => Promise<Record<string, string>>;
    }>;
  };
  if (typeof service.list !== "function") {
    throw new Error(
      "The installed Modal SDK cannot reconcile the exact auth setup operation; its lease was retained",
    );
  }
  const expectedTags = setupAuthOperationTags(volumeName, operationToken);
  const ids: string[] = [];
  for await (const candidate of service.list({
    tags: expectedTags,
  })) {
    if (typeof candidate.getTags !== "function") {
      throw new Error(
        "The installed Modal SDK cannot verify exact auth setup operation tags; its lease was retained",
      );
    }
    const actualTags = await candidate.getTags();
    if (Object.entries(expectedTags).some(([key, value]) => actualTags[key] !== value)) {
      throw new Error(
        "Modal returned a Sandbox that does not own the exact auth setup operation tags; its lease was retained",
      );
    }
    if (typeof candidate.sandboxId === "string" && candidate.sandboxId) {
      ids.push(candidate.sandboxId);
    }
  }
  return [...new Set(ids)];
}

async function recoverSetupAuthOperation(input: {
  journalPath: string;
  leasePath: string;
  volumeName: string;
  modal: ModalAdapter;
  now(): Date;
}): Promise<void> {
  const journal = await readSetupAuthOperationJournal(input.journalPath);
  if (!journal) return;
  if (journal.volumeName !== input.volumeName) {
    throw new Error(
      `Pending Modal auth setup belongs to ${journal.volumeName}; refusing to reconcile it as ${input.volumeName}`,
    );
  }
  await acquireCodexAuthLease(input.leasePath, journal.leaseTaskId, {
    workerId: "setup-auth-verifier",
    operationToken: journal.operationToken,
    adoptExisting: true,
  });

  if (journal.phase === "terminated" && journal.sandboxId) {
    await releaseCodexAuthLease(input.leasePath, journal.leaseTaskId, {
      kind: "terminate-wait",
      sandboxId: journal.sandboxId,
      volumePersisted: true,
      operationToken: journal.operationToken,
    });
    await unlinkSetupAuthOperationJournal(input.journalPath);
    return;
  }

  // Even a durable `prepared` journal may be the older namespace state left
  // behind by a pre-fix power loss after Sandbox creation. Query Modal by the
  // complete operation identity before concluding that no Sandbox can still
  // mutate the writable auth Volume.
  const sandboxIds = await discoverSetupAuthOperationSandboxes(
    input.modal,
    journal.volumeName,
    journal.operationToken,
  );
  const terminated: string[] = [];
  const unresolved: string[] = [];
  const terminateExactIds = async (ids: readonly string[]) => {
    for (const sandboxId of ids) {
      let sandbox;
      try {
        sandbox = await input.modal.fromId(sandboxId);
      } catch {
        unresolved.push(sandboxId);
        continue;
      }
      await sandbox.terminate({ wait: true });
      terminated.push(sandbox.sandboxId);
    }
  };
  await terminateExactIds(sandboxIds);
  if (unresolved.length > 0 || terminated.length !== sandboxIds.length) {
    throw new Error(
      "An exact-tagged Modal auth setup Sandbox could not be proven terminal; its lease was retained",
    );
  }
  if (terminated.length > 0) {
    const sandboxId = terminated[0]!;
    await writeSetupAuthOperationJournal(input.journalPath, {
      ...journal,
      phase: "terminated",
      sandboxId,
    });
    await releaseCodexAuthLease(input.leasePath, journal.leaseTaskId, {
      kind: "terminate-wait",
      sandboxId,
      volumePersisted: true,
      operationToken: journal.operationToken,
    });
    await unlinkSetupAuthOperationJournal(input.journalPath);
    return;
  }

  if (journal.phase === "prepared") {
    await releaseCodexAuthLease(input.leasePath, journal.leaseTaskId, {
      kind: "sandbox-not-created",
      operationToken: journal.operationToken,
    });
    await unlinkSetupAuthOperationJournal(input.journalPath);
    return;
  }

  const observedAt = input.now();
  if (observedAt.getTime() >= Date.parse(journal.terminalAfter)) {
    // Modal enforces the setup sandbox timeout. Once that deadline plus the
    // persistence grace has passed and the exact operation tag is absent, no
    // process from this operation can still mutate the credential Volume.
    await releaseCodexAuthLease(input.leasePath, journal.leaseTaskId, {
      kind: "setup-operation-expired",
      operationToken: journal.operationToken,
      terminalAfter: journal.terminalAfter,
      observedAt: observedAt.toISOString(),
    });
    await unlinkSetupAuthOperationJournal(input.journalPath);
    return;
  }
  throw new Error(
    "The exact Modal auth setup operation is not visible yet; its lease was retained for safe retry",
  );
}

async function readSetupAuthOperationJournal(
  journalPath: string,
): Promise<SetupAuthOperationJournal | undefined> {
  try {
    return SetupAuthOperationJournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Refusing to recover an unreadable Modal auth setup operation journal", {
      cause: error,
    });
  }
}

async function writeSetupAuthOperationJournal(
  journalPath: string,
  journal: SetupAuthOperationJournal,
): Promise<void> {
  const validated = SetupAuthOperationJournalSchema.parse(journal);
  await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  const temporary = `${journalPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, journalPath);
  await syncDirectory(path.dirname(journalPath));
}

async function createSetupAuthOperationJournal(
  journalPath: string,
  journal: SetupAuthOperationJournal,
): Promise<void> {
  const validated = SetupAuthOperationJournalSchema.parse(journal);
  await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  const temporary = `${journalPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // link(2) is an atomic create-if-absent publication. Unlike rename(), it
    // cannot overwrite a concurrent setup operation's recovery identity.
    await link(temporary, journalPath);
    await syncDirectory(path.dirname(journalPath));
  } finally {
    await unlinkDurably(temporary);
  }
}

async function unlinkSetupAuthOperationJournal(journalPath: string): Promise<void> {
  await unlinkDurably(journalPath);
}

async function unlinkDurably(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(path.dirname(filePath));
}

function remoteCodexAuthValidationScript(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "let homeFd; let authFd;",
    "try {",
    "  const home = path.resolve(process.argv[1]);",
    "  if (!path.isAbsolute(process.argv[1])) process.exit(1);",
    "  const authPath = path.join(home, 'auth.json');",
    "  if (path.dirname(authPath) !== home) process.exit(1);",
    "  homeFd = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);",
    "  let homeStat = fs.fstatSync(homeFd);",
    "  if (!homeStat.isDirectory() || (process.getuid && homeStat.uid !== process.getuid())) process.exit(1);",
    "  fs.fchmodSync(homeFd, 0o700);",
    "  homeStat = fs.fstatSync(homeFd);",
    "  if ((homeStat.mode & 0o777) !== 0o700) process.exit(1);",
    "  authFd = fs.openSync(authPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);",
    "  let authStat = fs.fstatSync(authFd);",
    "  if (!authStat.isFile() || authStat.nlink !== 1 || (process.getuid && authStat.uid !== process.getuid())) process.exit(1);",
    "  if (authStat.size < 2 || authStat.size > 1024 * 1024) process.exit(1);",
    "  fs.fchmodSync(authFd, 0o600);",
    "  authStat = fs.fstatSync(authFd);",
    "  if (!authStat.isFile() || authStat.nlink !== 1 || (authStat.mode & 0o777) !== 0o600) process.exit(1);",
    "  const auth = JSON.parse(fs.readFileSync(authFd, 'utf8'));",
    "  const tokens = auth && auth.tokens;",
    "  if (auth.auth_mode !== 'chatgpt' || !tokens ||",
    "      typeof tokens.access_token !== 'string' || !tokens.access_token ||",
    "      typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||",
    "      typeof tokens.id_token !== 'string' || !tokens.id_token) process.exit(1);",
    "} catch { process.exit(1); } finally {",
    "  if (authFd !== undefined) try { fs.closeSync(authFd); } catch {}",
    "  if (homeFd !== undefined) try { fs.closeSync(homeFd); } catch {}",
    "}",
  ].join(" ");
}

export async function acquireCodexAuthLease(
  leasePath: string,
  taskId: string,
  options: AcquireCodexAuthLeaseOptions = {},
): Promise<void> {
  const lease = CodexAuthLeaseSchema.parse({
    version: 1,
    taskId,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.operationToken === undefined ? {} : { operationToken: options.operationToken }),
  });
  const directory = path.dirname(leasePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const preparedPath = `${leasePath}.prepare.${process.pid}.${randomBytes(16).toString("hex")}`;
  const prepared = await open(preparedPath, "wx", 0o600);
  try {
    await prepared.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
    await prepared.sync();
  } finally {
    await prepared.close();
  }

  try {
    await options.beforePublish?.(preparedPath);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reconcileCodexAuthLeaseReleaseTransactions(leasePath, taskId);
      try {
        // The source inode is already complete and fsynced. link(2) atomically
        // creates the public name without exposing a zero-byte lease and cannot
        // overwrite a concurrent owner.
        await link(preparedPath, leasePath);
        await syncDirectory(directory);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let owner: z.infer<typeof CodexAuthLeaseSchema> | undefined;
      try {
        owner = await readCodexAuthLease(leasePath);
      } catch (error) {
        // The owner may have atomically entered a release transaction between
        // link(2) and this read. Reconcile/retry that race; all other unreadable
        // leases remain busy and are never replaced.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (
        options.adoptExisting === true &&
        owner?.taskId === lease.taskId &&
        owner.workerId === lease.workerId &&
        owner.operationToken === lease.operationToken
      ) {
        return;
      }
      throw new CodexAuthLeaseBusyError(taskId, owner?.taskId);
    }
    throw new CodexAuthLeaseBusyError(taskId);
  } finally {
    await unlink(preparedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function releaseCodexAuthLease(
  leasePath: string,
  taskId: string,
  evidence?: CodexAuthLeaseReleaseEvidence,
  options: ReleaseCodexAuthLeaseOptions = {},
): Promise<boolean> {
  if (!evidence) return false;
  if (evidence.kind === "auth-volume-sync") {
    if (
      !evidence.sandboxId
      || !/^[a-f0-9]{64}$/.test(evidence.handoffSha256)
      || !/^[a-f0-9]{64}$/.test(evidence.authSha256)
      || !Number.isFinite(Date.parse(evidence.persistedAt))
    ) {
      throw new Error("Refusing to release a Codex auth lease on invalid Volume persistence evidence");
    }
  }
  if (evidence.kind === "setup-operation-expired") {
    const terminalAfter = Date.parse(evidence.terminalAfter);
    const observedAt = Date.parse(evidence.observedAt);
    if (!Number.isFinite(terminalAfter) || !Number.isFinite(observedAt) || observedAt < terminalAfter) {
      throw new Error("Refusing to release a Modal auth setup lease before its terminal deadline");
    }
  }

  const transactionId = `${process.pid}.${randomBytes(16).toString("hex")}`;
  const capturedPath = `${leasePath}.release.releasing.${transactionId}`;
  const approvedPath = `${leasePath}.release.approved.${transactionId}`;
  activeCodexAuthLeaseReleaseTransactions.add(capturedPath);
  let captured = false;
  let approved = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await rename(leasePath, capturedPath);
        captured = true;
        await syncDirectory(path.dirname(leasePath));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await reconcileCodexAuthLeaseReleaseTransactions(leasePath, taskId);
        if (attempt === 1) return false;
      }
    }
    if (!captured) return false;

    await options.afterCapture?.(capturedPath);
    let lease: z.infer<typeof CodexAuthLeaseSchema>;
    try {
      lease = await readCodexAuthLease(capturedPath);
    } catch (error) {
      throw new Error("Refusing to release an unreadable Codex auth lease", { cause: error });
    }
    if (lease.taskId !== taskId) {
      throw new Error("Refusing to release a Codex auth lease owned by another task");
    }
    if (lease.operationToken !== undefined && lease.operationToken !== evidence.operationToken) {
      throw new Error("Refusing to release a Codex auth lease owned by another Modal operation");
    }

    // This rename records the ownership decision. Recovery may remove only the
    // approved marker; no releaser ever unlinks the live lease pathname, so a
    // successor cannot be removed by a stale retry.
    // Keep both names fenced across the rename. There must be no await point
    // where the on-disk marker is mistaken for a stale transaction.
    activeCodexAuthLeaseReleaseTransactions.add(approvedPath);
    await rename(capturedPath, approvedPath);
    approved = true;
    activeCodexAuthLeaseReleaseTransactions.delete(capturedPath);
    await syncDirectory(path.dirname(leasePath));
    await unlink(approvedPath);
    await syncDirectory(path.dirname(leasePath));
    return true;
  } catch (error) {
    if (captured && !approved) {
      try {
        await restoreCapturedCodexAuthLease(capturedPath, leasePath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Codex auth lease release failed and ownership could not be restored",
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    activeCodexAuthLeaseReleaseTransactions.delete(capturedPath);
    activeCodexAuthLeaseReleaseTransactions.delete(approvedPath);
  }
}

type CodexAuthLease = z.infer<typeof CodexAuthLeaseSchema>;
type CodexAuthLeaseReleaseMarker = {
  markerPath: string;
  phase: "releasing" | "approved";
  pid: number;
};

const activeCodexAuthLeaseReleaseTransactions = new Set<string>();

async function readCodexAuthLease(filePath: string): Promise<CodexAuthLease> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Codex auth lease must not be a symbolic link", { cause: error });
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 16 * 1024) {
      throw new Error("Codex auth lease has invalid file metadata");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Codex auth lease is not owned by the current user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Codex auth lease permissions are too broad");
    }
    return CodexAuthLeaseSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
  } finally {
    await handle.close();
  }
}

function releaseMarkerPattern(leasePath: string): RegExp {
  const basename = path.basename(leasePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${basename}\\.release\\.(releasing|approved)\\.(\\d+)\\.([a-f0-9]{32})$`);
}

async function listCodexAuthLeaseReleaseMarkers(
  leasePath: string,
): Promise<CodexAuthLeaseReleaseMarker[]> {
  const directory = path.dirname(leasePath);
  const basename = path.basename(leasePath);
  const prefix = `${basename}.release.`;
  const pattern = releaseMarkerPattern(leasePath);
  const markers: CodexAuthLeaseReleaseMarker[] = [];
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const match = pattern.exec(entry);
    if (!match) {
      throw new Error("Refusing to proceed with an unrecognized Codex auth lease release marker");
    }
    markers.push({
      markerPath: path.join(directory, entry),
      phase: match[1] as "releasing" | "approved",
      pid: Number(match[2]),
    });
  }
  return markers;
}

function isReleaseMarkerActive(marker: CodexAuthLeaseReleaseMarker): boolean {
  if (activeCodexAuthLeaseReleaseTransactions.has(marker.markerPath)) return true;
  // A marker from this process that is not registered is stale, as it can only
  // survive fault injection or a process restart/PID reuse.
  if (marker.pid === process.pid) return false;
  try {
    process.kill(marker.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function reconcileCodexAuthLeaseReleaseTransactions(
  leasePath: string,
  requestingTaskId: string,
): Promise<void> {
  for (const marker of await listCodexAuthLeaseReleaseMarkers(leasePath)) {
    if (isReleaseMarkerActive(marker)) {
      let ownerTaskId: string | undefined;
      try {
        ownerTaskId = (await readCodexAuthLease(marker.markerPath)).taskId;
      } catch {
        // An unreadable active transaction remains busy and is never removed.
      }
      throw new CodexAuthLeaseBusyError(requestingTaskId, ownerTaskId);
    }
    if (marker.phase === "approved") {
      await unlink(marker.markerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await syncDirectory(path.dirname(leasePath));
      continue;
    }
    await restoreCapturedCodexAuthLease(marker.markerPath, leasePath);
  }
}

async function restoreCapturedCodexAuthLease(
  capturedPath: string,
  leasePath: string,
): Promise<void> {
  // Never materialize an untrusted marker at the public lease pathname.
  await readCodexAuthLease(capturedPath);
  try {
    await link(capturedPath, leasePath);
    await syncDirectory(path.dirname(leasePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!await pathsReferenceSameFile(capturedPath, leasePath)) {
      throw new Error("Refusing to overwrite a successor Codex auth lease during release recovery");
    }
  }
  await unlink(capturedPath);
  await syncDirectory(path.dirname(leasePath));
}

async function pathsReferenceSameFile(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    open(leftPath, constants.O_RDONLY | constants.O_NOFOLLOW),
    open(rightPath, constants.O_RDONLY | constants.O_NOFOLLOW),
  ]);
  try {
    const [leftStat, rightStat] = await Promise.all([left.stat(), right.stat()]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}
