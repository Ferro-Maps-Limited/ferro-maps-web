import {FieldValue, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {FORECASTS_COLLECTION, HOTSPOTS_COLLECTION} from "./collections.js";
import {assertNoPrices} from "./priceGuard.js";

/*
 * Fields copied onto hotspot_forecasts. Names and shapes match hotspots_test.
 * updatedAt is added here only. It is a server timestamp and is not a pin field.
 *
 * forecastSource and forecastUpdatedAt are the category writer's fields.
 * The sheet writer also copies window_start, window_end, and expire_at.
 * recordForecastHistory copies forecastHistory.
 *
 * TODO: remove the forecast fields from hotspots_test in the following release.
 * Until then every writer keeps those pin fields unchanged and mirrors them here.
 */
export const FORECAST_MIRROR_FIELDS = [
  "forecast",
  "window_start",
  "window_end",
  "forecastHistory",
  "forecastSource",
  "forecastUpdatedAt",
  "expire_at",
] as const;

export interface ForecastMirrorWrite {
  id: string;
  fields: Record<string, unknown>;
  /* The surge has ended. The pin fields stay; the forecast document is removed. */
  remove?: boolean;
}

interface ForecastWriter {
  set(ref: DocumentReference, data: Record<string, unknown>, options: {merge: boolean}): unknown;
  delete(ref: DocumentReference): unknown;
}

export function forecastMirrorFields(data: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of FORECAST_MIRROR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined) {
      picked[key] = data[key];
    }
  }
  return picked;
}

/* A null forecast is a clear. Anything else with no forecast state is not a forecast. */
export function forecastCleared(fields: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(fields, "forecast") && fields.forecast == null;
}

function hasForecastPayload(picked: Record<string, unknown>): boolean {
  const forecast = picked.forecast;
  if (forecast && typeof forecast === "object" && !Array.isArray(forecast)) {
    const state = (forecast as {state?: unknown}).state;
    if (state === "available" || state === "no_prediction") return true;
  }
  const history = picked.forecastHistory;
  return Boolean(history && typeof history === "object" && !Array.isArray(history));
}

function mirrorPayload(picked: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {updatedAt: FieldValue.serverTimestamp()};
  for (const [key, value] of Object.entries(picked)) {
    if (value != null) payload[key] = value;
  }
  return payload;
}

/*
 * Queue one forecast-document write on an existing batch or transaction.
 * Prices are refused before any forecast write. A cleared or ended forecast
 * deletes the document. No forecast queues nothing.
 */
export function applyForecastMirror(
  writer: ForecastWriter,
  ref: DocumentReference,
  fields: Record<string, unknown>,
  remove = false,
): number {
  assertNoPrices(fields);
  const picked = forecastMirrorFields(fields);
  assertNoPrices(picked);
  if (remove || forecastCleared(fields)) {
    writer.delete(ref);
    return 1;
  }
  if (!hasForecastPayload(picked)) return 0;
  const payload = mirrorPayload(picked);
  assertNoPrices(payload);
  writer.set(ref, payload, {merge: true});
  return 1;
}

/*
 * Same rules as applyForecastMirror. When the payload has no expire_at, copy
 * the pin's expire_at so a later TTL policy can use the same instant.
 */
export async function queueForecastMirrors(
  db: Firestore,
  writer: ForecastWriter,
  writes: ForecastMirrorWrite[],
): Promise<number> {
  let ops = 0;
  for (const write of writes) {
    if (!write.id || write.id.includes("/")) throw new Error("forecast-id-required");
    const ref = db.collection(FORECASTS_COLLECTION).doc(write.id);
    let fields = write.fields;
    const picked = forecastMirrorFields(fields);
    const willWrite = !write.remove && !forecastCleared(fields) && hasForecastPayload(picked);
    if (willWrite && picked.expire_at == null) {
      const pin = await db.collection(HOTSPOTS_COLLECTION).doc(write.id).get();
      const stored = pin.get("expire_at");
      if (stored != null) fields = {...fields, expire_at: stored};
    }
    ops += applyForecastMirror(writer, ref, fields, write.remove === true);
  }
  return ops;
}
