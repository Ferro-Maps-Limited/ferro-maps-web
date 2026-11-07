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

/* Nearest metre. Representation only; not a match threshold. */
export function distanceMetres(
  from: {lat: number; lng: number},
  to: {lat: number; lng: number},
): number {
  const toRad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * toRad;
  const dLng = (to.lng - from.lng) * toRad;
  const lat1 = from.lat * toRad;
  const lat2 = to.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
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
  } else if (!windowsOverlap(input.pinWindow, input.eventWindow) &&
    (input.pinWindow.end.getTime() <= input.pinWindow.start.getTime() ||
      input.eventWindow.end.getTime() <= input.eventWindow.start.getTime())) {
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
    return {pickupId: pickup.id, distanceM: distanceMetres(pin, point), reason: null};
  }).sort((left, right) => left.pickupId.localeCompare(right.pickupId));
  return {
    held: true,
    linkClass: null,
    publishable: false,
    reason: "link-class-policy-unapproved",
    facts: {windowsOverlap: windows, windowReason, candidateCount, candidateReason, distances},
  };
}
