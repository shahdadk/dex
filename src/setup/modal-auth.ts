import { constants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ModalAdapter } from "../cloud/modal/adapter.js";
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
}).strict();

const ModalVolumeNameSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9._-]{0,62})$/,
  "Modal Codex auth Volume name must be 1-63 lowercase letters, numbers, dots, underscores, or hyphens",
);

const ModalVolumeEntriesSchema = z.array(z.object({
  filename: z.string(),
  type: z.string(),
}).passthrough());

type Runner = (command: string, args: readonly string[]) => Promise<ExecResult>;

export interface SeedModalCodexAuthOptions {
  authPath?: string;
  volumeName?: string;
  runner?: Runner;
  modal?: ModalAdapter;
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
  const volumeName = ModalVolumeNameSchema.parse(
    options.volumeName ?? process.env.DEX_MODAL_CODEX_AUTH_VOLUME ?? DEFAULT_MODAL_CODEX_AUTH_VOLUME,
  );
  await validateLocalCodexAuth(authPath);
  const runner = options.runner ?? execFile;
  const created = await runner("modal", ["volume", "create", volumeName]);
  if (created.exitCode !== 0 && !/already exists/i.test(`${created.stdout}\n${created.stderr}`)) {
    throw new Error("Could not create the private Modal Codex auth Volume");
  }
  const existing = await runner("modal", ["volume", "ls", "--json", volumeName, "auth.json"]);
  let hasRemoteAuth = false;
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
  } else if (!/no such file or directory/i.test(`${existing.stdout}\n${existing.stderr}`)) {
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
  const modal = options.modal ?? new ModalAdapter();
  let sandbox: Awaited<ReturnType<ModalAdapter["create"]>> | undefined;
  try {
    sandbox = await modal.create({
      appName: "dex-auth-setup",
      image: "node:22-bookworm",
      imageCommands: ["RUN npm install --global @openai/codex@0.149.0"],
      volumeNames: { [MODAL_CODEX_HOME]: volumeName },
      params: { timeoutMs: 120_000, command: ["sleep", "120"] },
    });
    for (const argv of [["mkdir", "-p", MODAL_CODEX_HOME], ["chmod", "700", MODAL_CODEX_HOME]]) {
      const process = await sandbox.exec(argv);
      if (await process.wait() !== 0) throw new Error("Could not secure the remote Codex home");
    }
    const permissions = await sandbox.exec(["chmod", "600", path.join(MODAL_CODEX_HOME, "auth.json")]);
    if (await permissions.wait() !== 0) throw new Error("Could not secure the remote Codex auth cache");
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
      [
        "const fs = require('node:fs');",
        "let auth;",
        "try { auth = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch { process.exit(1); }",
        "const tokens = auth && auth.tokens;",
        "if (auth.auth_mode !== 'chatgpt' || !tokens ||",
        "    typeof tokens.access_token !== 'string' || !tokens.access_token ||",
        "    typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||",
        "    typeof tokens.id_token !== 'string' || !tokens.id_token) process.exit(1);",
      ].join(" "),
      path.join(MODAL_CODEX_HOME, "auth.json"),
    ], { env: accountEnvironment });
    if (await modeCheck.wait() !== 0) {
      throw new Error("Modal Codex auth cache is not a ChatGPT account login");
    }
    const status = await sandbox.exec(["codex", "login", "status"], { env: accountEnvironment });
    if (await status.wait() !== 0) throw new Error("Codex did not accept the Modal ChatGPT account login");
  } finally {
    try {
      await sandbox?.terminate({ wait: true });
    } finally {
      await modal.close();
    }
  }
  const result = { volumeName } as SeedModalCodexAuthResult;
  // Keep the legacy enumerable shape ({ volumeName }) while exposing an idempotency report to callers.
  Object.defineProperty(result, "disposition", {
    value: hasRemoteAuth ? "reused" : "seeded",
    enumerable: false,
  });
  options.report?.(result);
  return result;
}

export async function acquireCodexAuthLease(leasePath: string, taskId: string): Promise<void> {
  const lease = CodexAuthLeaseSchema.parse({ version: 1, taskId });
  await mkdir(path.dirname(leasePath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(leasePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another Modal Codex worker holds the shared account-auth lease");
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(leasePath).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

export async function releaseCodexAuthLease(leasePath: string, taskId: string): Promise<void> {
  let lease;
  try {
    lease = CodexAuthLeaseSchema.parse(JSON.parse(await readFile(leasePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Refusing to release an unreadable Codex auth lease", { cause: error });
  }
  if (lease.taskId !== taskId) {
    throw new Error("Refusing to release a Codex auth lease owned by another task");
  }
  await unlink(leasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
