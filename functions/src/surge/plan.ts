import {
  completedBefore,
  effectiveFullTimeMs,
  forecastFor,
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
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function eventName(home: string, away: string, place: string, sheetEventId: string): string {
  if (home && away) return `${home} v ${away}`.slice(0, 80);
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

export function planStadiumEvents(input: {
  now: Date;
  events: unknown[][];
  readings: unknown[][];
}): PlanResult {
  const parsed = parseSurgeSheet(input.events, input.readings);
  const events = lastById(parsed.events);
  const records: StadiumEventRecord[] = [];
  let skipped = parsed.skipped;
  let rejected = parsed.rejected;
  for (const event of events) {
    const id = stadiumDocId(event.sheetEventId);
    if (!id || event.pickups.length === 0) {
      skipped += 1;
      continue;
    }
    const prior = completedBefore(events, event.kickOffMs);
    const pickupPoints: PublicPickup[] = [];
    for (const point of event.pickups) {
      const mark = pointMark(pointSupport(point.name, event, prior, parsed.readings));
      const share = pointConfidencePercent(point.name, event, prior, parsed.readings);
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
    const record: StadiumEventRecord = {
      id,
      idSource: ID_SOURCE,
      sheetEventId: event.sheetEventId,
      name: eventName(event.home, event.away, event.ground, event.sheetEventId),
      description: eventDescription(event.competition, event.ground),
      category: event.category,
      country: "United Kingdom",
      startTimeSource: event.startTimeSource,
      location: centroid(event.pickups),
      windowStart: iso(event.kickOffMs),
      matchEnd: iso(effectiveFullTimeMs(event)),
      removeBy: iso(removeByMs(event)),
      surgeEnded: surgeHasEnded(parsed.readings, event, input.now.getTime()),
      updatedFromSheetAt: input.now.toISOString(),
      pickupPoints,
      forecast: forecastFor(event, prior),
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
  return {records, skipped, rejected};
}
