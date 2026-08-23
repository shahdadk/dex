import { z } from "zod";
import { AgentKindSchema } from "../state/schemas.js";

const CreateTaskActionSchema = z.object({
  type: z.literal("CREATE_TASK"),
  description: z.string().min(1).max(4000),
  preferredAgent: AgentKindSchema.optional(),
  executionPreference: z.enum(["local", "cloud"]).optional(),
});

export const DexActionSchema = z.discriminatedUnion("type", [
  CreateTaskActionSchema,
  z.object({ type: z.literal("STATUS"), taskQuery: z.string().min(1).optional() }),
  z.object({ type: z.literal("MEMORY_QUERY"), query: z.string().min(1) }),
  z.object({
    type: z.literal("MOVE_TASK"),
    taskQuery: z.string().min(1),
    destination: z.enum(["local", "cloud"]),
    preferredAgent: AgentKindSchema.optional(),
  }),
  z.object({
    type: z.literal("CHANGE_AGENT"),
    taskQuery: z.string().min(1),
    agent: AgentKindSchema,
  }),
  z.object({ type: z.literal("STOP_TASK"), taskQuery: z.string().min(1) }),
  z.object({ type: z.literal("RESUME_TASK"), taskQuery: z.string().min(1) }),
  z.object({ type: z.literal("KEEP_AWAKE"), until: z.literal("tasks_complete").optional() }),
  z.object({ type: z.literal("SLEEP"), when: z.enum(["now", "tasks_complete"]) }),
]);

export const DexActionsSchema = z.array(DexActionSchema).min(1).max(8);
export type DexAction = z.infer<typeof DexActionSchema>;

export interface RouteResult {
  actions: DexAction[];
  source: "deterministic" | "flash-lite" | "flash";
}
