import {GeoPoint, Timestamp, type Firestore} from "firebase-admin/firestore";
import {type StadiumEventRecord} from "./plan.js";
import {assertNoPrices} from "./priceGuard.js";

/*
 * Phones already listen to this collection. The job never deletes a document in it.
 * Identity is the sheet event id (`sheet_<Event ID>`). A pin that only shares a
 * normalised name and coordinates — the private-parking key of normaliseName plus
 * formatCoord to 4 decimal places — is a different document and is not merged.
 */
export const HOTSPOTS_COLLECTION = "hotspots_test";

function stamp(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

export function toFirestoreData(record: StadiumEventRecord): Record<string, unknown> {
  const pickupPoints = record.pickupPoints.map((point) => {
    const copy: Record<string, unknown> = {
      name: point.name,
      lat: point.lat,
      lng: point.lng,
      verified: point.verified,
    };
    if (point.verified && point.confidence) copy.confidence = point.confidence;
    if (point.verified && point.confidencePercent != null) copy.confidencePercent = point.confidencePercent;
    return copy;
  });
  const forecast = record.forecast.state === "no_prediction" ?
    {state: "no_prediction"} :
    {
      state: "available",
      v: 1,
      startAt: stamp(record.forecast.startAt),
      endAt: stamp(record.forecast.endAt),
      strength: record.forecast.strength,
      confidence: record.forecast.confidence,
      confidencePercent: record.forecast.confidencePercent,
      basedOnEvents: record.forecast.basedOnEvents,
    };
  return {
    idSource: record.idSource,
    sheetEventId: record.sheetEventId,
    name: record.name,
    description: record.description,
    category: record.category,
    country: record.country,
    startTimeSource: record.startTimeSource,
    positionSource: record.positionSource,
    location: new GeoPoint(record.location.lat, record.location.lng),
    window_start: stamp(record.windowStart),
    window_end: stamp(record.removeBy),
    expire_at: stamp(record.removeBy),
    fetched_at: stamp(record.updatedFromSheetAt),
    events: {
      start_time: stamp(record.windowStart),
      end_time: stamp(record.matchEnd),
      closing_time: stamp(record.matchEnd),
    },
    removeBy: stamp(record.removeBy),
    surgeEnded: record.surgeEnded,
    updatedFromSheetAt: stamp(record.updatedFromSheetAt),
    pickupPoints,
    forecast,
  };
}

/*
 * Upsert one document per match. merge keeps fields this job does not own,
 * including pins written by other jobs. Nothing in this function deletes a document.
 */
export async function commitStadiumEvents(db: Firestore, records: StadiumEventRecord[]): Promise<number> {
  const writes = records.map((record) => {
    if (!record.id.startsWith("sheet_") || record.idSource !== "sheet_event") {
      throw new Error("sheet-id-required");
    }
    const data = toFirestoreData(record);
    assertNoPrices(data);
    return {id: record.id, data};
  });
  let batch = db.batch();
  let pending = 0;
  for (const write of writes) {
    batch.set(db.collection(HOTSPOTS_COLLECTION).doc(write.id), write.data, {merge: true});
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
