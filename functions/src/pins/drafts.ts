import {hotspotWireKey, staticWireKey, STATIC_WIRE} from "./categories";
import {geohash5} from "./geohash";
import {DAY_MS, excludedWindow, nextOpenWindow, OpenWindow} from "./openWindow";
import {TileMember} from "./splitTile";

export interface PinDraft extends TileMember {
  lat: number;
  lng: number;
  title: string;
  category: string;
  city?: string;
  country?: string;
  events?: Record<string, unknown>;
  parking?: Record<string, unknown>;
  liveSurge?: Record<string, unknown>;
  expireAt?: Date;
  hotspotId?: string;
  hotspotSrc?: "static" | "live";
  /** True window. The writer may store `now` instead when this pin is not on shard 0. */
  openStart: Date;
  openEnd: Date;
}

export interface SourceMaps {
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readLatLng(value: unknown): {lat: number, lng: number} | null {
  if (Array.isArray(value) && value.length >= 2) {
    return pair(value[0], value[1]);
  }
  const row = record(value);
  if (!row) return null;
  const lat = row.latitude ?? row.lat ?? row._latitude;
  const lng = row.longitude ?? row.lng ?? row.lon ?? row._longitude;
  return pair(lat, lng);
}

function pair(lat: unknown, lng: unknown): {lat: number, lng: number} | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return {lat, lng};
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const row = record(value);
  if (!row) return null;
  if (typeof row.toDate === "function") {
    const date = (row.toDate as () => Date)();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  const seconds = row._seconds ?? row.seconds;
  if (typeof seconds === "number") return new Date(seconds * 1000);
  return null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clampSurge(value: unknown): Record<string, unknown> | undefined {
  const row = record(value);
  if (!row) return undefined;
  if (row.v !== 1 && row.v !== 1.0) return undefined;
  if (typeof row.active !== "boolean") return undefined;
  if (typeof row.level !== "number" || !Number.isFinite(row.level) || row.level < 1) return undefined;
  const since = asDate(row.since);
  const expiresAt = asDate(row.expiresAt);
  if (!since || !expiresAt || expiresAt <= since) return undefined;
  return {
    active: row.active,
    level: Math.min(3, row.level),
    since,
    expiresAt,
    v: 1,
  };
}

function copyMap(value: unknown): Record<string, unknown> | undefined {
  const row = record(value);
  if (!row || "latitude" in row || "toDate" in row) return undefined;
  return {...row};
}

export function windowForStatic(events: unknown, expireAt: Date | undefined, now: Date): OpenWindow {
  if (expireAt && expireAt.getTime() <= now.getTime()) return excludedWindow(now);
  return nextOpenWindow(events, now) ?? excludedWindow(now);
}

export function staticDraftFromRow(row: SourceMaps, now: Date): {draft?: PinDraft, error?: string} {
  const id = text(row.id);
  if (!id || id.includes("/")) return {error: "missing or unsafe id"};
  const name = text(row.name) ?? text(row.title);
  if (!name) return {error: `${id}: missing name`};
  const category = staticWireKey(String(row.category ?? ""));
  if (!category) return {error: `${id}: category ${String(row.category)} is not a static wire key`};
  const point = readLatLng(row.location) ?? readLatLng(row.p);
  if (!point) return {error: `${id}: missing location`};
  const events = record(row.events) ?? undefined;
  const expireAt = asDate(row.expire_at) ?? undefined;
  const window = windowForStatic(events, expireAt, now);
  return {
    draft: {
      id,
      g5: geohash5(point.lat, point.lng),
      staticPin: true,
      windowEndMs: window.end.getTime(),
      lat: point.lat,
      lng: point.lng,
      title: name,
      category,
      city: text(row.city),
      country: text(row.country),
      events,
      openStart: window.start,
      openEnd: window.end,
      expireAt,
    },
  };
}

export function staticDraftFromStored(id: string, data: SourceMaps, now: Date): PinDraft | null {
  const point = readLatLng(data.p) ?? readLatLng(data.location);
  const category = staticWireKey(String(data.category ?? "")) ??
    (STATIC_WIRE.has(String(data.category)) ? String(data.category) : null);
  const title = text(data.title) ?? text(data.name);
  if (!point || !category || !title) return null;
  const events = record(data.events) ?? undefined;
  const expireAt = asDate(data.expire_at) ?? undefined;
  const window = windowForStatic(events, expireAt, now);
  return {
    id,
    g5: geohash5(point.lat, point.lng),
    staticPin: true,
    windowEndMs: window.end.getTime(),
    lat: point.lat,
    lng: point.lng,
    title,
    category,
    city: text(data.city),
    country: text(data.country),
    events,
    openStart: window.start,
    openEnd: window.end,
    expireAt,
  };
}

export function liveDraftFromHotspot(id: string, data: SourceMaps, now: Date): PinDraft | null {
  const wire = hotspotWireKey(String(data.category ?? ""));
  if (!wire) return null;
  const point = readLatLng(data.location);
  const title = text(data.name);
  if (!point || !title) return null;
  const expireAt = asDate(data.expire_at) ?? undefined;
  let openStart: Date;
  let openEnd: Date;
  if (wire === "parking") {
    if (expireAt && expireAt.getTime() <= now.getTime()) return null;
    openEnd = new Date(now.getTime() + DAY_MS);
    openStart = asDate(data.window_start) ?? asDate(data.createdAt) ?? asDate(data.fetched_at) ?? now;
    if (openStart.getTime() > openEnd.getTime()) openStart = now;
  } else {
    const start = asDate(data.window_start);
    const end = asDate(data.window_end);
    if (!start || !end || end.getTime() <= now.getTime() || end < start) return null;
    openStart = start;
    openEnd = end;
  }
  const src = STATIC_WIRE.has(wire) ? "static" : readSrc(data.src);
  return {
    id,
    g5: geohash5(point.lat, point.lng),
    staticPin: src === "static",
    windowEndMs: openEnd.getTime(),
    lat: point.lat,
    lng: point.lng,
    title,
    category: wire,
    city: text(data.city),
    country: text(data.country),
    events: record(data.events) ?? undefined,
    parking: copyMap(data.parking),
    liveSurge: clampSurge(data.liveSurge),
    expireAt,
    hotspotId: id,
    hotspotSrc: src,
    openStart,
    openEnd,
  };
}

function readSrc(value: unknown): "static" | "live" {
  if (typeof value === "string" && value.trim().toLowerCase() === "static") return "static";
  return "live";
}

export function activeMembers<T extends TileMember>(members: T[], now: Date): T[] {
  return members.filter((member) => member.windowEndMs > now.getTime());
}
