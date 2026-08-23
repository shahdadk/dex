import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { sha256Hex } from "./canonical.js";

export const DEX_SIGNATURE_ALGORITHM = "ed25519" as const;

export interface DexDeviceKeyPair {
  algorithm: typeof DEX_SIGNATURE_ALGORITHM;
  keyId: string;
  /** Ed25519 SubjectPublicKeyInfo encoded as PEM. */
  publicKey: string;
  /** Ed25519 PKCS#8 private key encoded as PEM. Keep this value secret. */
  privateKey: string;
}

export interface DexPinnedServerKey {
  algorithm: typeof DEX_SIGNATURE_ALGORITHM;
  keyId: string;
  /** Ed25519 SubjectPublicKeyInfo, as PEM or base64-encoded DER. */
  publicKey: string;
}

function assertEd25519(key: KeyObject, use: "private" | "public"): KeyObject {
  if (key.type !== use || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(`Dex requires an Ed25519 ${use} key`);
  }
  return key;
}

export function dexPublicKeyObject(publicKey: string | KeyObject): KeyObject {
  if (publicKey instanceof Object && "export" in publicKey) {
    return assertEd25519(publicKey as KeyObject, "public");
  }
  if (publicKey.includes("BEGIN PUBLIC KEY")) {
    return assertEd25519(createPublicKey(publicKey), "public");
  }
  return assertEd25519(
    createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    }),
    "public",
  );
}

export function dexPrivateKeyObject(privateKey: string | KeyObject): KeyObject {
  if (privateKey instanceof Object && "export" in privateKey) {
    return assertEd25519(privateKey as KeyObject, "private");
  }
  if (privateKey.includes("BEGIN PRIVATE KEY")) {
    return assertEd25519(createPrivateKey(privateKey), "private");
  }
  return assertEd25519(
    createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    }),
    "private",
  );
}

export function dexKeyId(publicKey: string | KeyObject): string {
  const key = dexPublicKeyObject(publicKey);
  const der = key.export({ format: "der", type: "spki" });
  return `dex_${sha256Hex(new Uint8Array(der)).slice(0, 32)}`;
}

export function generateDexDeviceKeyPair(): DexDeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    algorithm: DEX_SIGNATURE_ALGORITHM,
    keyId: dexKeyId(publicKey),
    publicKey: publicKeyPem,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function signDexBytes(
  bytes: string | Uint8Array,
  privateKey: string | KeyObject,
): string {
  const input = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return sign(null, input, dexPrivateKeyObject(privateKey)).toString("base64url");
}

export function verifyDexSignature(
  bytes: string | Uint8Array,
  signature: string,
  publicKey: string | KeyObject,
): boolean {
  const input = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  try {
    return verify(
      null,
      input,
      dexPublicKeyObject(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export const generateDeviceKeyPair = generateDexDeviceKeyPair;
