#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  loadConfig,
  DexConfigSchema,
  modalCodexAuthVolumeForDevice,
} from "./config/config.js";
import { resolveDexPaths } from "./config/paths.js";
import { runDaemon } from "./daemon.js";
import { MessageRouter } from "./dex/router.js";
import { buildStatusMessage } from "./dex/status.js";
import { DexProjectSchema } from "./state/schemas.js";
import { DexStateStore } from "./state/store.js";
import {
  runDoctor,
  formatDoctor,
  waitForHealthySignedTransport,
} from "./setup/doctor.js";
import { installLaunchAgent, installRuntime } from "./setup/service.js";
import { inspectRepository } from "./tasks/worktree.js";
import { projectId } from "./utils/ids.js";
import { ModalAdapter } from "./cloud/modal/adapter.js";
import { detectMacName, pairMac } from "./setup/onboarding.js";
import { sendControlCommand } from "./local/daemon/control-socket.js";
import { hydrateRuntimeSecrets, persistRuntimeSecrets } from "./local/pairing/secrets.js";
import { seedModalCodexAuth } from "./setup/modal-auth.js";
import { assertStrongRootHandoffKey, ensureRootHandoffKey } from "./setup/handoff-key.js";
import {
  discoverClaudeMem,
  extractObservationIds,
  type ClaudeMemClient,
} from "./memory/claude-mem.js";

const VERSION = "0.0.1";
const program = new Command();
program.name("dex").description("Text Dex. Get software built.").version(VERSION);

program
  .command("setup")
  .description("Pair this Mac and install Dex")
  .option("--no-service", "do not install the background LaunchAgent")
  .option("--project <path>", "default repository", process.cwd())
  .option("--pairing-code <code>", "use a specific phone pairing code")
  .option("--device-name <name>", "name shown for this Mac")
  .option("--skip-modal-smoke", "skip the real Modal lifecycle smoke test")
  .action(async (options: { service: boolean; project: string; pairingCode?: string; deviceName?: string; skipModalSmoke?: boolean }) => {
    assertNode22();
    await hydrateRuntimeSecrets();
    ensureRootHandoffKey();
    const paths = resolveDexPaths();
    const store = new DexStateStore(paths.state);
    // Validate the repository before creating a cloud pairing or mutating Dex
    // state. registerProject performs the actual durable write after pairing.
    await inspectRepository(options.project);
    let config = await loadConfig(paths, { allowLegacyPairedModalAuthVolume: true });
    const deviceName = options.deviceName ?? await detectMacName();
    const identity = await pairMac({
      config,
      ...(options.pairingCode ? { pairingCode: options.pairingCode } : {}),
      deviceName,
    });
    const project = await registerProject(store, options.project);
    const modalCodexAuthVolume = modalCodexAuthVolumeForDevice(identity.deviceId);
    config = DexConfigSchema.parse({
      ...config,
      deviceId: identity.deviceId,
      deviceKeyId: identity.keyId,
      modalCodexAuthVolume,
      ownerId: identity.ownerId,
      ...(identity.pairedConversationId ? { pairedConversationId: identity.pairedConversationId } : {}),
      deviceName,
      defaultProjectId: project.id,
      defaultRepository: project.path,
    });
    const checks = await runDoctor(config, { signedTransportMode: "preinstall" });
    console.log(formatDoctor(checks, "Dex Setup · Preflight", "Pre-install checks passed."));
    if (checks.some((check) => check.status === "fail")) {
      throw new Error("Required setup checks failed; fix them and run dex setup again.");
    }
    if (checks.find((check) => check.name === "Modal")?.status !== "pass") {
      throw new Error("An authenticated Modal environment or CLI profile is required for Dex cloud continuity");
    }
    assertStrongRootHandoffKey(process.env.DEX_HANDOFF_SIGNING_KEY);
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is required for Dex's ambiguous routing lane");
    }
    process.env.DEX_MODAL_CODEX_AUTH_VOLUME = modalCodexAuthVolume;
    const auth = await seedModalCodexAuth({
      volumeName: modalCodexAuthVolume,
      leasePath: path.join(paths.handoffs, ".codex-account-auth.lease"),
    });
    // Do not persist a migrated device-to-Volume binding until that exact
    // Volume has passed the lease-protected account-auth verification.
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(`✓ Codex ChatGPT account auth ${auth.disposition} in private Modal Volume ${auth.volumeName}`);
    if (!options.skipModalSmoke) {
      const smoke = await modalSmokeTest();
      console.log(`✓ Modal create/write-file/exec/detach/reconnect/terminate: ${smoke.id} (${smoke.version})`);
    }
    await persistRuntimeSecrets();
    if (options.service) {
      const runtime = await installRuntime(paths, VERSION);
      await installLaunchAgent(runtime, paths, { codexAuthVolumeName: modalCodexAuthVolume });
      // Require a sync written after the newly installed service itself has
      // reported ready. This deliberately waits through one 25-second poll
      // rather than accepting a stale write raced in by the previous daemon.
      const serviceReadyAt = new Date().toISOString();
      const transportBaseline = await store.read();
      await waitForHealthySignedTransport({
        loadState: () => store.read(),
        afterRevision: transportBaseline.revision,
        notBefore: serviceReadyAt,
        ...(transportBaseline.signedTransportHealth?.lastSuccessAt === undefined
          ? {}
          : { previousLastSuccessAt: transportBaseline.signedTransportHealth.lastSuccessAt }),
      });
      const finalChecks = await runDoctor(config);
      console.log(`\n${formatDoctor(finalChecks, "Dex Setup · Final checks")}`);
      if (finalChecks.some((check) => check.status === "fail")) {
        throw new Error("Dex background service started, but final setup checks failed.");
      }
      console.log("\n✓ Dex is running in the background with signed cloud transport");
      console.log(`\nProject:\n${project.path}\n\nYou're done. Close Terminal and text Dex.`);
      return;
    }
    console.log("\n! --no-service selected: the background daemon and signed transport were not started");
    console.log(`\nProject:\n${project.path}`);
    console.log("\nDeveloper setup is prepared. Run `dex daemon` or rerun `dex setup` without --no-service before texting Dex.");
  });

