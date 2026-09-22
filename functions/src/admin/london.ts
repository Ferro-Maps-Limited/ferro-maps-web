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
 * Midnight London at the start of `dayKey`, as a UTC instant.
 *
 * London is either UTC or UTC+1, so local midnight is the UTC instant one of
 * those two offsets before it. Rather than track when BST starts, both
 * candidates are asked which London day they fall in and the earliest one that
 * answers `dayKey` wins. Midnight never lands inside a DST gap here — the
 * clocks move at 01:00 — so exactly one candidate is correct.
 * @param {string} dayKey the London day, as YYYY-MM-DD.
 * @return {Date} the UTC instant that day begins at.
 */
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
