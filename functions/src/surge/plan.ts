import {createHash} from "node:crypto";
import {parseSheetTime} from "./londonTime.js";
import {readingId} from "./readingId.js";

/*
 * Structured rows only. Sheet column titles are not in §21, so this module
 * does not map a header name onto a field. Callers pass these keys.
 * A value that does not parse is rejected. Nothing is filled in.
 */

export const ID_MAX = 256;
export const NAME_MAX = 200;
export const PRODUCT_MAX = 80;
export const TEXT_MAX = 4000;

export type SurgeKind = "event" | "disruption";
export type SurgePhase = "baseline" | "pre" | "during" | "post";
export type PickupKind = "entrance" | "station" | "other";
export type PointSource = "sheet" | "none";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface NormalizedEvent {
  eventId: string;
  kind: SurgeKind;
  title: string;
  home: string | null;
  away: string | null;
  act: string | null;
  venueName: string | null;
  venueP: GeoPoint | null;
  startAt: Date | null;
  expectedEndAt: Date | null;
  windowStart: Date;
  windowEnd: Date;
  sheetConf: number | null;
  sheetStatus: string | null;
  sheetResult: string | null;
  raw: string;
}

export interface NormalizedPickup {
  eventId: string;
  pickupId: string;
  name: string;
  p: GeoPoint | null;
  pSource: PointSource;
  kind: PickupKind;
}

export interface NormalizedReading {
  eventId: string;
  pickupName: string;
  takenAt: Date;
  phase: SurgePhase;
  product: string;
  pricePence: number;
  baselinePence: number | null;
  waitMin: number | null;
  busyShown: string | null;
  raw: string;
}

export interface ReadingWrite {
  id: string;
  data: {
    eventId: string;
    pickupName: string;
    takenAt: string;
    phase: SurgePhase;
    product: string;
    pricePence: number;
    baselinePence: number | null;
    waitMin: number | null;
    busyShown: string | null;
    raw: string;
  };
}

export interface Accepted<T> {
  ok: true;
  value: T;
}

export interface Rejected {
  ok: false;
  reason: string;
}

const KINDS = new Set<SurgeKind>(["event", "disruption"]);
const PHASES = new Set<SurgePhase>(["baseline", "pre", "during", "post"]);
const PICKUP_KINDS = new Set<PickupKind>(["entrance", "station", "other"]);

function text(value: unknown, max: number, empty: "reject" | "null"): string | null | Rejected {
  if (value == null) return empty === "null" ? null : {ok: false, reason: "missing-text"};
  if (typeof value !== "string") return {ok: false, reason: "text-not-string"};
  const trimmed = value.trim();
  if (trimmed.length === 0) return empty === "null" ? null : {ok: false, reason: "empty-text"};
  if (trimmed.length > max || /[\r\n]/.test(trimmed)) return {ok: false, reason: "text-rejected"};
  return trimmed;
}

function isRejected(value: unknown): value is Rejected {
  return typeof value === "object" && value != null && "ok" in value && (value as Rejected).ok === false;
}

function point(value: unknown): GeoPoint | null | Rejected {
  if (value == null) return null;
  if (typeof value !== "object") return {ok: false, reason: "point-not-object"};
  const record = value as {lat?: unknown; lng?: unknown};
  if (typeof record.lat !== "number" || typeof record.lng !== "number") {
    return {ok: false, reason: "point-incomplete"};
  }
  if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng)) {
    return {ok: false, reason: "point-not-finite"};
  }
  if (record.lat < -90 || record.lat > 90 || record.lng < -180 || record.lng > 180) {
    return {ok: false, reason: "point-out-of-range"};
  }
  return {lat: record.lat, lng: record.lng};
}

function pence(value: unknown, zero: "allow" | "reject"): number | Rejected {
  if (typeof value !== "number" || !Number.isInteger(value)) return {ok: false, reason: "pence-not-integer"};
  if (value < 0 || (zero === "reject" && value === 0)) return {ok: false, reason: "pence-rejected"};
  return value;
}

function optionalTime(value: unknown): Date | null | Rejected {
  if (value == null) return null;
  const parsed = parseSheetTime(value);
  if (parsed == null) return {ok: false, reason: "time-unparsed"};
  return parsed;
}

