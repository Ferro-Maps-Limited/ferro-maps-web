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

/* Held. Does not apply the proposed bands, even when a check looks complete. */
export function scoreEvent(input: {
  windowStart: Date;
  windowEnd: Date;
  checks: SurgeCheck[];
}): "unknown" {
  void input;
  return "unknown";
}
