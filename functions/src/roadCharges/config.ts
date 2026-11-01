import {addDays, londonDayKey, londonStartOfDay} from "../admin/london.js";

/**
 * CC and ULEZ config, entry planning, and reminder decisions.
 *
 * Amounts come from `roadCharges/{cc|ulez}`. This file does not embed a
 * charge. A missing or invalid config produces no price and no push.
 */

export const ROAD_CHARGES_COLLECTION = "roadCharges";
export const ZONE_TYPES = ["cc", "ulez"] as const;
export type ZoneType = typeof ZONE_TYPES[number];
export type PaymentMethod = "autopay" | "manual" | "unknown";

/** Seven days after the entry is created. Firestore TTL deletes the doc. */
export const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One scheduler run. Stops a single invocation draining the whole backlog. */
export const REMINDER_PAGE_SIZE = 40;

/** Newest devices only, so one user cannot fan out to every old install. */
export const MAX_DEVICE_TOKENS = 10;

/** Transient FCM failures before the entry is left unsent. */
export const MAX_SEND_ATTEMPTS = 3;

export const ROAD_CHARGE_CHANNEL_ID = "road_charge_reminders";

/**
 * Three lines from the TfL Transport Data Service terms. The GIS hub says
 * those terms apply alongside the Open Government Licence. Line 3's year is
 * written `[2019]` on the TfL page; the brackets are a placeholder, so the
 * stored line has no brackets. See the contract open questions.
 */
export const ATTRIBUTION_LINES: readonly [string, string, string] = [
  "Powered by TfL Open Data",
  "Contains OS data © Crown copyright and database rights 2016",
  "Geomni UK Map data © and database rights 2019",
];

const UNREGISTERED_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

const FORBIDDEN_KEY = /^(fare|fares|uber|bolt|uberprice|boltprice|multiplier|earnings)$/i;
const FORBIDDEN_TEXT = /\b(uber|bolt|fares?|earnings|multiplier)\b/i;

const DAY_KEY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ZONE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/;

export interface CcRegion {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface ClosedRange {
  start: string;
  end: string;
}

export interface ChargeWindow {
  /** ISO weekday, 1 Monday through 7 Sunday. */
  weekdays: number[];
  /** London local HH:MM. Start is inclusive, end is exclusive. `24:00` is a valid end. */
  start: string;
  end: string;
}

export interface SourcedRate {
  pence: number;
  sourceUrl: string;
}

export interface RoadChargeConfig {
  v: 1;
  zoneVersion: string;
  boundaryUrl: string;
  attribution: [string, string, string];
  ccStandard: SourcedRate;
  ccLate: SourcedRate;
  ccAutoPay: SourcedRate;
  /** Electric car on Auto Pay. This is a CC rate, not a ULEZ rate. */
  ccEvCarAutoPay: SourcedRate;
  ccEvVanAutoPay: SourcedRate;
  ulezDaily: SourcedRate;
  /** Calendar days after the travel date. The deadline is midnight at the end of that day. */
  payByDaysAfter: number;
  windows: ChargeWindow[];
  closedDates: string[];
  closedRanges: ClosedRange[];
  /** England and Wales bank holidays. Empty means the reminder job does not run. */
  bankHolidays: string[];
  /** CC only. A coarse circle, not the chargeable boundary. */
  ccRegion?: CcRegion;
}

export type ConfigParse =
  | {ok: true; config: RoadChargeConfig}
  | {ok: false; reason: string};

export function isZoneType(value: string): value is ZoneType {
  return value === "cc" || value === "ulez";
}

export function isUnregisteredToken(code: string | undefined): boolean {
  return code != null && UNREGISTERED_TOKEN_CODES.has(code);
}

export function containsForbiddenPricing(value: unknown): boolean {
  if (typeof value === "string") return FORBIDDEN_TEXT.test(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return false;
  if (Array.isArray(value)) return value.some(containsForbiddenPricing);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, inner]) =>
      FORBIDDEN_KEY.test(key) || containsForbiddenPricing(inner));
  }
  return false;
}

export function isLondonDayKey(value: string): boolean {
  if (!DAY_KEY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

// Midnight at the end of the Nth London day after travelDate.
// Monday with N = 3 is 00:00 London on Friday.
export function payByInstant(travelDate: string, daysAfter: number): Date {
  return londonStartOfDay(addDays(travelDate, daysAfter + 1));
}

// True when the reminder job must not send. There is no weekday fallback.
export function bankHolidayListMissing(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0;
}

export function isClosedDay(config: RoadChargeConfig, travelDate: string): boolean {
  if (config.closedDates.includes(travelDate)) return true;
  return config.closedRanges.some((range) => travelDate >= range.start && travelDate <= range.end);
}

export function isFutureTravelDate(travelDate: string, now: Date): boolean {
  return travelDate > londonDayKey(now);
}

function isPence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
}

function parseRate(value: unknown): SourcedRate | null {
  if (value == null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!isPence(source.pence)) return null;
  if (typeof source.sourceUrl !== "string" || !source.sourceUrl.startsWith("https://tfl.gov.uk/")) return null;
  if (source.sourceUrl.length > 300) return null;
  return {pence: source.pence, sourceUrl: source.sourceUrl};
}

function clockMinutes(value: string): number | null {
  if (!CLOCK.test(value)) return null;
  if (value === "24:00") return 24 * 60;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function parseWindows(value: unknown): ChargeWindow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const windows: ChargeWindow[] = [];
  for (const row of value) {
    if (row == null || typeof row !== "object") return null;
    const source = row as Record<string, unknown>;
    if (!Array.isArray(source.weekdays) || source.weekdays.length === 0 || source.weekdays.length > 7) {
      return null;
    }
    const weekdays: number[] = [];
    for (const day of source.weekdays) {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7 || weekdays.includes(day)) {
        return null;
      }
      weekdays.push(day);
    }
    if (typeof source.start !== "string" || typeof source.end !== "string") return null;
    const start = clockMinutes(source.start);
    const end = clockMinutes(source.end);
    if (start == null || end == null || start >= end || source.start === "24:00") return null;
    windows.push({weekdays, start: source.start, end: source.end});
  }
  return windows;
}

