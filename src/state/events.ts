import { mkdir, open, readFile } from "node:fs/promises";
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
      const prepared = await prepareEventLog(this.#file, input.id ? event.id : undefined);
      if (prepared.existing) return prepared.existing;
      const handle = await open(this.#file, "a", 0o600);
      try {
        await handle.write(`${prepared.prependNewline ? "\n" : ""}${JSON.stringify(event)}\n`);
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

async function prepareEventLog(
  file: string,
  id?: string,
): Promise<{ existing?: DexEvent; prependNewline: boolean }> {
  let handle;
  try {
    handle = await open(file, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prependNewline: false };
    throw error;
  }
  let prependNewline = false;
  try {
    const metadata = await handle.stat();
    if (metadata.size > 0) {
      const windowBytes = Math.min(metadata.size, 8 * 1024 * 1024);
      const buffer = Buffer.alloc(windowBytes);
      await handle.read(buffer, 0, windowBytes, metadata.size - windowBytes);
      if (buffer[buffer.length - 1] !== 0x0a) {
        const previousNewline = buffer.lastIndexOf(0x0a);
        if (previousNewline < 0 && windowBytes !== metadata.size) {
          throw new Error("Dex event log has an oversized unterminated tail");
        }
        const tailStart = metadata.size - windowBytes + previousNewline + 1;
        const tail = buffer.subarray(previousNewline + 1).toString("utf8");
        try {
          DexEventSchema.parse(JSON.parse(tail));
          prependNewline = true;
        } catch {
          // A process crash may tear only the final append. Keep every
          // newline-terminated event and discard the unrecoverable tail.
          await handle.truncate(tailStart);
          await handle.sync();
        }
      }
    }
  } finally {
    await handle.close();
  }

  if (!id) return { prependNewline };
  const contents = await readFile(file, "utf8");
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const parsed = DexEventSchema.parse(JSON.parse(line));
    if (parsed.id === id) return { existing: parsed, prependNewline };
  }
  return { prependNewline };
}
