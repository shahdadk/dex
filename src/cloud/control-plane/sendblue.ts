import { createHash, timingSafeEqual } from "node:crypto";
import { ControlPlaneError } from "./errors.js";
import {
  SendblueInboundWebhookSchema,
  type ParsedInboundMessage,
  type SendblueInboundWebhook,
} from "./models.js";

export const SENDBLUE_SECRET_HEADER = "sb-signing-secret";

export type HeaderSource =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined) continue;
    return typeof value === "string" ? value : value[0];
  }
  return undefined;
}

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function constantTimeSecretEqual(supplied: string | undefined, expected: string): boolean {
  if (!expected) throw new TypeError("An expected secret is required");
  if (supplied === undefined || supplied.length === 0) return false;
  return timingSafeEqual(secretDigest(supplied), secretDigest(expected));
}

/** Sendblue currently transmits the configured secret verbatim in this header. */
export function verifySendblueWebhookSecret(
  headers: HeaderSource,
  expectedSecret: string,
): boolean {
  if (!expectedSecret) throw new TypeError("A Sendblue webhook secret is required");
  const supplied = headerValue(headers, SENDBLUE_SECRET_HEADER);
  return constantTimeSecretEqual(supplied, expectedSecret);
}

export function parseSendblueInboundWebhook(input: unknown): SendblueInboundWebhook {
  const result = SendblueInboundWebhookSchema.safeParse(input);
  if (!result.success) {
    throw new ControlPlaneError(400, "invalid_sendblue_webhook", "Invalid Sendblue webhook");
  }
  return result.data;
}

export function parseInboundMessage(text: string): ParsedInboundMessage {
  const normalized = text.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  const withoutAddress = normalized.replace(/^dex(?:\s*[,;:]|\s+)\s*/i, "").trim();
  if (/^pair$/i.test(withoutAddress)) return { kind: "pair" };
  const pairing = /^pair\s+(\S+)$/i.exec(withoutAddress);
  if (pairing) {
    const setupCode = pairing[1]!;
    if (!/^[A-Z0-9_-]{16,128}$/.test(setupCode)) {
      throw new ControlPlaneError(
        400,
        "invalid_pairing_code_format",
        "Pairing setup code is not in the expected high-entropy format",
      );
    }
    return { kind: "pair", setupCode };
  }
  if (/^pair\b/i.test(withoutAddress)) {
    throw new ControlPlaneError(400, "invalid_pairing_command", "Invalid PAIR command");
  }
  if (!withoutAddress) {
    throw new ControlPlaneError(400, "empty_message", "Message does not contain an instruction");
  }
  return { kind: "engineering", text: withoutAddress };
}

export function conciseTaskTitle(text: string): string {
  const firstLine = text.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
  return firstLine.slice(0, 72) || "Engineering task";
}
