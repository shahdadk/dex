import { z } from "zod";
import { Sha256Schema } from "../modal/schemas.js";

export const ModalMonitorRequestSchema = z.object({
  taskId: z.string().min(1),
  sandboxId: z.string().min(1),
  handoffSha256: Sha256Schema,
  startedAt: z.string().datetime(),
  attempt: z.number().int().min(0).default(0),
  resultPath: z.string().startsWith("/").default("/dex/result.json"),
});

export type ModalMonitorRequest = z.input<typeof ModalMonitorRequestSchema>;
export type ParsedModalMonitorRequest = z.output<
  typeof ModalMonitorRequestSchema
>;
