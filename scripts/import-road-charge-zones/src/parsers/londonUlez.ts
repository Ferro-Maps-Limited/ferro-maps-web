import {combinePolygons, readFeatures, sortFeatures} from "../geo.ts";
import {LONDON_ULEZ} from "../sources.ts";
import {assertZone, type RoadChargeZone} from "../types.ts";

/**
 * London Datastore "London Wide Ultra Low Emission Zone 2023", OGL v2.0.
 * The GeoJSON is EPSG:27700. The feature attribute says "Low Emission Zone"
 * because the London-wide ULEZ uses that boundary. The record is the ULEZ
 * dataset, not a separate LEZ product. Charge fields are not copied.
 */
export function parseLondonUlez(raw: string, fetchedAt: string): RoadChargeZone {
  const features = sortFeatures(readFeatures(raw));
  const zone: RoadChargeZone = {
    ...LONDON_ULEZ,
    geometry: combinePolygons(features),
    fetchedAt,
  };
  assertZone(zone);
  return zone;
}
