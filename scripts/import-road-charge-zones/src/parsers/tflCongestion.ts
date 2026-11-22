import {combinePolygons, readFeatures, sortFeatures} from "../geo.ts";
import {TFL_CONGESTION} from "../sources.ts";
import {assertZone, type RoadChargeZone} from "../types.ts";

/**
 * TfL GIS hub Congestion Charge Zone GeoJSON.
 * The hub item is Open Government Licence v3.0. Ask the feature service for
 * outSR=4326 so the file is already longitude and latitude. Both published
 * polygons are kept. Charge fields on the features are not copied.
 */
export function parseTflCongestion(raw: string, fetchedAt: string): RoadChargeZone {
  const features = sortFeatures(readFeatures(raw));
  for (const feature of features) {
    const description = feature.properties.DESCRIPTIO;
    if (typeof description === "string" && !/congestion/i.test(description)) {
      throw new Error("TfL file is not the Congestion Charge boundary");
    }
  }
  const zone: RoadChargeZone = {
    ...TFL_CONGESTION,
    geometry: combinePolygons(features),
    fetchedAt,
  };
  assertZone(zone);
  return zone;
}
