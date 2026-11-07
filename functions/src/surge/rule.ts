/*
 * §21.4. One rule. `sheetResult` and `sheetStatus` are not inputs.
 * Missing data is `unknown`, never `no`.
 * The "at least 3 checks" minimum is the proposed mark in §21.4.
 */

export type SurgeBand = "low" | "medium" | "high";

export type EventScore = SurgeBand | "no" | "unknown";

export interface SurgeCheck {
  pickupId: string;
  takenAt: Date;
  pricePence: number;
  baselinePence: number | null;
}

export const RISE_LOW = 0.2;
export const RISE_MEDIUM = 0.5;
export const RISE_HIGH = 1;
export const MIN_CHECKS = 3;
export const MAX_FORECAST_WINDOW_MS = 6 * 60 * 60 * 1000;

const BAND_RANK: Record<SurgeBand, number> = {low: 1, medium: 2, high: 3};

export function rise(pricePence: number, baselinePence: number): number | null {
  if (!Number.isInteger(pricePence) || !Number.isInteger(baselinePence)) return null;
  if (pricePence < 0 || baselinePence <= 0) return null;
  return (pricePence - baselinePence) / baselinePence;
}

export function bandForRise(value: number): SurgeBand | "no" {
  if (value >= RISE_HIGH) return "high";
  if (value >= RISE_MEDIUM) return "medium";
  if (value >= RISE_LOW) return "low";
  return "no";
}

export function forecastWindowOk(start: Date, end: Date): boolean {
  const span = end.getTime() - start.getTime();
  return span > 0 && span <= MAX_FORECAST_WINDOW_MS;
}

/* Finished when the window has passed. The sheet's own status is ignored. */
export function windowState(now: Date, windowEnd: Date): "finished" | "open" {
  return windowEnd.getTime() <= now.getTime() ? "finished" : "open";
}

function inWindow(check: SurgeCheck, start: Date, end: Date): boolean {
  const time = check.takenAt.getTime();
  return time >= start.getTime() && time <= end.getTime();
}

function checkRise(check: SurgeCheck): number | null {
  if (check.baselinePence == null) return null;
  return rise(check.pricePence, check.baselinePence);
}

/* `peak` null means no adjacent pair cleared 0.20. `ok` false means a rise could not be calculated. */
function qualifyingPeak(checks: SurgeCheck[]): {ok: true; peak: number | null} | {ok: false} {
  const ordered = [...checks].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  let peak: number | null = null;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = checkRise(ordered[index - 1]);
    const current = checkRise(ordered[index]);
    if (previous == null || current == null) return {ok: false};
    if (previous < RISE_LOW || current < RISE_LOW) continue;
    peak = Math.max(peak ?? previous, current);
  }
  return {ok: true, peak};
}

export function scoreEvent(input: {
  windowStart: Date;
  windowEnd: Date;
  checks: SurgeCheck[];
}): EventScore {
  const checks = input.checks.filter((check) => inWindow(check, input.windowStart, input.windowEnd));
  if (checks.length < MIN_CHECKS) return "unknown";
  for (const check of checks) {
    if (check.baselinePence == null || rise(check.pricePence, check.baselinePence) == null) {
      return "unknown";
    }
  }
  const byPickup = new Map<string, SurgeCheck[]>();
  for (const check of checks) {
    const list = byPickup.get(check.pickupId) ?? [];
    list.push(check);
    byPickup.set(check.pickupId, list);
  }
  let best: SurgeBand | null = null;
  for (const group of byPickup.values()) {
    const found = qualifyingPeak(group);
    if (!found.ok) return "unknown";
    if (found.peak == null) continue;
    const band = bandForRise(found.peak);
    if (band === "no") continue;
    if (best == null || BAND_RANK[band] > BAND_RANK[best]) best = band;
  }
  return best ?? "no";
}
