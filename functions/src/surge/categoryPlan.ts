import {
  SHEET_VENUE_HISTORY,
  TPC_ROUTE_HISTORY,
  TPC_STATION_HISTORY,
  type CategoryForecastPatch,
  type ForecastSource,
} from "./categoryCommit.js";
import {applyRecordedOutcomes, type RecordedSurge} from "./forecastHistory.js";
import {completedBefore, forecastFromPool} from "./forecast.js";
import {normLabel, parseSurgeSheet, stadiumDocId, type ParsedEvent} from "./parse.js";
import {londonCalendarDate, londonLocalToUtcMs} from "./time.js";
import {normPlaceKey, selectVenueGrounds} from "./placeMatch.js";
import {parseTpcSheet, type TpcIncident, type TpcScope} from "./tpc.js";
import {GROUND_MIN} from "./thresholds.js";
import {lookupVenueLocation, normVenueName} from "./venueLocations.js";

/*
 * Forecasts for pins this repo does not own.
 *
 * An event pin (a tm_ id, or category events / event / sport) gets a forecast
 * only when its venue name and city match one place, the pin sits within
 * VENUE_PIN_MAX_METERS of that place's checked coordinate, and that London
 * date is not already a sheet_ pin. Matching ignores case, punctuation, a
 * leading "The", and a trailing "City". The reviewed alias table in
 * placeMatch.ts maps a few sponsor spellings onto one place. Those spellings
 * share one history pool. Every other sheet label stays its own pool.
 * "Utilita Arena Birmingham" and "Utilita Arena Birmingham, Birmingham" are
 * not aliases. These pins do not carry home and away teams, so the fixture
 * shortcut (3 rows) is not used. The venue needs the ground minimum. History
 * is completed YES/NO rows strictly before the pin's start. A pending sheet
 * row counts when that same event id has a recorded yes or no. A yes or no
 * already on the sheet stays as it is. The surge window starts at the pin's
 * ending time and runs to that time plus the usual 3 hour hard-stop gap,
 * capped at 6 hours.
 *
 * A travel pin (category "travel disruptions") uses the TPC log. A StopPoint
 * id 910G<station>_<date>_H<hour> matches a station only when Location/Station/Airport
 * normalises to that station and the row is not a line or a route. Station
 * keys use the same case, punctuation, leading "The", and trailing "City"
 * rules. A line-wide incident is not a surge at every station. A route matches
 * only when routeName equals that route label. Pending stays out. A YES or NO
 * with no reading row is incomplete and is left out, not counted as NO. The
 * same ground minimum applies, which is stricter than the fixture shortcut.
 * The window is the hour named in the id, or the pin's own start and end for
 * a route pin.
 *
 * More than one place, or a failed coordinate check, is no_prediction.
 * Nothing is guessed.
 */

export const VENUE_PIN_MAX_METERS = 300;

const HOUR_MS = 60 * 60 * 1000;
const STOP_ID = /^(910G[A-Z0-9]{3,})_(\d{4}-\d{2}-\d{2})_H(\d{2})$/;

export interface HotspotPin {
  id: string;
  data: Record<string, unknown>;
}

export interface CategoryPlan {
  patches: CategoryForecastPatch[];
}

interface Coords {
  lat: number;
  lng: number;
}

