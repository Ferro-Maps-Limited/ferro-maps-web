/*
 * Operational scoring is held. §21.4's 20% bands, the 4h baseline tolerance,
 * and the 3-check minimum are proposed, not approved. `scoreEvent` does not
 * emit `no` or a band.
 *
 * `proposedScoreEvent` is an illustration of that unapproved text. It is not
 * called by the handler and must not be treated as a verdict.
 */

export type SurgeBand = "low" | "medium" | "high";

export type EventScore = SurgeBand | "no" | "unknown";

export type BaselineSource = "earlier-check" | "copied-current" | "unproven";

export interface SurgeCheck {
  pickupId: string;
  destinationId: string;
  product: string;
  takenAt: Date;
  pricePence: number;
  baselinePence: number | null;
  baselineSource: BaselineSource;
  samePickup: boolean;
  sameDestination: boolean;
  sameProduct: boolean;
}

export const PROPOSED_RISE_LOW = 0.2;
export const PROPOSED_RISE_MEDIUM = 0.5;
export const PROPOSED_RISE_HIGH = 1;
export const PROPOSED_MIN_CHECKS = 3;
export const MAX_FORECAST_WINDOW_MS = 6 * 60 * 60 * 1000;

const BAND_RANK: Record<SurgeBand, number> = {low: 1, medium: 2, high: 3};

export function rise(pricePence: number, baselinePence: number): number | null {
  if (!Number.isInteger(pricePence) || !Number.isInteger(baselinePence)) return null;
  if (pricePence < 0 || baselinePence <= 0) return null;
  return (pricePence - baselinePence) / baselinePence;
}

export function proposedBandForRise(value: number): SurgeBand | "no" {
  if (value >= PROPOSED_RISE_HIGH) return "high";
  if (value >= PROPOSED_RISE_MEDIUM) return "medium";
  if (value >= PROPOSED_RISE_LOW) return "low";
  return "no";
}

export function forecastWindowOk(start: Date, end: Date): boolean {
  const span = end.getTime() - start.getTime();
  return span > 0 && span <= MAX_FORECAST_WINDOW_MS;
}

export function windowState(now: Date, windowEnd: Date): "finished" | "open" {
  return windowEnd.getTime() <= now.getTime() ? "finished" : "open";
}

function likeForLike(check: SurgeCheck): boolean {
  return check.baselineSource === "earlier-check" &&
    check.samePickup === true &&
    check.sameDestination === true &&
    check.sameProduct === true &&
    check.destinationId.trim().length > 0 &&
    check.product.trim().length > 0 &&
    check.baselinePence != null &&
    rise(check.pricePence, check.baselinePence) != null;
}

function inWindow(check: SurgeCheck, start: Date, end: Date): boolean {
  const time = check.takenAt.getTime();
  return time >= start.getTime() && time <= end.getTime();
}

function seriesKey(check: SurgeCheck): string {
  return `${check.pickupId}\u0000${check.destinationId}\u0000${check.product}`;
}

/* Not an operational verdict. Unproven or copied baselines stay `unknown`, not `no`. */
export function proposedScoreEvent(input: {
  windowStart: Date;
  windowEnd: Date;
  checks: SurgeCheck[];
}): EventScore {
  const checks = input.checks.filter((check) => inWindow(check, input.windowStart, input.windowEnd));
  if (checks.length < PROPOSED_MIN_CHECKS) return "unknown";
  if (checks.some((check) => !likeForLike(check))) return "unknown";
  const bySeries = new Map<string, SurgeCheck[]>();
  for (const check of checks) {
    const list = bySeries.get(seriesKey(check)) ?? [];
    list.push(check);
    bySeries.set(seriesKey(check), list);
  }
  let best: SurgeBand | null = null;
  for (const group of bySeries.values()) {
    const ordered = [...group].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
    let peak: number | null = null;
    for (let index = 1; index < ordered.length; index += 1) {
      const previousBaseline = ordered[index - 1].baselinePence;
      const currentBaseline = ordered[index].baselinePence;
      if (previousBaseline == null || currentBaseline == null) return "unknown";
      const previous = rise(ordered[index - 1].pricePence, previousBaseline);
      const current = rise(ordered[index].pricePence, currentBaseline);
      if (previous == null || current == null) return "unknown";
      if (previous < PROPOSED_RISE_LOW || current < PROPOSED_RISE_LOW) continue;
      peak = Math.max(peak ?? previous, current);
    }
    if (peak == null) continue;
    const band = proposedBandForRise(peak);
    if (band === "no") continue;
    if (best == null || BAND_RANK[band] > BAND_RANK[best]) best = band;
  }
  return best ?? "no";
}

/* Held hook from the scaffold. Offline r1 is retrospectiveScore, and it is not published. */
export function scoreEvent(input: {
  windowStart: Date;
  windowEnd: Date;
  checks: SurgeCheck[];
}): "unknown" {
  void input;
  return "unknown";
}

export type RetroPhase = "baseline" | "pre" | "during" | "post";

export interface RetroReading {
  pickupId: string;
  product: string;
  destination: string | null;
  takenAt: Date;
  phase: RetroPhase;
  pricePence: number | null;
}

export type RetroScore = "none" | "low" | "medium" | "high" | "unknown";

export interface RetroGroup {
  pickupId: string;
  score: RetroScore;
  peakAt: Date | null;
  tie: boolean;
}

