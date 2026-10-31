const ZONE = "Europe/London";
export const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface OpenWindow {
  start: Date;
  end: Date;
}

interface CivilDay {
  year: number;
  month: number;
  day: number;
}

interface Zoned extends CivilDay {
  hour: number;
  minute: number;
  weekday: number;
}

function zonedParts(date: Date): Zoned {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(bag.weekday);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    weekday,
  };
}

function zonedTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = zonedParts(new Date(utcGuess));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(utcGuess - (asUtc - Date.UTC(year, month - 1, day, hour, minute)));
}

function addDays(day: CivilDay, delta: number): CivilDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + delta, 12, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function weekdayOf(day: CivilDay): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day, 12, 0)).getUTCDay();
}

function normKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

function parseInstant(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && (value.includes("T") || /^\d{4}-\d{2}-\d{2}/.test(value))) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const record = asRecord(value);
  if (!record) return null;
  const seconds = record._seconds ?? record.seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds)) return new Date(seconds * 1000);
  return null;
}

function hoursOn(openMin: number, closeMin: number, day: CivilDay): OpenWindow {
  const start = zonedTime(day.year, day.month, day.day, Math.floor(openMin / 60), openMin % 60);
  if (closeMin === 24 * 60) {
    const next = addDays(day, 1);
    return {start, end: zonedTime(next.year, next.month, next.day, 0, 0)};
  }
  if (closeMin <= openMin) {
    const next = addDays(day, 1);
    return {
      start,
      end: zonedTime(next.year, next.month, next.day, Math.floor(closeMin / 60), closeMin % 60),
    };
  }
  return {
    start,
    end: zonedTime(day.year, day.month, day.day, Math.floor(closeMin / 60), closeMin % 60),
  };
}

function pairFrom(record: Record<string, unknown>): {open: unknown, close: unknown} | null {
  const bag: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) bag[normKey(key)] = value;
  const open = bag.openingtime ?? bag.starttime ?? bag.startingtime ?? bag.open ?? bag.start;
  const close = bag.closingtime ?? bag.endtime ?? bag.endingtime ?? bag.close ?? bag.end;
  if (open == null || close == null) return null;
  return {open, close};
}

function weekdayIndex(key: string): number {
  const name = normKey(key);
  const full = WEEKDAYS.indexOf(name);
  if (full >= 0) return full;
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(name);
}

function clockPair(open: unknown, close: unknown, day: CivilDay): OpenWindow | null {
  const openMin = parseClock(open);
  const closeMin = parseClock(close);
  if (openMin == null || closeMin == null) return null;
  return hoursOn(openMin, closeMin, day);
}

function collectIntervals(events: unknown, now: Date): OpenWindow[] {
  const record = asRecord(events);
  if (!record) return [];
  const pair = pairFrom(record);
  if (pair) {
    const openAt = parseInstant(pair.open);
    const closeAt = parseInstant(pair.close);
    if (openAt && closeAt) return [{start: openAt, end: closeAt}];
  }

  const byDay = new Map<number, {open: unknown, close: unknown}>();
  for (const [key, value] of Object.entries(record)) {
    const day = weekdayIndex(key);
    if (day < 0) continue;
    if (Array.isArray(value) && value.length >= 2) {
      byDay.set(day, {open: value[0], close: value[1]});
      continue;
    }
    if (typeof value === "string" && value.includes("-")) {
      const [open, close] = value.split("-");
      byDay.set(day, {open, close});
      continue;
    }
    const child = asRecord(value);
    const childPair = child ? pairFrom(child) : null;
    if (childPair) byDay.set(day, childPair);
  }

  const today = zonedParts(now);
  const days = [-1, 0, 1].map((delta) => addDays(today, delta));
  const out: OpenWindow[] = [];
  if (byDay.size > 0) {
    for (const day of days) {
      const hours = byDay.get(weekdayOf(day));
      if (!hours) continue;
      const interval = clockPair(hours.open, hours.close, day);
      if (interval) out.push(interval);
    }
    return out;
  }
  if (!pair) return [];
  for (const day of days) {
    const interval = clockPair(pair.open, pair.close, day);
    if (interval) out.push(interval);
  }
  return out;
}

/**
 * Next open interval clipped to the following 24 hours.
 * @param {unknown} events hotspot events map.
 * @param {Date} now clock.
 * @return {OpenWindow|null} null when nothing is open in that horizon.
 */
export function nextOpenWindow(events: unknown, now: Date): OpenWindow | null {
  const horizon = now.getTime() + DAY_MS;
  const clipped: OpenWindow[] = [];
  for (const interval of collectIntervals(events, now)) {
    if (interval.end.getTime() <= now.getTime() || interval.start.getTime() >= horizon) continue;
    const start = interval.start.getTime() < now.getTime() ? now : interval.start;
    const endMs = Math.min(interval.end.getTime(), horizon);
    if (endMs <= start.getTime()) continue;
    clipped.push({start, end: new Date(endMs)});
  }
  clipped.sort((a, b) => a.start.getTime() - b.start.getTime());
  return clipped[0] ?? null;
}

/**
 * A zero-length window the listener query does not return.
 * @param {Date} now clock.
 * @return {OpenWindow} start and end equal to now.
 */
export function excludedWindow(now: Date): OpenWindow {
  return {start: now, end: now};
}
