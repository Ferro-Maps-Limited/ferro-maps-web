import {windowsOverlap, type TimeWindow} from "./match.js";
import {inUk} from "./pickup.js";
import type {ImportPlan, SurgeWrite} from "./importSheet.js";

/*
 * Offline readiness notes. They do not approve ingestion, scoring, matching,
 * or publishing. Baseline tolerance and link-class distances stay unapproved.
 */

export interface IngestionReadiness {
  status: "held";
  reasons: string[];
  scoring: "unknown";
  scoringReason: "baseline-policy-unapproved";
  matching: "held";
  matchingReason: "link-class-policy-unapproved";
  publishing: "blocked";
  publishingReason: "gate-not-approved";
}

export interface MatchFacts {
  windowsOverlap: boolean | null;
  windowReason: "windows-missing" | "windows-invalid" | null;
  candidateCount: number | null;
  candidateReason: "candidate-count-missing" | "candidate-count-invalid" | null;
  distances: {
    pickupId: string;
    distanceM: number | null;
    reason: "invalid-point" | "duplicate-pickup" | null;
  }[];
}

export interface MatchHandCheck {
  held: true;
  linkClass: null;
  publishable: false;
  reason: "link-class-policy-unapproved";
  facts: MatchFacts;
}

const POINT_FLAGS = new Set(["point-tie", "no-usable-point"]);

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function assessIngestion(plan: Pick<ImportPlan, "outcome" | "rejects" | "writes" | "headerProblems">): IngestionReadiness {
  const reasons = ["live-ingestion-not-authorized"];
  if (plan.outcome === "headerFail") reasons.push("header-fail");
  for (const problem of plan.headerProblems) {
    if (problem.missing.length > 0) reasons.push("header-missing");
    if (problem.duplicate.length > 0) reasons.push("header-duplicate");
    if (problem.unexpected.length > 0) reasons.push("header-unexpected");
  }
  if (plan.outcome === "rejected" || plan.rejects.length > 0) reasons.push("plan-rejected");
  if (hasPointHold(plan.writes)) reasons.push("pickup-point-incomplete");
  return {
    status: "held",
    reasons: sortedUnique(reasons),
    scoring: "unknown",
    scoringReason: "baseline-policy-unapproved",
    matching: "held",
    matchingReason: "link-class-policy-unapproved",
    publishing: "blocked",
    publishingReason: "gate-not-approved",
  };
}

function hasPointHold(writes: SurgeWrite[]): boolean {
  return writes.some((write) => {
    if (!Array.isArray(write.data.flags)) return false;
    return write.data.flags.some((flag) => typeof flag === "string" && POINT_FLAGS.has(flag));
  });
}

function finitePoint(lat: number | null, lng: number | null): {lat: number; lng: number} | null {
  if (lat == null || lng == null || !inUk(lat, lng)) return null;
  return {lat, lng};
}

export interface DistanceResult {
  distanceM: number | null;
  reason: "invalid-point" | null;
}

/*
 * Nearest metre between two points inside the existing UK sheet bounds.
 * Representation only, not a match threshold. A non-finite or out-of-bounds
 * coordinate is invalid and is never returned as a measured length.
 */
export function distanceMetres(
  from: {lat: number; lng: number},
  to: {lat: number; lng: number},
): DistanceResult {
  const start = finitePoint(from.lat, from.lng);
  const end = finitePoint(to.lat, to.lng);
  if (start == null || end == null) return {distanceM: null, reason: "invalid-point"};
  const toRad = Math.PI / 180;
  const dLat = (end.lat - start.lat) * toRad;
  const dLng = (end.lng - start.lng) * toRad;
  const lat1 = start.lat * toRad;
  const lat2 = end.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const metres = Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
  if (!Number.isInteger(metres) || metres < 0) return {distanceM: null, reason: "invalid-point"};
  return {distanceM: metres, reason: null};
}

function finiteInstant(value: Date): number | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/* Both ends finite and in order. A reversed or non-finite window is unusable. */
function orderedWindow(window: TimeWindow): boolean {
  const start = finiteInstant(window.start);
  const end = finiteInstant(window.end);
  return start != null && end != null && end > start;
}

export function matchHandCheck(input: {
  pinWindow: TimeWindow | null;
  eventWindow: TimeWindow | null;
  pin: {lat: number; lng: number} | null;
  candidateCount: number | undefined;
  pickups: {id: string; lat: number | null; lng: number | null}[];
}): MatchHandCheck {
  let windows: boolean | null = null;
  let windowReason: MatchFacts["windowReason"] = null;
  if (input.pinWindow == null || input.eventWindow == null) {
    windowReason = "windows-missing";
  } else if (!orderedWindow(input.pinWindow) || !orderedWindow(input.eventWindow)) {
    windowReason = "windows-invalid";
  } else {
    windows = windowsOverlap(input.pinWindow, input.eventWindow);
  }
  let candidateCount: number | null = null;
  let candidateReason: MatchFacts["candidateReason"] = null;
  if (input.candidateCount == null) candidateReason = "candidate-count-missing";
  else if (!Number.isInteger(input.candidateCount) || input.candidateCount < 1) {
    candidateReason = "candidate-count-invalid";
  } else candidateCount = input.candidateCount;
  const seen = new Map<string, number>();
  for (const pickup of input.pickups) seen.set(pickup.id, (seen.get(pickup.id) ?? 0) + 1);
  const pin = input.pin == null ? null : finitePoint(input.pin.lat, input.pin.lng);
  const distances = input.pickups.map((pickup) => {
    if ((seen.get(pickup.id) ?? 0) > 1) {
      return {pickupId: pickup.id, distanceM: null, reason: "duplicate-pickup" as const};
    }
    const point = finitePoint(pickup.lat, pickup.lng);
    if (pin == null || point == null) {
      return {pickupId: pickup.id, distanceM: null, reason: "invalid-point" as const};
    }
    const measured = distanceMetres(pin, point);
    return {pickupId: pickup.id, distanceM: measured.distanceM, reason: measured.reason};
  }).sort((left, right) => left.pickupId.localeCompare(right.pickupId));
  return {
    held: true,
    linkClass: null,
    publishable: false,
    reason: "link-class-policy-unapproved",
    facts: {windowsOverlap: windows, windowReason, candidateCount, candidateReason, distances},
  };
}
