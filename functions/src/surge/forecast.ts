import {confidencePercent} from "./kickoff.js";
import {type ParsedEvent, type ParsedReading, normLabel, pickupKey} from "./parse.js";
import {
  EXPECTED_FULL_TIME_AFTER_KICKOFF_MS,
  FIXTURE_MIN,
  GROUND_MIN,
  HARD_STOP_AFTER_FULL_TIME_MS,
  MAX_FORECAST_WINDOW_MS,
  MIN_STRENGTH_UPLIFT,
  MIN_YES,
  MIN_YES_RATE,
  PICKUP_MATCH_RADIUS_M,
  PICKUP_MIN_EVENTS,
  PICKUP_READINGS_PER_EVENT,
  type Band,
  confidenceBand,
  pickupConfidence,
  strengthBand,
} from "./thresholds.js";

export type SheetConfidenceSource = "events_tab" | "none";

export interface ForecastAvailable {
  state: "available";
  v: 1;
  startAt: string;
  endAt: string;
  strength: Band;
  confidence: Band;
  /*
   * Category pins store the YES share. Event pins store the Events-tab cell,
   * or null when that cell cannot be used. The YES share is not a fallback.
   */
  confidencePercent?: number | null;
  confidenceSource?: SheetConfidenceSource;
  basedOnEvents: number;
}

export interface ForecastNone {
  state: "no_prediction";
  confidencePercent?: number | null;
  confidenceSource?: SheetConfidenceSource;
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

export function forecastFromPool(event: ParsedEvent, pool: ParsedEvent[] | null): Forecast {
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

export function forecastFor(event: ParsedEvent, prior: ParsedEvent[]): Forecast {
  return forecastFromPool(event, historyPool(event, prior));
}

/*
 * Event pins only. The yes/no decision, the strength word, the confidence word,
 * and basedOnEvents stay on the history pool. The percent is the Events-tab cell.
 */
export function withEventsTabConfidence(forecast: Forecast, percent: number | null): Forecast {
  const confidenceSource: SheetConfidenceSource = percent == null ? "none" : "events_tab";
  if (forecast.state === "no_prediction") {
    return {state: "no_prediction", confidencePercent: percent, confidenceSource};
  }
  return {
    state: "available",
    v: 1,
    startAt: forecast.startAt,
    endAt: forecast.endAt,
    strength: forecast.strength,
    confidence: forecast.confidence,
    basedOnEvents: forecast.basedOnEvents,
    confidencePercent: percent,
    confidenceSource,
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

/* Great-circle distance in metres. */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface PickupLocation {
  lat: number;
  lng: number;
}

/* One pickup of the current event, as used for matching readings. */
export interface PickupForMatch {
  name: string;
  lat?: number;
  lng?: number;
}

export interface PointHistory {
  /* Earlier events at this ground with enough readings for this pickup. */
  events: number;
  /* Of those, events whose Events-tab outcome was yes. */
  yes: number;
  /* Of those, events where the readings matched by name alone. */
  byName: number;
  /* Of those, events that only qualified once nearby readings were counted. */
  byLocation: number;
}

/*
 * The one pickup a reading supports, or null. A reading never counts for two
 * pickups. A name match wins (the first pickup with that name). Otherwise the
 * nearest pickup within PICKUP_MATCH_RADIUS_M wins, the earlier one on a tie.
 */
export function readingOwner(
  reading: ParsedReading,
  pickups: PickupForMatch[],
): {index: number; by: "name" | "location"} | null {
  const key = pickupKey(reading.pickupName);
  if (key !== "") {
    const named = pickups.findIndex((pickup) => pickupKey(pickup.name) === key);
    if (named >= 0) return {index: named, by: "name"};
  }
  const {lat, lng} = reading;
  if (lat == null || lng == null) return null;
  let bestIndex = -1;
  let bestMetres = Infinity;
  for (let index = 0; index < pickups.length; index += 1) {
    const pickup = pickups[index];
    if (pickup.lat == null || pickup.lng == null) continue;
    const metres = metresBetween(pickup.lat, pickup.lng, lat, lng);
    if (metres <= PICKUP_MATCH_RADIUS_M && metres < bestMetres) {
      bestIndex = index;
      bestMetres = metres;
    }
  }
  return bestIndex >= 0 ? {index: bestIndex, by: "location"} : null;
}

/*
 * Support for one pickup from earlier events at the same ground. `pickups` is
 * every pickup of the current event, so a reading is shared out between them
 * by readingOwner and is never counted twice. Without `pickups` the point is
 * matched on its own. Only `prior` events with an earlier kick-off count, so a
 * later event never supports an earlier one.
 */
export function pointHistory(
  pointName: string,
  event: ParsedEvent,
  prior: ParsedEvent[],
  readings: ParsedReading[],
  location?: PickupLocation,
  pickups?: PickupForMatch[],
): PointHistory {
  const self: PickupForMatch = {name: pointName, lat: location?.lat, lng: location?.lng};
  const set = pickups && pickups.length > 0 ? pickups : [self];
  let index = set.findIndex((pickup) => {
    return pickup.name === pointName && pickup.lat === self.lat && pickup.lng === self.lng;
  });
  if (index < 0) index = set.findIndex((pickup) => pickup.name === pointName);
  const ground = normLabel(event.ground);
  let events = 0;
  let yes = 0;
  let byName = 0;
  let byLocation = 0;
  if (index < 0) return {events, yes, byName, byLocation};
  for (const earlier of prior) {
    if (normLabel(earlier.ground) !== ground) continue;
    if (earlier.kickOffMs >= event.kickOffMs) continue;
    let named = 0;
    let either = 0;
    for (const reading of readings) {
      if (reading.eventId !== earlier.sheetEventId) continue;
      const owner = readingOwner(reading, set);
      if (!owner || owner.index !== index) continue;
      either += 1;
      if (owner.by === "name") named += 1;
    }
    if (either < PICKUP_READINGS_PER_EVENT) continue;
    events += 1;
    if (named >= PICKUP_READINGS_PER_EVENT) byName += 1;
    else byLocation += 1;
    if (earlier.outcome === "yes") yes += 1;
  }
  return {events, yes, byName, byLocation};
}

export function pointSupport(
  pointName: string,
  event: ParsedEvent,
  prior: ParsedEvent[],
  readings: ParsedReading[],
  location?: PickupLocation,
  pickups?: PickupForMatch[],
): number {
  return pointHistory(pointName, event, prior, readings, location, pickups).events;
}

/* The share of this pickup's own earlier events that surged, or null when there are not enough. */
export function pointConfidencePercent(
  pointName: string,
  event: ParsedEvent,
  prior: ParsedEvent[],
  readings: ParsedReading[],
  location?: PickupLocation,
  pickups?: PickupForMatch[],
): number | null {
  const history = pointHistory(pointName, event, prior, readings, location, pickups);
  if (history.events < PICKUP_MIN_EVENTS) return null;
  return confidencePercent(history.yes, history.events);
}

export function pointMark(supportingEvents: number): {verified: false} | {verified: true; confidence: Band} {
  return pickupConfidence(supportingEvents);
}
