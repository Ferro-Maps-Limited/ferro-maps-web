import {defineString} from "firebase-functions/params";
import {rowsFromMatrix} from "../parking/privateSheet/rows.js";
import {distanceMeters} from "./categoryPlan.js";
import {GROUND} from "./headers.js";
import {
  type ExistingPlace,
  type HotspotPlaceRecord,
} from "./placeCommit.js";
import {
  hotspotPinDocId,
  insideUk,
  knownPlaceCategory,
  PLACE_POINT_MAX_METERS,
  sheetPoint,
  slugDocId,
  type PlaceCategory,
} from "./placeKinds.js";
import {parsePickupPoints} from "./parse.js";
import {PriceLeakError, assertNoPrices} from "./priceGuard.js";
import {classifyTpcPlace, TPC_LOCATION} from "./tpc.js";
import {lookupVenueLocation, normVenueName} from "./venueLocations.js";

/*
 * Places named on the surge tabs that are not already hotspots_test docs.
 * A place is created only when its category is one this repo already uses
 * and its point is checked: sheet coordinates inside the UK, or the
 * committed venue table. Anything else is skippedUnverified.
 * The document id is deterministic. An existing id or fixedPlaceKey is
 * left untouched. Names are not matched. Price columns are not copied.
 */

export const surgeFixedPlacesTab = defineString("SURGE_FIXED_PLACES_TAB", {default: "Fixed Places"});
export const surgePlaceTpcLogTab = defineString("SURGE_PLACE_TPC_LOG_TAB", {default: "TPC Disruption Log"});
export const surgeCreatePlacesDryRun = defineString("SURGE_CREATE_PLACES_DRY_RUN", {default: "true"});

const KEY_HEADERS = ["Place key", "Place ID", "Key", "Fixed place key"];
const NAME_HEADERS = ["Place name", "Name", "Ground", "Venue", "Venue name"];
const CATEGORY_HEADERS = ["Category", "Venue type", "Venue category", "Type"];

export interface PlaceTabs {
  events: unknown[][];
  fixedPlaces: unknown[][];
  watchlist: unknown[][];
  tpcLog: unknown[][];
}

export interface PlaceCreateSummary {
  status: "ok" | "skipped" | "error";
  reason?: "sheet-id-missing" | "read-failed" | "write-failed" | "price-leak";
  dryRun: boolean;
  created: number;
  skippedUnverified: number;
  alreadyPresent: number;
  wouldCreate: HotspotPlaceRecord[];
}

interface Candidate {
  id: string;
  idSource: HotspotPlaceRecord["idSource"];
  name: string;
  category: PlaceCategory;
  city?: string;
  location: {lat: number; lng: number};
  positionSource: HotspotPlaceRecord["positionSource"];
  fixedPlaceKey?: string;
  priority: number;
}