export function acceptReading(input: {
  eventId: unknown;
  pickupName: unknown;
  takenAt: unknown;
  phase: unknown;
  product: unknown;
  pricePence: unknown;
  baselinePence: unknown;
  waitMin: unknown;
  busyShown: unknown;
  raw: unknown;
}): Accepted<NormalizedReading> | Rejected {
  const eventId = text(input.eventId, ID_MAX, "reject");
  if (isRejected(eventId) || eventId == null) return {ok: false, reason: "event-id"};
  const pickupName = text(input.pickupName, NAME_MAX, "reject");
  if (isRejected(pickupName) || pickupName == null) return {ok: false, reason: "pickup-name"};
  const product = text(input.product, PRODUCT_MAX, "reject");
  if (isRejected(product) || product == null) return {ok: false, reason: "product"};
  const raw = text(input.raw, TEXT_MAX, "reject");
  if (isRejected(raw) || raw == null) return {ok: false, reason: "raw"};
  const takenAt = parseSheetTime(input.takenAt);
  if (takenAt == null) return {ok: false, reason: "time-unparsed"};
  if (typeof input.phase !== "string" || !PHASES.has(input.phase as SurgePhase)) {
    return {ok: false, reason: "phase"};
  }
  const price = pence(input.pricePence, "allow");
  if (isRejected(price)) return {ok: false, reason: "price"};
  let baseline: number | null = null;
  if (input.baselinePence != null) {
    const parsed = pence(input.baselinePence, "reject");
    if (isRejected(parsed)) return {ok: false, reason: "baseline"};
    baseline = parsed;
  }
  let waitMin: number | null = null;
  if (input.waitMin != null) {
    if (typeof input.waitMin !== "number" || !Number.isInteger(input.waitMin) || input.waitMin < 0) {
      return {ok: false, reason: "wait"};
    }
    waitMin = input.waitMin;
  }
  const busyShown = text(input.busyShown, TEXT_MAX, "null");
  if (isRejected(busyShown)) return {ok: false, reason: "busy"};
  return {
    ok: true,
    value: {
      eventId,
      pickupName,
      takenAt,
      phase: input.phase as SurgePhase,
      product,
      pricePence: price,
      baselinePence: baseline,
      waitMin,
      busyShown,
      raw,
    },
  };
}

