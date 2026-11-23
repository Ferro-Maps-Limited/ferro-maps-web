import {OSM_GATES} from "../sources.ts";
import {assertZone, type OmittedSource, type RoadChargeZone} from "../types.ts";

interface OsmParse {
  zones: RoadChargeZone[];
  omitted: OmittedSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Optional OpenStreetMap toll gates. ODbL 1.0. Off unless the caller passes
 * the switch. Accepts an Overpass `elements` array or a GeoJSON
 * FeatureCollection of points. Tags that carry a fee are not copied.
 * Only `barrier=toll_booth` becomes a gate.
 */
export function parseOsmGates(raw: string, fetchedAt: string): OsmParse {
  const parsed: unknown = JSON.parse(raw);
  const zones: RoadChargeZone[] = [];
  const omitted: OmittedSource[] = [];
  const elements = elementsOf(parsed);
  for (const element of elements) {
    if (!isRecord(element)) continue;
    const tags = isRecord(element.tags) ? element.tags : isRecord(element.properties) ? element.properties : {};
    if (tags.barrier !== "toll_booth") continue;
    const id = element.id;
    const lat = typeof element.lat === "number" ? element.lat : coordinate(element, 1);
    const lon = typeof element.lon === "number" ? element.lon : coordinate(element, 0);
    if (typeof id !== "number" || lat === null || lon === null) {
      omitted.push({
        name: typeof tags.name === "string" ? tags.name : "Toll gate",
        kind: "gate",
        reason: "OpenStreetMap toll booth has no node id or no position, so it was not written.",
      });
      continue;
    }
    const zone: RoadChargeZone = {
      id: `osm-gate-${id}`,
      name: typeof tags.name === "string" && tags.name.trim() ? tags.name.trim() : "Toll gate",
      kind: "gate",
      geometry: {type: "Point", coordinates: [lon, lat]},
      sourceUrl: `https://www.openstreetmap.org/node/${id}`,
      licence: OSM_GATES.licence,
      attribution: OSM_GATES.attribution,
      fetchedAt,
    };
    assertZone(zone);
    zones.push(zone);
  }
  return {zones, omitted};
}

function elementsOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) throw new Error("OpenStreetMap file is not JSON");
  if (Array.isArray(parsed.elements)) return parsed.elements;
  if (parsed.type === "FeatureCollection" && Array.isArray(parsed.features)) {
    return parsed.features.map((feature) => {
      if (!isRecord(feature) || !isRecord(feature.geometry)) return feature;
      const coordinates = feature.geometry.coordinates;
      const lon = Array.isArray(coordinates) ? coordinates[0] : undefined;
      const lat = Array.isArray(coordinates) ? coordinates[1] : undefined;
      return {
        id: isRecord(feature.properties) ? feature.properties.id : undefined,
        lon,
        lat,
        tags: feature.properties,
      };
    });
  }
  throw new Error("OpenStreetMap file has no elements");
}

function coordinate(element: Record<string, unknown>, index: number): number | null {
  const geometry = element.geometry;
  if (!isRecord(geometry) || !Array.isArray(geometry.coordinates)) return null;
  const value = geometry.coordinates[index];
  return typeof value === "number" ? value : null;
}
