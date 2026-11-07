/* Integer pence. Three decimal places round half up. No binary float. */

export interface PenceParse {
  pence: number | null;
  fare3dp: boolean;
  noFare: boolean;
  reject: boolean;
}

export function parsePence(value: unknown): PenceParse {
  if (value == null) return {pence: null, fare3dp: false, noFare: true, reject: false};
  const text = String(value).trim();
  if (text.length === 0 || /^n\/a\b/i.test(text)) {
    return {pence: null, fare3dp: false, noFare: true, reject: false};
  }
  const match = text.match(/^£?(\d+)(?:\.(\d+))?$/);
  if (!match) return {pence: null, fare3dp: false, noFare: false, reject: true};
  const pounds = Number(match[1]);
  const frac = match[2] ?? "";
  if (frac.length > 3) return {pence: null, fare3dp: false, noFare: false, reject: true};
  if (frac.length === 3) {
    const hundredths = Number(frac.slice(0, 2));
    const third = Number(frac[2]);
    const pence = pounds * 100 + hundredths + (third >= 5 ? 1 : 0);
    return {pence, fare3dp: true, noFare: false, reject: false};
  }
  const hundredths = Number((frac + "00").slice(0, 2));
  return {pence: pounds * 100 + hundredths, fare3dp: false, noFare: false, reject: false};
}

/* "65%" is 0.65. A bare number from 0 to 1 is kept. Anything else is unusable. */
export function parsePercent(value: unknown): {value: number | null; bad: boolean} {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return {value: null, bad: false};
  }
  const text = String(value).trim();
  const percent = text.match(/^(\d+)(?:\.(\d+))?%$/);
  if (percent) {
    const whole = Number(percent[1]);
    const frac = percent[2] ?? "";
    const numer = Number(`${whole}${frac}`);
    const denom = 10 ** frac.length;
    const asPercent = numer / denom;
    if (asPercent < 0 || asPercent > 100) return {value: null, bad: true};
    return {value: asPercent / 100, bad: false};
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return {value: null, bad: true};
  const bare = Number(text);
  if (bare < 0 || bare > 1) return {value: null, bad: true};
  return {value: bare, bad: false};
}
