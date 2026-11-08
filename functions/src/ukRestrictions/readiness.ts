/*
 * Offline readiness check for UK restriction sources.
 * It never says parking is allowed and never says UK coverage is complete.
 * No feed is enabled. No freshness threshold is invented here.
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

const NATIONS: Nation[] = ["england", "wales", "scotland", "northern-ireland"];

export function emptyRegistry(): readonly SourceRecord[] {
  return [];
}

function result(reasons: string[]): Readiness {
  return {
    verdict: "not-ready",
    parkingAllowed: PARKING_ALLOWED,
    nationalComplete: NATIONAL_COMPLETE,
    reasons: [...new Set(reasons)].sort(),
  };
}

function validInstant(value: string | null): boolean {
  if (value == null) return true;
  return Number.isFinite(Date.parse(value));
}

function sourceReasons(source: SourceRecord, asOf: string | null): string[] {
  const reasons: string[] = [];
  if (!source.sourceId || source.nation == null || source.authorityId == null) reasons.push("malformed");
  if (!NATIONS.includes(source.nation as Nation)) reasons.push("nation-unknown");
  if (source.roadOwner === "unknown") reasons.push("road-owner-unknown");
  if (source.place === "unknown") reasons.push("place-unknown");
  if (source.restrictionTypes.length === 0) reasons.push("restriction-type-unknown");
  if (!source.licenceVerified) reasons.push("licence-unverified");
  if (!source.schemaVerified) reasons.push("schema-unverified");
  if (!source.geometryVerified) reasons.push("geometry-unverified");
  if (source.freshnessPolicy !== "reviewed") reasons.push("freshness-unreviewed");
  else if (source.freshnessObservation === "stale") reasons.push("stale");
  else if (source.freshnessObservation !== "unknown" && source.freshnessObservation != null) {
    reasons.push("freshness-unreviewed");
  }
  if (source.claimedCoverage && !source.coverageEvidence) reasons.push("claimed-coverage-unverified");
  if (source.importHealth === "succeeded" && !source.coverageEvidence) reasons.push("coverage-not-promoted");
  if (source.importHealth !== "succeeded") reasons.push("import-not-healthy");
  if (source.conflictsWith.length > 0) reasons.push("conflict");
  if (source.enabled) reasons.push("feed-not-approved");
  const datesOk = validInstant(source.effectiveFrom) && validInstant(source.effectiveUntil);
  const clockOk = asOf == null || validInstant(asOf);
  if (!datesOk || !clockOk) reasons.push("malformed-date");
  else reasons.push(...applicabilityReasons(source, asOf));
  return reasons;
}

function applicabilityReasons(source: SourceRecord, asOf: string | null): string[] {
  if (asOf == null) return ["time-unknown"];
  const at = Date.parse(asOf);
  const from = source.effectiveFrom == null ? null : Date.parse(source.effectiveFrom);
  const until = source.effectiveUntil == null ? null : Date.parse(source.effectiveUntil);
  const reasons: string[] = [];
  if (source.legalStatus === "future" || (from != null && at < from)) reasons.push("future-not-active");
  if (source.legalStatus === "proposed") reasons.push("not-in-force");
  if (source.legalStatus === "made") reasons.push("not-shown-in-force");
  if (source.legalStatus === "unknown") reasons.push("applicability-unknown");
  if (source.legalStatus === "expired" || (until != null && at > until)) {
    reasons.push(source.legalEvidence ? "expired" : "applicability-evidence-missing");
  }
  if (source.legalStatus === "amended" || source.legalStatus === "revoked") {
    reasons.push(source.legalEvidence ? source.legalStatus : "applicability-evidence-missing");
  }
  if (source.legalStatus === "in-force" && !source.legalEvidence) reasons.push("applicability-evidence-missing");
  return reasons;
}

export function assessSource(source: SourceRecord, asOf: string | null): Readiness {
  return result(sourceReasons(source, asOf));
}

export function assessQuery(sources: readonly SourceRecord[], asOf: string | null): Readiness {
  if (sources.length === 0) return result(["no-results", "no-sources"]);
  const reasons = sources.flatMap((source) => sourceReasons(source, asOf));
  const covered = new Set(sources.map((source) => source.nation).filter((nation): nation is Nation => nation != null));
  if (covered.size < NATIONS.length) reasons.push("coverage-incomplete");
  const anyUnverified = sources.some((source) => !source.coverageEvidence || !source.licenceVerified);
  const anySuccess = sources.some((source) => source.importHealth === "succeeded");
  if (anySuccess && anyUnverified) reasons.push("mixed-coverage-not-promoted");
  return result(reasons);
}
