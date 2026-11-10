import {GeoPoint, Timestamp, type Firestore} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "./commit.js";
import {placeFamily, type PlaceCategory} from "./placeKinds.js";
import {assertNoPrices} from "./priceGuard.js";

/*
 * Create-only. create() fails when the document is already there, so a
 * second run cannot overwrite a pin another job owns. The payload has no
 * price, fare, baseline, or ratio field.
 */
export interface HotspotPlaceRecord {
  id: string;
  idSource: "fixed_places" | "tpc_watchlist_pin" | "surge_events_place" | "tpc_disruption_place";
  name: string;
  description: string;
  category: PlaceCategory;
  country: "United Kingdom";
  city?: string;
  location: {lat: number; lng: number};
  positionSource: "sheet_coordinates" | "venue_lookup";
  fixedPlaceKey?: string;
}

export interface ExistingPlace {
  id: string;
  fixedPlaceKey: string | null;
}

export async function listExistingPlaces(db: Firestore): Promise<ExistingPlace[]> {
  const snap = await db.collection(HOTSPOTS_COLLECTION).get();
  return snap.docs.map((doc) => {
    const value = doc.get("fixedPlaceKey");
    const key = typeof value === "string" ? value.trim() : "";
    return {id: doc.id, fixedPlaceKey: key || null};
  });
}

export function toPlaceData(record: HotspotPlaceRecord, now: Date): Record<string, unknown> {
  const family = placeFamily(record.category);
  if (!family) throw new Error("known-category-required");
  const data: Record<string, unknown> = {
    idSource: record.idSource,
    name: record.name,
    description: record.description,
    category: record.category,
    country: record.country,
    location: new GeoPoint(record.location.lat, record.location.lng),
    positionSource: record.positionSource,
    fetched_at: Timestamp.fromDate(now),
  };
  if (record.city) data.city = record.city;
  if (record.fixedPlaceKey) data.fixedPlaceKey = record.fixedPlaceKey;
  if (family === "venue") data.events = {venue_name: record.name};
  assertNoPrices(data);
  return data;
}

export async function commitNewHotspots(
  db: Firestore,
  records: HotspotPlaceRecord[],
  now: Date,
): Promise<number> {
  const writes = records.map((record) => {
    if (!record.id || record.id.includes("/") || record.id.startsWith("sheet_")) {
      throw new Error("create-id-required");
    }
    return {id: record.id, data: toPlaceData(record, now)};
  });
  let batch = db.batch();
  let pending = 0;
  for (const write of writes) {
    batch.create(db.collection(HOTSPOTS_COLLECTION).doc(write.id), write.data);
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
  return writes.length;
}
