import {bngToWgs84} from "./bng.ts";
import {type GeoJSONGeometry, type Position} from "./types.ts";

export interface GeoFeature {
  properties: Record<string, unknown>;
  geometry: GeoJSONGeometry;
}

type CrsKind = "wgs84" | "bng";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function crsKind(collection: Record<string, unknown>): CrsKind | null {
  const crs = collection.crs;
  if (crs === undefined) return null;
  if (!isRecord(crs) || !isRecord(crs.properties) || typeof crs.properties.name !== "string") {
    throw new Error("GeoJSON crs is not a named CRS");
  }
  const name = crs.properties.name.toUpperCase();
  if (name.includes("27700")) return "bng";
  if (name.includes("4326") || name.includes("CRS84")) return "wgs84";
  throw new Error(`unsupported coordinate reference system ${crs.properties.name}`);
}

function looksLikeLonLat(position: Position): boolean {
  return Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90;
}

function firstPosition(coordinates: unknown): Position {
  let current: unknown = coordinates;
  while (Array.isArray(current)) {
    if (current.length >= 2 && typeof current[0] === "number" && typeof current[1] === "number") {
      return [current[0], current[1]];
    }
    current = current[0];
  }
  throw new Error("GeoJSON geometry has no coordinates");
}

function mapPositions(value: unknown, map: (position: Position) => Position): unknown {
  if (!Array.isArray(value)) throw new Error("GeoJSON coordinates are not an array");
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    if (!Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
      throw new Error("GeoJSON coordinate is not a finite number");
    }
    return map([value[0], value[1]]);
  }
  return value.map((child) => mapPositions(child, map));
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length < 4) throw new Error("a polygon ring needs at least four positions");
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) throw new Error("a polygon ring is empty");
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  throw new Error("a polygon ring is not closed");
}

function asGeometry(type: string, coordinates: unknown, map: (position: Position) => Position): GeoJSONGeometry {
  const mapped = mapPositions(coordinates, map);
  if (type === "Point") return {type, coordinates: mapped as Position};
  if (type === "LineString") {
    const line = mapped as Position[];
    if (line.length < 2) throw new Error("a line needs at least two positions");
    return {type, coordinates: line};
  }
  if (type === "Polygon") {
    return {type, coordinates: (mapped as Position[][]).map(closeRing)};
  }
  if (type === "MultiPolygon") {
    const parts = (mapped as Position[][][]).map((polygon) => polygon.map(closeRing));
    return {type, coordinates: parts};
  }
  throw new Error(`unsupported GeoJSON geometry ${type}`);
}

/**
 * Read a GeoJSON FeatureCollection and return WGS84 geometries.
 * EPSG:27700 is converted. Grid coordinates with no CRS are rejected
 * rather than guessed. Properties are returned so each parser can pick
 * the name fields and drop everything else, including any charge amount.
 */
export function readFeatures(raw: string): GeoFeature[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error("expected a GeoJSON FeatureCollection");
  }
  let crs = crsKind(parsed);
  const output: GeoFeature[] = [];
  for (const feature of parsed.features) {
    if (!isRecord(feature) || !isRecord(feature.geometry) || typeof feature.geometry.type !== "string") {
      throw new Error("GeoJSON feature has no geometry");
    }
    const first = firstPosition(feature.geometry.coordinates);
    if (!crs) {
      if (!looksLikeLonLat(first)) {
        throw new Error("coordinate reference system is missing and the coordinates are not longitude and latitude");
      }
      crs = "wgs84";
    }
    if (crs === "wgs84" && !looksLikeLonLat(first)) {
      throw new Error("file says WGS84 but the coordinates are not longitude and latitude");
    }
    const map = crs === "bng"
      ? (position: Position) => bngToWgs84(position[0], position[1])
      : (position: Position) => {
        if (!looksLikeLonLat(position)) throw new Error("a WGS84 coordinate is outside longitude and latitude");
        return position;
      };
    const properties = isRecord(feature.properties) ? feature.properties : {};
    output.push({
      properties,
      geometry: asGeometry(feature.geometry.type, feature.geometry.coordinates, map),
    });
  }
  if (output.length === 0) throw new Error("GeoJSON file has no features");
  return output;
}

export function sortFeatures(features: GeoFeature[]): GeoFeature[] {
  const key = (feature: GeoFeature): number => {
    const value = feature.properties.OBJECTID ?? feature.properties.OBJECTID_1 ?? feature.properties.fid ?? feature.properties.id;
    return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
  };
  return [...features].sort((a, b) => key(a) - key(b));
}

export function combinePolygons(features: GeoFeature[]): GeoJSONGeometry {
  const parts: Position[][][] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (geometry.type === "Polygon") parts.push(geometry.coordinates);
    else if (geometry.type === "MultiPolygon") parts.push(...geometry.coordinates);
    else throw new Error(`expected a polygon and found ${geometry.type}`);
  }
  if (parts.length === 1) {
    const only = parts[0];
    if (!only) throw new Error("no polygons to combine");
    return {type: "Polygon", coordinates: only};
  }
  return {type: "MultiPolygon", coordinates: parts};
}
