import { open, readFile, stat, unlink } from "node:fs/promises";
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

type Runner = (command: string, args: readonly string[]) => Promise<ExecResult>;

export interface SeedModalCodexAuthOptions {
  authPath?: string;
  volumeName?: string;
  runner?: Runner;
  modal?: ModalAdapter;
}

export async function validateLocalCodexAuth(authPath = path.join(os.homedir(), ".codex", "auth.json")): Promise<void> {
  const metadata = await stat(authPath);
  if (!metadata.isFile()) throw new Error("Codex auth cache must be a regular file");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Codex auth cache must be owned by the current user");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Codex auth cache permissions are too broad; run chmod 600 ~/.codex/auth.json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(authPath, "utf8"));
  } catch (error) {
    throw new Error("Codex auth cache is not valid JSON", { cause: error });
  }
  if (!ChatGptAuthSchema.safeParse(parsed).success) {
    throw new Error("Codex auth cache is not a ChatGPT account login");
  }
}

/** Seeds auth directly from the user's home directory; no credential enters the repository. */
export async function seedModalCodexAuth(options: SeedModalCodexAuthOptions = {}): Promise<{ volumeName: string }> {
  const authPath = options.authPath ?? path.join(os.homedir(), ".codex", "auth.json");
  const volumeName = options.volumeName ?? process.env.DEX_MODAL_CODEX_AUTH_VOLUME ?? DEFAULT_MODAL_CODEX_AUTH_VOLUME;
  await validateLocalCodexAuth(authPath);
  const runner = options.runner ?? execFile;
  const created = await runner("modal", ["volume", "create", volumeName]);
  if (created.exitCode !== 0 && !/already exists/i.test(`${created.stdout}\n${created.stderr}`)) {
    throw new Error("Could not create the private Modal Codex auth Volume");
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
    await sandbox.copyFromLocal(authPath, path.join(MODAL_CODEX_HOME, "auth.json"));
    const permissions = await sandbox.exec(["chmod", "600", path.join(MODAL_CODEX_HOME, "auth.json")]);
    if (await permissions.wait() !== 0) throw new Error("Could not secure the remote Codex auth cache");
    const status = await sandbox.exec(["codex", "login", "status"], { env: { CODEX_HOME: MODAL_CODEX_HOME } });
    if (await status.wait() !== 0) throw new Error("Codex did not accept the seeded ChatGPT account login");
  } finally {
    await sandbox?.terminate().catch(() => undefined);
    await modal.close();
  }
  return { volumeName };
}

export async function acquireCodexAuthLease(leasePath: string, taskId: string): Promise<void> {
  try {
    const handle = await open(leasePath, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ version: 1, taskId })}\n`, "utf8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another Modal Codex worker holds the shared account-auth lease");
    }
    throw error;
  }
}

export async function releaseCodexAuthLease(leasePath: string, taskId: string): Promise<void> {
  let lease: unknown;
  try { lease = JSON.parse(await readFile(leasePath, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Refusing to release an unreadable Codex auth lease", { cause: error });
  }
  if (!lease || typeof lease !== "object" || (lease as { taskId?: unknown }).taskId !== taskId) {
    throw new Error("Refusing to release a Codex auth lease owned by another task");
  }
  await unlink(leasePath);
}
