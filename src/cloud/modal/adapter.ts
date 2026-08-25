export type MaybePromise<T> = T | Promise<T>;

export interface ModalAppLike {
  readonly appId?: string;
}

export interface ModalImageLike {
  dockerfileCommands?(commands: string[]): ModalImageLike;
}

export interface ModalReadStreamLike {
  readText(): Promise<string>;
}

export interface ModalWriteStreamLike {
  getWriter(): WritableStreamDefaultWriter<string>;
}

export interface ModalProcessLike {
  /** Modal always exposes stdin; optional keeps injected legacy test doubles source-compatible. */
  readonly stdin?: ModalWriteStreamLike;
  readonly stdout: ModalReadStreamLike;
  readonly stderr: ModalReadStreamLike;
  wait(): Promise<number>;
}

export interface ModalFilesystemLike {
  copyFromLocal(localPath: string, remotePath: string): Promise<void>;
  copyToLocal(remotePath: string, localPath: string): Promise<void>;
  readText(remotePath: string): Promise<string>;
  writeText(data: string, remotePath: string): Promise<void>;
}

export interface ModalSecretLike {}

export interface ModalVolumeLike {}

export type ModalSandboxCreateParams = Record<string, unknown>;
export type ModalSandboxExecParams = Record<string, unknown>;

export interface ModalSdkSandboxLike {
  readonly sandboxId: string;
  readonly filesystem: ModalFilesystemLike;
  exec(
    command: string[],
    params?: ModalSandboxExecParams,
  ): Promise<ModalProcessLike>;
  detach(): MaybePromise<void>;
  terminate(params?: { wait?: boolean }): Promise<void | number>;
  poll(): Promise<number | null>;
}

export interface ModalClientLike {
  readonly apps: {
    fromName(
      name: string,
      params?: { createIfMissing?: boolean; environment?: string },
    ): Promise<ModalAppLike>;
  };
  readonly images: {
    fromRegistry(tag: string): ModalImageLike;
  };
  readonly sandboxes: {
    create(
      app: ModalAppLike,
      image: ModalImageLike,
      params?: ModalSandboxCreateParams,
    ): Promise<ModalSdkSandboxLike>;
    fromId(sandboxId: string): Promise<ModalSdkSandboxLike>;
  };
  readonly secrets: {
    fromName(
      name: string,
      params?: { environment?: string; requiredKeys?: string[] },
    ): Promise<ModalSecretLike>;
    fromObject?(
      entries: Record<string, string>,
      params?: { environment?: string },
    ): Promise<ModalSecretLike>;
  };
  readonly volumes?: {
    fromName(
      name: string,
      params?: { environment?: string; createIfMissing?: boolean },
    ): Promise<ModalVolumeLike>;
  };
  close?(): void;
}

export interface ModalSdkModuleLike {
  ModalClient: new (params?: Record<string, unknown>) => ModalClientLike;
}

export type ModalSdkLoader = () => Promise<ModalSdkModuleLike>;

export interface ModalAdapterOptions {
  /** A ready client is useful for tests and applications managing one globally. */
  client?: ModalClientLike;
  /** The SDK module or a lazy loader. The default imports the `modal` package. */
  sdk?: ModalSdkModuleLike | ModalSdkLoader;
  clientParams?: Record<string, unknown>;
}

export interface CreateModalSandboxOptions {
  appName?: string;
  app?: ModalAppLike;
  image?: string | ModalImageLike;
  imageCommands?: string[];
  environment?: string;
  createAppIfMissing?: boolean;
  secretNames?: string[];
  /** Ephemeral Modal secret values sent directly to the worker, never written into handoff files. */
  secretValues?: Record<string, string>;
  requiredSecretKeys?: string[];
  /** Named Modal Volumes keyed by their absolute Sandbox mount path. */
  volumeNames?: Record<string, string>;
  createVolumesIfMissing?: boolean;
  params?: ModalSandboxCreateParams;
}

export const DEFAULT_MODAL_APP_NAME = "dex";
export const DEFAULT_MODAL_IMAGE = "node:22-bookworm";

