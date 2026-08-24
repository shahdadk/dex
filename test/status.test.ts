import { describe, expect, it } from "vitest";
import { buildStatusMessage } from "../src/dex/status.js";
import type { DexTask } from "../src/state/schemas.js";

describe("status persona", () => {
  it("reports semantic stages without percentages or logs", () => {
    const now = new Date().toISOString();
    const tasks: DexTask[] = [
      {
        id: "auth-a81f",
        kind: "dex",
        projectId: "p1",
        title: "auth",
        originalRequest: "fix auth",
        repositoryPath: "/repo",
        baseBranch: "main",
        dexBranch: "dex/auth-a81f",
        worktreePath: "/worktree",
        status: "running",
        stage: "implementing",
        createdAt: now,
        updatedAt: now,
        workerHistory: [],
        memoryQueries: [],
        metadata: {},
      },
    ];
    const message = buildStatusMessage(tasks);
    expect(message).toContain("auth — implementing the change");
    expect(message).toContain("nothing needs you");
    expect(message).not.toContain("%");
  });

  it("turns cloud-worker output into concise text instead of leaking workspace paths or validation logs", () => {
    const now = new Date().toISOString();
    const task: DexTask = {
      id: "checkout-a81f",
      kind: "dex",
      projectId: "p1",
      title: "checkout",
      originalRequest: "fix checkout",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/checkout-a81f",
      worktreePath: "/worktree",
      status: "completed",
      stage: "done",
      createdAt: now,
      updatedAt: now,
      latestSummary: "Fixed in [src/checkout.js](/workspace/project/src/checkout.js:11). Early `invoice.paid` events now wait safely. Validation: - `npm test`: 2/2 tests passed - `git diff --check`: passed",
      workerHistory: [],
      memoryQueries: [],
      metadata: {},
    };

    const message = buildStatusMessage([task]);

    expect(message).toContain("checkout — Fixed in src/checkout.js. Early invoice.paid events now wait safely — 2/2 tests passed");
    expect(message).not.toContain("/workspace/project");
    expect(message).not.toContain("git diff");
    expect(message).not.toContain("`");
  });

  it("includes durable cross-agent review findings without replacing the implementation result", () => {
    const now = new Date().toISOString();
    const task: DexTask = {
      id: "checkout-review",
      kind: "dex",
      projectId: "p1",
      title: "checkout",
      originalRequest: "fix checkout",
      repositoryPath: "/repo",
      baseBranch: "main",
      dexBranch: "dex/checkout-review",
      worktreePath: "/worktree",
      status: "completed",
      stage: "done",
      createdAt: now,
      updatedAt: now,
      latestSummary: "checkout fix validated — 2/2 tests passed",
      workerHistory: [],
      memoryQueries: [],
      metadata: {
        latestReview: {
          reviewer: "claude",
          sourceAgent: "codex",
          status: "completed",
          summary: "no material findings; the ordering regression is covered",
        },
      },
    };

    const message = buildStatusMessage([task]);

    expect(message).toContain("checkout fix validated — 2/2 tests passed");
    expect(message).toContain("claude review: no material findings");
  });
});
