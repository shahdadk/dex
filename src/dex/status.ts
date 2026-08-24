import type { DexTask, WorkerSession } from "../state/schemas.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function buildStatusMessage(tasks: DexTask[], workers: WorkerSession[] = []): string {
  if (tasks.length === 0) return "nothing is running right now.";
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const active = tasks.filter((task) => !TERMINAL.has(task.status));
  const heading = active.length > 0 ? `${active.length} ${active.length === 1 ? "thing" : "things"} active:` : "recent work:";
  const lines = tasks.slice(0, 6).map((task) => {
    const worker = task.currentWorkerId ? workerById.get(task.currentWorkerId) : undefined;
    const baseDetail = task.latestSummary ? semanticSummary(task.latestSummary) : stageText(task);
    const detail = withReviewSummary(task, baseDetail);
    const owner = worker && task.metadata.showAgent === true ? ` (${worker.agent})` : "";
    return `${displayTitle(task.title)}${owner} — ${detail}`;
  });
  const blocked = tasks.filter((task) => task.status === "waiting_user");
  return [
    heading,
    "",
    ...lines,
    "",
    blocked.length > 0
      ? `${blocked.length === 1 ? blocked[0]?.title : `${blocked.length} tasks`} needs your input.`
      : "nothing needs you right now.",
  ].join("\n");
}

function withReviewSummary(task: DexTask, baseDetail: string): string {
  const value = task.metadata.latestReview;
  if (!value || typeof value !== "object" || Array.isArray(value)) return baseDetail;
  const review = value as Record<string, unknown>;
  const reviewer = review.reviewer === "claude" || review.reviewer === "codex" ? review.reviewer : "agent";
  if (review.status === "failed") return `${truncateAtWord(baseDetail, 135)} · ${reviewer} review needs a retry`;
  if (review.status === "cancelled") return `${truncateAtWord(baseDetail, 135)} · ${reviewer} review stopped`;
  if (review.status !== "completed" || typeof review.summary !== "string") return baseDetail;
  const summary = semanticSummary(review.summary);
  return `${truncateAtWord(baseDetail, 105)} · ${reviewer} review: ${truncateAtWord(summary, 100)}`;
}

function semanticSummary(value: string): string {
  const clean = value
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const testEvidence = clean.match(/\b(\d+)\s*\/\s*(\d+)\s+tests?\s+passed\b/i);
  const narrative = clean.split(/\bValidation\s*:/i)[0]?.trim() || clean;
  const detail = truncateAtWord(narrative, 210);
  if (!testEvidence || detail.toLowerCase().includes(testEvidence[0]!.toLowerCase())) return detail;
  return `${detail.replace(/[.;:,\s]+$/g, "")} — ${testEvidence[1]}/${testEvidence[2]} tests passed`;
}

function truncateAtWord(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const candidate = value.slice(0, maximum - 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary >= maximum * 0.65 ? boundary : candidate.length).trimEnd()}…`;
}

function stageText(task: DexTask): string {
  switch (task.stage) {
    case "queued": return "queued";
    case "investigating": return "investigating the issue";
    case "implementing": return "implementing the change";
    case "testing": return "running validation";
    case "reviewing": return "reviewing the result";
    case "waiting": return task.blockedReason ? `waiting: ${task.blockedReason}` : "waiting for input";
    case "checkpointing": return "saving a continuation checkpoint";
    case "handing_off": return "moving the work to another worker";
    case "done": return task.testStatus?.summary ? `done — ${task.testStatus.summary}` : "done";
    case "failed": return task.blockedReason ? `failed: ${task.blockedReason}` : "failed";
  }
}

function displayTitle(title: string): string {
  return title.length > 42 ? `${title.slice(0, 39)}…` : title;
}
