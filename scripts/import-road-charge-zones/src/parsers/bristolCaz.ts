import {combinePolygons, readFeatures, sortFeatures} from "../geo.ts";
import {BRISTOL_CAZ} from "../sources.ts";
import {assertZone, type OmittedSource, type RoadChargeZone} from "../types.ts";

export interface BristolParse {
  zone: RoadChargeZone | null;
  omitted: OmittedSource[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * West of England Combined Authority `weca_caz` GeoJSON, OGL v3.0.
 * The file contains Bath and Bristol. Only Bristol is kept.
 */
export function parseBristolCaz(raw: string, fetchedAt: string): BristolParse {
  const features = sortFeatures(readFeatures(raw));
  const bristol = features.filter((feature) => {
    const code = text(feature.properties.ladcd);
    const name = text(feature.properties.ladnm);
    return code === "E06000023" || /bristol/i.test(name);
  });
  const omitted: OmittedSource[] = features
    .filter((feature) => !bristol.includes(feature))
    .map((feature) => ({
      name: text(feature.properties.ladnm) || "West of England zone",
      kind: "caz",
      reason: "The West of England file also contains this zone. This import keeps the Bristol boundary only.",
    }));
  if (bristol.length === 0) {
    return {
      zone: null,
      omitted: [{
        name: "Bristol Clean Air Zone",
        kind: "caz",
        reason: "The West of England file has no Bristol feature.",
      }],
    };
  }
  const zone: RoadChargeZone = {
    ...BRISTOL_CAZ,
    geometry: combinePolygons(bristol),
    fetchedAt,
  };
  assertZone(zone);
  return {zone, omitted};
}