program.command("doctor").description("Run internal dependency diagnostics").action(async () => {
  await hydrateRuntimeSecrets();
  const paths = resolveDexPaths();
  console.log(formatDoctor(await runDoctor(await loadConfig(paths))));
});

program.command("daemon").description("Run the Dex background service").action(async () => {
  await runDaemon();
});

program.command("status").description("Internal durable status view").action(async () => {
  const paths = resolveDexPaths();
  const state = await new DexStateStore(paths.state).read();
  console.log(buildStatusMessage(Object.values(state.tasks), Object.values(state.workers)));
});

program.command("watch").description("Judge/developer orchestration view").option("--once", "render once").action(async (options: { once?: boolean }) => {
  const render = async () => {
    const paths = resolveDexPaths();
    const state = await new DexStateStore(paths.state).read();
    if (!options.once) process.stdout.write("\u001Bc");
    console.log(renderWatch(state));
  };
  await render();
  if (!options.once) {
    const timer = setInterval(() => void render(), 1_000);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => {
        clearInterval(timer);
        resolve();
      });
    });
  }
});

program
  .command("project")
  .description("Manage the default project")
  .command("add")
  .argument("[path]", "Git repository", process.cwd())
  .action(async (repositoryPath: string) => {
    const paths = resolveDexPaths();
    const project = await registerProject(new DexStateStore(paths.state), repositoryPath);
    const config = DexConfigSchema.parse({
      ...(await loadConfig(paths)),
      defaultProjectId: project.id,
      defaultRepository: project.path,
    });
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(`✓ ${project.name}: ${project.path}`);
  });

program.command("route").description("Internal router probe").argument("<message...>").action(async (parts: string[]) => {
  console.log(JSON.stringify(await new MessageRouter().route(parts.join(" ")), null, 2));
});

const demoCommand = program.command("demo").description("Controlled demo inputs");

demoCommand
  .command("battery")
  .argument("<percent>")
  .action(async (percentText: string) => {
    const percent = Number(percentText);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("Battery percent must be an integer from 0 to 100");
    const paths = resolveDexPaths();
    await sendControlCommand(paths.controlSocket, { type: "demo.battery", percent });
    console.log(`✓ injected simulated ${percent}% battery reading through the production policy path`);
  });

