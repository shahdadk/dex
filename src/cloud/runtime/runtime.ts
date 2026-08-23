import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  DexControlPlaneService,
  createDexControlPlaneFetchHandler,
  createDexControlPlaneServer,
} from "../control-plane/index.js";
import { ModalAdapter } from "../modal/index.js";
import {
  AtomicFileStateBackend,
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
  readonly #sendblueDispatcher: SendblueOutboxDispatcher;
  readonly #onBackgroundError: (error: unknown) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #cycleTail: Promise<unknown> = Promise.resolve();
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
    this.fetchHandler = createDexControlPlaneFetchHandler({ service: this.service });
    this.server = createDexControlPlaneServer({ service: this.service });

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
      const monitors = await this.#monitorRunner.drain(monitorLimit);
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

  async listen(): Promise<AddressInfo> {
    if (this.#closed) throw new Error("Dex Cloud runtime is closed");
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
  }

  startBackgroundWork(): void {
    if (this.#closed) throw new Error("Dex Cloud runtime is closed");
    if (this.#timer !== undefined) return;
    const tick = (): void => {
      void this.runCycle().catch(this.#onBackgroundError);
    };
    this.#timer = setInterval(tick, this.config.pollIntervalMs);
    this.#timer.unref?.();
    tick();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
      });
    }
    await this.#cycleTail.catch(() => undefined);
    await this.modal.close();
    await this.backend.close();
  }
}

export function createStateBackend(config: DexCloudConfig): DexCloudStateBackend {
  return config.persistence.kind === "postgres"
    ? new PostgresStateBackend({
        databaseUrl: config.persistence.databaseUrl,
        ...(config.persistence.ssl === undefined ? {} : { ssl: config.persistence.ssl }),
      })
    : new AtomicFileStateBackend({ filePath: config.persistence.filePath });
}

export function createDexCloudRuntime(options: DexCloudRuntimeOptions): DexCloudRuntime {
  return new DexCloudRuntime(options);
}
