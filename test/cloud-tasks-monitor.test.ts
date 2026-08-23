import { describe, expect, it, vi } from "vitest";
import {
  createDexControlPlaneFetchHandler,
  type DexControlPlaneService,
} from "../src/cloud/control-plane/index.js";
import type { ModalAdapter, ModalSandbox } from "../src/cloud/modal/index.js";
import {
  CLOUD_TASKS_MONITOR_PATH,
  CloudTasksModalMonitor,
  CloudTasksMonitorDispatcher,
  CloudTasksRequestAuthenticator,
  cloudTaskId,
  modalMonitorIdempotencyKey,
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
    const now = Date.parse("2026-08-23T18:00:00.123Z");
    const createTask = vi.fn(async () => [{}]);
    const client: CloudTasksClientLike = {
      queuePath: (project, location, queue) => `projects/${project}/locations/${location}/queues/${queue}`,
      taskPath: (project, location, queue, task) =>
        `projects/${project}/locations/${location}/queues/${queue}/tasks/${task}`,
      createTask,
    };
    const dispatcher = new CloudTasksMonitorDispatcher(config, client, () => now);
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
    expect(request.task.scheduleTime).toEqual({
      seconds: Math.floor((now + 10_000) / 1_000),
      nanos: 123_000_000,
    });
    expect(JSON.parse(Buffer.from(request.task.httpRequest.body, "base64").toString("utf8")))
      .toEqual(body);
    await expect(dispatcher.schedule({
      ...body,
      idempotencyKey: "modal-monitor:task-1:attempt:2",
      delayMs: 10_000,
    })).rejects.toThrow("idempotency key");
  });

  it("requires matching Cloud Tasks headers, a valid body, and the configured OIDC audience", async () => {
    const verifyIdToken = vi.fn(async () => ({
      getPayload: () => ({ email: config.serviceAccountEmail, email_verified: true }),
    }));
    const authenticator = new CloudTasksRequestAuthenticator(config, { verifyIdToken });
    const headers = new Headers({
      authorization: "Bearer signed-token",
      "content-type": "application/json; charset=utf-8",
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
    await expect(authenticator.verify(headers, {
      ...body,
      request: { ...body.request, unexpected: true },
    })).rejects.toMatchObject({ status: 400 });
    const mismatchedIdentity = {
      ...body,
      idempotencyKey: "modal-monitor:task-1:attempt:2",
    };
    const mismatchedHeaders = new Headers(headers);
    mismatchedHeaders.set(
      "x-cloudtasks-taskname",
      cloudTaskId(mismatchedIdentity.idempotencyKey),
    );
    await expect(authenticator.verify(mismatchedHeaders, mismatchedIdentity))
      .rejects.toMatchObject({ status: 400 });

    const missingContentType = new Headers(headers);
    missingContentType.delete("content-type");
    await expect(authenticator.verify(missingContentType, body))
      .rejects.toMatchObject({ status: 415 });

    const invalidToken = new CloudTasksRequestAuthenticator(config, {
      verifyIdToken: vi.fn(async () => { throw new Error("invalid signature"); }),
    });
    await expect(invalidToken.verify(headers, { invalid: true }))
      .rejects.toMatchObject({ status: 401 });
  });

  it("reconnects by sandbox ID and reschedules a running sandbox", async () => {
    const sandbox = {
      poll: vi.fn(async () => null),
      detach: vi.fn(async () => undefined),
      copyToLocal: vi.fn(async () => {
        throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
      }),
    } as unknown as ModalSandbox;
    const modal = {
      fromId: vi.fn(async () => sandbox),
    } as unknown as Pick<ModalAdapter, "fromId">;
    const schedule = vi.fn(async () => undefined);
    const onTerminal = vi.fn(async () => undefined);
    const monitor = new CloudTasksModalMonitor({
      modal,
      once: {
        runOnce: async (_key, effect) => {
          await effect();
          return true;
        },
      },
      dispatcher: { schedule },
      onTerminal,
      now: () => Date.parse(body.request.startedAt),
    });

    await expect(monitor.run(body.request)).resolves.toEqual({
      kind: "rescheduled",
      delayMs: 10_000,
      nextAttempt: 2,
      idempotencyKey: "modal-monitor:task-1:attempt:2",
      scheduled: true,
    });
    expect(modal.fromId).toHaveBeenCalledWith(body.request.sandboxId);
    expect(sandbox.detach).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith({
      request: { ...body.request, attempt: 2 },
      delayMs: 10_000,
      idempotencyKey: "modal-monitor:task-1:attempt:2",
    });
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("terminal-completes a sandbox that reaches its deadline", async () => {
    const sandbox = {
      poll: vi.fn(async () => null),
      terminate: vi.fn(async () => undefined),
    } as unknown as ModalSandbox;
    const onTerminal = vi.fn(async () => undefined);
    const monitor = new CloudTasksModalMonitor({
      modal: { fromId: vi.fn(async () => sandbox) },
      once: {
        runOnce: async (_key, effect) => {
          await effect();
          return true;
        },
      },
      dispatcher: { schedule: vi.fn(async () => undefined) },
      onTerminal,
      now: () => Date.parse(body.request.startedAt) + 25 * 60_000,
    });

    const outcome = await monitor.run(body.request);
    expect(outcome).toMatchObject({
      kind: "terminal",
      callbackInvoked: true,
      event: {
        taskId: body.request.taskId,
        sandboxId: body.request.sandboxId,
        completionKey: `modal-monitor:${body.request.taskId}:terminal`,
        status: "failed",
        reason: "deadline_exceeded",
      },
    });
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      completionKey: `modal-monitor:${body.request.taskId}:terminal`,
    }));
  });

  it("serves the authenticated monitor only through its POST endpoint", async () => {
    const authenticator = new CloudTasksRequestAuthenticator(config, {
      verifyIdToken: vi.fn(async () => ({
        getPayload: () => ({ email: config.serviceAccountEmail, email_verified: true }),
      })),
    });
    const run = vi.fn(async () => ({ kind: "accepted" }));
    const handler = createDexControlPlaneFetchHandler({
      service: {} as DexControlPlaneService,
      monitorTask: {
        verify: (headers, input) => authenticator.verify(headers, input),
        run,
      },
    });
    const headers = {
      authorization: "Bearer signed-token",
      "content-type": "application/json",
      "x-cloudtasks-queuename": config.queue,
      "x-cloudtasks-taskname": cloudTaskId(body.idempotencyKey),
    };
    const response = await handler(new Request(
      `https://dex.example.test${CLOUD_TASKS_MONITOR_PATH}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "accepted" });
    expect(run).toHaveBeenCalledWith(body);

    const get = await handler(new Request(
      `https://dex.example.test${CLOUD_TASKS_MONITOR_PATH}`,
      { headers },
    ));
    expect(get.status).toBe(405);
    expect(modalMonitorIdempotencyKey(body.request)).toBe(body.idempotencyKey);
  });
});