interface Bucket {
  candidates: Candidate[];
  rejected: boolean;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function firstText(values: Record<string, unknown>, headers: readonly string[]): string {
  for (const header of headers) {
    const value = text(values[header]);
    if (value) return value;
  }
  return "";
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function blankSummary(status: PlaceCreateSummary["status"], dryRun: boolean, reason?: PlaceCreateSummary["reason"]): PlaceCreateSummary {
  return {
    status,
    reason,
    dryRun,
    created: 0,
    skippedUnverified: 0,
    alreadyPresent: 0,
    wouldCreate: [],
  };
}

function ensure(buckets: Map<string, Bucket>, id: string): Bucket {
  const found = buckets.get(id);
  if (found) return found;
  const bucket: Bucket = {candidates: [], rejected: false};
  buckets.set(id, bucket);
  return bucket;
}

function addCandidate(buckets: Map<string, Bucket>, candidate: Candidate): void {
  ensure(buckets, candidate.id).candidates.push(candidate);
}

function reject(buckets: Map<string, Bucket>, id: string): void {
  ensure(buckets, id).rejected = true;
}

function checkedSheetPoint(lat: unknown, lng: unknown): {lat: number; lng: number} | "missing" | "rejected" {
  const present = text(lat) !== "" || text(lng) !== "" || typeof lat === "number" || typeof lng === "number";
  if (!present) return "missing";
  const point = sheetPoint(lat, lng);
  if (!point || !insideUk(point.lat, point.lng)) return "rejected";
  return point;
}

function lookupPoint(name: string): {lat: number; lng: number} | null {
  const venue = lookupVenueLocation(name);
  if (!venue || !insideUk(venue.lat, venue.lng)) return null;
  return {lat: venue.lat, lng: venue.lng};
}

function cityOf(value: unknown): string | undefined {
  const city = text(value);
  if (!city || city.length > 40 || !/^[A-Za-z][A-Za-z .'-]*$/.test(city)) return undefined;
  return city;
}

function fromFixedPlaces(matrix: unknown[][], buckets: Map<string, Bucket>): void {
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const key = firstText(row.values, KEY_HEADERS);
    const name = firstText(row.values, NAME_HEADERS);
    const categoryText = firstText(row.values, CATEGORY_HEADERS);
    const category = knownPlaceCategory(categoryText);
    const id = key ? slugDocId("fp", key) : null;
    if (!key || !name || !id) {
      reject(buckets, `unverified:fixed:${row.sheetRow}`);
      continue;
    }
    if (categoryText && !category) {
      reject(buckets, id);
      continue;
    }
    if (!category) {
      ensure(buckets, id);
      continue;
    }
    const sheet = checkedSheetPoint(row.values.Latitude, row.values.Longitude);
    if (sheet === "rejected") {
      reject(buckets, id);
      continue;
    }
    const looked = sheet === "missing" ? lookupPoint(name) : null;
    const point = sheet === "missing" ? looked : sheet;
    if (!point) {
      ensure(buckets, id);
      continue;
    }
    addCandidate(buckets, {
      id,
      idSource: "fixed_places",
      name: clip(name, 80),
      category,
      city: cityOf(row.values.City),
      location: point,
      positionSource: sheet === "missing" ? "venue_lookup" : "sheet_coordinates",
      fixedPlaceKey: key,
      priority: 1,
    });
  }
}

function fromWatchlist(matrix: unknown[][], buckets: Map<string, Bucket>): void {
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const placeId = text(row.values["Place ID"]);
    const source = text(row.values["Place source"]).toLowerCase().replace(/\s+/g, " ");
    const name = text(row.values["Place name"]);
    const categoryText = text(row.values.Category);
    const category = knownPlaceCategory(categoryText);
    if (!placeId || (source !== "hotspot test pins" && source !== "fixed places")) {
      reject(buckets, `unverified:watch:${row.sheetRow}`);
      continue;
    }
    const id = source === "hotspot test pins" ? hotspotPinDocId(placeId) : slugDocId("fp", placeId);
    if (!id) {
      reject(buckets, `unverified:watch:${placeId || row.sheetRow}`);
      continue;
    }
    if (categoryText && !category) {
      reject(buckets, id);
      continue;
    }
    if (!name || !category) {
      ensure(buckets, id);
      continue;
    }
    const sheet = checkedSheetPoint(row.values.Latitude, row.values.Longitude);
    if (sheet === "rejected") {
      reject(buckets, id);
      continue;
    }
    const looked = sheet === "missing" ? lookupPoint(name) : null;
    const point = sheet === "missing" ? looked : sheet;
    if (!point) {
      ensure(buckets, id);
      continue;
    }
    addCandidate(buckets, {
      id,
      idSource: source === "hotspot test pins" ? "tpc_watchlist_pin" : "fixed_places",
      name: clip(name, 80),
      category,
      location: point,
      positionSource: sheet === "missing" ? "venue_lookup" : "sheet_coordinates",
      fixedPlaceKey: source === "fixed places" ? placeId : undefined,
      priority: source === "fixed places" ? 2 : 3,
    });
  }
}

function eventPlaceName(values: Record<string, unknown>): string {
  return text(values[GROUND]) || text(values.Venue) || text(values["Venue name"]);
}

function eventCategory(values: Record<string, unknown>): PlaceCategory | null {
  for (const header of ["Venue type", "Category", "Venue category", "Type"]) {
    if (!text(values[header])) continue;
    return knownPlaceCategory(values[header]);
  }
  return null;
}

function fromEvents(matrix: unknown[][], buckets: Map<string, Bucket>): void {
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const name = eventPlaceName(row.values);
    const categoryCell = ["Venue type", "Category", "Venue category", "Type"].some((header) => text(row.values[header]));
    const category = eventCategory(row.values);
    if (!name || !categoryCell || !category) {
      reject(buckets, `unverified:event:${row.sheetRow}`);
      continue;
    }
    const id = slugDocId("place", `${category}-${normVenueName(name)}`);
    if (!id) {
      reject(buckets, `unverified:event:${row.sheetRow}`);
      continue;
    }
    const pickups = parsePickupPoints(row.values["Pickup points (name | lat,lng)"]);
    let point: {lat: number; lng: number} | null = null;
    let positionSource: Candidate["positionSource"] = "venue_lookup";
    if (pickups.length > 0) {
      if (pickups.some((pickup) => !insideUk(pickup.lat, pickup.lng))) {
        reject(buckets, id);
        continue;
      }
      point = {
        lat: pickups.reduce((sum, pickup) => sum + pickup.lat, 0) / pickups.length,
        lng: pickups.reduce((sum, pickup) => sum + pickup.lng, 0) / pickups.length,
      };
      if (!insideUk(point.lat, point.lng)) {
        reject(buckets, id);
        continue;
      }
      positionSource = "sheet_coordinates";
    } else {
      point = lookupPoint(name);
    }
    if (!point) {
      ensure(buckets, id);
      continue;
    }
    addCandidate(buckets, {
      id,
      idSource: "surge_events_place",
      name: clip(name, 80),
      category,
      location: point,
      positionSource,
      priority: 4,
    });
  }
}

function modeCategory(value: string): PlaceCategory | null {
  const key = value.toLowerCase();
  if (!key) return null;
  if (/\b(airport|flight|air)\b/.test(key)) return "airport";
  if (/\b(rail|train|tube|underground|station|dlr|overground|tram|metro)\b/.test(key)) return "station";
  return knownPlaceCategory(value);
}

function fromTpcLog(matrix: unknown[][], buckets: Map<string, Bucket>): void {
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const location = text(row.values[TPC_LOCATION]);
    const classified = classifyTpcPlace(text(row.values[GROUND]), location);
    if (!location || classified.scope !== "station") {
      reject(buckets, `unverified:tpc:${row.sheetRow}`);
      continue;
    }
    const mode = text(row.values.Mode);
    const kind = text(row.values.Type);
    const category = modeCategory(mode) ?? modeCategory(kind) ?? (!mode && !kind ? "station" : null);
    const id = category ? slugDocId("tpc", `${category}-${normVenueName(location)}`) : null;
    if (!category || !id) {
      reject(buckets, `unverified:tpc:${location}`);
      continue;
    }
    const point = lookupPoint(location);
    if (!point) {
      ensure(buckets, id);
      continue;
    }
    addCandidate(buckets, {
      id,
      idSource: "tpc_disruption_place",
      name: clip(location, 80),
      category,
      location: point,
      positionSource: "venue_lookup",
      priority: 5,
    });
  }
}

