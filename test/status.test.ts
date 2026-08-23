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
});
