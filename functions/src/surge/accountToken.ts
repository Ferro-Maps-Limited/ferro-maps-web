import {createHash} from "node:crypto";

/*
 * Shared with iOS SurgeAccountToken.namespace. The phone computes the same
 * UUIDv5 from the Firebase uid. Nothing on users/{uid} stores this token.
 */
export const SURGE_ACCOUNT_TOKEN_NAMESPACE = "c5a5a951-b94c-4d05-a80c-226d6e96814e";

function namespaceBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("invalid_namespace");
  return Buffer.from(hex, "hex");
}

/* RFC 4122 version 5. SHA-1 of the namespace UUID bytes plus the uid as UTF-8. */
export function surgeAccountToken(uid: string): string {
  const hash = createHash("sha1")
    .update(namespaceBytes(SURGE_ACCOUNT_TOKEN_NAMESPACE))
    .update(Buffer.from(uid, "utf8"))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
