import {applyRecordedOutcomes, type RecordedSurge} from "./forecastHistory.js";
import {
  completedBefore,
  effectiveFullTimeMs,
  forecastFor,
  withEventsTabConfidence,
  pointConfidencePercent,
  pointMark,
  pointSupport,
  removeByMs,
  surgeHasEnded,
  type Forecast,
} from "./forecast.js";
import {type StartTimeSource} from "./kickoff.js";
import {parseSurgeSheet, stadiumDocId, type PickupCoord} from "./parse.js";
import {assertNoPrices, PriceLeakError} from "./priceGuard.js";
import {lookupVenueLocation} from "./venueLocations.js";

export const ID_SOURCE = "sheet_event" as const;

export interface PublicPickup {
  name: string;
  lat: number;
  lng: number;
  verified: boolean;
  confidence?: "low" | "medium" | "high";
  confidencePercent?: number;
}

export interface StadiumEventRecord {
  id: string;
  idSource: typeof ID_SOURCE;
  sheetEventId: string;
  name: string;
  description: string;
  category: string;
  country: "United Kingdom";
  startTimeSource: StartTimeSource;
  positionSource: "pickup_centroid" | "venue_lookup";
  location: {lat: number; lng: number};
  windowStart: string;
  matchEnd: string;
  removeBy: string;
  surgeEnded: boolean;
  updatedFromSheetAt: string;
  pickupPoints: PublicPickup[];
  forecast: Forecast;
}

export interface PlanResult {
  records: StadiumEventRecord[];
  skipped: number;
  rejected: number;
  venueLookup: number;
  skippedVenueUnverified: number;
  /* Pickups left out because their name would publish a fare word. The event is kept. */
  droppedPickups: number;
  /*
   * Events whose pickup cell is the "Owner bot to set pickups…" note, with no
   * pickups built from it, that already have at least one Readings row.
   */
  placeholderEventsWithReadings: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/*
 * A side is missing when the cell is blank, or when it is only dashes and
 * whitespace (so "- -" and " – — " count, not just a single "-"). Dashes
 * include a hyphen (-), an en dash (–), an em dash (—), the minus sign (−),
 * and the other Unicode dash marks. A concert row uses "-", and drivers
 * search the home name ("SBTV20"), not "SBTV20 v -". A home cell that is
 * only a dash is empty too, so the name falls back to the place, then the
 * sheet event id, instead of publishing "-".
 */
const ONLY_DASHES = /^[\p{Pd}\u2212]+$/u;

function sideMissing(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return compact === "" || ONLY_DASHES.test(compact);
}

export function eventName(home: string, away: string, place: string, sheetEventId: string): string {
  const homeMissing = sideMissing(home);
  const awayMissing = sideMissing(away);
  if (!homeMissing && !awayMissing) return `${home} v ${away}`.slice(0, 80);
  if (!homeMissing) return home.trim().slice(0, 80);
  if (place) return place.slice(0, 80);
  return sheetEventId.slice(0, 80);
}

function eventDescription(competition: string, place: string): string {
  if (competition && place && competition.toLowerCase() !== place.toLowerCase()) {
    return `${competition} at ${place}`.slice(0, 160);
  }
  if (place) return place.slice(0, 160);
  if (competition) return competition.slice(0, 160);
  return "Event";
}

function centroid(points: PickupCoord[]): {lat: number; lng: number} {
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return {lat, lng};
}

function lastById<T extends {sheetEventId: string}>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.sheetEventId, row);
  return [...byId.values()];
}

/*
 * parse.ts already removes "(Uber …)" notes from names. Anything that would
 * still trip the price guard is left out on its own, so no fare word or app
 * name is ever shown, and the rest of the event is kept.
 */
function pickupNameIsClean(name: string): boolean {
  try {
    assertNoPrices({name});
    return true;
  } catch (err) {
    if (!(err instanceof PriceLeakError)) throw err;
    return false;
  }
}

export function planStadiumEvents(input: {
  now: Date;
  events: unknown[][];
  readings: unknown[][];
  recordedOutcomes?: RecordedSurge[];
}): PlanResult {
  const parsed = parseSurgeSheet(input.events, input.readings);
  const events = applyRecordedOutcomes(lastById(parsed.events), input.recordedOutcomes ?? []);
  const records: StadiumEventRecord[] = [];
  let skipped = parsed.skipped;
  let rejected = parsed.rejected;
  let venueLookup = 0;
  let skippedVenueUnverified = 0;
  let droppedPickups = 0;
  for (const event of events) {
    const id = stadiumDocId(event.sheetEventId);
    if (!id) {
      skipped += 1;
      continue;
    }
    const prior = completedBefore(events, event.kickOffMs);
    const pickups = event.pickups.filter((point) => {
      if (pickupNameIsClean(point.name)) return true;
      droppedPickups += 1;
      return false;
    });
    const pickupPoints: PublicPickup[] = [];
    for (const point of pickups) {
      const at = {lat: point.lat, lng: point.lng};
      const mark = pointMark(pointSupport(point.name, event, prior, parsed.readings, at, pickups));
      const share = pointConfidencePercent(point.name, event, prior, parsed.readings, at, pickups);
      const pickup: PublicPickup = {
        name: point.name,
        lat: point.lat,
        lng: point.lng,
        verified: mark.verified,
      };
      if (mark.verified) pickup.confidence = mark.confidence;
      if (mark.verified && share != null) pickup.confidencePercent = share;
      pickupPoints.push(pickup);
    }
    let location: {lat: number; lng: number};
    let positionSource: "pickup_centroid" | "venue_lookup";
    if (pickups.length > 0) {
      location = centroid(pickups);
      positionSource = "pickup_centroid";
    } else {
      const venue = lookupVenueLocation(event.ground);
      if (!venue) {
        skipped += 1;
        skippedVenueUnverified += 1;
        continue;
      }
      location = {lat: venue.lat, lng: venue.lng};
      positionSource = "venue_lookup";
      venueLookup += 1;
    }
    const record: StadiumEventRecord = {
      id,
      idSource: ID_SOURCE,
      sheetEventId: event.sheetEventId,
      name: eventName(event.home, event.away, event.ground, event.sheetEventId),
      description: eventDescription(event.competition, event.ground),
      category: event.category,
      country: "United Kingdom",
      startTimeSource: event.startTimeSource,
      positionSource,
      location,
      windowStart: iso(event.kickOffMs),
      matchEnd: iso(effectiveFullTimeMs(event)),
      removeBy: iso(removeByMs(event)),
      surgeEnded: surgeHasEnded(parsed.readings, event, input.now.getTime()),
      updatedFromSheetAt: input.now.toISOString(),
      pickupPoints,
      forecast: withEventsTabConfidence(forecastFor(event, prior), event.predictedConfidencePercent),
    };
    try {
      assertNoPrices(record);
      records.push(record);
    } catch (err) {
      if (!(err instanceof PriceLeakError)) throw err;
      rejected += 1;
    }
  }
  records.sort((left, right) => left.id.localeCompare(right.id));
  return {
    records,
    skipped,
    rejected,
    venueLookup,
    skippedVenueUnverified,
    droppedPickups,
    placeholderEventsWithReadings: parsed.placeholderEventsWithReadings,
  };
}