export function eventContentHash(event: NormalizedEvent): string {
  const body = {
    kind: event.kind,
    title: event.title,
    home: event.home,
    away: event.away,
    act: event.act,
    venueName: event.venueName,
    venueP: event.venueP,
    startAt: event.startAt?.toISOString() ?? null,
    expectedEndAt: event.expectedEndAt?.toISOString() ?? null,
    windowStart: event.windowStart.toISOString(),
    windowEnd: event.windowEnd.toISOString(),
    sheetConf: event.sheetConf,
    sheetStatus: event.sheetStatus,
    sheetResult: event.sheetResult,
    raw: event.raw,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function planReadings(input: {
  readings: NormalizedReading[];
  existingHashes: ReadonlyMap<string, string>;
}): {writes: ReadingWrite[]; unchanged: number; conflicts: {id: string; reason: "payload-differs"}[]} {
  const pending = new Map<string, {write: ReadingWrite; hash: string}>();
  const conflicts = new Map<string, {id: string; reason: "payload-differs"}>();
  let unchanged = 0;
  for (const reading of input.readings) {
    const write = readingWrite(reading);
    const hash = readingBodyHash(write.data);
    const stored = input.existingHashes.get(write.id);
    if (stored != null && stored !== hash) {
      conflicts.set(write.id, {id: write.id, reason: "payload-differs"});
      pending.delete(write.id);
      continue;
    }
    if (stored === hash) {
      unchanged += 1;
      continue;
    }
    const prior = pending.get(write.id);
    if (prior && prior.hash !== hash) {
      conflicts.set(write.id, {id: write.id, reason: "payload-differs"});
      pending.delete(write.id);
      continue;
    }
    if (prior) {
      unchanged += 1;
      continue;
    }
    pending.set(write.id, {write, hash});
  }
  return {
    writes: [...pending.values()].map((item) => item.write),
    unchanged,
    conflicts: [...conflicts.values()],
  };
}

function readingWrite(reading: NormalizedReading): ReadingWrite {
  const id = readingId({
    eventId: reading.eventId,
    pickupName: reading.pickupName,
    takenAt: reading.takenAt,
    product: reading.product,
  });
  return {
    id,
    data: {
      eventId: reading.eventId,
      pickupName: reading.pickupName,
      takenAt: reading.takenAt.toISOString(),
      phase: reading.phase,
      product: reading.product,
      pricePence: reading.pricePence,
      baselinePence: reading.baselinePence,
      waitMin: reading.waitMin,
      busyShown: reading.busyShown,
      raw: reading.raw,
    },
  };
}

export function readingBodyHash(data: ReadingWrite["data"]): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function acceptEvent(input: {
  eventId: unknown;
  kind: unknown;
  title: unknown;
  home: unknown;
  away: unknown;
  act: unknown;
  venueName: unknown;
  venueP: unknown;
  startAt: unknown;
  expectedEndAt: unknown;
  windowStart: unknown;
  windowEnd: unknown;
  sheetConf: unknown;
  sheetStatus: unknown;
  sheetResult: unknown;
  raw: unknown;
}): Accepted<NormalizedEvent> | Rejected {
  const eventId = text(input.eventId, ID_MAX, "reject");
  if (isRejected(eventId) || eventId == null) return {ok: false, reason: "event-id"};
  if (typeof input.kind !== "string" || !KINDS.has(input.kind as SurgeKind)) {
    return {ok: false, reason: "kind"};
  }
  const title = text(input.title, NAME_MAX, "reject");
  if (isRejected(title) || title == null) return {ok: false, reason: "title"};
  const home = text(input.home, NAME_MAX, "null");
  if (isRejected(home)) return {ok: false, reason: "home"};
  const away = text(input.away, NAME_MAX, "null");
  if (isRejected(away)) return {ok: false, reason: "away"};
  const act = text(input.act, NAME_MAX, "null");
  if (isRejected(act)) return {ok: false, reason: "act"};
  const venueName = text(input.venueName, NAME_MAX, "null");
  if (isRejected(venueName)) return {ok: false, reason: "venue"};
  const venueP = point(input.venueP);
  if (isRejected(venueP)) return venueP;
  const startAt = optionalTime(input.startAt);
  if (isRejected(startAt)) return {ok: false, reason: "start"};
  const expectedEndAt = optionalTime(input.expectedEndAt);
  if (isRejected(expectedEndAt)) return {ok: false, reason: "expected-end"};
  const windowStart = parseSheetTime(input.windowStart);
  const windowEnd = parseSheetTime(input.windowEnd);
  if (windowStart == null || windowEnd == null || windowEnd.getTime() <= windowStart.getTime()) {
    return {ok: false, reason: "window"};
  }
  let sheetConf: number | null = null;
  if (input.sheetConf != null) {
    if (typeof input.sheetConf !== "number" || !Number.isFinite(input.sheetConf)) {
      return {ok: false, reason: "sheet-conf"};
    }
    if (input.sheetConf < 0 || input.sheetConf > 1) return {ok: false, reason: "sheet-conf"};
    sheetConf = input.sheetConf;
  }
  const sheetStatus = text(input.sheetStatus, TEXT_MAX, "null");
  if (isRejected(sheetStatus)) return {ok: false, reason: "sheet-status"};
  const sheetResult = text(input.sheetResult, TEXT_MAX, "null");
  if (isRejected(sheetResult)) return {ok: false, reason: "sheet-result"};
  const raw = text(input.raw, TEXT_MAX, "reject");
  if (isRejected(raw) || raw == null) return {ok: false, reason: "raw"};
  return {
    ok: true,
    value: {
      eventId,
      kind: input.kind as SurgeKind,
      title,
      home,
      away,
      act,
      venueName,
      venueP,
      startAt,
      expectedEndAt,
      windowStart,
      windowEnd,
      sheetConf,
      sheetStatus,
      sheetResult,
      raw,
    },
  };
}

export function acceptPickup(input: {
  eventId: unknown;
  pickupId: unknown;
  name: unknown;
  p: unknown;
  pSource: unknown;
  kind: unknown;
}): Accepted<NormalizedPickup> | Rejected {
  const eventId = text(input.eventId, ID_MAX, "reject");
  if (isRejected(eventId) || eventId == null) return {ok: false, reason: "event-id"};
  const pickupId = text(input.pickupId, ID_MAX, "reject");
  if (isRejected(pickupId) || pickupId == null) return {ok: false, reason: "pickup-id"};
  const name = text(input.name, NAME_MAX, "reject");
  if (isRejected(name) || name == null) return {ok: false, reason: "name"};
  const p = point(input.p);
  if (isRejected(p)) return p;
  if (input.pSource !== "sheet" && input.pSource !== "none") return {ok: false, reason: "point-source"};
  if ((p == null) !== (input.pSource === "none")) return {ok: false, reason: "point-source"};
  if (typeof input.kind !== "string" || !PICKUP_KINDS.has(input.kind as PickupKind)) {
    return {ok: false, reason: "kind"};
  }
  return {ok: true, value: {eventId, pickupId, name, p, pSource: input.pSource, kind: input.kind as PickupKind}};
}
