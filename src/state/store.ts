import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { DexStateSchema, emptyState, type DexState } from "./schemas.js";

export class AtomicJsonStore<T> {
  readonly #file: string;
  readonly #schema: ZodType<T>;
  readonly #fallback: () => T;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(file: string, schema: ZodType<T>, fallback: () => T) {
    this.#file = file;
    this.#schema = schema;
    this.#fallback = fallback;
  }

  async read(): Promise<T> {
    try {
      return this.#schema.parse(JSON.parse(await readFile(this.#file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.#fallback();
      throw new Error(`Dex state is unreadable at ${this.#file}`, { cause: error });
    }
  }

  async write(value: T): Promise<void> {
    const parsed = this.#schema.parse(value);
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temp, this.#file);
      const directory = await open(path.dirname(this.#file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    const operation = this.#tail.then(async () => {
      const current = await this.read();
      const next = await mutator(current);
      await this.write(next);
      return next;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

export class DexStateStore extends AtomicJsonStore<DexState> {
  constructor(file: string) {
    super(file, DexStateSchema, emptyState);
  }

  updateState(mutator: (draft: DexState) => void): Promise<DexState> {
    return this.update((current) => {
      const draft = structuredClone(current);
      mutator(draft);
      draft.revision += 1;
      return draft;
    });
  }
}
