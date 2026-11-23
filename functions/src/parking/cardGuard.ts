const CARD_KEYS = /card|pan|cvc|cvv|paymentmethod/i;
const CARD_DIGITS = /(?:\d[ -]*?){13,19}/;

export function containsCardNumber(value: string): boolean {
  return new RegExp(`\\b${CARD_DIGITS.source}\\b`).test(value);
}

export function redactCardNumbers(value: string): string {
  return value.replace(new RegExp(`\\b${CARD_DIGITS.source}\\b`, "g"), "[redacted]");
}

export function assertNoCardData(value: unknown, label = "request"): void {
  const seen = new Set<unknown>();
  walk(value, label, seen);
}

function walk(value: unknown, label: string, seen: Set<unknown>): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && containsCardNumber(value)) {
      throw new Error(`${label} looks like a card number`);
    }
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, label, seen);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (CARD_KEYS.test(key)) throw new Error(`${label} has a card field`);
    walk(nested, label, seen);
  }
}