demoCommand
  .command("seed-memory")
  .description("Seed the checkout continuity fact in the real Claude-Mem worker")
  .action(async () => {
    const paths = resolveDexPaths();
    const config = await loadConfig(paths);
    const discovery = await discoverClaudeMem({
      ...(process.env.CLAUDE_MEM_URL ? { baseUrl: process.env.CLAUDE_MEM_URL } : {}),
    });
    if (!discovery.client) throw new Error("Claude-Mem is unavailable; start it and retry");
    const repository = config.defaultRepository ?? process.cwd();
    const result = await discovery.client.recordObservation({
      claudeSessionId: "dex:demo:checkout-history",
      contentSessionId: "dex:demo:checkout-history",
      toolName: "dex_architecture_decision",
      toolInput: {
        task: "checkout webhook ordering",
        kind: "failed_approach",
      },
      toolResponse: {
        summary: "Webhook handling cannot assume event order.",
        facts: [
          "invoice.paid may arrive before the local subscription write finishes",
          "Do not move idempotency verification after the external charge; duplicate delivery can charge twice",
        ],
        failedApproach: "Performing the external charge before the idempotency lookup",
        nextStep: "Use an order-independent handler and preserve the regression test",
      },
      cwd: repository,
      platformSource: "dex",
      agentType: "dex",
      agentId: "demo-seed-memory",
      toolUseId: "dex-demo-checkout-continuity-v1",
    });
    await discovery.client.summarizeSession({
      contentSessionId: "dex:demo:checkout-history",
      lastAssistantMessage: "The checkout ordering constraint and failed approach are ready for the next worker.",
      platformSource: "dex",
    });
    const observationId = await waitForSeededMemory(discovery.client);
    console.log(`✓ seeded and verified real Claude-Mem checkout continuity #${observationId} (${result.status})`);
  });

program
  .command("power")
  .description("Internal power recovery tools")
  .command("restore")
  .action(async () => {
    const paths = resolveDexPaths();
    await sendControlCommand(paths.controlSocket, { type: "power.restore" });
    console.log("✓ told the running Dex daemon to restore normal Mac sleep behavior");
  });

program
  .command("cloud")
  .description("Internal cloud diagnostics")
  .command("doctor")
  .action(async () => {
    assertNode22();
    await hydrateRuntimeSecrets();
    assertStrongRootHandoffKey(process.env.DEX_HANDOFF_SIGNING_KEY);
    const paths = resolveDexPaths();
    const config = await loadConfig(paths);
    if (!config.modalCodexAuthVolume) {
      throw new Error("A paired device-specific Modal Codex auth Volume is required; run dex setup");
    }
    const auth = await seedModalCodexAuth({
      volumeName: config.modalCodexAuthVolume,
      leasePath: path.join(paths.handoffs, ".codex-account-auth.lease"),
    });
    console.log(`✓ Codex ChatGPT account auth verified in private Modal Volume ${auth.volumeName} (${auth.disposition})`);
    const smoke = await modalSmokeTest();
    console.log(`✓ Modal create/write-file/exec/detach/reconnect/terminate: ${smoke.id} (${smoke.version})`);
  });

