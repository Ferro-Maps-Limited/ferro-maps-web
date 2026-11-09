import {confidencePercent} from "./kickoff.js";
import {type ParsedEvent, type ParsedReading, normLabel} from "./parse.js";
import {
  EXPECTED_FULL_TIME_AFTER_KICKOFF_MS,
  FIXTURE_MIN,
  GROUND_MIN,
  HARD_STOP_AFTER_FULL_TIME_MS,
  MAX_FORECAST_WINDOW_MS,
  MIN_STRENGTH_UPLIFT,
  MIN_YES,
  MIN_YES_RATE,
  PICKUP_MIN_EVENTS,
  PICKUP_READINGS_PER_EVENT,
  type Band,
  confidenceBand,
  pickupConfidence,
  strengthBand,
} from "./thresholds.js";

export interface ForecastAvailable {
  state: "available";
  v: 1;
  startAt: string;
  endAt: string;
  strength: Band;
  confidence: Band;
  confidencePercent: number;
  basedOnEvents: number;
}

export interface ForecastNone {
  state: "no_prediction";
}

export type Forecast = ForecastAvailable | ForecastNone;

export function effectiveFullTimeMs(event: ParsedEvent): number {
  return event.fullTimeMs ?? event.kickOffMs + EXPECTED_FULL_TIME_AFTER_KICKOFF_MS;
}

/* Hard stop from the sheet, or expected full time plus 3 hours when that cell is blank or unusable. */
export function removeByMs(event: ParsedEvent): number {
  if (event.hardStopMs != null) return event.hardStopMs;
  return effectiveFullTimeMs(event) + HARD_STOP_AFTER_FULL_TIME_MS;
}

export function completedBefore(events: ParsedEvent[], kickOffMs: number): ParsedEvent[] {
  return events.filter((event) => {
    return (event.outcome === "yes" || event.outcome === "no") && event.kickOffMs < kickOffMs;
  });
}

function sameFixture(left: ParsedEvent, right: ParsedEvent): boolean {
  return normLabel(left.ground) === normLabel(right.ground) &&
    normLabel(left.home) === normLabel(right.home) &&
    normLabel(left.away) === normLabel(right.away);
}

export function historyPool(event: ParsedEvent, prior: ParsedEvent[]): ParsedEvent[] | null {
  const fixture = prior.filter((item) => sameFixture(item, event));
  if (fixture.length >= FIXTURE_MIN) return fixture;
  const ground = prior.filter((item) => normLabel(item.ground) === normLabel(event.ground));
  if (ground.length >= GROUND_MIN) return ground;
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

export function forecastFor(event: ParsedEvent, prior: ParsedEvent[]): Forecast {
  const pool = historyPool(event, prior);
  if (!pool) return {state: "no_prediction"};
  const yes = pool.filter((item) => item.outcome === "yes");
  const yesRate = yes.length / pool.length;
  if (yes.length < MIN_YES || yesRate < MIN_YES_RATE) return {state: "no_prediction"};
  const peaks = yes
    .map((item) => item.peakUplift)
    .filter((peak): peak is number => peak != null && peak >= MIN_STRENGTH_UPLIFT);
  if (peaks.length === 0) return {state: "no_prediction"};
  const strength = strengthBand(median(peaks));
  if (!strength) return {state: "no_prediction"};
  const start = event.surgeStartMs ?? event.fullTimeMs;
  if (start == null) return {state: "no_prediction"};
  let end = event.surgeEndMs ?? removeByMs(event);
  if (end <= start) return {state: "no_prediction"};
  if (end - start > MAX_FORECAST_WINDOW_MS) end = start + MAX_FORECAST_WINDOW_MS;
  return {
    state: "available",
    v: 1,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    strength,
    confidence: confidenceBand(pool.length, yesRate),
    confidencePercent: confidencePercent(yes.length, pool.length),
    basedOnEvents: pool.length,
  };
}

function countsTowardStop(reading: ParsedReading, windowStartMs: number | null): boolean {
  if (reading.phase === "during" || reading.phase === "post") return true;
  if (reading.phase === "baseline" || reading.phase === "pre") return false;
  if (windowStartMs == null) return false;
  return reading.timeMs >= windowStartMs;
}

/* Two back-to-baseline checks in a row, at one pickup, during or after the match. */
export function hasReturnedToBaseline(readings: ParsedReading[], event: ParsedEvent): boolean {
  const windowStart = event.surgeStartMs ?? event.fullTimeMs;
  const groups = new Map<string, ParsedReading[]>();
  for (const reading of readings) {
    if (reading.eventId !== event.sheetEventId || reading.backToBaseline == null) continue;
    if (!countsTowardStop(reading, windowStart)) continue;
    const key = normLabel(reading.pickupName);
    const list = groups.get(key) ?? [];
    list.push(reading);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => left.timeMs - right.timeMs || left.order - right.order);
    for (let index = 1; index < list.length; index += 1) {
      if (list[index - 1].backToBaseline === true && list[index].backToBaseline === true) return true;
    }
  }
  return false;
}

export function surgeHasEnded(readings: ParsedReading[], event: ParsedEvent, nowMs: number): boolean {
  if (nowMs >= removeByMs(event)) return true;
  return hasReturnedToBaseline(readings, event);
}

export function pointHistory(
  pointName: string,
  event: ParsedEvent,
  prior: ParsedEvent[],
  readings: ParsedReading[],
): {events: number; yes: number} {
  const point = normLabel(pointName);
  const ground = normLabel(event.ground);
  let events = 0;
  let yes = 0;
  for (const earlier of prior) {
    if (normLabel(earlier.ground) !== ground) continue;
    const checks = readings.filter((reading) => {
      return reading.eventId === earlier.sheetEventId && normLabel(reading.pickupName) === point;
    }).length;
    if (checks < PICKUP_READINGS_PER_EVENT) continue;
    events += 1;
    if (earlier.outcome === "yes") yes += 1;
  }
  return {events, yes};
}

export function pointSupport(
  pointName: string,
  event: ParsedEvent,
  prior: ParsedEvent[],
  readings: ParsedReading[],
): number {
  return pointHistory(pointName, event, prior, readings).events;
}

/* The share of this pickup's own earlier events that surged, or null when there are not enough. */
export function pointConfidencePercent(
  pointName: string,
  event: ParsedEvent,
  prior: ParsedEvent[],
  readings: ParsedReading[],
): number | null {
  const history = pointHistory(pointName, event, prior, readings);
  if (history.events < PICKUP_MIN_EVENTS) return null;
  return confidencePercent(history.yes, history.events);
}

export function pointMark(supportingEvents: number): {verified: false} | {verified: true; confidence: Band} {
  return pickupConfidence(supportingEvents);
}
