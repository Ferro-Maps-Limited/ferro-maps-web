import {GeoPoint, Timestamp, type Firestore} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "./collections.js";
import {queueForecastMirrors} from "./forecastMirror.js";
import {type StadiumEventRecord} from "./plan.js";
import {assertNoPrices} from "./priceGuard.js";

/*
 * Phones already listen to this collection. The job never deletes a document in it.
 * Identity is the sheet event id (`sheet_<Event ID>`). A pin that only shares a
 * normalised name and coordinates — the private-parking key of normaliseName plus
 * formatCoord to 4 decimal places — is a different document and is not merged.
 */
export {HOTSPOTS_COLLECTION};

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
    {
      state: "no_prediction",
      confidencePercent: record.forecast.confidencePercent ?? null,
      confidenceSource: record.forecast.confidenceSource ?? "none",
    } :
    {
      state: "available",
      v: 1,
      startAt: stamp(record.forecast.startAt),
      endAt: stamp(record.forecast.endAt),
      strength: record.forecast.strength,
      confidence: record.forecast.confidence,
      confidencePercent: record.forecast.confidencePercent ?? null,
      confidenceSource: record.forecast.confidenceSource ?? "none",
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
    /*
     * window_end stays the hard stop, the same instant as removeBy and expire_at.
     * events.end_time is the earlier expected finish. For sheet row 2026-11-01-LIV-ARS
     * that finish is 18:25 UK and the hard stop is 21:25 UK, so this mapping stores
     * 21:25 in both window_end and removeBy. A live Anfield sample had window_end at
     * the finish and a later removeBy. This file has used the hard stop for window_end
     * since the writer was added, and a merged set would overwrite window_end on the
     * next run, so that sample was not produced by this mapping. Left unchanged.
     */
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

/* The live pin keeps its map fields. The forecast map is stored only on hotspot_forecasts. */
export function pinFields(data: Record<string, unknown>): Record<string, unknown> {
  const pin = {...data};
  delete pin.forecast;
  return pin;
}

/*
 * Upsert one document per match. merge keeps fields this job does not own,
 * including pins written by other jobs. Nothing in this function deletes a
 * hotspots_test document.
 *
 * The forecast map is not written on the pin. It goes to hotspot_forecasts.
 * surgeEnded, removeBy, window_start, window_end, and expire_at stay on the pin:
 * the map still uses them to show and drop the pin. jobs_accepted and other
 * fields this job does not write stay in place.
 */
export async function commitStadiumEvents(db: Firestore, records: StadiumEventRecord[]): Promise<number> {
  const writes = records.map((record) => {
    if (!record.id.startsWith("sheet_") || record.idSource !== "sheet_event") {
      throw new Error("sheet-id-required");
    }
    const data = toFirestoreData(record);
    assertNoPrices(data);
    return {id: record.id, data, pin: pinFields(data)};
  });
  let batch = db.batch();
  let pending = 0;
  for (const write of writes) {
    batch.set(db.collection(HOTSPOTS_COLLECTION).doc(write.id), write.pin, {
      mergeFields: Object.keys(write.pin),
    });
    const mirrored = await queueForecastMirrors(db, batch, [{
      id: write.id,
      fields: write.data,
    }], "syncSurgeSheetEvents");
    pending += 1 + mirrored;
    if (pending >= 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
  return writes.length;
}
