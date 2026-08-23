import type { AgentProvider } from "./types.js";

export interface WorkerPromptInput {
  goal: string;
  taskId?: string;
  constraints?: readonly string[];
  acceptanceCriteria?: readonly string[];
  context?: readonly string[];
  learnedFacts?: readonly string[];
  failedApproaches?: readonly string[];
  validationCommands?: readonly (readonly string[])[];
}

function section(title: string, values: readonly string[] | undefined): string[] {
  if (!values?.length) return [];
  return [title, ...values.map((value) => `- ${value}`), ""];
}

/**
 * Builds the explicit, self-contained prompt used for every fresh worker. Command
 * validations are represented as argv JSON arrays so they are never mistaken for
 * shell snippets by Dex.
 */
export function buildWorkerPrompt(
  provider: AgentProvider,
  input: WorkerPromptInput,
): string {
  const lines = [
    `You are a fresh ${provider === "codex" ? "Codex" : "Claude"} worker launched by Dex.`,
    "Work autonomously in the provided repository and finish the task, including proportionate validation.",
    "Treat inherited facts as evidence to verify, and do not repeat listed failed approaches unless new evidence justifies it.",
    "Run programs with executable-and-argv semantics; never construct a shell command from untrusted text.",
    "Do not merely describe edits: make the requested changes when authorized, then report changed paths and validation results.",
    "",
    ...(input.taskId ? ["Task ID", input.taskId, ""] : []),
    "Goal",
    input.goal,
    "",
    ...section("Constraints", input.constraints),
    ...section("Acceptance criteria", input.acceptanceCriteria),
    ...section("Inherited context", input.context),
    ...section("Learned facts", input.learnedFacts),
    ...section("Failed approaches to avoid", input.failedApproaches),
  ];

  if (input.validationCommands?.length) {
    lines.push(
      "Validation commands (argv arrays)",
      ...input.validationCommands.map((argv) => `- ${JSON.stringify(argv)}`),
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

export function buildClaudeWorkerPrompt(input: WorkerPromptInput): string {
  return buildWorkerPrompt("claude", input);
}

export function buildCodexWorkerPrompt(input: WorkerPromptInput): string {
  return buildWorkerPrompt("codex", input);
}
