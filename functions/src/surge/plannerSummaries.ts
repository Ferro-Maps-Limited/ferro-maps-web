import {randomBytes} from "crypto";
import {FieldValue, GeoPoint, Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {geohash} from "../parking/privateSheet/geohash.js";
import {SUMMARIES_COLLECTION} from "./collections.js";
import {assertNoPrices, PriceLeakError} from "./priceGuard.js";
import {londonCalendarDate, londonLocalToUtcMs} from "./time.js";

/*
 * config/flags.plannerSummaries is the client switch. config/plannerSummaries.enabled
 * is the server switch. Either one missing, false, or unreadable means off.
 * A map is on only when its enabled field is true. Nothing else turns this on.
 */
export function flagIsOn(value: unknown): boolean {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as {enabled?: unknown}).enabled === true;
}

export async function plannerSummariesEnabled(db: Firestore): Promise<boolean> {
  const [flags, server] = await Promise.all([
    db.doc("config/flags").get(),
    db.doc("config/plannerSummaries").get(),
  ]);
  return flagIsOn(flags.get("plannerSummaries")) && server.get("enabled") === true;
}

/* The first instant of the next London calendar day. That is the end of startAt's UK day. */
export function endOfLondonDayMs(startMs: number): number | null {
  const day = londonCalendarDate(startMs);
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date));
  next.setUTCDate(next.getUTCDate() + 1);
  return londonLocalToUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
}

/*
 * Server-only map from the public summary id back to the pin.
 * Clients cannot read or write it. The public id is not the hotspot id.
 */
export const SUMMARY_KEYS_COLLECTION = "plannerSummaryKeys";

export const SUMMARY_FIELDS = [
  "windowStart",
  "windowEnd",
  "confidence",
  "startAt",
  "geohash4",
  "expireAt",
  "updatedAt",
] as const;

export interface SummaryWriter {
  set(ref: DocumentReference, data: Record<string, unknown>): unknown;
  delete(ref: DocumentReference): unknown;
}

export interface ExistingSummaryKey {
  id: string;
  windowStart: Timestamp | null;
  windowEnd: Timestamp | null;
}

export interface SummaryKeyDoc {
  hotspotId: string;
  windowStart: Timestamp;
  windowEnd: Timestamp;
  expireAt: Timestamp;
}

export interface SummaryUpsert {
  id: string;
  data: Record<string, unknown>;
  key: SummaryKeyDoc;
}

export interface SummaryPlan {
  deletes: string[];
  upsert: SummaryUpsert | null;
}

/* 32 hex characters. Not derived from the hotspot id. */
export function opaqueSummaryId(): string {
  return randomBytes(16).toString("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asGeoPoint(value: unknown): GeoPoint | null {
  if (value instanceof GeoPoint) return value;
  if (!value || typeof value !== "object") return null;
  const point = value as {latitude?: unknown; longitude?: unknown};
  if (typeof point.latitude !== "number" || typeof point.longitude !== "number") return null;
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
  return new GeoPoint(point.latitude, point.longitude);
}

function asTimestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null;
}

function eventStart(pin: Record<string, unknown>): Timestamp | null {
  const events = asRecord(pin.events);
  return asTimestamp(events?.start_time);
}

function sameStamp(left: Timestamp | null, right: Timestamp | null): boolean {
  if (!left || !right) return false;
  return left.toMillis() === right.toMillis();
}

/* Whole-number percent. A band word is not stored. */
export function wholePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > 100) return null;
  return value;
}

/*
 * The public document. No name, venue, place, coordinates, hotspot id, or
 * strength band. confidence is the whole-number percent when the forecast has one.
 * geohash4 is precision 4 so a phone can query its cell and the eight neighbours.
 * That query is a single field, so Firestore's automatic index covers it.
 */
