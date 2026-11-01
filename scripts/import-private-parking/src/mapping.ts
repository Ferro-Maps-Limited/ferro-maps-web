import {createHash} from "node:crypto";
import {
  type AudCode,
  type CanPark,
  type FeeUnit,
  type PrivatePlace,
  type SrcType,
  isSrcType,
} from "./types.ts";

export function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function norm(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

export function normaliseName(value: unknown): string {
  return norm(value);
}

export function normalisePostcode(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, "");
}

/** Half away from zero, then 4 decimal places. Used only for the stable id. */
export function formatCoord(value: number): string {
  const scaled = Math.abs(value) * 10000;
  const rounded = Math.round(scaled) / 10000;
  const body = rounded.toFixed(4);
  return value < 0 ? `-${body}` : body;
}

export function placeId(name: unknown, postcode: unknown, lat: number, lng: number): string {
  const key = [
    normaliseName(name),
    normalisePostcode(postcode),
    formatCoord(lat),
    formatCoord(lng),
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

/** Numbers and numeric strings. `UNCLEAR` and blanks are not coordinates. */
export function parseCoord(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.toUpperCase() === "UNCLEAR") return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function mapCanPark(value: unknown): CanPark {
  switch (norm(value)) {
    case "yes":
      return 1;
    case "conditional":
      return 2;
    case "no":
      return 3;
    default:
      return 0;
  }
}

/** Missing and unrecognised audiences are omitted. They are never public. */
export function mapAud(value: unknown): AudCode | undefined {
  switch (norm(value)) {
    case "customers only":
      return "c";
    case "guests only":
      return "g";
    case "patients and visitors":
      return "g";
    case "permit holders":
      return "p";
    case "anyone":
    case "anyone (paid)":
      return "a";
    default:
      return undefined;
  }
}

/**
 * Evidence class. Partial official text is `official`.
 * Blank omits the field. Any other non-blank text is `none`.
 * The raw sentence is never returned.
 */
export function mapSrcType(value: unknown): SrcType | undefined {
  const s = norm(value);
  if (!s) return undefined;
  let mapped: SrcType;
  if (s === "official site: clear answer" || s === "official site: partial info") {
    mapped = "official";
  } else if (s === "google maps only") {
    mapped = "gmaps";
  } else if (/\bon-?site\b|\bsite visit\b|\bvisited\b/.test(s)) {
    mapped = "onsite";
  } else {
    mapped = "none";
  }
  if (!isSrcType(mapped)) {
    throw new Error(`srcType ${mapped} is not an allowed value`);
  }
  return mapped;
}

export function isApproxPrecision(value: unknown): boolean {
  const s = norm(value);
  if (!s) return false;
  if (s === "postcode centroid" || s === "area centre" || s === "area center" || s === "street") {
    return true;
  }
  return s.startsWith("nearby poi");
}

function expandYear(raw: string): number {
  if (raw.length === 4) return Number(raw);
  const yy = Number(raw);
  return yy >= 70 ? 1900 + yy : 2000 + yy;
}

function utcDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.toISOString();
}

function dateOnlyFromDate(date: Date): string | undefined {
  if (Number.isNaN(date.getTime())) return undefined;
  const utcMidnight = date.getUTCHours() === 0
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0;
  if (utcMidnight) return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  const localMidnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  if (localMidnight) return utcDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return date.toISOString();
}

/** ISO `YYYY-MM-DD`, `dd/mm/yyyy`, and `dd/mm/yy`. Date-only values are UTC midnight. */
export function parseDate(value: unknown): string | undefined {
  if (value instanceof Date) return dateOnlyFromDate(value);
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return dateOnlyFromDate(new Date(ms));
  }
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!slash) return undefined;
  return utcDate(expandYear(slash[3]), Number(slash[2]), Number(slash[1]));
}

export function isKnownVerification(value: unknown): boolean {
  const s = norm(value);
  return s === "confirmed" || s === "corrected";
}

export function parseMinutes(value: unknown): number | undefined {
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) n = Number(value.trim());
  if (n == null || n < 0) return undefined;
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) > 1e-6) return undefined;
  return rounded;
}

export function mapConf(value: unknown): number | undefined {
  const score = parseMinutes(value);
  if (score == null || score < 1 || score > 5) return undefined;
  return score / 5;
}

export function poundsToPence(value: unknown): number | undefined {
  const n = parseCoord(value);
  if (n == null || n < 0) return undefined;
  return Math.round(n * 100);
}

export function isAutopay(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const s = value.trim().toLowerCase();
  return s === "✅" || s === "✓" || s === "yes" || s === "true" || s === "checked";
}

