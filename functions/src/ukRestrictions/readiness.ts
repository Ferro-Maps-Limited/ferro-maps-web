/*
 * Offline readiness check for UK restriction sources.
 * It never says parking is allowed and never says UK coverage is complete.
 * No feed is enabled. No freshness threshold is invented here.
 *
 * An instant is a real calendar date written as YYYY-MM-DDTHH:mm:ss[.sss]Z
 * or the same form with a numeric offset ±HH:MM. Other text is rejected.
 */

export const PARKING_ALLOWED = false;
export const NATIONAL_COMPLETE = false;

export type Nation = "england" | "wales" | "scotland" | "northern-ireland";
export type RoadOwner = "local" | "trunk" | "unknown";
export type Place = "on-street" | "off-street" | "unknown";
export type LegalStatus =
  | "unknown"
  | "proposed"
  | "made"
  | "in-force"
  | "future"
  | "expired"
  | "amended"
  | "revoked";

export interface SourceRecord {
  sourceId: string;
  fixture: "synthetic" | "candidate";
  nation: Nation | null;
  authorityId: string | null;
  roadOwner: RoadOwner;
  place: Place;
  restrictionTypes: string[];
  claimedCoverage: string | null;
  coverageEvidence: string | null;
  licenceVerified: boolean;
  schemaVerified: boolean;
  geometryVerified: boolean;
  freshnessPolicy: "unreviewed" | "reviewed";
  freshnessObservation: "unknown" | "stale" | null;
  legalStatus: LegalStatus;
  legalEvidence: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  importHealth: "not-run" | "failed" | "partial" | "succeeded";
  conflictsWith: string[];
  enabled: boolean;
}

export interface Readiness {
  verdict: "not-ready";
  parkingAllowed: false;
  nationalComplete: false;
  reasons: string[];
}

const NATIONS: readonly Nation[] = ["england", "wales", "scotland", "northern-ireland"];
const ROAD_OWNERS: readonly RoadOwner[] = ["local", "trunk", "unknown"];
const PLACES: readonly Place[] = ["on-street", "off-street", "unknown"];
const LEGAL: readonly LegalStatus[] = [
  "unknown", "proposed", "made", "in-force", "future", "expired", "amended", "revoked",
];
const FIXTURES = ["synthetic", "candidate"] as const;
const IMPORTS = ["not-run", "failed", "partial", "succeeded"] as const;
const ALWAYS = ["policy-unapproved", "runtime-disabled"];
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function emptyRegistry(): readonly SourceRecord[] {
  return [];
}