function merge(bucket: Bucket): HotspotPlaceRecord | null {
  if (bucket.rejected || bucket.candidates.length === 0) return null;
  const first = bucket.candidates[0];
  if (bucket.candidates.some((item) => item.category !== first.category)) return null;
  const key = first.fixedPlaceKey ?? null;
  if (bucket.candidates.some((item) => (item.fixedPlaceKey ?? null) !== key)) return null;
  const sheet = bucket.candidates.filter((item) => item.positionSource === "sheet_coordinates");
  const points = sheet.length > 0 ? sheet : bucket.candidates;
  const origin = points[0].location;
  if (points.some((item) => distanceMeters(origin, item.location) > PLACE_POINT_MAX_METERS)) return null;
  const named = [...bucket.candidates].sort((left, right) => left.priority - right.priority)[0];
  const city = bucket.candidates.find((item) => item.city)?.city;
  const record: HotspotPlaceRecord = {
    id: named.id,
    idSource: named.idSource,
    name: named.name,
    description: clip(named.name, 160),
    category: named.category,
    country: "United Kingdom",
    location: {lat: origin.lat, lng: origin.lng},
    positionSource: sheet.length > 0 ? "sheet_coordinates" : "venue_lookup",
  };
  if (city) record.city = city;
  if (key) record.fixedPlaceKey = key;
  return record;
}