async function loadInstalledModalSdk(): Promise<ModalSdkModuleLike> {
  // A variable specifier keeps Modal an optional runtime dependency. Consumers
  // that use this adapter install `modal`; unit tests inject a tiny SDK facade.
  const packageName = "modal";
  let imported: unknown;
  try {
    imported = await import(packageName);
  } catch (cause) {
    throw new Error(
      "The Modal JavaScript SDK is not installed. Install `modal` or inject a Modal SDK/client.",
      { cause },
    );
  }

  const sdk = imported as Partial<ModalSdkModuleLike>;
  if (typeof sdk.ModalClient !== "function") {
    throw new TypeError("The loaded `modal` package does not export ModalClient");
  }
  return sdk as ModalSdkModuleLike;
}

/** A thin handle that preserves the real Modal Sandbox behavior. */
export class ModalSandbox {
  readonly #sandbox: ModalSdkSandboxLike;

  constructor(sandbox: ModalSdkSandboxLike) {
    this.#sandbox = sandbox;
  }

  get sandboxId(): string {
    return this.#sandbox.sandboxId;
  }

  get id(): string {
    return this.sandboxId;
  }

  get raw(): ModalSdkSandboxLike {
    return this.#sandbox;
  }

  copyFromLocal(localPath: string, remotePath: string): Promise<void> {
    return this.#sandbox.filesystem.copyFromLocal(localPath, remotePath);
  }

  exec(
    command: string[],
    params?: ModalSandboxExecParams,
  ): Promise<ModalProcessLike> {
    return this.#sandbox.exec(command, params);
  }

  detach(): MaybePromise<void> {
    return this.#sandbox.detach();
  }

  copyToLocal(remotePath: string, localPath: string): Promise<void> {
    return this.#sandbox.filesystem.copyToLocal(remotePath, localPath);
  }

  terminate(params?: { wait?: boolean }): Promise<void | number> {
    return this.#sandbox.terminate(params);
  }

  poll(): Promise<number | null> {
    return this.#sandbox.poll();
  }
}

export type ModalSandboxReference =
  | string
  | ModalSandbox
  | ModalSdkSandboxLike;

/**
 * Adapter over Modal's real JavaScript SDK. SDK loading and client creation are
 * deferred until the first operation, so importing Dex does not require Modal.
 */
export class ModalAdapter {
  readonly #clientParams: Record<string, unknown> | undefined;
  readonly #sdkLoader: ModalSdkLoader;
  #clientPromise: Promise<ModalClientLike> | undefined;

  constructor(options: ModalAdapterOptions = {}) {
    this.#clientParams = options.clientParams;
    if (options.client) {
      this.#clientPromise = Promise.resolve(options.client);
    }

    if (typeof options.sdk === "function") {
      this.#sdkLoader = options.sdk;
    } else if (options.sdk) {
      const sdk = options.sdk;
      this.#sdkLoader = async () => sdk;
    } else {
      this.#sdkLoader = loadInstalledModalSdk;
    }
  }

  async client(): Promise<ModalClientLike> {
    this.#clientPromise ??= this.#sdkLoader().then(
      (sdk) => new sdk.ModalClient(this.#clientParams),
    );
    return this.#clientPromise;
  }

