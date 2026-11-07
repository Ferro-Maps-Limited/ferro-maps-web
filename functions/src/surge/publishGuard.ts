/*
 * §21.5. A published doc contains no price, fare, currency sign or percentage.
 * Prices stay in surgeReadings (§21.2, hard rule 8). This does not publish.
 */

const BANNED_TEXT = /[£$€\p{Sc}%]|\b(?:fare|fares|price|prices|percent|percentage)\b/iu;

const BANNED_KEYS = new Set([
  "pricePence",
  "baselinePence",
  "price",
  "fare",
  "raw",
  "sheetResult",
  "sheetStatus",
]);

export function publishedDocViolation(value: unknown): string | null {
  return walk(value, "");
}

function walk(value: unknown, key: string): string | null {
  if (BANNED_KEYS.has(key)) return `banned-key:${key}`;
  if (typeof value === "string") {
    return BANNED_TEXT.test(value) ? "banned-text" : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = walk(entry, "");
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      const found = walk(child, childKey);
      if (found) return found;
    }
  }
  return null;
}