export function distanceMeters(left: Coords, right: Coords): number {
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const earth = 6371000;
  const dLat = toRad(right.lat - left.lat);
  const dLng = toRad(right.lng - left.lng);
  const lat1 = toRad(left.lat);
  const lat2 = toRad(right.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function none(id: string, source: ForecastSource, updatedAt: string): CategoryForecastPatch {
  return {id, forecast: {state: "no_prediction"}, forecastSource: source, updatedAt};
}

function pinKind(pin: HotspotPin): "event" | "travel" | null {
  if (!pin.id || pin.id.startsWith("sheet_")) return null;
  const category = typeof pin.data.category === "string" ? normLabel(pin.data.category) : "";
  if (category === "travel disruptions") return "travel";
  if (pin.id.startsWith("tm_")) return "event";
  if (category === "events" || category === "event" || category === "sport" || category === "sports") {
    return "event";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readInstant(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && "toDate" in value && typeof (value as {toDate: unknown}).toDate === "function") {
    const date = (value as {toDate: () => Date}).toDate();
    const ms = date instanceof Date ? date.getTime() : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/* A present value that does not parse, or two present values that disagree, is a conflict. */
function oneInstant(values: unknown[]): number | null | "conflict" {
  const found: number[] = [];
  for (const value of values) {
    if (value == null || value === "") continue;
    const ms = readInstant(value);
    if (ms == null) return "conflict";
    found.push(ms);
  }
  if (found.length === 0) return null;
  if (found.some((ms) => ms !== found[0])) return "conflict";
  return found[0];
}

function readCoords(value: unknown): Coords | null {
  const record = asRecord(value);
  if (!record) return null;
  const lat = typeof record.latitude === "number" ? record.latitude : record.lat;
  const lng = typeof record.longitude === "number" ? record.longitude : record.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {lat, lng};
}

function lastEvents(events: ParsedEvent[]): ParsedEvent[] {
  const byId = new Map<string, ParsedEvent>();
  for (const event of events) byId.set(event.sheetEventId, event);
  return [...byId.values()];
}

function blockedOccasions(events: ParsedEvent[], existingIds: Set<string>): Set<string> {
  const blocked = new Set<string>();
  for (const event of events) {
    const id = stadiumDocId(event.sheetEventId);
    const day = londonCalendarDate(event.kickOffMs);
    if (!id || !day || !existingIds.has(id)) continue;
    const key = `${normVenueName(event.ground)}|${day}`;
    blocked.add(key);
  }
  return blocked;
}

function eventTarget(ground: string, startMs: number, endMs: number): ParsedEvent {
  return {
    sheetEventId: "pin",
    competition: "",
    home: "",
    away: "",
    ground,
    category: "events",
    kickOffMs: startMs,
    startTimeSource: "sheet_exact",
    fullTimeMs: endMs,
    surgeStartMs: null,
    surgeEndMs: null,
    hardStopMs: null,
    outcome: "pending",
    peakUplift: null,
    predictedConfidencePercent: null,
    pickups: [],
  };
}

function travelTarget(startMs: number, endMs: number): ParsedEvent {
  return {
    sheetEventId: "pin",
    competition: "",
    home: "",
    away: "",
    ground: "",
    category: "travel disruptions",
    kickOffMs: startMs,
    startTimeSource: "sheet_exact",
    fullTimeMs: endMs,
    surgeStartMs: startMs,
    surgeEndMs: endMs,
    hardStopMs: endMs,
    outcome: "pending",
    peakUplift: null,
    predictedConfidencePercent: null,
    pickups: [],
  };
}

interface StationPin {
  key: string;
  startMs: number;
  endMs: number;
}

export function stationIdentity(id: string): StationPin | null {
  const match = STOP_ID.exec(id.trim().toUpperCase());
  if (!match) return null;
  const key = normPlaceKey(match[1].slice("910G".length));
  const hour = Number(match[3]);
  if (!key || hour > 23) return null;
  const parts = match[2].split("-").map(Number);
  const startMs = londonLocalToUtcMs(parts[0], parts[1], parts[2], hour, 0);
  if (startMs == null) return null;
  return {key, startMs, endMs: startMs + HOUR_MS};
}

function countable(row: TpcIncident, scope: TpcScope, key: string, beforeMs: number): boolean {
  if (row.scope !== scope || row.key !== key || !row.hasReadings) return false;
  if (row.outcome !== "yes" && row.outcome !== "no") return false;
  return row.kickOffMs < beforeMs;
}

function tpcPool(rows: TpcIncident[], scope: TpcScope, key: string, beforeMs: number): ParsedEvent[] | null {
  const chosen = rows.filter((row) => countable(row, scope, key, beforeMs));
  if (chosen.length < GROUND_MIN) return null;
  return chosen.map((row) => ({
    sheetEventId: row.id,
    competition: "",
    home: "",
    away: "",
    ground: row.key ?? "",
    category: "travel disruptions",
    kickOffMs: row.kickOffMs,
    startTimeSource: "sheet_exact" as const,
    fullTimeMs: null,
    surgeStartMs: null,
    surgeEndMs: null,
    hardStopMs: null,
    outcome: row.outcome,
    peakUplift: row.peakUplift,
    predictedConfidencePercent: null,
    pickups: [],
  }));
}

function planEventPin(
  pin: HotspotPin,
  events: ParsedEvent[],
  blocked: Set<string>,
  updatedAt: string,
): CategoryForecastPatch {
  const source = SHEET_VENUE_HISTORY;
  const eventsMap = asRecord(pin.data.events);
  const venueName = eventsMap && typeof eventsMap.venue_name === "string" ? eventsMap.venue_name : "";
  const city = typeof pin.data.city === "string" ? pin.data.city : "";
  const start = oneInstant([
    pin.data.starting_time,
    eventsMap?.starting_time,
    eventsMap?.start_time,
  ]);
  const end = oneInstant([
    pin.data.ending_time,
    eventsMap?.ending_time,
    eventsMap?.end_time,
  ]);
  const chosen = selectVenueGrounds(events.map((event) => event.ground), venueName, city);
  const coords = readCoords(pin.data.location);
  if (
    !chosen ||
    start === "conflict" ||
    end === "conflict" ||
    start == null ||
    end == null ||
    end <= start
  ) {
    return none(pin.id, source, updatedAt);
  }
  const venues: {lat: number; lng: number}[] = [];
  for (const ground of chosen) {
    const venue = lookupVenueLocation(ground);
    if (venue) venues.push(venue);
  }
  if (
    !coords ||
    venues.length === 0 ||
    venues.some((venue) => distanceMeters(coords, venue) > VENUE_PIN_MAX_METERS)
  ) {
    return none(pin.id, source, updatedAt);
  }
  const day = londonCalendarDate(start);
  if (!day || chosen.some((ground) => blocked.has(`${normVenueName(ground)}|${day}`))) {
    return none(pin.id, source, updatedAt);
  }
  const prior = completedBefore(events.filter((event) => chosen.includes(event.ground)), start);
  /* No home or away team is read off the pin, so the 3-row fixture shortcut does not apply. */
  const pool = prior.length >= GROUND_MIN ? prior : null;
  const forecast = forecastFromPool(eventTarget(chosen[0], start, end), pool);
  return {id: pin.id, forecast, forecastSource: source, updatedAt};
}

function planTravelPin(
  pin: HotspotPin,
  incidents: TpcIncident[],
  updatedAt: string,
): CategoryForecastPatch {
  const station = stationIdentity(pin.id);
  if (station) {
    const pool = tpcPool(incidents, "station", station.key, station.startMs);
    const forecast = forecastFromPool(travelTarget(station.startMs, station.endMs), pool);
    return {id: pin.id, forecast, forecastSource: TPC_STATION_HISTORY, updatedAt};
  }
  const routeName = typeof pin.data.routeName === "string" ? pin.data.routeName : "";
  const routeKey = normVenueName(routeName);
  const eventsMap = asRecord(pin.data.events);
  const start = oneInstant([pin.data.starting_time, eventsMap?.starting_time, eventsMap?.start_time]);
  const end = oneInstant([pin.data.ending_time, eventsMap?.ending_time, eventsMap?.end_time]);
  if (!routeKey || start === "conflict" || end === "conflict" || start == null || end == null || end <= start) {
    return none(pin.id, routeKey ? TPC_ROUTE_HISTORY : TPC_STATION_HISTORY, updatedAt);
  }
  const pool = tpcPool(incidents, "route", routeKey, start);
  const forecast = forecastFromPool(travelTarget(start, end), pool);
  return {id: pin.id, forecast, forecastSource: TPC_ROUTE_HISTORY, updatedAt};
}

export function planCategoryForecasts(input: {
  now: Date;
  events: unknown[][];
  tpcLog: unknown[][];
  tpcReadings: unknown[][];
  pins: HotspotPin[];
  recordedOutcomes?: RecordedSurge[];
}): CategoryPlan {
  const parsed = parseSurgeSheet(input.events, []);
  const events = applyRecordedOutcomes(lastEvents(parsed.events), input.recordedOutcomes ?? []);
  const incidents = parseTpcSheet(input.tpcLog, input.tpcReadings);
  const existingIds = new Set(input.pins.map((pin) => pin.id));
  const blocked = blockedOccasions(events, existingIds);
  const updatedAt = input.now.toISOString();
  const patches: CategoryForecastPatch[] = [];
  for (const pin of input.pins) {
    const kind = pinKind(pin);
    if (kind === "event") patches.push(planEventPin(pin, events, blocked, updatedAt));
    if (kind === "travel") patches.push(planTravelPin(pin, incidents, updatedAt));
  }
  patches.sort((left, right) => left.id.localeCompare(right.id));
  return {patches};
}
