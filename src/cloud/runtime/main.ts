import { fileURLToPath } from "node:url";
import path from "node:path";
import { redactString } from "../../utils/redact.js";
import { loadDexCloudConfig } from "./config.js";
import { createDexCloudRuntime } from "./runtime.js";

export function describeBackgroundError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown background error";
  const code = (error as Error & { code?: unknown }).code;
  const suffix = typeof code === "string" || typeof code === "number"
    ? ` code=${String(code)}`
    : "";
  return redactString(`${error.name}: ${error.message}${suffix}`).slice(0, 1_000);
}

export async function runDexCloud(): Promise<void> {
  const config = await loadDexCloudConfig();
  const runtime = createDexCloudRuntime({
    config,
    onBackgroundError: (error) => {
      process.stderr.write(
        `Dex Cloud background cycle failed; it will retry. ${describeBackgroundError(error)}\n`,
      );
    },
  });
  const shutdown = (): void => {
    void runtime.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const address = await runtime.listen();
  process.stdout.write(`Dex Cloud listening on ${address.address}:${address.port}\n`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  await runDexCloud().catch(() => {
    process.stderr.write("Dex Cloud failed to start. Check its environment configuration.\n");
    process.exitCode = 1;
  });
}