await program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Dex: ${message}`);
  process.exitCode = 1;
});

function assertNode22(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 22) throw new Error(`Dex requires Node 22+. Found ${process.versions.node}.`);
}

async function registerProject(store: DexStateStore, repositoryPath: string) {
  const repository = await inspectRepository(path.resolve(repositoryPath));
  const existing = Object.values((await store.read()).projects).find((project) => project.path === repository.root);
  if (existing) return existing;
  const now = new Date().toISOString();
  const project = DexProjectSchema.parse({
    id: projectId(),
    name: path.basename(repository.root),
    path: repository.root,
    remote: repository.remote,
    defaultBranch: repository.branch,
    createdAt: now,
  });
  await store.updateState((state) => {
    state.projects[project.id] = project;
  });
  return project;
}

function renderWatch(state: Awaited<ReturnType<DexStateStore["read"]>>): string {
  const lines = ["DEX — LIVE", "", "TASKS"];
  const tasks = Object.values(state.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (tasks.length === 0) lines.push("\n  no tasks yet");
  for (const task of tasks) {
    const worker = task.currentWorkerId ? state.workers[task.currentWorkerId] : undefined;
    lines.push("", task.title, `  status       ${task.status.toUpperCase()}`, `  stage        ${task.stage}`);
    if (worker) {
      lines.push(`  worker       ${worker.agent} / ${worker.target.kind}`, `  session      ${worker.providerSessionId ?? "starting"}`);
      if (worker.target.kind === "modal") lines.push(`  sandbox      ${worker.target.sandboxId ?? "creating"}`);
    }
    lines.push(`  branch       ${task.dexBranch}`, `  worktree     ${task.worktreePath}`);
    const memoryCount = numericMetadata(task.metadata.memoryCount) ?? taskKnowledgeCount(task.metadata.taskKnowledge);
    if (memoryCount > 0) lines.push(`  memory       ${memoryCount} continuity items`);
    const failedApproaches = numericMetadata(task.metadata.failedApproachCount);
    if (failedApproaches !== undefined) lines.push(`  failures     ${failedApproaches} packaged`);
    if (typeof task.metadata.handoffHash === "string") {
      lines.push(`  checkpoint   ${task.metadata.handoffHash.slice(0, 12)} verified`);
    }
    if (task.metadata.cloudMonitorAcknowledged === true) lines.push("  monitor      CLOUD OWNERSHIP CONFIRMED");
    if (task.testStatus?.summary) lines.push(`  tests        ${task.testStatus.summary}`);
  }
  lines.push("", "MACHINE");
  if (state.machine) {
    const battery = `${state.machine.batteryPercent ?? "unknown"}%${state.machine.batteryReadingSimulated ? " (simulated)" : ""}`;
    lines.push(`  ${state.machine.hostname}`, `  battery      ${battery}`, `  keep-awake   ${state.machine.sleepPreventionActive ? "ACTIVE" : "off"}`);
  } else {
    lines.push("  not paired");
  }
  if (state.pendingMachineActions.length > 0) {
    lines.push(`  pending      ${state.pendingMachineActions.map((action) => `${action.type}:${action.trigger}`).join(", ")}`);
  }
  return lines.join("\n");
}

function numericMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function taskKnowledgeCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const record = value as Record<string, unknown>;
  return Object.values(record).reduce<number>(
    (total, item) => total + (Array.isArray(item) ? item.length : 0),
    0,
  );
}

async function waitForSeededMemory(client: ClaudeMemClient, timeoutMs = 90_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const search = await client.search({
        query: "Webhook idempotency external charge",
        project: "dex",
        type: "observations",
        limit: 10,
        orderBy: "relevance",
      });
      const ids = extractObservationIds(search).slice(0, 10);
      const observations = await client.getObservations({ ids, project: "dex", limit: 10 });
      const match = observations.find((observation) => {
        const text = [observation.title, observation.narrative, ...observation.facts].join(" ");
        return /idempotency/i.test(text) && /charge twice|double-billing/i.test(text);
      });
      if (typeof match?.id === "number") return match.id;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Claude-Mem accepted the observation but did not make it searchable in time", {
    cause: lastError,
  });
}

async function modalSmokeTest(): Promise<{ id: string; version: string }> {
  const modal = new ModalAdapter();
  const sandbox = await modal.create({
    params: {
      timeoutMs: 120_000,
      command: ["sleep", "120"],
    },
  });
  let terminated = false;
  try {
    const keyPath = "/tmp/dex-handoff-smoke.key";
    const scopedKey = randomBytes(32).toString("base64url");
    const expectedDigest = createHash("sha256").update(scopedKey).digest("hex");
    await sandbox.raw.filesystem.writeText(scopedKey, keyPath);
    const process = await sandbox.exec([
      "node",
      "-e",
      `const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); const key = readFileSync(${JSON.stringify(keyPath)}); if (process.env.DEX_HANDOFF_SIGNING_KEY || createHash("sha256").update(key).digest("hex") !== ${JSON.stringify(expectedDigest)}) process.exit(9); process.stdout.write(process.version)`,
    ]);
    const [exitCode, output] = await Promise.all([process.wait(), process.stdout.readText()]);
    if (exitCode !== 0) throw new Error(`Modal command exited ${exitCode}: ${await process.stderr.readText()}`);
    const id = sandbox.sandboxId;
    await sandbox.detach();
    const reconnected = await modal.fromId(id);
    await reconnected.terminate({ wait: true });
    terminated = true;
    return { id, version: output.trim() };
  } finally {
    try {
      if (!terminated) await sandbox.terminate({ wait: true });
    } finally {
      await modal.close();
    }
  }
}
