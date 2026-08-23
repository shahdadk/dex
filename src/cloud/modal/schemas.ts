import { z } from "zod";

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

/**
 * Written by the cloud worker before the local machine is allowed to sleep.
 * The IDs are evidence that the handoff context was actually loaded.
 */
export const ModalStartupAcknowledgementSchema = z.object({
  taskId: z.string().min(1),
  handoffSha256: Sha256Schema,
  sandboxId: z.string().min(1).optional(),
  providerThreadId: z.string().min(1),
  loadedMemoryIds: z.array(z.string().min(1)),
  loadedFailedApproachIds: z.array(z.string().min(1)),
  acknowledgedAt: z.string().datetime().optional(),
});

export type ModalStartupAcknowledgement = z.infer<
  typeof ModalStartupAcknowledgementSchema
>;

// Short aliases are convenient at artifact read sites.
export const ModalStartupSchema = ModalStartupAcknowledgementSchema;
export type ModalStartup = ModalStartupAcknowledgement;

export const ModalResultStatusSchema = z.enum([
  "succeeded",
  "failed",
  "cancelled",
]);

export const ModalResultArtifactSchema = z.object({
  taskId: z.string().min(1),
  handoffSha256: Sha256Schema,
  status: ModalResultStatusSchema,
  summary: z.string().min(1),
  validation: z.object({
    commands: z.array(z.string().min(1)),
    passed: z.boolean(),
  }),
  git: z.object({
    branch: z.string().min(1),
    commit: z.string().min(1),
    bundlePath: z.string().startsWith("/").optional(),
    bundleSha256: Sha256Schema.optional(),
  }),
});

export type ModalResultArtifact = z.infer<typeof ModalResultArtifactSchema>;

export const ModalResultSchema = ModalResultArtifactSchema;
export type ModalResult = ModalResultArtifact;
