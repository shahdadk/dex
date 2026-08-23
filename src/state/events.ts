import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { eventId } from "../utils/ids.js";
import { redact } from "../utils/redact.js";
import { DexEventSchema, type DexEvent } from "./schemas.js";

export type NewDexEvent = Omit<DexEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

export class EventLog {
  readonly #file: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  append(input: NewDexEvent): Promise<DexEvent> {
    const event = DexEventSchema.parse({
      ...input,
      id: input.id ?? eventId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      payload: redact(input.payload),
    });
    const operation = this.#tail.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const handle = await open(this.#file, "a", 0o600);
      try {
        await handle.write(`${JSON.stringify(event)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return event;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}
