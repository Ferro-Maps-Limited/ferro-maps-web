import {Timestamp} from "firebase-admin/firestore";

/**
 * Day boundaries in Europe/London, because that is where the drivers are and
 * what the rest of the product already uses — onUserActive counts a streak by
 * London days, and the digest and weekly summary send on London clocks. A
 * rollup keyed by UTC days would disagree with both for one hour of the year.
 */
export const LONDON_TZ = "Europe/London";

const DAY_MS = 86_400_000;

/**
 * The London calendar day an instant falls in, as YYYY-MM-DD.
 * @param {Date} date the instant to place.
 * @return {string} the London day key.
 */
export function londonDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Midnight at the start of a London calendar day, as a UTC instant.
 *
 * London is either UTC or UTC+1. Both candidates are checked against the
 * London calendar. Midnight never lands in the DST gap: the clocks move at 01:00.
 * @param {string} dayKey the London day, as YYYY-MM-DD.
 * @return {Date} the UTC instant that day begins.
 */
export function londonStartOfDay(dayKey: string): Date {
  return londonMidnightUtc(dayKey);
}

/**
 * A London wall-clock time on `dayKey`. 17:30 and 20:00 are never inside the
 * DST overlap, so exactly one UTC offset matches.
 * @param {string} dayKey the London day, as YYYY-MM-DD.
 * @param {number} hour 0..23.
 * @param {number} minute 0..59.
 * @return {Date} the UTC instant of that London clock time.
 */
export function londonWallTime(dayKey: string, hour: number, minute: number): Date {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`londonWallTime: bad clock ${hour}:${minute}`);
  }
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const utc = Date.parse(`${dayKey}T${hh}:${mm}:00Z`);
  if (Number.isNaN(utc)) throw new Error(`londonWallTime: ${dayKey} is not a YYYY-MM-DD day key`);
  const want = `${hh}:${mm}`;
  for (const offsetHours of [0, 1]) {
    const candidate = new Date(utc - offsetHours * 3_600_000);
    if (londonDayKey(candidate) === dayKey && londonHourMinute(candidate) === want) return candidate;
  }
  throw new Error(`londonWallTime: ${dayKey} ${want} does not exist in London`);
}

function londonHourMinute(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function londonMidnightUtc(dayKey: string): Date {
  const utcMidnight = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) {
    throw new Error(`londonMidnightUtc: ${dayKey} is not a YYYY-MM-DD day key`);
  }
  for (const offsetHours of [1, 0]) {
    const candidate = new Date(utcMidnight - offsetHours * 3_600_000);
    if (londonDayKey(candidate) === dayKey) return candidate;
  }
  throw new Error(`londonMidnightUtc: no London midnight found for ${dayKey}`);
}

/**
 * The half-open range [start, end) covering one London day.
 * @param {string} dayKey the London day, as YYYY-MM-DD.
 * @return {{start: Timestamp, end: Timestamp}} the range to query with.
 */
export function londonDayRange(dayKey: string): {start: Timestamp; end: Timestamp} {
  const start = londonMidnightUtc(dayKey);
  const end = londonMidnightUtc(addDays(dayKey, 1));
  return {start: Timestamp.fromDate(start), end: Timestamp.fromDate(end)};
}

/**
 * `dayKey` shifted by whole calendar days.
 * @param {string} dayKey the London day to shift.
 * @param {number} days how many days to move, negative for earlier.
 * @return {string} the shifted day key.
 */
export function addDays(dayKey: string, days: number): string {
  return londonDayKey(new Date(londonMidnightUtc(dayKey).getTime() + days * DAY_MS + 12 * 3_600_000));
}