const OPERATOR_OMIT = new Set(["not published", "not applicable", "unknown", "n/a", "none"]);

export function mapOperator(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || OPERATOR_OMIT.has(raw.toLowerCase())) return undefined;
  return raw;
}

export function firstUrl(value: unknown): string | undefined {
  const s = text(value);
  if (!s) return undefined;
  const match = /https?:\/\/[^\s;]+/i.exec(s);
  if (!match) return undefined;
  return match[0].replace(/[),.;]+$/g, "");
}

export function mapHours(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s || undefined;
}

export function formatAddr(street: unknown, postcode: unknown): string | undefined {
  const line = text(street);
  const code = text(postcode);
  if (!line && !code) return undefined;
  if (line && code && line.toUpperCase().includes(code.toUpperCase())) return line;
  if (line && code) return `${line}, ${code}`;
  return line || code;
}

function detailUnits(detail: string): {hour: boolean; day: boolean; visit: boolean; night: boolean} {
  return {
    hour: /\b(?:per hour|an hour|\/hour|hourly)\b/.test(detail),
    day: /\b(?:per 24 hours|per day|a day|daily)\b/.test(detail),
    visit: /\b(?:per visit|per stay)\b/.test(detail),
    night: /\b(?:per night|a night|overnight)\b/.test(detail),
  };
}

/**
 * `hour` | `visit` | `day` only when the tariff names one unit.
 * A night rate is not a day. Mixed units are omitted.
 */
export function mapFeeUnit(type: unknown, detail: unknown): FeeUnit | undefined {
  const tariff = norm(type);
  const prose = norm(detail);
  const units = detailUnits(prose);
  const mentioned = [units.hour, units.day, units.visit, units.night].filter(Boolean).length;

  if (tariff === "hourly rate" || tariff === "free period, then hourly") {
    if (units.day || units.visit || units.night) return undefined;
    return "hour";
  }
  if (tariff === "flat rate per 24 hours") {
    if (units.hour || units.visit || units.night) return undefined;
    return "day";
  }
  if (tariff === "flat rate per night") return undefined;
  if (mentioned !== 1 || units.night) return undefined;
  if (units.hour) return "hour";
  if (units.day) return "day";
  if (units.visit) return "visit";
  return undefined;
}

function providerSlug(raw: string): string | undefined {
  const s = raw.toLowerCase().replace(/[\s-]+/g, "");
  if (s.includes("paybyphone")) return "paybyphone";
  if (s.includes("ringgo")) return "ringgo";
  if (s.includes("justpark")) return "justpark";
  if (s.includes("ecpparkbuddy") || s.includes("eurocarparks")) return "eurocarparks";
  if (s.includes("parkbuddy")) return "parkbuddy";
  if (s.includes("apcoa")) return "apcoa";
  if (s.includes("evology")) return "evology";
  return undefined;
}

export interface LocationCode {
  locationCode: string;
  locationProvider: string;
  ambiguous: boolean;
}

/**
 * First provider+code in the rules text.
 * `PayByPhone location 37208` -> `{locationCode: "37208", locationProvider: "paybyphone"}`.
 * A second different code is reported and the first code is kept.
 */
const PROVIDER_SOURCE = "pay\\s*-?\\s*by\\s*-?\\s*phone|paybyphone|ring\\s*-?\\s*go|just\\s*-?\\s*park|euro\\s*car\\s*parks|ecp\\s*parkbuddy|parkbuddy|apcoa(?:\\s+connect)?|evology";

