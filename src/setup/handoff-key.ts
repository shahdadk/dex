import { randomBytes } from "node:crypto";

export const ROOT_HANDOFF_KEY_BYTES = 32;
export const ROOT_HANDOFF_KEY_BASE64URL_LENGTH = 43;
export const ROOT_HANDOFF_KEY_REQUIREMENT =
  `DEX_HANDOFF_SIGNING_KEY must be ${ROOT_HANDOFF_KEY_BASE64URL_LENGTH} unpadded base64url characters encoding exactly ${ROOT_HANDOFF_KEY_BYTES} bytes`;

const ROOT_HANDOFF_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isStrongRootHandoffKey(value: string): boolean {
  if (!ROOT_HANDOFF_KEY_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === ROOT_HANDOFF_KEY_BYTES
    && decoded.toString("base64url") === value;
}

export function assertStrongRootHandoffKey(value: string | undefined): asserts value is string {
  if (!value) {
    throw new Error("DEX_HANDOFF_SIGNING_KEY is missing; run dex setup to generate it");
  }
  if (!isStrongRootHandoffKey(value)) {
    throw new Error(ROOT_HANDOFF_KEY_REQUIREMENT);
  }
}

/** Creates the root key only during setup; callers must never display the value. */
export function ensureRootHandoffKey(
  env: NodeJS.ProcessEnv = process.env,
): "generated" | "rotated" | "existing" {
  const existing = env.DEX_HANDOFF_SIGNING_KEY;
  if (existing && isStrongRootHandoffKey(existing)) return "existing";
  env.DEX_HANDOFF_SIGNING_KEY = randomBytes(ROOT_HANDOFF_KEY_BYTES).toString("base64url");
  return existing ? "rotated" : "generated";
}
