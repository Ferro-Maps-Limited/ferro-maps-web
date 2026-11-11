import {logger} from "firebase-functions/logger";
import {FieldValue, Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {FORECASTS_COLLECTION, HOTSPOTS_COLLECTION} from "./collections.js";
import {assertNoPrices} from "./priceGuard.js";

/*
 * Fields copied onto hotspot_forecasts. Names and shapes match hotspots_test.
 * updatedAt is added here only. It is a server timestamp and is not a pin field.
 *
 * Apps fetch this collection with window_end > now. Every document needs a
 * Timestamp window_end already stored on the pin. A missing or non-Timestamp
 * value is not invented: the forecast write is skipped. The surging-now badge
 * uses forecast.startAt, forecast.endAt, and surgeEnded. The document is
 * removed only when the forecast itself is cleared.
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

const FORECAST_CHILD_FIELDS = [
  "state",
  "v",
  "startAt",
  "endAt",
  "strength",
  "confidence",
  "confidencePercent",
  "confidenceSource",
  "basedOnEvents",
] as const;

const HISTORY_PRE_EVENT_FIELDS = [
  "snapshotAt",
  "state",
  "strength",
  "confidencePercent",
  "basedOnEvents",
  "startAt",
  "endAt",
] as const;

const HISTORY_OUTCOME_FIELDS = [
  "surged",
  "windowStartAt",
  "windowEndAt",
  "strength",
  "readingCount",
  "readingTimes",
] as const;

interface ForecastWriter {
  set(
    ref: DocumentReference,
    data: Record<string, unknown>,
    options: {mergeFields: string[]},
  ): unknown;
  delete(ref: DocumentReference): unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function allowlisted(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function copyReadingTimes(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => {
    if (item == null || typeof item !== "object") return item != null;
    return Object.getPrototypeOf(item) !== Object.prototype;
  });
}

function copyForecast(value: unknown): Record<string, unknown> | undefined {
  return allowlisted(value, FORECAST_CHILD_FIELDS);
}

function copyHistory(value: unknown): Record<string, unknown> | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const out: Record<string, unknown> = {};
  const preEvent = allowlisted(source.preEvent, HISTORY_PRE_EVENT_FIELDS);
  const outcomeSource = asRecord(source.outcome);
  const outcome = allowlisted(outcomeSource, HISTORY_OUTCOME_FIELDS);
  if (outcome) {
    const times = copyReadingTimes(outcomeSource?.readingTimes);
    if (times) outcome.readingTimes = times;
    else delete outcome.readingTimes;
  }
  if (preEvent && Object.keys(preEvent).length > 0) out.preEvent = preEvent;
  if (outcome && Object.keys(outcome).length > 0) out.outcome = outcome;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function forecastMirrorFields(data: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of FORECAST_MIRROR_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, key) || data[key] === undefined) continue;
    if (key === "forecast") {
      const forecast = copyForecast(data.forecast);
      if (forecast) picked.forecast = forecast;
      continue;
    }
    if (key === "forecastHistory") {
      const history = copyHistory(data.forecastHistory);
      if (history) picked.forecastHistory = history;
      continue;
    }
    picked[key] = data[key];
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
 * the document. No forecast queues nothing. A forecast with no Timestamp
 * window_end is not written.
 */
export function applyForecastMirror(
  batch: ForecastWriter,
  ref: DocumentReference,
  fields: Record<string, unknown>,
  writerName: string,
): number {
  const picked = forecastMirrorFields(fields);
  assertNoPrices(picked);
  if (forecastCleared(fields)) {
    batch.delete(ref);
    return 1;
  }
  if (!hasForecastPayload(picked)) return 0;
  if (!(picked.window_end instanceof Timestamp)) {
    logger.warn("hotspot_forecasts write skipped", {hotspotId: ref.id, writer: writerName});
    return 0;
  }
  const payload = mirrorPayload(picked);
  assertNoPrices(payload);
  // mergeFields replaces each named field. forecast is the whole map, so a
  // later no_prediction drops startAt, endAt, and strength.
  batch.set(ref, payload, {mergeFields: Object.keys(payload)});
  return 1;
}

/*
 * Same rules as applyForecastMirror. Mirror fields the writer did not set are
 * copied off the pin, including surgeEnded and removeBy for the live badge.
 */
export async function queueForecastMirrors(
  db: Firestore,
  batch: ForecastWriter,
  writes: ForecastMirrorWrite[],
  writerName: string,
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
    ops += applyForecastMirror(batch, ref, fields, writerName);
  }
  return ops;
}