export interface RetroIllustration {
  score: RetroScore;
  goTo: string | null;
  peakAt: Date | null;
  tie: boolean;
  groups: RetroGroup[];
}

export interface RetroResult {
  /** Complete-event verdict. Held unknown until a baseline policy is approved. */
  score: "unknown";
  held: true;
  approved: false;
  reason: "baseline-policy-unapproved" | "incomplete-coverage" | "example-only";
  /** Example arithmetic only. Null unless the caller opts into exampleOnly. */
  illustrative: RetroIllustration | null;
}

export interface RetroExample {
  /** Not an approved baseline window. Lookback is not a 4-hour rule. */
  exampleOnly: true;
}

const BANDS: RetroScore[] = ["none", "low", "medium", "high"];

function atLeast20(price: number, baseline: number): boolean {
  return price * 5 >= baseline * 6;
}

function bandOf(price: number, baseline: number): "low" | "medium" | "high" | "none" {
  if (price >= baseline * 2) return "high";
  if (price * 2 >= baseline * 3) return "medium";
  if (atLeast20(price, baseline)) return "low";
  return "none";
}

function groupKey(reading: RetroReading): string {
  return `${reading.pickupId}\u0000${reading.product}\u0000${reading.destination ?? ""}`;
}

function scoreGroup(
  readings: RetroReading[],
  windowStart: Date,
  hardStopAt: Date,
): RetroGroup {
  const pickupId = readings[0]?.pickupId ?? "";
  const baselines = readings.filter((reading) => {
    return reading.phase === "baseline" &&
      reading.pricePence != null &&
      reading.pricePence > 0 &&
      reading.takenAt.getTime() < windowStart.getTime();
  });
  baselines.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const latest = baselines[baselines.length - 1];
  const tiedBaseline = baselines.filter((reading) => reading.takenAt.getTime() === latest?.takenAt.getTime());
  if (latest?.pricePence == null || tiedBaseline.length !== 1) {
    return {pickupId, score: "unknown", peakAt: null, tie: tiedBaseline.length > 1};
  }
  const baseline = latest.pricePence;
  const checks = readings.filter((reading) => {
    const time = reading.takenAt.getTime();
    return reading.phase !== "baseline" &&
      reading.pricePence != null &&
      time >= windowStart.getTime() &&
      time <= hardStopAt.getTime();
  }).sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const unique: RetroReading[] = [];
  for (const check of checks) {
    const prev = unique[unique.length - 1];
    if (prev && prev.takenAt.getTime() === check.takenAt.getTime()) {
      if (prev.pricePence !== check.pricePence) {
        return {pickupId, score: "unknown", peakAt: null, tie: true};
      }
      continue;
    }
    unique.push(check);
  }
  if (unique.length < 3) return {pickupId, score: "unknown", peakAt: null, tie: false};
  let surged = false;
  for (let index = 1; index < unique.length; index += 1) {
    const previous = unique[index - 1].pricePence ?? 0;
    const current = unique[index].pricePence ?? 0;
    if (atLeast20(previous, baseline) && atLeast20(current, baseline)) surged = true;
  }
  if (!surged) return {pickupId, score: "none", peakAt: null, tie: false};
  let best = unique[0];
  let tie = false;
  for (const check of unique.slice(1)) {
    const price = check.pricePence ?? 0;
    const bestPrice = best.pricePence ?? 0;
    if (price === bestPrice) tie = true;
    if (price > bestPrice) {
      best = check;
      tie = false;
    }
  }
  const score = bandOf(best.pricePence ?? 0, baseline);
  return {pickupId, score, peakAt: tie ? null : best.takenAt, tie};
}

function held(reason: RetroResult["reason"], illustrative: RetroIllustration | null = null): RetroResult {
  return {score: "unknown", held: true, approved: false, reason, illustrative};
}

/*
 * Offline illustration of r1. Not wired to a writer.
 * Without exampleOnly, no baseline age is treated as valid.
 * An unknown group never becomes a complete-event none or band.
 */
export function retrospectiveScore(input: {
  windowStart: Date;
  hardStopAt: Date;
  readings: RetroReading[];
}, policy?: RetroExample): RetroResult {
  if (policy?.exampleOnly !== true) {
    return held("baseline-policy-unapproved");
  }
  const byGroup = new Map<string, RetroReading[]>();
  for (const reading of input.readings) {
    const list = byGroup.get(groupKey(reading)) ?? [];
    list.push(reading);
    byGroup.set(groupKey(reading), list);
  }
  const groups = [...byGroup.values()].map((group) => {
    return scoreGroup(group, input.windowStart, input.hardStopAt);
  });
  if (groups.length === 0 || groups.some((group) => group.score === "unknown")) {
    return held("incomplete-coverage", {
      score: "unknown",
      goTo: null,
      peakAt: null,
      tie: false,
      groups,
    });
  }
  let best: RetroScore = "none";
  for (const group of groups) {
    if (BANDS.indexOf(group.score) > BANDS.indexOf(best)) best = group.score;
  }
  if (best === "none") {
    return held("example-only", {score: "none", goTo: null, peakAt: null, tie: false, groups});
  }
  const tops = groups.filter((group) => group.score === best);
  if (tops.length !== 1) {
    return held("example-only", {score: best, goTo: null, peakAt: null, tie: true, groups});
  }
  const top = tops[0];
  return held("example-only", {
    score: best,
    goTo: top.tie ? null : top.pickupId,
    peakAt: top.tie ? null : top.peakAt,
    tie: top.tie,
    groups,
  });
}