export function planMissingHotspots(input: PlaceTabs & {existing: ExistingPlace[]}): {
  creates: HotspotPlaceRecord[];
  skippedUnverified: number;
  alreadyPresent: number;
} {
  const buckets = new Map<string, Bucket>();
  fromFixedPlaces(input.fixedPlaces, buckets);
  fromWatchlist(input.watchlist, buckets);
  fromEvents(input.events, buckets);
  fromTpcLog(input.tpcLog, buckets);
  const ids = new Set(input.existing.map((place) => place.id));
  const keys = new Set(input.existing.map((place) => place.fixedPlaceKey).filter((key): key is string => Boolean(key)));
  const creates: HotspotPlaceRecord[] = [];
  let skippedUnverified = 0;
  let alreadyPresent = 0;
  for (const bucket of buckets.values()) {
    const record = merge(bucket);
    if (!record) {
      skippedUnverified += 1;
      continue;
    }
    try {
      assertNoPrices(record);
    } catch (err) {
      if (!(err instanceof PriceLeakError)) throw err;
      skippedUnverified += 1;
      continue;
    }
    if (ids.has(record.id) || (record.fixedPlaceKey != null && keys.has(record.fixedPlaceKey))) {
      alreadyPresent += 1;
      continue;
    }
    creates.push(record);
  }
  creates.sort((left, right) => left.id.localeCompare(right.id));
  return {creates, skippedUnverified, alreadyPresent};
}

export function dryRunEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}

export async function runMissingHotspotCreate(input: {
  now: Date;
  dryRun?: boolean;
  sheetId: string;
  eventsTab: string;
  fixedPlacesTab: string;
  watchlistTab: string;
  tpcLogTab: string;
  load: (
    sheetId: string,
    eventsTab: string,
    fixedPlacesTab: string,
    watchlistTab: string,
    tpcLogTab: string,
  ) => Promise<PlaceTabs>;
  listExisting: () => Promise<ExistingPlace[]>;
  commit: (records: HotspotPlaceRecord[]) => Promise<number>;
}): Promise<PlaceCreateSummary> {
  const dryRun = input.dryRun !== false;
  if (!input.sheetId.trim()) return blankSummary("skipped", dryRun, "sheet-id-missing");
  let tabs: PlaceTabs;
  let existing: ExistingPlace[];
  try {
    [tabs, existing] = await Promise.all([
      input.load(
        input.sheetId.trim(),
        input.eventsTab.trim() || "Events",
        input.fixedPlacesTab.trim() || "Fixed Places",
        input.watchlistTab.trim() || "TPC Watchlist Readings",
        input.tpcLogTab.trim() || "TPC Disruption Log",
      ),
      input.listExisting(),
    ]);
  } catch (err) {
    if (err instanceof PriceLeakError) return blankSummary("error", dryRun, "price-leak");
    return blankSummary("error", dryRun, "read-failed");
  }
  let planned: ReturnType<typeof planMissingHotspots>;
  try {
    planned = planMissingHotspots({...tabs, existing});
  } catch (err) {
    if (err instanceof PriceLeakError) return blankSummary("error", dryRun, "price-leak");
    return blankSummary("error", dryRun, "read-failed");
  }
  if (dryRun || planned.creates.length === 0) {
    return {
      status: "ok",
      dryRun,
      created: 0,
      skippedUnverified: planned.skippedUnverified,
      alreadyPresent: planned.alreadyPresent,
      wouldCreate: planned.creates,
    };
  }
  try {
    const created = await input.commit(planned.creates);
    return {
      status: "ok",
      dryRun: false,
      created,
      skippedUnverified: planned.skippedUnverified,
      alreadyPresent: planned.alreadyPresent,
      wouldCreate: planned.creates,
    };
  } catch (err) {
    if (err instanceof PriceLeakError) return blankSummary("error", false, "price-leak");
    return blankSummary("error", false, "write-failed");
  }
}
