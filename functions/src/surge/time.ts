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

function londonStamp(parts: ClockParts, withTime: boolean): string {
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const date = `${parts.year}-${month}-${day}`;
  if (!withTime) return date;
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  return `${date} ${hour}:${minute}`;
}

/* London calendar date `YYYY-MM-DD` for an instant, used to spot the same occasion. */
export function londonCalendarDate(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return londonStamp(londonParts(new Date(ms)), false);
}

/* UK wall clock `YYYY-MM-DD HH:mm`, the same shape as the Events tab. */
export function formatLondonDateTime(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return londonStamp(londonParts(new Date(ms)), true);
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

/* Europe/London hour 0–23 for an instant. */
export function londonHour(ms: number): number | null {
  if (!Number.isFinite(ms)) return null;
  return londonParts(new Date(ms)).hour;
}

/* `YYYY-MM-DD` shifted by whole London calendar days. */
export function addLondonDays(day: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match || !Number.isInteger(days)) return null;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  utc.setUTCDate(utc.getUTCDate() + days);
  const year = utc.getUTCFullYear();
  const month = utc.getUTCMonth() + 1;
  const date = utc.getUTCDate();
  if (londonLocalToUtcMs(year, month, date, 12, 0) == null) return null;
  const monthText = String(month).padStart(2, "0");
  const dayText = String(date).padStart(2, "0");
  return `${year}-${monthText}-${dayText}`;
}

/*
 * One clock hour in Europe/London, from HH:00 to the next HH:00.
 * The end is the following London clock time, so a DST change is not a flat 60 minutes.
 */
export function londonHourWindow(day: string, hour: number): {startMs: number; endMs: number} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const startMs = londonLocalToUtcMs(year, month, date, hour, 0);
  if (startMs == null) return null;
  let endMs: number | null;
  if (hour < 23) {
    endMs = londonLocalToUtcMs(year, month, date, hour + 1, 0);
  } else {
    const next = addLondonDays(day, 1);
    const nextMatch = next ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(next) : null;
    endMs = nextMatch ?
      londonLocalToUtcMs(Number(nextMatch[1]), Number(nextMatch[2]), Number(nextMatch[3]), 0, 0) :
      null;
  }
  if (endMs == null || endMs <= startMs) return null;
  return {startMs, endMs};
}
