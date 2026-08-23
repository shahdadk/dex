import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  DexControlPlaneService,
  MonitorJobOutbox,
  createDexControlPlaneFetchHandler,
  createDexControlPlaneServer,
} from "../control-plane/index.js";
import { ModalAdapter } from "../modal/index.js";
import {
  AtomicFileStateBackend,
  CloudSqlPostgresStateBackend,
  DurableDexCloudRepository,
  DurableModalMonitorOnce,
  PostgresStateBackend,
  type DexCloudStateBackend,
} from "../persistence/index.js";
import {
  SendblueClient,
  SendblueOutboxDispatcher,
  type SendblueDispatchResult,
  type SendblueFetch,
} from "../providers/index.js";
import { ConfiguredAssociationVerifier } from "./association.js";
import type { DexCloudConfig } from "./config.js";
import {
  CloudTasksModalMonitor,
  CloudTasksMonitorDispatcher,
  CloudTasksRequestAuthenticator,
  type CloudTasksMonitorBody,
} from "./cloud-tasks.js";
import {
  DeterministicMonitorRunner,
  type MonitorDrainResult,
} from "./monitor-runner.js";

export interface DexCloudRuntimeCycle {
  monitors: MonitorDrainResult;
  sendblue: SendblueDispatchResult[];
}

export interface DexCloudRuntimeOptions {
  config: DexCloudConfig;
  backend?: DexCloudStateBackend;
  modal?: ModalAdapter;
  fetch?: SendblueFetch;
  now?: () => number;
  onBackgroundError?: (error: unknown) => void;
}

export class DexCloudRuntime {
  readonly config: DexCloudConfig;
  readonly backend: DexCloudStateBackend;
  readonly repository: DurableDexCloudRepository;
  readonly service: DexControlPlaneService;
  readonly modal: ModalAdapter;
  readonly server: Server;
  readonly fetchHandler: (request: Request) => Promise<Response>;
  readonly #monitorRunner: DeterministicMonitorRunner;
  readonly #cloudTasksOutbox: MonitorJobOutbox | undefined = undefined;
  readonly #sendblueDispatcher: SendblueOutboxDispatcher;
  readonly #onBackgroundError: (error: unknown) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #cycleTail: Promise<unknown> = Promise.resolve();
  #readinessCheck: Promise<void> | undefined;
  #listenPromise: Promise<AddressInfo> | undefined;
  #closePromise: Promise<void> | undefined;
  #backgroundCycleRunning = false;
  #backgroundWorkStarted = false;
  #closed = false;

