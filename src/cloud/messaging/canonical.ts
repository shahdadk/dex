import {
  canonicalJson as sharedCanonicalJson,
  sha256Hex as sharedSha256Hex,
} from "../../memory/integrity.js";

/** The canonical JSON representation used by every Dex device signature. */
export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

/** SHA-256 over UTF-8 text, raw bytes, or the canonical JSON form of a value. */
export function sha256Hex(value: string | Uint8Array | unknown): string {
  return sharedSha256Hex(value);
}
