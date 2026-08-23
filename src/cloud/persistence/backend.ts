import { createRequire } from "node:module";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  emptyDexCloudState,
  parseDexCloudState,
  type DexCloudStateDocument,
} from "./state.js";

export interface DexCloudStateBackend {
  read<T>(reader: (state: DexCloudStateDocument) => T | Promise<T>): Promise<T>;
  mutate<T>(mutation: (state: DexCloudStateDocument) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface QueryResult<T> {
  rows: T[];
}

interface PgClientLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

interface PgPoolLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

interface PgPoolConstructor {
  new(options: Record<string, unknown>): PgPoolLike;
}

export interface PostgresStateBackendOptions {
  databaseUrl: string;
  rowId?: string;
  maxConnections?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

const require = createRequire(import.meta.url);

/**
 * PostgreSQL durability using one transactionally locked JSONB aggregate row.
 * The deliberately small schema is sufficient for the hackathon composition
 * while preserving atomic control-plane, scheduler, and delivery transitions.
 */
export class PostgresStateBackend implements DexCloudStateBackend {
  readonly #pool: PgPoolLike;
  readonly #rowId: string;
  readonly #ready: Promise<void>;

  constructor(options: PostgresStateBackendOptions) {
    let url: URL;
    try {
      url = new URL(options.databaseUrl);
    } catch {
      throw new TypeError("DEX_DATABASE_URL must be a valid PostgreSQL URL");
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new TypeError("DEX_DATABASE_URL must use postgres:// or postgresql://");
    }
    const max = options.maxConnections ?? 4;
    if (!Number.isSafeInteger(max) || max < 1 || max > 32) {
      throw new RangeError("PostgreSQL connection count must be between one and 32");
    }
    const module = require("pg") as { Pool: PgPoolConstructor };
    this.#pool = new module.Pool({
      connectionString: options.databaseUrl,
      max,
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    });
    this.#rowId = options.rowId ?? "default";
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(this.#rowId)) {
      throw new TypeError("Dex cloud state row ID is invalid");
    }
    this.#ready = this.#initialize();
  }

  async #initialize(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS dex_cloud_state (
        id text PRIMARY KEY,
        state jsonb NOT NULL,
        revision bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.#pool.query(
      `INSERT INTO dex_cloud_state (id, state)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [this.#rowId, JSON.stringify(emptyDexCloudState())],
    );
  }

  async read<T>(reader: (state: DexCloudStateDocument) => T | Promise<T>): Promise<T> {
    await this.#ready;
    const result = await this.#pool.query<{ state: unknown }>(
      "SELECT state FROM dex_cloud_state WHERE id = $1",
      [this.#rowId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Dex cloud persistence state row is unavailable");
    return reader(parseDexCloudState(row.state));
  }

  async mutate<T>(mutation: (state: DexCloudStateDocument) => T | Promise<T>): Promise<T> {
    await this.#ready;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ state: unknown }>(
        "SELECT state FROM dex_cloud_state WHERE id = $1 FOR UPDATE",
        [this.#rowId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Dex cloud persistence state row is unavailable");
      const state = parseDexCloudState(row.state);
      const output = await mutation(state);
      await client.query(
        `UPDATE dex_cloud_state
         SET state = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE id = $1`,
        [this.#rowId, JSON.stringify(state)],
      );
      await client.query("COMMIT");
      return output;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export interface AtomicFileStateBackendOptions {
  filePath: string;
}

/** Single-process development fallback with fsync + same-directory rename. */
export class AtomicFileStateBackend implements DexCloudStateBackend {
  readonly #filePath: string;
  #tail: Promise<unknown> = Promise.resolve();
  #temporarySequence = 0;

  constructor(options: AtomicFileStateBackendOptions) {
    if (!path.isAbsolute(options.filePath)) {
      throw new TypeError("Dex cloud state file path must be absolute");
    }
    this.#filePath = options.filePath;
  }

  read<T>(reader: (state: DexCloudStateDocument) => T | Promise<T>): Promise<T> {
    return this.#serialized(async () => reader(await this.#readState()));
  }

  mutate<T>(mutation: (state: DexCloudStateDocument) => T | Promise<T>): Promise<T> {
    return this.#serialized(async () => {
      const state = await this.#readState();
      const result = await mutation(state);
      await this.#writeState(state);
      return result;
    });
  }

  async close(): Promise<void> {
    await this.#tail.catch(() => undefined);
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #readState(): Promise<DexCloudStateDocument> {
    try {
      return parseDexCloudState(JSON.parse(await readFile(this.#filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDexCloudState();
      throw error;
    }
  }

  async #writeState(state: DexCloudStateDocument): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.#temporarySequence += 1;
    const temporary = path.join(
      directory,
      `.${path.basename(this.#filePath)}.${process.pid}.${this.#temporarySequence}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#filePath);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
