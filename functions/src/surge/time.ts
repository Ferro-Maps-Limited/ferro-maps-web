const LONDON = "Europe/London";

interface ClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function londonParts(instant: Date): ClockParts {
  const bag: Record<string, string> = {};
  for (const part of FORMAT.formatToParts(instant)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

/* London calendar date `YYYY-MM-DD` for an instant, used to spot the same occasion. */
export function londonCalendarDate(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const parts = londonParts(new Date(ms));
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

function offsetMs(instant: Date): number {
  const parts = londonParts(instant);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

function realCalendarDay(year: number, month: number, day: number, hour: number, minute: number): boolean {
  if (year < 2000 || year > 2100) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/* A UK wall-clock time as UTC epoch milliseconds, or null when the clock time does not exist. */
export function londonLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  if (!realCalendarDay(year, month, day, hour, minute)) return null;
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const utc = guess - offsetMs(new Date(guess - offsetMs(new Date(guess))));
  const parts = londonParts(new Date(utc));
  if (
    parts.year !== year ||
    parts.month !== month ||
    parts.day !== day ||
    parts.hour !== hour ||
    parts.minute !== minute
  ) {
    return null;
  }
  return utc;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{1,2}):(\d{2})(?::\d{2})?)?$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[Tt ](\d{1,2}):(\d{2})(?::\d{2})?)?$/;

/*
 * Sheet clocks are UK local unless the text already carries a zone.
 * Date-only values are midnight at the start of that UK day. Excel serial numbers are ignored.
 */
export function parseSheetTime(value: unknown, zone: "uk" | "utc"): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || /^n\/a/i.test(text) || text === "-" || text.toLowerCase() === "pending") return null;
  if (/[zZ]$/.test(text) || /[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const iso = ISO_DATE.exec(text);
  if (iso) {
    return zoned(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), zone);
  }
  const slash = SLASH_DATE.exec(text);
  if (slash) {
    return zoned(
      Number(slash[3]),
      Number(slash[2]),
      Number(slash[1]),
      Number(slash[4] ?? 0),
      Number(slash[5] ?? 0),
      zone,
    );
  }
  return null;
}

function zoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: "uk" | "utc",
): number | null {
  if (zone === "utc") {
    if (!realCalendarDay(year, month, day, hour, minute)) return null;
    return Date.UTC(year, month - 1, day, hour, minute, 0);
  }
  return londonLocalToUtcMs(year, month, day, hour, minute);
}