export function parseLocationCode(value: unknown): LocationCode | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const hits: Array<{at: number; code: string; provider: string}> = [];
  const tight = new RegExp(
    `\\b(${PROVIDER_SOURCE})\\b\\s*(?:\\(\\s*)?(?:(?:location(?:\\s+id)?|loc\\.?|zone|codes?|number|no\\.?)\\s+)?(\\d{4,8})\\b`,
    "gi",
  );
  for (const match of value.matchAll(tight)) {
    const provider = providerSlug(match[1] ?? "");
    const code = match[2] ?? "";
    if (!provider || !code || match.index == null) continue;
    hits.push({at: match.index, code, provider});
  }
  const keyed = new RegExp(
    `\\b(location(?:\\s+id)?|loc\\.?|zone|codes?|number|no\\.?)\\s+(\\d{4,8}(?:\\s*,\\s*\\d{4,8})*)`,
    "gi",
  );
  for (const match of value.matchAll(keyed)) {
    const keyword = (match[1] ?? "").toLowerCase();
    const parts = (match[2] ?? "").split(/\s*,\s*/);
    const codes = keyword === "codes" ? parts : parts.slice(0, 1);
    const window = value.slice(Math.max(0, (match.index ?? 0) - 80), match.index ?? 0);
    const providerRe = new RegExp(`\\b(${PROVIDER_SOURCE})\\b`, "gi");
    let provider: string | undefined;
    for (const found of window.matchAll(providerRe)) provider = providerSlug(found[1] ?? "");
    if (!provider) continue;
    codes.forEach((code, offset) => {
      if (!/^\d{4,8}$/.test(code)) return;
      hits.push({at: (match.index ?? 0) + offset, code, provider});
    });
  }
  hits.sort((a, b) => a.at - b.at || a.code.localeCompare(b.code));
  const unique: Array<{code: string; provider: string}> = [];
  for (const hit of hits) {
    if (unique.some((item) => item.code === hit.code && item.provider === hit.provider)) continue;
    unique.push({code: hit.code, provider: hit.provider});
  }
  const first = unique[0];
  if (!first) return undefined;
  const ambiguous = unique.some((hit) => hit.code !== first.code || hit.provider !== first.provider);
  return {locationCode: first.code, locationProvider: first.provider, ambiguous};
}

export function closureReason(value: unknown): "closed" | "temporarily_closed" | null {
  const s = norm(value);
  if (s === "closed") return "closed";
  if (s === "temporarily closed") return "temporarily_closed";
  return null;
}

export function coordinateSkip(latValue: unknown, lngValue: unknown): boolean {
  const lat = parseCoord(latValue);
  const lng = parseCoord(lngValue);
  if (lat == null || lng == null) return true;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return true;
  return lat === 0 && lng === 0;
}

export function skipReason(values: Record<string, unknown>): string | null {
  const closed = closureReason(values["Location Status"]);
  if (closed) return closed;
  if (coordinateSkip(values.Latitude, values.Longitude)) return "bad_coordinates";
  if (!text(values["Location Name"])) return "missing_name";
  return null;
}

function assign<K extends keyof PrivatePlace>(place: PrivatePlace, key: K, value: PrivatePlace[K] | undefined): void {
  if (value !== undefined) place[key] = value;
}

/** Map one kept sheet row onto a place. Does not set `r`, `payMode`, or `tl`. */
export function mapPlace(values: Record<string, unknown>): PrivatePlace {
  const lat = parseCoord(values.Latitude);
  const lng = parseCoord(values.Longitude);
  if (lat == null || lng == null) throw new Error("mapPlace called without coordinates");
  const name = text(values["Location Name"]);
  const place: PrivatePlace = {
    id: placeId(name, values.Postcode, lat, lng),
    n: name,
    p: [lat, lng],
    s: mapCanPark(values["Can Park? (Yes/No/Conditional)"]),
  };
  if (isKnownVerification(values["Verification Result"])) {
    place.q = "known";
    assign(place, "verifiedAt", parseDate(values["Verified Date"]));
  }
  assign(place, "conf", mapConf(values["Confidence (1-5)"]));
  assign(place, "aud", mapAud(values["Who Can Park"]));
  if (isApproxPrecision(values["Geo Precision"])) place.approx = true;
  assign(place, "free", parseMinutes(values["Free Stay Countdown (mins)"]));
  assign(place, "max", parseMinutes(values["Max Stay (mins)"]));
  if (norm(values["Price Status"]) === "published") {
    assign(place, "fee", poundsToPence(values["Parking Charge (£)"]));
  }
  assign(place, "feeUnit", mapFeeUnit(values["Tariff Type"], values["Tariff Detail"]));
  if (isAutopay(values["Ferro Autopay"])) place.auto = true;
  assign(place, "operator", mapOperator(values.Operator));
  assign(place, "src", firstUrl(values["Source URLs (primary first)"]));
  assign(place, "srcType", mapSrcType(values["Evidence Type"]));
  assign(place, "capturedAt", parseDate(values["Date Captured"]));
  assign(place, "hours", mapHours(values["Hours (OpenStreetMap opening_hours format)"]));
  assign(place, "addr", formatAddr(values["Street Address"], values.Postcode));
  const location = parseLocationCode(values["Rules Summary"]);
  if (location) {
    place.locationCode = location.locationCode;
    place.locationProvider = location.locationProvider;
  }
  if (place.srcType !== undefined && !isSrcType(place.srcType)) {
    throw new Error("srcType escaped the allowed list");
  }
  return place;
}
