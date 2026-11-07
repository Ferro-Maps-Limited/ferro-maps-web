/*
 * Incomplete unused check. It does not protect publishing, and no publisher
 * calls it. A null result is not approval to publish.
 */

const BANNED_TEXT = new RegExp(
  "[£$€\\p{Sc}%]|\\b(?:fare|fares|price|prices|percent|percentage|multiplier|multipliers)\\b|\\b\\d+(?:\\.\\d+)?\\s*x\\b|\\bx\\s*\\d+",
  "iu",
);

const BANNED_KEY = /price|fare|pence|percent|currency|multiplier|amount|sheetresult|sheetstatus|^raw$/i;

function normalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keyBanned(key: string): boolean {
  if (key.length === 0) return false;
  return BANNED_KEY.test(normalKey(key));
}

export function publishedDocViolation(value: unknown): string | null {
  return walk(value, "", new WeakSet<object>());
}

function walk(value: unknown, key: string, seen: WeakSet<object>): string | null {
  if (keyBanned(key)) return `banned-key:${key}`;
  if (typeof value === "string") {
    return BANNED_TEXT.test(value) ? "banned-text" : null;
  }
  if (value == null || typeof value !== "object") return null;
  if (seen.has(value)) return "cycle";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = walk(entry, "", seen);
      if (found) return found;
    }
    return null;
  }
  for (const [childKey, child] of Object.entries(value)) {
    const found = walk(child, childKey, seen);
    if (found) return found;
  }
  return null;
}
