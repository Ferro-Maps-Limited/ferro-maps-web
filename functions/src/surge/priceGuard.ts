const BANNED_KEY = new RegExp(
  "^(fare|fares|price|prices|uplift|baseline|baselinefare|gbp|quid|uber|bolt|" +
  "currency|fee|fees|multiplier|conf|probability|peakuplift)$",
  "i",
);
const BANNED_TEXT = /[£$€]|\b(gbp|quid|fares?|uber|bolt|uplift|baseline|price|prices)\b/i;

export class PriceLeakError extends Error {
  constructor() {
    super("price-leak");
    this.name = "PriceLeakError";
  }
}

/*
 * Reject a value that would publish a fare, a currency amount, or a numeric confidence.
 * The error text is a fixed code and does not include the rejected value.
 */
export function assertNoPrices(value: unknown, key: string | null = null): void {
  if (key && BANNED_KEY.test(key.replace(/[^a-z0-9]/gi, ""))) throw new PriceLeakError();
  if (key === "confidence" && typeof value === "number") throw new PriceLeakError();
  if (typeof value === "string" && BANNED_TEXT.test(value)) throw new PriceLeakError();
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrices(item);
    return;
  }
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) return;
    for (const [childKey, child] of Object.entries(value)) {
      assertNoPrices(child, childKey);
    }
  }
}
