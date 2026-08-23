import type { DexTask, WorkerSession } from "../state/schemas.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function buildStatusMessage(tasks: DexTask[], workers: WorkerSession[] = []): string {
  if (tasks.length === 0) return "nothing is running right now.";
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const active = tasks.filter((task) => !TERMINAL.has(task.status));
  const heading = active.length > 0 ? `${active.length} ${active.length === 1 ? "thing" : "things"} active:` : "recent work:";
  const lines = tasks.slice(0, 6).map((task) => {
    const worker = task.currentWorkerId ? workerById.get(task.currentWorkerId) : undefined;
    const detail = task.latestSummary || stageText(task);
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