  async create(options?: CreateModalSandboxOptions): Promise<ModalSandbox>;
  async create(
    appName: string,
    image: string | ModalImageLike,
    params?: ModalSandboxCreateParams,
  ): Promise<ModalSandbox>;
  async create(
    optionsOrAppName: CreateModalSandboxOptions | string = {},
    positionalImage?: string | ModalImageLike,
    positionalParams?: ModalSandboxCreateParams,
  ): Promise<ModalSandbox> {
    const options: CreateModalSandboxOptions =
      typeof optionsOrAppName === "string"
        ? {
            appName: optionsOrAppName,
            image: positionalImage ?? DEFAULT_MODAL_IMAGE,
            ...(positionalParams === undefined ? {} : { params: positionalParams }),
          }
        : optionsOrAppName;

    const client = await this.client();
    const app = options.app ?? (await client.apps.fromName(
      options.appName ?? DEFAULT_MODAL_APP_NAME,
      {
        createIfMissing: options.createAppIfMissing ?? true,
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      },
    ));

    const imageInput = options.image ?? DEFAULT_MODAL_IMAGE;
    let image =
      typeof imageInput === "string"
        ? client.images.fromRegistry(imageInput)
        : imageInput;
    if (options.imageCommands && options.imageCommands.length > 0) {
      if (!image.dockerfileCommands) {
        throw new TypeError("The selected Modal image cannot apply image commands");
      }
      image = image.dockerfileCommands(options.imageCommands);
    }

    const namedSecrets = options.secretNames?.length
      ? await Promise.all(
          options.secretNames.map((name) =>
            client.secrets.fromName(name, {
              ...(options.environment === undefined ? {} : { environment: options.environment }),
              ...(options.requiredSecretKeys?.length
                ? { requiredKeys: options.requiredSecretKeys }
                : {}),
            }),
          ),
        )
      : [];
    let inlineSecrets: ModalSecretLike[] = [];
    if (options.secretValues && Object.keys(options.secretValues).length > 0) {
      if (!client.secrets.fromObject) {
        throw new TypeError("The installed Modal SDK cannot create an ephemeral worker secret");
      }
      const entries = Object.fromEntries(
        Object.entries(options.secretValues).map(([name, value]) => {
          if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(name) || !value) {
            throw new TypeError("Modal ephemeral secret entries must have valid non-empty environment keys");
          }
          return [name, value];
        }),
      );
      inlineSecrets = [await client.secrets.fromObject(entries, {
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      })];
    }
    const namedVolumes: Record<string, ModalVolumeLike> = {};
    if (options.volumeNames && Object.keys(options.volumeNames).length > 0) {
      if (!client.volumes) {
        throw new TypeError("The installed Modal SDK cannot mount named Volumes");
      }
      for (const [mountPath, name] of Object.entries(options.volumeNames)) {
        if (!mountPath.startsWith("/") || !name.trim()) {
          throw new TypeError("Modal Volume mounts require an absolute path and non-empty name");
        }
        namedVolumes[mountPath] = await client.volumes.fromName(name, {
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          createIfMissing: options.createVolumesIfMissing ?? false,
        });
      }
    }
    const params = {
      ...(options.params ?? {}),
      ...(namedSecrets.length + inlineSecrets.length > 0
        ? {
            secrets: [
              ...(((options.params?.secrets as ModalSecretLike[] | undefined) ?? [])),
              ...namedSecrets,
              ...inlineSecrets,
            ],
          }
        : {}),
      ...(Object.keys(namedVolumes).length > 0
        ? {
            volumes: {
              ...(((options.params?.volumes as Record<string, ModalVolumeLike> | undefined) ?? {})),
              ...namedVolumes,
            },
          }
        : {}),
    };

    return new ModalSandbox(
      await client.sandboxes.create(app, image, params),
    );
  }

  async fromId(sandboxId: string): Promise<ModalSandbox> {
    const client = await this.client();
    return new ModalSandbox(await client.sandboxes.fromId(sandboxId));
  }

  async copyFromLocal(
    reference: ModalSandboxReference,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    const sandbox = await this.#resolve(reference);
    await sandbox.filesystem.copyFromLocal(localPath, remotePath);
  }

  async exec(
    reference: ModalSandboxReference,
    command: string[],
    params?: ModalSandboxExecParams,
  ): Promise<ModalProcessLike> {
    return (await this.#resolve(reference)).exec(command, params);
  }

  async detach(reference: ModalSandboxReference): Promise<void> {
    await (await this.#resolve(reference)).detach();
  }

  async copyToLocal(
    reference: ModalSandboxReference,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    const sandbox = await this.#resolve(reference);
    await sandbox.filesystem.copyToLocal(remotePath, localPath);
  }

  async terminate(
    reference: ModalSandboxReference,
    params?: { wait?: boolean },
  ): Promise<void | number> {
    return (await this.#resolve(reference)).terminate(params);
  }

  async close(): Promise<void> {
    if (!this.#clientPromise) return;
    (await this.#clientPromise).close?.();
  }

  async #resolve(reference: ModalSandboxReference): Promise<ModalSdkSandboxLike> {
    if (typeof reference === "string") return (await this.fromId(reference)).raw;
    if (reference instanceof ModalSandbox) return reference.raw;
    return reference;
  }
}

export const ModalSdkAdapter = ModalAdapter;

export function createModalAdapter(options?: ModalAdapterOptions): ModalAdapter {
  return new ModalAdapter(options);
}
