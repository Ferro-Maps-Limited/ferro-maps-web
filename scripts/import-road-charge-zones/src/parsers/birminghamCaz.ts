import {combinePolygons, readFeatures, sortFeatures} from "../geo.ts";
import {BIRMINGHAM_CAZ} from "../sources.ts";
import {assertZone, type RoadChargeZone} from "../types.ts";

/**
 * Transport for West Midlands feature service for the Birmingham Clean Air
 * Zone. The ArcGIS item states Open Government Licence v3.0 and the layer
 * copyright is Birmingham City Council. The Birmingham map server at
 * maps.birmingham.gov.uk is not used: its copyright text is empty.
 */
export function parseBirminghamCaz(raw: string, fetchedAt: string): RoadChargeZone {
  const zone: RoadChargeZone = {
    ...BIRMINGHAM_CAZ,
    geometry: combinePolygons(sortFeatures(readFeatures(raw))),
    fetchedAt,
  };
  assertZone(zone);
  return zone;
}