function parseDayList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const days: string[] = [];
  for (const day of value) {
    if (typeof day !== "string" || !isLondonDayKey(day) || days.includes(day)) return null;
    days.push(day);
  }
  return days;
}

function parseRanges(value: unknown): ClosedRange[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const ranges: ClosedRange[] = [];
  for (const row of value) {
    if (row == null || typeof row !== "object") return null;
    const source = row as Record<string, unknown>;
    if (typeof source.start !== "string" || typeof source.end !== "string") return null;
    if (!isLondonDayKey(source.start) || !isLondonDayKey(source.end) || source.start > source.end) return null;
    ranges.push({start: source.start, end: source.end});
  }
  return ranges;
}

function parseRegion(value: unknown): CcRegion | null {
  if (value == null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const {lat, lng, radiusM} = source;
  if (typeof lat !== "number" || typeof lng !== "number" || typeof radiusM !== "number") return null;
  if (!Number.isFinite(lat) || lat < 51 || lat > 52) return null;
  if (!Number.isFinite(lng) || lng < -1 || lng > 1) return null;
  if (!Number.isInteger(radiusM) || radiusM < 500 || radiusM > 20_000) return null;
  return {lat, lng, radiusM};
}

function boundaryUrlOk(url: string, zoneVersion: string): boolean {
  if (url.length > 2048 || FORBIDDEN_TEXT.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  const needleDot = `/${zoneVersion}.`;
  const needleSlash = `/${zoneVersion}/`;
  return parsed.pathname.includes(needleDot) || parsed.pathname.endsWith(`/${zoneVersion}`) ||
    parsed.pathname.includes(needleSlash);
}

// Extra keys are ignored. A bad document is rejected so the caller does not invent a price.
export function parseRoadChargeConfig(type: ZoneType, raw: unknown): ConfigParse {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {ok: false, reason: "config-invalid"};
  }
  const source = raw as Record<string, unknown>;
  if (source.v !== 1) return {ok: false, reason: "config-invalid"};
  if (typeof source.zoneVersion !== "string" || !ZONE_VERSION.test(source.zoneVersion)) {
    return {ok: false, reason: "config-invalid"};
  }
  if (typeof source.boundaryUrl !== "string" || !boundaryUrlOk(source.boundaryUrl, source.zoneVersion)) {
    return {ok: false, reason: "config-invalid"};
  }
  if (!Array.isArray(source.attribution) || source.attribution.length !== 3) {
    return {ok: false, reason: "config-invalid"};
  }
  const attribution = source.attribution as unknown[];
  if (attribution.some((line) => typeof line !== "string" || line.length === 0 || line.length > 180)) {
    return {ok: false, reason: "config-invalid"};
  }
  const lines = [attribution[0], attribution[1], attribution[2]] as [string, string, string];
  if (lines[0] !== ATTRIBUTION_LINES[0] || lines[1] !== ATTRIBUTION_LINES[1] || lines[2] !== ATTRIBUTION_LINES[2]) {
    return {ok: false, reason: "config-invalid"};
  }
  const ccStandard = parseRate(source.ccStandard);
  const ccLate = parseRate(source.ccLate);
  const ccAutoPay = parseRate(source.ccAutoPay);
  const ccEvCarAutoPay = parseRate(source.ccEvCarAutoPay);
  const ccEvVanAutoPay = parseRate(source.ccEvVanAutoPay);
  const ulezDaily = parseRate(source.ulezDaily);
  if (!ccStandard || !ccLate || !ccAutoPay || !ccEvCarAutoPay || !ccEvVanAutoPay || !ulezDaily) {
    return {ok: false, reason: "config-invalid"};
  }
  if (typeof source.payByDaysAfter !== "number" || !Number.isInteger(source.payByDaysAfter) ||
      source.payByDaysAfter < 1 || source.payByDaysAfter > 14) {
    return {ok: false, reason: "config-invalid"};
  }
  const windows = parseWindows(source.windows);
  const closedDates = parseDayList(source.closedDates, 64);
  const bankHolidays = parseDayList(source.bankHolidays, 512);
  const closedRanges = parseRanges(source.closedRanges);
  if (!windows || !closedDates || !bankHolidays || !closedRanges) {
    return {ok: false, reason: "config-invalid"};
  }
  const region = source.ccRegion == null ? undefined : parseRegion(source.ccRegion);
  if (source.ccRegion != null && !region) return {ok: false, reason: "config-invalid"};
  if (type === "cc" && !region) return {ok: false, reason: "config-invalid"};
  if (type === "ulez" && region) return {ok: false, reason: "config-invalid"};
  const config: RoadChargeConfig = {
    v: 1,
    zoneVersion: source.zoneVersion,
    boundaryUrl: source.boundaryUrl,
    attribution: lines,
    ccStandard,
    ccLate,
    ccAutoPay,
    ccEvCarAutoPay,
    ccEvVanAutoPay,
    ulezDaily,
    payByDaysAfter: source.payByDaysAfter,
    windows,
    closedDates,
    closedRanges,
    bankHolidays,
    ...(region ? {ccRegion: region} : {}),
  };
  if (containsForbiddenPricing(config)) return {ok: false, reason: "config-invalid"};
  return {ok: true, config};
}
