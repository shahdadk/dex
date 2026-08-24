import { z } from "zod";
import {
  ModalResultArtifactSchema,
  Sha256Schema,
} from "../../cloud/modal/schemas.js";

export const CloudResultBundleSchema = z.object({
  path: z.string().startsWith("/").max(4_096),
  sha256: Sha256Schema.optional(),
  bytes: z.number().int().nonnegative().optional(),
}).passthrough();

/**
 * The result-related portion of the current task.cloud.completed payload.
 * The daemon command schema is intentionally passthrough, so the importer
 * validates the retrieval fields again at its trust boundary.
 */
export const CloudResultCompletionSchema = z.object({
  taskId: z.string().min(1).max(512),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  sandboxId: z.string().min(1).max(512).optional(),
  sandbox: z.object({
    id: z.string().min(1).max(512),
    resultPath: z.string().startsWith("/").max(4_096).optional(),
    retainedUntil: z.string().datetime().optional(),
  }).passthrough().optional(),
  handoffSha256: Sha256Schema.optional(),
  result: ModalResultArtifactSchema.optional(),
  bundle: CloudResultBundleSchema.optional(),
}).passthrough();

export type CloudResultCompletion = z.output<
  typeof CloudResultCompletionSchema
>;
