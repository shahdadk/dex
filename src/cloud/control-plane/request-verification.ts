import {
  dexRequestSigningBytes,
  sha256Hex,
  verifyDexSignature,
} from "../messaging/index.js";
import { ControlPlaneError } from "./errors.js";
import { headerValue, type HeaderSource } from "./sendblue.js";

export const DEX_WIRE_HEADERS = {
  client: "x-appfi-client",
  protocol: "x-appfi-protocol-version",
  deviceId: "x-appfi-device-id",
  keyId: "x-appfi-key-id",
  algorithm: "x-appfi-signature-algorithm",
  sequence: "x-appfi-sequence",
  nonce: "x-appfi-nonce",
  timestamp: "x-appfi-timestamp",
  contentSha256: "x-appfi-content-sha256",
  bodySha256: "x-appfi-body-sha256",
  signature: "x-appfi-signature",
  expectedSequence: "x-appfi-expected-sequence",
  nextSequence: "x-appfi-next-sequence",
} as const;

export interface VerifiedDexRequestProof {
  keyId: string;
  deviceId?: string;
  sequence: number;
  nonce: string;
  timestamp: number;
  contentSha256: string;
}

export interface VerifyDexRequestInput {
  path: "/v1/device/pair" | "/v1/device/sync";
  body: string;
  headers: HeaderSource;
  publicKey: string;
  expectedKeyId: string;
  expectedDeviceId?: string;
  now: number;
  maxRequestAgeMs: number;
}

function required(headers: HeaderSource, name: string): string {
  const value = headerValue(headers, name);
  if (value === undefined || value.length === 0) {
    throw new ControlPlaneError(401, "invalid_request_signature", "Invalid Dex request proof");
  }
  return value;
}

function positiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ControlPlaneError(401, "invalid_request_signature", "Invalid Dex request proof");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ControlPlaneError(401, "invalid_request_signature", "Invalid Dex request proof");
  }
  return number;
}

export function verifyDexRequestProof(input: VerifyDexRequestInput): VerifiedDexRequestProof {
  if (
    required(input.headers, DEX_WIRE_HEADERS.client) !== "dex" ||
    required(input.headers, DEX_WIRE_HEADERS.protocol) !== "1" ||
    required(input.headers, DEX_WIRE_HEADERS.algorithm) !== "ed25519"
  ) {
    throw new ControlPlaneError(401, "invalid_request_signature", "Invalid Dex request proof");
  }
  const keyId = required(input.headers, DEX_WIRE_HEADERS.keyId);
  const deviceId = headerValue(input.headers, DEX_WIRE_HEADERS.deviceId);
  const sequence = positiveInteger(required(input.headers, DEX_WIRE_HEADERS.sequence));
  const timestamp = positiveInteger(required(input.headers, DEX_WIRE_HEADERS.timestamp));
  const nonce = required(input.headers, DEX_WIRE_HEADERS.nonce);
  const contentSha256 = required(input.headers, DEX_WIRE_HEADERS.contentSha256);
  const bodySha256 = required(input.headers, DEX_WIRE_HEADERS.bodySha256);
  const signature = required(input.headers, DEX_WIRE_HEADERS.signature);
  const actualSha256 = sha256Hex(input.body);
  if (
    keyId !== input.expectedKeyId ||
    (input.expectedDeviceId !== undefined && deviceId !== input.expectedDeviceId) ||
    (input.expectedDeviceId === undefined && deviceId !== undefined) ||
    nonce.length > 512 ||
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    contentSha256 !== actualSha256 ||
    bodySha256 !== actualSha256 ||
    Math.abs(input.now - timestamp) > input.maxRequestAgeMs
  ) {
    throw new ControlPlaneError(401, "invalid_request_signature", "Invalid Dex request proof");
  }

  const verified = verifyDexSignature(
    dexRequestSigningBytes({
      method: "POST",
      path: input.path,
      keyId,
      ...(deviceId === undefined ? {} : { deviceId }),
      sequence,
      nonce,
      timestamp,
      contentSha256,
    }),
    signature,
    input.publicKey,
  );
  if (!verified) {
    throw new ControlPlaneError(401, "invalid_request_signature", "Invalid Dex request proof");
  }
  return {
    keyId,
    ...(deviceId === undefined ? {} : { deviceId }),
    sequence,
    nonce,
    timestamp,
    contentSha256,
  };
}
