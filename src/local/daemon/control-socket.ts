import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import path from "node:path";
import { z } from "zod";

export const ControlCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("demo.battery"), percent: z.number().int().min(0).max(100) }).strict(),
  z.object({ type: z.literal("power.restore") }).strict(),
]);
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

const ControlResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export interface DexControlServer {
  close(): Promise<void>;
}

export async function startControlSocket(
  socketPath: string,
  handle: (command: ControlCommand) => Promise<void>,
): Promise<DexControlServer> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 8_192) socket.destroy(new Error("Dex control request is too large"));
      if (handled || !input.includes("\n")) return;
      handled = true;
      void (async () => {
        try {
          const command = ControlCommandSchema.parse(JSON.parse(input.slice(0, input.indexOf("\n"))));
          await handle(command);
          socket.end(`${JSON.stringify({ ok: true })}\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          socket.end(`${JSON.stringify({ ok: false, error: message.slice(0, 500) })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    close: async () => {
      await closeServer(server);
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

export async function sendControlCommand(socketPath: string, command: ControlCommand): Promise<void> {
  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => { output += chunk; });
    socket.once("connect", () => socket.write(`${JSON.stringify(ControlCommandSchema.parse(command))}\n`));
    socket.once("close", () => resolve(output));
  });
  const parsed = ControlResponseSchema.parse(JSON.parse(response));
  if (!parsed.ok) throw new Error(parsed.error);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
