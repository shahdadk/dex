import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_TASKS_MONITOR_PATH,
  CloudTasksMonitorDispatcher,
  CloudTasksRequestAuthenticator,
  cloudTaskId,
  type CloudTasksClientLike,
  type CloudTasksMonitorConfig,
} from "../src/cloud/runtime/index.js";

const HASH = "a".repeat(64);
const config: CloudTasksMonitorConfig = {
  project: "dex-project",
  location: "northamerica-northeast1",
  queue: "modal-monitors",
  serviceUrl: "https://dex.example.test",
  audience: "https://dex.example.test",
  serviceAccountEmail: "tasks@dex-project.iam.gserviceaccount.com",
};
const body = {
  idempotencyKey: "modal-monitor:task-1:attempt:1",
  request: {
    taskId: "task-1",
    sandboxId: "sandbox-1",
    handoffSha256: HASH,
    startedAt: "2026-08-23T18:00:00.000Z",
    resultPath: "/dex/result.json",
    attempt: 1,
  },
};

describe("Cloud Tasks Modal monitoring", () => {
  it("uses a deterministic provider task name and an OIDC HTTP request", async () => {
    const createTask = vi.fn(async () => [{}]);
    const client: CloudTasksClientLike = {
      queuePath: (project, location, queue) => `projects/${project}/locations/${location}/queues/${queue}`,
      taskPath: (project, location, queue, task) =>
        `projects/${project}/locations/${location}/queues/${queue}/tasks/${task}`,
      createTask,
    };
    const dispatcher = new CloudTasksMonitorDispatcher(config, client);
    await dispatcher.schedule({ ...body, delayMs: 10_000 });

    const request = createTask.mock.calls[0]![0] as any;
    expect(request.task.name.endsWith(`/tasks/${cloudTaskId(body.idempotencyKey)}`)).toBe(true);
    expect(request.task.httpRequest).toMatchObject({
      httpMethod: "POST",
      url: `https://dex.example.test${CLOUD_TASKS_MONITOR_PATH}`,
      oidcToken: {
        serviceAccountEmail: config.serviceAccountEmail,
        audience: config.audience,
      },
    });
    expect(JSON.parse(Buffer.from(request.task.httpRequest.body, "base64").toString("utf8")))
      .toEqual(body);
  });

  it("requires matching Cloud Tasks headers, a valid body, and the configured OIDC audience", async () => {
    const verifyIdToken = vi.fn(async () => ({
      getPayload: () => ({ email: config.serviceAccountEmail, email_verified: true }),
    }));
    const authenticator = new CloudTasksRequestAuthenticator(config, { verifyIdToken });
    const headers = new Headers({
      authorization: "Bearer signed-token",
      "x-cloudtasks-queuename": config.queue,
      "x-cloudtasks-taskname": cloudTaskId(body.idempotencyKey),
    });
    await expect(authenticator.verify(headers, body)).resolves.toEqual(body);
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "signed-token",
      audience: config.audience,
    });

    const wrongTask = new Headers(headers);
    wrongTask.set("x-cloudtasks-taskname", "another-task");
    await expect(authenticator.verify(wrongTask, body)).rejects.toMatchObject({ status: 401 });
    await expect(authenticator.verify(headers, { ...body, unexpected: true }))
      .rejects.toMatchObject({ status: 400 });
  });
});
