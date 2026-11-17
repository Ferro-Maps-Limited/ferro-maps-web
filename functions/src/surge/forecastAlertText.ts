/*
 * Alert text for a `surge_forecast` push (docs/backend-contract.md §11, §11.1).
 *
 * Pure: no Firebase imports, no I/O. The iOS sender puts the result in
 * `apns.payload.aps.alert`. Output never carries distance, confidence, price
 * or currency, and never reads `area`.
 */

/** Anything with `toMillis()`, such as a Firestore `Timestamp`. */
export interface MillisLike {
  toMillis(): number;
}

export type AlertTime = MillisLike | Date | number | string;

export interface SurgeForecastAlertInput {
  name?: string | null;
  startAt: AlertTime;
  endAt: AlertTime;
  peakBand?: string | null;
}

export interface SurgeForecastAlertText {
  title: string;
  body?: string;
}

/** §11 `name` rule: at most 60 characters. */
export const MAX_NAME_LENGTH = 60;

/** §11 `name` rule: banned words (`fare`, `fares`, `earn`, `earnings`, `uber`, `bolt`). Whole words, any case. */
export const BANNED_NAME_WORDS: readonly string[] = ["fare", "fares", "earn", "earnings", "uber", "bolt"];

const BANNED_WORD_RE = new RegExp(`\\b(?:${BANNED_NAME_WORDS.join("|")})\\b`, "i");

/** §11 `[£$€]`, widened to every Unicode currency symbol. */
const CURRENCY_SYMBOL_RE = /[£$€\p{Sc}]/u;

/** Money amounts written without a symbol: `5p`, `12.50`, `GBP 10`, `10 pounds`. */
const MONEY_AMOUNT_RES: readonly RegExp[] = [
  /\b\d+(?:[.,]\d+)?\s?p\b/i,
  /\b\d+[.,]\d{2}\b/,
  /\b(?:gbp|eur|usd|pence|pounds?|quid)\b/i,
];

const SEPARATOR = " \u00B7 ";
const EN_DASH = "\u2013";

const BAND_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const LONDON_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function toMillis(value: AlertTime): number {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  } else if (value && typeof value.toMillis === "function") {
    ms = value.toMillis();
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) {
    throw new RangeError("surge_forecast alert time is not a valid timestamp");
  }
  return ms;
}

/* 24-hour `HH:mm` in Europe/London. */
export function londonHHmm(value: AlertTime): string {
  const parts = LONDON_TIME.formatToParts(new Date(toMillis(value)));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/*
 * Trimmed name with whitespace runs collapsed to one space, or `undefined` when it must be treated as missing.
 * A failing name is dropped, never shortened.
 */
export function usableName(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return undefined;
  if ([...name].length > MAX_NAME_LENGTH) return undefined;
  if (BANNED_WORD_RE.test(name)) return undefined;
  if (CURRENCY_SYMBOL_RE.test(name)) return undefined;
  if (MONEY_AMOUNT_RES.some((re) => re.test(name))) return undefined;
  return name;
}

/* `Low`, `Medium`, `High`, or `undefined` for a missing or unknown band. */
export function bandLabel(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  return BAND_LABELS[raw.trim().toLowerCase()];
}

/* §11.1 title and body for a `surge_forecast` alert. */
export function buildSurgeForecastAlert(data: SurgeForecastAlertInput): SurgeForecastAlertText {
  const range = `${londonHHmm(data.startAt)}${EN_DASH}${londonHHmm(data.endAt)}`;
  const name = usableName(data.name);
  const title = name ? `${name}${SEPARATOR}likely surge ${range}` : `Likely surge ${range}`;
  const body = bandLabel(data.peakBand);
  return body ? {title, body} : {title};
}
