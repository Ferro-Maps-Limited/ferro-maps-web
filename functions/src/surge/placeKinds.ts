/*
 * Standing places already stored on hotspots_test use one shared set of
 * fields, plus a small extra map for a venue.
 *
 * Venue (stadium, arena, sport, event): events.venue_name, which is the
 * field an event pin already records.
 * Travel (station, airport, flights): name, category, and location only.
 *   A station pin in this repo does not carry events.venue_name.
 * Amenity (hospital, university, pub, shop, hotel, nightclub): the same
 *   plain shape as the fixed hospital pin the sheet writer leaves alone.
 *
 * A blank category is not turned into "event". Unknown words are not places.
 */

export const PLACE_POINT_MAX_METERS = 300;

const FAMILIES = {
  "stadium": "venue",
  "arena": "venue",
  "sport": "venue",
  "event": "venue",
  "events": "venue",
  "venues": "venue",
  "station": "travel",
  "airport": "travel",
  "flights": "travel",
  "flight disruptions": "travel",
  "travel disruptions": "travel",
  "hospital": "amenity",
  "university": "amenity",
  "pub": "amenity",
  "shopping": "amenity",
  "hotel": "amenity",
  "nightclub": "amenity",
} as const;

export type PlaceCategory = keyof typeof FAMILIES;
export type PlaceFamily = (typeof FAMILIES)[PlaceCategory];

const ALIASES: Record<string, PlaceCategory> = {
  "stadiums": "stadium",
  "arenas": "arena",
  "stations": "station",
  "airports": "airport",
  "sports": "sport",
  "hospitals": "hospital",
  "universities": "university",
  "pubs": "pub",
  "hotels": "hotel",
  "nightclubs": "nightclub",
  "flight": "flights",
  "flight disruption": "flight disruptions",
  "travel disruption": "travel disruptions",
  "venue": "venues",
  "shop": "shopping",
  "shops": "shopping",
};

export function knownPlaceCategory(value: unknown): PlaceCategory | null {
  const cleaned = text(value).toLowerCase().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 40) return null;
  const category = ALIASES[cleaned] ?? cleaned;
  if (Object.prototype.hasOwnProperty.call(FAMILIES, category)) return category as PlaceCategory;
  return null;
}

export function placeFamily(category: string): PlaceFamily | null {
  if (Object.prototype.hasOwnProperty.call(FAMILIES, category)) {
    return FAMILIES[category as PlaceCategory];
  }
  return null;
}

/*
 * A coarse UK check. It is not a border survey. It keeps Great Britain,
 * Northern Ireland, and the Isles of Scilly, and it leaves out the
 * Republic of Ireland and the near continent. 0,0 is not a place.
 */
export function insideUk(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < 49.85 || lat > 60.87 || lng < -8.2 || lng > 1.78) return false;
  if (lat < 51.35 && lng < -5.5) return true;
  if (lng < -5.5 && lat < 53.95) return false;
  return true;
}

export function sheetPoint(lat: unknown, lng: unknown): {lat: number; lng: number} | null {
  const latitude = coordinate(lat);
  const longitude = coordinate(lng);
  if (latitude == null || longitude == null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return {lat: latitude, lng: longitude};
}

function coordinate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function slugDocId(prefix: string, label: string): string | null {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 72) return null;
  const id = `${prefix}_${slug}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,100}$/.test(id)) return null;
  return id;
}

/* Hotspot Test Pins already use a document id. sheet_ ids belong to the event writer. */
export function hotspotPinDocId(placeId: string): string | null {
  const id = placeId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(id)) return null;
  if (id.startsWith("sheet_")) return null;
  return id;
}
