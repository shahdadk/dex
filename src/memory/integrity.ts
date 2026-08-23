import {
  createHash,
  createHmac,
  timingSafeEqual,
  type BinaryLike,
  type KeyObject,
} from "node:crypto";

export interface ManifestArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ManifestSignature {
  algorithm: "hmac-sha256" | string;
  value: string;
  keyId?: string;
}

export interface IntegrityManifest {
  version: 1;
  algorithm: "sha256";
  contentSha256: string;
  artifacts: ManifestArtifact[];
  signature?: ManifestSignature;
}

export interface ManifestArtifactInput {
  path: string;
  content?: string | Uint8Array;
  bytes?: number;
  sha256?: string;
}

export type ManifestSigner = (
  manifestBytes: Uint8Array,
  manifest: Readonly<IntegrityManifest>,
) => Promise<ManifestSignature | string> | ManifestSignature | string;

export type ManifestVerifier = (
  manifestBytes: Uint8Array,
  signature: Readonly<ManifestSignature>,
  manifest: Readonly<IntegrityManifest>,
) => Promise<boolean> | boolean;

type HmacKey = BinaryLike | KeyObject;

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, ancestors) ?? null);
    }
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const normalized = canonicalize(record[key], ancestors);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  const normalized = canonicalize(value, new Set());
  if (normalized === undefined) throw new TypeError("Cannot canonicalize undefined as a document");
  return JSON.stringify(normalized);
}

export function sha256Hex(value: string | Uint8Array | unknown): string {
  const input =
    typeof value === "string" || value instanceof Uint8Array ? value : canonicalJson(value);
  return createHash("sha256").update(input).digest("hex");
}

function unsignedManifest(manifest: IntegrityManifest): IntegrityManifest {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

export function manifestSigningBytes(manifest: IntegrityManifest): Uint8Array {
  return Buffer.from(canonicalJson(unsignedManifest(manifest)), "utf8");
}

export function createManifest(
  content: unknown,
  artifactInputs: readonly ManifestArtifactInput[] = [],
): IntegrityManifest {
  const artifacts = artifactInputs
    .map((artifact): ManifestArtifact => {
      if (!artifact.path.trim()) throw new TypeError("Manifest artifact path cannot be empty");
      const contentBytes =
        artifact.content === undefined
          ? undefined
          : typeof artifact.content === "string"
            ? Buffer.from(artifact.content, "utf8")
            : artifact.content;
      const bytes = artifact.bytes ?? contentBytes?.byteLength;
      const sha256 = artifact.sha256 ?? (contentBytes === undefined ? undefined : sha256Hex(contentBytes));
      if (bytes === undefined || !Number.isInteger(bytes) || bytes < 0 || sha256 === undefined) {
        throw new TypeError(`Manifest artifact ${artifact.path} requires content or bytes plus sha256`);
      }
      if (!/^[a-f0-9]{64}$/i.test(sha256)) {
        throw new TypeError(`Manifest artifact ${artifact.path} has an invalid SHA-256 digest`);
      }
      return { path: artifact.path, bytes, sha256: sha256.toLowerCase() };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: 1,
    algorithm: "sha256",
    contentSha256: sha256Hex(content),
    artifacts,
  };
}

export async function signManifest(
  manifest: IntegrityManifest,
  signer: ManifestSigner | HmacKey,
  keyId?: string,
): Promise<IntegrityManifest> {
  const unsigned = unsignedManifest(manifest);
  const bytes = manifestSigningBytes(unsigned);
  let signature: ManifestSignature;
  if (typeof signer === "function") {
    const result = await signer(bytes, unsigned);
    signature = typeof result === "string" ? { algorithm: "hmac-sha256", value: result } : result;
  } else {
    signature = {
      algorithm: "hmac-sha256",
      value: createHmac("sha256", signer).update(bytes).digest("hex"),
    };
  }
  if (keyId !== undefined && signature.keyId === undefined) signature = { ...signature, keyId };
  return { ...unsigned, signature };
}

function equalSignatures(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export async function verifyManifest(
  content: unknown,
  manifest: IntegrityManifest,
  verifier?: ManifestVerifier | HmacKey,
): Promise<boolean> {
  if (manifest.algorithm !== "sha256" || manifest.version !== 1) return false;
  if (!equalSignatures(sha256Hex(content), manifest.contentSha256.toLowerCase())) return false;
  if (manifest.signature === undefined) return verifier === undefined;
  if (verifier === undefined) return false;
  const unsigned = unsignedManifest(manifest);
  const bytes = manifestSigningBytes(unsigned);
  if (typeof verifier === "function") return verifier(bytes, manifest.signature, unsigned);
  if (manifest.signature.algorithm !== "hmac-sha256") return false;
  const expected = createHmac("sha256", verifier).update(bytes).digest("hex");
  return equalSignatures(expected, manifest.signature.value);
}

export async function assertManifest(
  content: unknown,
  manifest: IntegrityManifest,
  verifier?: ManifestVerifier | HmacKey,
): Promise<void> {
  if (!(await verifyManifest(content, manifest, verifier))) {
    throw new Error("Handoff integrity verification failed");
  }
}

export function hmacManifestSigner(key: HmacKey, keyId?: string): ManifestSigner {
  return (bytes) => ({
    algorithm: "hmac-sha256",
    value: createHmac("sha256", key).update(bytes).digest("hex"),
    ...(keyId === undefined ? {} : { keyId }),
  });
}

export function hmacManifestVerifier(key: HmacKey): ManifestVerifier {
  return (bytes, signature) => {
    if (signature.algorithm !== "hmac-sha256") return false;
    return equalSignatures(
      createHmac("sha256", key).update(bytes).digest("hex"),
      signature.value,
    );
  };
}

export const sha256 = sha256Hex;
