/*
 * A confidence as a whole-number percent from 0 to 100.
 * A whole number is already a percent: 72 is 72%. Anything else is a fraction
 * of 1 and is multiplied by 100, then rounded to the nearest whole percent,
 * half up: 0.72 is 72%, 0.725 is 73%. Negative, non-finite, and anything that
 * lands outside 0 to 100 (72.4 would be 7240) are null.
 */
export function percentFromConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const percent = Number.isInteger(value) ? value : Math.round(Number((value * 100).toFixed(6)));
  return percent <= 100 ? percent : null;
}
