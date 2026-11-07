import {createHash} from "node:crypto";

/*
 * PDF reading id: first 32 hex characters of SHA-256 over
 * eventId|pickupId|takenAt UTC ISO|product.
 * The importer rejects any part that contains "|".
 */
export function readingId(parts: {
  eventId: string;
  pickupId: string;
  takenAt: Date;
  product: string;
}): string {
  const canonical = [
    parts.eventId,
    parts.pickupId,
    parts.takenAt.toISOString(),
    parts.product,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
