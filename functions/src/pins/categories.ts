/**
 * Lowercase a label and strip spaces, underscores, and hyphens.
 * @param {string} raw display label or category.
 * @return {string} lookup key.
 */
export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

const STATIC_LABELS: Record<string, string> = {
  hospital: "hospital",
  hospitals: "hospital",
  university: "university",
  universities: "university",
  pub: "pub",
  pubs: "pub",
  boostedtrain: "boosted_train",
  boostedtrains: "boosted_train",
  shopping: "shopping",
};

const HOTSPOT_LABELS: Record<string, string> = {
  ...STATIC_LABELS,
  event: "event",
  events: "event",
  hotel: "hotel",
  hotels: "hotel",
  sport: "sport",
  sports: "sport",
  nightclub: "nightclub",
  nightclubs: "nightclub",
  flight: "flight",
  flights: "flight",
  flightdisruption: "flight_disruption",
  flightdisruptions: "flight_disruption",
  tfl: "tfl",
  traveldisruption: "tfl",
  traveldisruptions: "tfl",
  egg: "egg",
  contribute: "egg",
  parking: "parking",
};

export const STATIC_WIRE = new Set([
  "hospital",
  "university",
  "pub",
  "boosted_train",
  "shopping",
]);

/**
 * Map a FixedHotspots display label onto a static wire key.
 * @param {string} label category string from the iOS file.
 * @return {string|null} wire key, or null when it is not one of the five.
 */
export function staticWireKey(label: string): string | null {
  return STATIC_LABELS[normalizeLabel(label)] ?? null;
}

export function hotspotWireKey(label: string): string | null {
  return HOTSPOT_LABELS[normalizeLabel(label)] ?? null;
}
