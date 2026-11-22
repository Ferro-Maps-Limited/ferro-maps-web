export const ZONE_KINDS = ["congestion", "ulez", "toll", "caz", "tunnel", "gate"] as const;

export type ZoneKind = (typeof ZONE_KINDS)[number];

export type Position = [number, number];

export type GeoJSONGeometry =
  | {type: "Point"; coordinates: Position}
  | {type: "LineString"; coordinates: Position[]}
  | {type: "Polygon"; coordinates: Position[][]}
  | {type: "MultiPolygon"; coordinates: Position[][][]};

/**
 * One zone used for detection and alerts. Prices are not part of this record.
 * geometry is a GeoJSON geometry object in WGS84 (longitude, latitude).
 */
export interface RoadChargeZone {
  id: string;
  name: string;
  kind: ZoneKind;
  geometry: GeoJSONGeometry;
  sourceUrl: string;
  licence: string;
  attribution: string;
  fetchedAt: string;
}

export interface OmittedSource {
  name: string;
  kind: ZoneKind | null;
  reason: string;
}

export const ZONE_FIELDS = [
  "id",
  "name",
  "kind",
  "geometry",
  "sourceUrl",
  "licence",
  "attribution",
  "fetchedAt",
] as const;

const BANNED_KEY = /price|amount|pence|tariff|fee|gbp|cost/i;

export function assertFetchedAt(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error("fetchedAt must be a UTC ISO timestamp");
  }
}

export function assertZoneId(id: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) {
    throw new Error(`zone id is not a safe document id: ${id}`);
  }
}

/** Reject charge amounts wherever they appear in a parsed value. */
export function assertNoMoney(value: unknown, path = "record"): void {
  if (typeof value === "string") {
    if (value.includes("£")) throw new Error(`${path} contains a price`);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoMoney(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (BANNED_KEY.test(key)) throw new Error(`${path}.${key} is a charge field`);
      assertNoMoney(child, `${path}.${key}`);
    }
  }
}

export function assertZone(zone: RoadChargeZone): void {
  const keys = Object.keys(zone).sort();
  const expected = [...ZONE_FIELDS].sort();
  if (keys.join() !== expected.join()) {
    throw new Error(`zone ${zone.id || "(missing id)"} has unexpected fields`);
  }
  assertZoneId(zone.id);
  if (!zone.name.trim()) throw new Error(`zone ${zone.id} has no name`);
  if (!ZONE_KINDS.includes(zone.kind)) throw new Error(`zone ${zone.id} has kind ${zone.kind}`);
  if (!zone.sourceUrl.startsWith("https://")) throw new Error(`zone ${zone.id} has no source URL`);
  if (!zone.licence.trim()) throw new Error(`zone ${zone.id} has no licence`);
  if (!zone.attribution.trim()) throw new Error(`zone ${zone.id} has no attribution`);
  assertFetchedAt(zone.fetchedAt);
  if (zone.geometry.type !== "Point"
    && zone.geometry.type !== "LineString"
    && zone.geometry.type !== "Polygon"
    && zone.geometry.type !== "MultiPolygon") {
    throw new Error(`zone ${zone.id} has no GeoJSON geometry`);
  }
  assertNoMoney(zone);
}
