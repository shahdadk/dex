import { z } from "zod";
import { execFile, type ExecResult } from "../../utils/exec.js";

const RuntimeSecretsSchema = z.object({
  version: z.literal(1),
  GEMINI_API_KEY: z.string().min(1).optional(),
  MODAL_TOKEN_ID: z.string().min(1).optional(),
  MODAL_TOKEN_SECRET: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  DEX_HANDOFF_SIGNING_KEY: z.string().min(1).optional(),
}).strict();

export type DexRuntimeSecrets = z.infer<typeof RuntimeSecretsSchema>;
type Runner = (command: string, args: readonly string[]) => Promise<ExecResult>;

export class MacOSDexRuntimeSecrets {
  readonly #runner: Runner;
  readonly #platform: NodeJS.Platform;
  readonly #service = "com.dex.runtime.secrets";
  readonly #account = "daemon";

  constructor(options: { runner?: Runner; platform?: NodeJS.Platform } = {}) {
    this.#runner = options.runner ?? execFile;
    this.#platform = options.platform ?? process.platform;
  }

  async load(): Promise<DexRuntimeSecrets | null> {
    this.#assertMac();
    const result = await this.#runner("/usr/bin/security", [
      "find-generic-password", "-s", this.#service, "-a", this.#account, "-w",
    ]);
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw new Error("Could not read Dex runtime credentials from macOS Keychain");
    try {
      return RuntimeSecretsSchema.parse(JSON.parse(result.stdout));
    } catch (error) {
      throw new Error("Dex runtime credentials in macOS Keychain are invalid", { cause: error });
    }
  }

  async save(input: Omit<DexRuntimeSecrets, "version">): Promise<void> {
    this.#assertMac();
    const value = RuntimeSecretsSchema.parse({ version: 1, ...input });
    const result = await this.#runner("/usr/bin/security", [
      "add-generic-password", "-U", "-s", this.#service, "-a", this.#account,
      "-w", JSON.stringify(value),
    ]);
    if (result.exitCode !== 0) throw new Error("Could not save Dex runtime credentials in macOS Keychain");
  }

  #assertMac(): void {
    if (this.#platform !== "darwin") throw new Error("Dex runtime credential storage requires macOS Keychain");
  }
}

export async function persistRuntimeSecrets(): Promise<void> {
  const values = {
    ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
    ...(process.env.MODAL_TOKEN_ID ? { MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID } : {}),
    ...(process.env.MODAL_TOKEN_SECRET ? { MODAL_TOKEN_SECRET: process.env.MODAL_TOKEN_SECRET } : {}),
    ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.DEX_HANDOFF_SIGNING_KEY ? { DEX_HANDOFF_SIGNING_KEY: process.env.DEX_HANDOFF_SIGNING_KEY } : {}),
  };
  await new MacOSDexRuntimeSecrets().save(values);
}

export async function hydrateRuntimeSecrets(): Promise<void> {
  if (process.platform !== "darwin") return;
  const secrets = await new MacOSDexRuntimeSecrets().load();
  if (!secrets) return;
  for (const [name, value] of Object.entries(secrets)) {
    if (name === "version" || !value || process.env[name]) continue;
    process.env[name] = String(value);
  }
}
