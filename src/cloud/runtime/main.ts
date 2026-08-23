import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDexCloudConfig } from "./config.js";
import { createDexCloudRuntime } from "./runtime.js";

export async function runDexCloud(): Promise<void> {
  const config = await loadDexCloudConfig();
  const runtime = createDexCloudRuntime({
    config,
    onBackgroundError: () => {
      process.stderr.write("Dex Cloud background cycle failed; it will retry.\n");
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