export function buildPlannerSummary(pin: Record<string, unknown>): Record<string, unknown> | null {
  const forecast = asRecord(pin.forecast);
  if (!forecast || forecast.state !== "available") return null;
  const windowStart = asTimestamp(forecast.startAt);
  const windowEnd = asTimestamp(forecast.endAt);
  const startAt = eventStart(pin);
  const location = asGeoPoint(pin.location);
  if (!windowStart || !windowEnd || !startAt || !location) return null;
  if (windowEnd.toMillis() <= windowStart.toMillis()) return null;
  const expireMs = endOfLondonDayMs(startAt.toMillis());
  if (expireMs == null) return null;
  const data: Record<string, unknown> = {
    windowStart,
    windowEnd,
    startAt,
    geohash4: geohash(location.latitude, location.longitude, 4),
    expireAt: Timestamp.fromMillis(expireMs),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const confidence = wholePercent(forecast.confidencePercent);
  if (confidence != null) data.confidence = confidence;
  for (const key of Object.keys(data)) {
    if (!SUMMARY_FIELDS.includes(key as typeof SUMMARY_FIELDS[number])) throw new Error("summary-field");
  }
  assertSummaryPrices(data);
  return data;
}

/* Numeric confidence is the percent on this document. The price guard otherwise rejects that key. */
function assertSummaryPrices(data: Record<string, unknown>): void {
  const confidence = data.confidence;
  if (confidence != null && wholePercent(confidence) == null) throw new PriceLeakError();
  const rest: Record<string, unknown> = {...data};
  delete rest.confidence;
  assertNoPrices(rest);
}

function shouldDelete(pin: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(pin, "forecast")) return false;
  const forecast = pin.forecast;
  if (forecast == null) return true;
  const record = asRecord(forecast);
  if (!record || record.state === "no_prediction") return true;
  if (record.state !== "available") return false;
  return buildPlannerSummary(pin) == null;
}

/*
 * One opaque id per forecast window. The same window keeps its id.
 * A different window, a clear, no_prediction, a stale row, or a pin that has
 * lost its event start or location deletes the old summary and its key.
 */
export function planPlannerSummary(
  hotspotId: string,
  pin: Record<string, unknown>,
  existing: ExistingSummaryKey[],
  newId: () => string = opaqueSummaryId,
): SummaryPlan {
  if (shouldDelete(pin)) return {deletes: existing.map((key) => key.id), upsert: null};
  const data = buildPlannerSummary(pin);
  if (!data) return {deletes: [], upsert: null};
  const windowStart = data.windowStart as Timestamp;
  const windowEnd = data.windowEnd as Timestamp;
  const match = existing.find((key) => {
    return sameStamp(key.windowStart, windowStart) && sameStamp(key.windowEnd, windowEnd);
  });
  const id = match?.id ?? newId();
  return {
    deletes: existing.filter((key) => key.id !== id).map((key) => key.id),
    upsert: {
      id,
      data,
      key: {
        hotspotId,
        windowStart,
        windowEnd,
        expireAt: data.expireAt as Timestamp,
      },
    },
  };
}

export function summaryKeyFromDoc(id: string, data: Record<string, unknown> | undefined): ExistingSummaryKey {
  return {
    id,
    windowStart: asTimestamp(data?.windowStart),
    windowEnd: asTimestamp(data?.windowEnd),
  };
}

export async function loadSummaryKeys(db: Firestore, hotspotId: string): Promise<ExistingSummaryKey[]> {
  const snap = await db.collection(SUMMARY_KEYS_COLLECTION).where("hotspotId", "==", hotspotId).get();
  return snap.docs.map((doc) => summaryKeyFromDoc(doc.id, doc.data()));
}

/* Replace the summary so a later write cannot leave a removed field behind. */
export function applySummaryPlan(
  batch: SummaryWriter,
  db: Firestore,
  plan: SummaryPlan,
): number {
  let ops = 0;
  for (const id of plan.deletes) {
    batch.delete(db.collection(SUMMARIES_COLLECTION).doc(id));
    batch.delete(db.collection(SUMMARY_KEYS_COLLECTION).doc(id));
    ops += 2;
  }
  if (!plan.upsert) return ops;
  const keyData: Record<string, unknown> = {...plan.upsert.key};
  assertSummaryPrices(plan.upsert.data);
  assertNoPrices(keyData);
  batch.set(db.collection(SUMMARIES_COLLECTION).doc(plan.upsert.id), plan.upsert.data);
  batch.set(db.collection(SUMMARY_KEYS_COLLECTION).doc(plan.upsert.id), keyData);
  return ops + 2;
}

export {SUMMARIES_COLLECTION};