  constructor(options: DexCloudRuntimeOptions) {
    this.config = options.config;
    this.backend = options.backend ?? createStateBackend(options.config);
    this.repository = new DurableDexCloudRepository({ backend: this.backend });
    this.modal = options.modal ?? new ModalAdapter();
    const now = options.now ?? Date.now;
    const associationVerifier = new ConfiguredAssociationVerifier({
      associations: options.config.ownerAssociations,
      sendblueNumber: options.config.sendblue.line,
    });
    this.service = new DexControlPlaneService({
      repository: this.repository,
      associationVerifier,
      signingKey: options.config.signingKey,
      sendblueWebhookSecret: options.config.sendblue.webhookSecret,
      internalSecret: options.config.internalSecret,
      now,
    });
    const once = new DurableModalMonitorOnce({
      backend: this.backend,
      workerId: options.config.workerId,
      now,
    });
    this.#monitorRunner = new DeterministicMonitorRunner({
      repository: this.repository,
      modal: this.modal,
      once,
      now,
      onTerminal: this.service.modalTerminalHandler(),
    });
    let monitorTask: {
      verify(headers: Headers, body: unknown): Promise<CloudTasksMonitorBody>;
      run(body: unknown): Promise<unknown>;
    } | undefined;
    if (options.config.cloudTasks !== undefined) {
      const dispatcher = new CloudTasksMonitorDispatcher(
        options.config.cloudTasks,
        undefined,
        now,
      );
      const authenticator = new CloudTasksRequestAuthenticator(options.config.cloudTasks);
      const cloudMonitor = new CloudTasksModalMonitor({
        modal: this.modal,
        once,
        dispatcher,
        onTerminal: this.service.modalTerminalHandler(),
        now,
      });
      this.#cloudTasksOutbox = new MonitorJobOutbox({
        repository: this.repository,
        dispatcher,
        now,
      });
      monitorTask = {
        verify: (headers, body) => authenticator.verify(headers, body),
        run: (body) => cloudMonitor.run((body as CloudTasksMonitorBody).request),
      };
    }
    const readiness = (): Promise<void> => this.#checkReadiness();
    const handlerOptions = {
      service: this.service,
      readiness,
      ...(monitorTask === undefined ? {} : {
        monitorTask,
        // With no resident timer, each mutating request drains both the monitor
        // outbox and terminal/user notifications before Cloud Run can scale down.
        onMonitorRegistered: async () => { await this.runCycle(); },
      }),
    };
    this.fetchHandler = createDexControlPlaneFetchHandler(handlerOptions);
    this.server = createDexControlPlaneServer(handlerOptions);
    const sendblueClient = new SendblueClient({
      apiKeyId: options.config.sendblue.apiKeyId,
      apiSecretKey: options.config.sendblue.apiSecretKey,
      fetch: options.fetch ?? globalThis.fetch,
    });
    this.#sendblueDispatcher = new SendblueOutboxDispatcher({
      client: sendblueClient,
      store: this.repository,
      fromNumber: options.config.sendblue.line,
      workerId: options.config.workerId,
      now,
      ...(options.config.sendblue.statusCallback === undefined
        ? {}
        : { statusCallback: options.config.sendblue.statusCallback }),
    });
    this.#onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  runCycle(options: { monitorLimit?: number; sendblueLimit?: number } = {}): Promise<DexCloudRuntimeCycle> {
    if (this.#closed) return Promise.reject(new Error("Dex Cloud runtime is closed"));
    const monitorLimit = options.monitorLimit ?? 25;
    const sendblueLimit = options.sendblueLimit ?? 100;
    if (!Number.isSafeInteger(sendblueLimit) || sendblueLimit < 1 || sendblueLimit > 500) {
      throw new RangeError("Sendblue drain limit must be between one and 500");
    }
    const operation = this.#cycleTail.then(async () => {
      // Monitoring only observes Modal state and validates result artifacts; it
      // never invokes a model. Terminal effects enqueue through the repository.
      let monitors: MonitorDrainResult;
      if (this.#cloudTasksOutbox === undefined) {
        monitors = await this.#monitorRunner.drain(monitorLimit);
      } else {
        const dispatched = await this.#cloudTasksOutbox.dispatchPending(monitorLimit);
        monitors = {
          initialAttempted: dispatched.attempted,
          initialCompleted: dispatched.dispatched,
          scheduledAttempted: 0,
          scheduledCompleted: 0,
          outcomes: [],
        };
      }
      const sendblue: SendblueDispatchResult[] = [];
      for (let index = 0; index < sendblueLimit; index += 1) {
        const result = await this.#sendblueDispatcher.dispatchNext();
        sendblue.push(result);
        if (result.kind === "idle") break;
      }
      return { monitors, sendblue };
    });
    this.#cycleTail = operation.catch(() => undefined);
    return operation;
  }

  listen(): Promise<AddressInfo> {
    if (this.#closed) return Promise.reject(new Error("Dex Cloud runtime is closed"));
    if (this.#listenPromise !== undefined) return this.#listenPromise;
    const operation = (async () => {
      if (!this.server.listening) {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            this.server.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            this.server.off("error", onError);
            resolve();
          };
          this.server.once("error", onError);
          this.server.once("listening", onListening);
          this.server.listen(this.config.port, this.config.host);
        });
      }
      this.startBackgroundWork();
      const address = this.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Dex Cloud server did not expose a TCP address");
      }
      return address;
    })();
    this.#listenPromise = operation;
    void operation.catch(() => {
      if (this.#listenPromise === operation) this.#listenPromise = undefined;
    });
    return operation;
  }

  startBackgroundWork(): void {
    if (this.#closed) throw new Error("Dex Cloud runtime is closed");
    if (this.#backgroundWorkStarted) return;
    this.#backgroundWorkStarted = true;
    const tick = (): void => {
      if (this.#backgroundCycleRunning || this.#closed) return;
      this.#backgroundCycleRunning = true;
      void this.runCycle()
        .catch((error) => {
          try {
            this.#onBackgroundError(error);
          } catch {
            // A reporting hook must not turn a handled background failure into
            // an unhandled rejection.
          }
        })
        .finally(() => {
          this.#backgroundCycleRunning = false;
        });
    };
    if (this.config.cloudTasks !== undefined) {
      tick();
      return;
    }
    this.#timer = setInterval(tick, this.config.pollIntervalMs);
    this.#timer.unref?.();
    tick();
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const failures: unknown[] = [];
      if (this.#timer !== undefined) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
      await this.#listenPromise?.catch(() => undefined);
      if (this.server.listening) {
        try {
          await new Promise<void>((resolve, reject) => {
            this.server.close((error) => error ? reject(error) : resolve());
          });
        } catch (error) {
          failures.push(error);
        }
      }
      await this.#cycleTail.catch(() => undefined);
      try {
        await this.modal.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.backend.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Dex Cloud runtime shutdown failed");
      }
    })();
    return this.#closePromise;
  }

  #checkReadiness(): Promise<void> {
    if (this.#readinessCheck !== undefined) return this.#readinessCheck;
    const operation = Promise.resolve().then(async () => {
      if (this.#closed) throw new Error("Dex Cloud runtime is closed");
      await this.backend.ready();
      if (this.#closed) throw new Error("Dex Cloud runtime is closed");
    });
    this.#readinessCheck = operation;
    const clear = (): void => {
      if (this.#readinessCheck === operation) this.#readinessCheck = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }
}

export function createStateBackend(config: DexCloudConfig): DexCloudStateBackend {
  if (config.persistence.kind === "postgres") {
    return new PostgresStateBackend({
        databaseUrl: config.persistence.databaseUrl,
        ...(config.persistence.ssl === undefined ? {} : { ssl: config.persistence.ssl }),
      });
  }
  if (config.persistence.kind === "cloud-sql") {
    return new CloudSqlPostgresStateBackend({
      instanceConnectionName: config.persistence.instanceConnectionName,
      database: config.persistence.database,
      user: config.persistence.user,
      ipType: config.persistence.ipType,
    });
  }
  return new AtomicFileStateBackend({ filePath: config.persistence.filePath });
}

export function createDexCloudRuntime(options: DexCloudRuntimeOptions): DexCloudRuntime {
  return new DexCloudRuntime(options);
}