function result(reasons: string[]): Readiness {
  return {
    verdict: "not-ready",
    parkingAllowed: PARKING_ALLOWED,
    nationalComplete: NATIONAL_COMPLETE,
    reasons: [...new Set([...ALWAYS, ...reasons])].sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((item) => item === value);
}

function text(value: unknown): "ok" | "missing" | "bad" {
  if (value == null) return "missing";
  if (typeof value !== "string" || value.trim() === "") return "bad";
  return "ok";
}

function textList(value: unknown): {ok: boolean; items: string[]; duplicate: boolean} {
  if (!Array.isArray(value)) return {ok: false, items: [], duplicate: false};
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return {ok: false, items: [], duplicate: false};
    items.push(item);
  }
  return {ok: true, items, duplicate: new Set(items).size !== items.length};
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function zoneOffsetMinutes(zone: string): number | null {
  if (zone === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function parseInstant(value: string): number | null {
  const match = INSTANT.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = match[7] == null ? 0 : Number(match[7].padEnd(3, "0"));
  const offset = zoneOffsetMinutes(match[8]);
  if (offset == null || millis > 999) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset * 60000;
  return Number.isFinite(utc) ? utc : null;
}

function bound(value: unknown): {ok: true; at: number | null} | {ok: false} {
  if (value == null) return {ok: true, at: null};
  if (typeof value !== "string") return {ok: false};
  const at = parseInstant(value);
  return at == null ? {ok: false} : {ok: true, at};
}

function applicability(
  status: LegalStatus,
  hasEvidence: boolean,
  from: number | null,
  until: number | null,
  at: number | null,
): string[] {
  if (at == null) return ["time-unknown"];
  const reasons: string[] = [];
  if (status === "future" || (from != null && at < from)) reasons.push("future-not-active");
  if (status === "proposed") reasons.push("not-in-force");
  if (status === "made") reasons.push("not-shown-in-force");
  if (status === "unknown") reasons.push("applicability-unknown");
  const ended = status === "expired" || (until != null && at > until);
  if (ended) reasons.push(hasEvidence ? "expired" : "applicability-evidence-missing");
  if (status === "amended" || status === "revoked") {
    reasons.push(hasEvidence ? status : "applicability-evidence-missing");
  }
  if (status === "in-force" && !hasEvidence) reasons.push("applicability-evidence-missing");
  return reasons;
}

function recognizedScope(input: unknown): Nation | null {
  if (!isRecord(input) || !oneOf(input.nation, NATIONS)) return null;
  if (input.roadOwner !== "local" && input.roadOwner !== "trunk") return null;
  if (input.place !== "on-street" && input.place !== "off-street") return null;
  const types = textList(input.restrictionTypes);
  if (!types.ok || types.items.length === 0 || types.duplicate) return null;
  return input.nation;
}

function sourceReasons(input: unknown, asOf: unknown): string[] {
  const reasons: string[] = [];
  const clock = bound(asOf);
  if (!isRecord(input)) {
    reasons.push("malformed", "nation-unknown", "restriction-type-unknown");
    reasons.push(clock.ok ? "time-unknown" : "malformed-date");
    return reasons;
  }
  if (typeof input.sourceId !== "string" || input.sourceId.trim() === "") reasons.push("malformed");
  if (!oneOf(input.fixture, FIXTURES)) reasons.push("malformed");
  if (!oneOf(input.nation, NATIONS)) {
    reasons.push("nation-unknown");
    reasons.push("malformed");
  }
  if (typeof input.authorityId !== "string" || input.authorityId.trim() === "") reasons.push("malformed");
  if (!oneOf(input.roadOwner, ROAD_OWNERS)) reasons.push("malformed", "road-owner-unknown");
  else if (input.roadOwner === "unknown") reasons.push("road-owner-unknown");
  if (!oneOf(input.place, PLACES)) reasons.push("malformed", "place-unknown");
  else if (input.place === "unknown") reasons.push("place-unknown");

  const types = textList(input.restrictionTypes);
  if (!types.ok || types.items.length === 0) reasons.push("restriction-type-unknown");
  if (!types.ok) reasons.push("malformed");
  if (types.duplicate) reasons.push("duplicate-restriction-type");

  if (input.licenceVerified !== true) reasons.push("licence-unverified");
  if (input.schemaVerified !== true) reasons.push("schema-unverified");
  if (input.geometryVerified !== true) reasons.push("geometry-unverified");
  if (typeof input.licenceVerified !== "boolean") reasons.push("malformed");
  if (typeof input.schemaVerified !== "boolean") reasons.push("malformed");
  if (typeof input.geometryVerified !== "boolean") reasons.push("malformed");
  reasons.push(...freshnessReasons(input.freshnessPolicy, input.freshnessObservation));

  const claim = text(input.claimedCoverage);
  const evidence = text(input.coverageEvidence);
  if (claim === "bad" || evidence === "bad") reasons.push("malformed");
  if (claim === "ok" && evidence !== "ok") reasons.push("claimed-coverage-unverified");
  if (!oneOf(input.importHealth, IMPORTS)) reasons.push("malformed", "import-not-healthy");
  else if (input.importHealth !== "succeeded") reasons.push("import-not-healthy");
  else if (evidence !== "ok") reasons.push("coverage-not-promoted");

  const conflicts = textList(input.conflictsWith);
  if (!conflicts.ok) reasons.push("malformed");
  else if (conflicts.items.length > 0) reasons.push("conflict");
  if (input.enabled === true) reasons.push("feed-not-approved");
  else if (typeof input.enabled !== "boolean") reasons.push("malformed");

  const legalEvidence = text(input.legalEvidence);
  if (legalEvidence === "bad") reasons.push("malformed");
  const from = bound(input.effectiveFrom);
  const until = bound(input.effectiveUntil);
  const range = from.ok && until.ok && from.at != null && until.at != null && until.at <= from.at;
  if (!from.ok || !until.ok || !clock.ok || range) reasons.push("malformed-date");
  else if (oneOf(input.legalStatus, LEGAL)) {
    reasons.push(...applicability(input.legalStatus, legalEvidence === "ok", from.at, until.at, clock.at));
  } else {
    reasons.push("malformed", "applicability-unknown");
  }
  return reasons;
}

function freshnessReasons(policy: unknown, observation: unknown): string[] {
  if (policy !== "reviewed") {
    return policy === "unreviewed" ? ["freshness-unreviewed"] : ["malformed", "freshness-unreviewed"];
  }
  if (observation === "stale") return ["stale"];
  if (observation == null || observation === "unknown") return ["freshness-unknown"];
  return ["malformed", "freshness-unreviewed"];
}

export function assessSource(input: unknown, asOf: unknown): Readiness {
  return result(sourceReasons(input, asOf));
}

export function assessQuery(input: unknown, asOf: unknown): Readiness {
  const reasons = ["authority-coverage-unreviewed"];
  if (!Array.isArray(input)) return result([...reasons, "malformed", "coverage-incomplete"]);
  if (input.length === 0) {
    return result([...reasons, "no-results", "no-sources", "coverage-incomplete"]);
  }
  const seen = new Set<string>();
  const nations = new Set<Nation>();
  let anySuccess = false;
  let anyUnverified = false;
  for (const item of input) {
    reasons.push(...sourceReasons(item, asOf));
    const nation = recognizedScope(item);
    if (nation) nations.add(nation);
    if (!isRecord(item)) continue;
    if (typeof item.sourceId === "string" && seen.has(item.sourceId)) reasons.push("duplicate-source");
    if (typeof item.sourceId === "string" && item.sourceId.trim() !== "") seen.add(item.sourceId);
    if (item.importHealth === "succeeded") anySuccess = true;
    const hasEvidence = typeof item.coverageEvidence === "string" && item.coverageEvidence.trim() !== "";
    if (!hasEvidence || item.licenceVerified !== true) anyUnverified = true;
  }
  if (nations.size < NATIONS.length) reasons.push("coverage-incomplete");
  if (anySuccess && anyUnverified) reasons.push("mixed-coverage-not-promoted");
  return result(reasons);
}
