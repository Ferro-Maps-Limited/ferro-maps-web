import {createHash} from "node:crypto";

/*
 * Contract §21.2. The id is the SHA-256 of the event id, the pickup name,
 * the check time and the product. A second import of the same four adds nothing.
 * The canonical bytes are a JSON array, so a comma inside a name cannot
 * slide into the next field. `takenAt` is UTC ISO-8601.
 */
export function readingId(parts: {
  eventId: string;
  pickupName: string;
  takenAt: Date;
  product: string;
}): string {
  const canonical = JSON.stringify([
    parts.eventId,
    parts.pickupName,
    parts.takenAt.toISOString(),
    parts.product,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
