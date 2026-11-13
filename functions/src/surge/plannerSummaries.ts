import {FieldValue, GeoPoint, Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {geohash} from "../parking/privateSheet/geohash.js";
import {SUMMARIES_COLLECTION} from "./collections.js";
import {assertNoPrices} from "./priceGuard.js";
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

export interface SummaryWriter {
  set(ref: DocumentReference, data: Record<string, unknown>): unknown;
  delete(ref: DocumentReference): unknown;
}

export type SummaryDecision =
  | {op: "set"; data: Record<string, unknown>}
  | {op: "delete"}
  | {op: "none"};

const SUMMARY_KEYS = [
  "hasForecast",
  "name",
  "venue",
  "place",
  "startAt",
  "location",
  "geohash",
  "expireAt",
  "updatedAt",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asGeoPoint(value: unknown): GeoPoint | null {
  if (value instanceof GeoPoint) return value;
  if (!value || typeof value !== "object") return null;
  const point = value as {latitude?: unknown; longitude?: unknown};
  if (typeof point.latitude !== "number" || typeof point.longitude !== "number") return null;
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
  return new GeoPoint(point.latitude, point.longitude);
}

function eventStart(pin: Record<string, unknown>): Timestamp | null {
  const events = asRecord(pin.events);
  const start = events?.start_time;
  return start instanceof Timestamp ? start : null;
}

/* events.venue_name when the pin has one. Otherwise the stored pin name. */
export function summaryVenue(pin: Record<string, unknown>, name: string): string {
  const events = asRecord(pin.events);
  const venue = text(events?.venue_name);
  return venue || name;
}

/* city when it is stored, otherwise area. A missing pair is left off the document. */
export function summaryPlace(pin: Record<string, unknown>): string {
  return text(pin.city) || text(pin.area);
}

/*
 * Public fields only. startAt is the event start. expireAt is the end of that
 * UK day, never removeBy and never the forecast window. Geohash precision 5
 * matches the local cell already used for area topics. No geohash query is added.
 */
export function buildPlannerSummary(pin: Record<string, unknown>): Record<string, unknown> | null {
  const name = typeof pin.name === "string" ? pin.name : "";
  if (!name) return null;
  const startAt = eventStart(pin);
  const location = asGeoPoint(pin.location);
  if (!startAt || !location) return null;
  const expireMs = endOfLondonDayMs(startAt.toMillis());
  if (expireMs == null) return null;
  const place = summaryPlace(pin);
  const data: Record<string, unknown> = {
    hasForecast: true,
    name,
    venue: summaryVenue(pin, name),
    startAt,
    location,
    geohash: geohash(location.latitude, location.longitude, 5),
    expireAt: Timestamp.fromMillis(expireMs),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (place) data.place = place;
  for (const key of Object.keys(data)) {
    if (!SUMMARY_KEYS.includes(key as typeof SUMMARY_KEYS[number])) {
      throw new Error("summary-field");
    }
  }
  assertNoPrices(data);
  return data;
}

/*
 * A real prediction writes a summary. A clear or no_prediction deletes one.
 * An available forecast that has lost its event start or its location deletes
 * the summary too, so a stale row does not stay behind.
 */
export function summaryDecision(pin: Record<string, unknown>): SummaryDecision {
  if (!Object.prototype.hasOwnProperty.call(pin, "forecast")) return {op: "none"};
  const forecast = pin.forecast;
  if (forecast == null) return {op: "delete"};
  const record = asRecord(forecast);
  if (!record) return {op: "delete"};
  if (record.state === "no_prediction") return {op: "delete"};
  if (record.state !== "available") return {op: "none"};
  if (eventStart(pin) == null || asGeoPoint(pin.location) == null) return {op: "delete"};
  const data = buildPlannerSummary(pin);
  if (!data) return {op: "none"};
  return {op: "set", data};
}

/* Replace the whole document so a later write cannot leave a hidden field behind. */
export function applyPlannerSummary(
  batch: SummaryWriter,
  ref: DocumentReference,
  pin: Record<string, unknown>,
): number {
  const decision = summaryDecision(pin);
  if (decision.op === "none") return 0;
  if (decision.op === "delete") {
    batch.delete(ref);
    return 1;
  }
  assertNoPrices(decision.data);
  batch.set(ref, decision.data);
  return 1;
}

export {SUMMARIES_COLLECTION};
