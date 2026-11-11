import {FieldValue, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {FORECASTS_COLLECTION, HOTSPOTS_COLLECTION} from "./collections.js";
import {assertNoPrices} from "./priceGuard.js";

/*
 * Fields copied onto hotspot_forecasts. Names and shapes match hotspots_test.
 * updatedAt is added here only. It is a server timestamp and is not a pin field.
 *
 * The surging-now badge reads forecast.state, forecast.startAt, forecast.endAt,
 * forecast.strength, forecast.confidence, forecast.confidencePercent, surgeEnded,
 * and removeBy. Those stay on this document after the apps stop reading them
 * from hotspots_test. surgeEnded true does not delete the document: the badge
 * has to see that the surge has finished. The document is removed only when
 * the forecast itself is cleared.
 *
 * TODO: remove the forecast fields from hotspots_test in the following release.
 * Until then every writer keeps those pin fields unchanged and mirrors them here.
 */
export const FORECAST_MIRROR_FIELDS = [
  "forecast",
  "window_start",
  "window_end",
  "removeBy",
  "surgeEnded",
  "forecastHistory",
  "forecastSource",
  "forecastUpdatedAt",
  "expire_at",
] as const;

export interface ForecastMirrorWrite {
  id: string;
  fields: Record<string, unknown>;
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

/* Fill only the mirror fields the writer did not set, using the pin's current values. */
export function withPinForecastFields(
  fields: Record<string, unknown>,
  pinData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!pinData) return fields;
  const merged: Record<string, unknown> = {...fields};
  for (const key of FORECAST_MIRROR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) continue;
    if (Object.prototype.hasOwnProperty.call(pinData, key) && pinData[key] !== undefined) {
      merged[key] = pinData[key];
    }
  }
  return merged;
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
 * Prices are refused before any forecast write. A cleared forecast deletes
 * the document. No forecast queues nothing. surgeEnded is stored either way.
 */
export function applyForecastMirror(
  writer: ForecastWriter,
  ref: DocumentReference,
  fields: Record<string, unknown>,
): number {
  const picked = forecastMirrorFields(fields);
  assertNoPrices(picked);
  if (forecastCleared(fields)) {
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
 * Same rules as applyForecastMirror. Mirror fields the writer did not set are
 * copied off the pin, including surgeEnded and removeBy for the live badge.
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
    if (!forecastCleared(fields)) {
      const missing = FORECAST_MIRROR_FIELDS.some((key) => !Object.prototype.hasOwnProperty.call(fields, key));
      if (missing) {
        const pin = await db.collection(HOTSPOTS_COLLECTION).doc(write.id).get();
        fields = withPinForecastFields(fields, pin.exists ? pin.data() : undefined);
      }
    }
    ops += applyForecastMirror(writer, ref, fields);
  }
  return ops;
}
