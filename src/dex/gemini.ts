import { DexActionsSchema, type DexAction } from "./actions.js";

export interface GeminiRouterOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GeminiRouter {
  readonly #apiKey: string | undefined;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GeminiRouterOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.#endpoint = options.endpoint ?? "https://generativelanguage.googleapis.com/v1beta/models";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
  }

  get available(): boolean {
    return Boolean(this.#apiKey);
  }

  async route(message: string, tier: "fast" | "brain"): Promise<DexAction[]> {
    if (!this.#apiKey) throw new Error("Gemini routing is unavailable: GEMINI_API_KEY is not configured");
    const model = tier === "fast" ? "gemini-3.5-flash-lite" : "gemini-3.7-flash";
    const thinkingLevel = tier === "fast" ? "minimal" : "low";
    const response = await this.#fetch(
      `${this.#endpoint}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.#apiKey,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: ROUTER_PROMPT }],
          },
          contents: [{ role: "user", parts: [{ text: message }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: GEMINI_ACTION_SCHEMA,
            temperature: 0,
            thinkingConfig: { thinkingLevel },
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Gemini ${model} routing failed (${response.status})`);
    }
    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
    if (!text) throw new Error(`Gemini ${model} returned no structured actions`);
    return DexActionsSchema.parse(normalizeGeminiActions(JSON.parse(text)));
  }
}

/**
 * Normalize a very small set of harmless provider aliases before the strict
 * Zod boundary. Gemini remains unable to introduce an executable operation:
 * every result still has to match DexAction exactly.
 */
export function normalizeGeminiActions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const action = candidate as Record<string, unknown>;
    const rawType = typeof action.type === "string" ? action.type.toUpperCase() : action.type;
    return {
      ...action,
      type: rawType,
      ...(action.preferredAgent === undefined && action.agent !== undefined
        ? { preferredAgent: action.agent }
        : {}),
      ...(action.executionPreference === undefined && action.execution !== undefined
        ? { executionPreference: action.execution }
        : {}),
    };
  });
}

const GEMINI_ACTION_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  items: {
    anyOf: [
      {
        type: "object",
        properties: {
          type: { const: "CREATE_TASK" },
          description: { type: "string" },
          preferredAgent: { enum: ["claude", "codex"] },
          executionPreference: { enum: ["local", "cloud"] },
        },
        required: ["type", "description"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { type: { const: "STATUS" }, taskQuery: { type: "string" } },
        required: ["type"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { type: { const: "MEMORY_QUERY" }, query: { type: "string" } },
        required: ["type", "query"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "MOVE_TASK" },
          taskQuery: { type: "string" },
          destination: { enum: ["local", "cloud"] },
          preferredAgent: { enum: ["claude", "codex"] },
        },
        required: ["type", "taskQuery", "destination"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "CHANGE_AGENT" },
          taskQuery: { type: "string" },
          agent: { enum: ["claude", "codex"] },
        },
        required: ["type", "taskQuery", "agent"],
        additionalProperties: false,
      },
      ...["STOP_TASK", "RESUME_TASK"].map((type) => ({
        type: "object",
        properties: { type: { const: type }, taskQuery: { type: "string" } },
        required: ["type", "taskQuery"],
        additionalProperties: false,
      })),
      {
        type: "object",
        properties: { type: { const: "KEEP_AWAKE" }, until: { const: "tasks_complete" } },
        required: ["type"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { type: { const: "SLEEP" }, when: { enum: ["now", "tasks_complete"] } },
        required: ["type", "when"],
        additionalProperties: false,
      },
    ],
  },
} as const;

const ROUTER_PROMPT = `You route messages for Dex, a persistent software developer.
Return only a JSON array of actions. Never return shell commands.
Allowed action types: CREATE_TASK, STATUS, MEMORY_QUERY, MOVE_TASK, CHANGE_AGENT,
STOP_TASK, RESUME_TASK, KEEP_AWAKE, SLEEP.
Split independent engineering outcomes into separate CREATE_TASK actions.
Use preferredAgent for explicit Claude/Codex choices and executionPreference for local/cloud choices.
The type field must use the exact uppercase enum value shown above.
Use SLEEP with tasks_complete when the user says sleep when done.`;
