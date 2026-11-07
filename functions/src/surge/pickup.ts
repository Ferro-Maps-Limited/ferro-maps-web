/*
 * Pickup ids. A second name that slugs to the same id is a hold, not a "-2"
 * suffix: that suffix changes if the row order changes.
 */

export type PickupKind = "station" | "airport" | "entrance" | "other";

const STATION = /\b(?:bus station|station|underground|overground|metrolink|dlr|rail|tram)\b/i;
const AIRPORT = /\b(?:airport|terminal)\b/i;
const ENTRANCE = /\b(?:stand|end|gate|entrance|forecourt)\b/i;

export function pickupSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export function pickupKind(name: string): PickupKind {
  if (STATION.test(name)) return "station";
  if (AIRPORT.test(name)) return "airport";
  if (ENTRANCE.test(name)) return "entrance";
  return "other";
}

export interface ParsedPickup {
  name: string;
  slug: string;
  lat: number | null;
  lng: number | null;
}

export interface PickupList {
  pickups: ParsedPickup[];
  collision: boolean;
}

export function inUk(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= 49.8 && lat <= 60.9 && lng >= -8.7 && lng <= 1.8;
}

function latLng(text: string): {lat: number; lng: number} | null {
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!inUk(lat, lng)) return null;
  return {lat, lng};
}

/* Stop at "Real:" or a part that starts with "Owner". Do not assign -2. */
export function parsePickupCell(value: unknown): PickupList {
  if (typeof value !== "string" || value.trim() === "") return {pickups: [], collision: false};
  const pickups: ParsedPickup[] = [];
  for (const part of value.split(";")) {
    const trimmed = part.trim().replace(/^\d+\)\s*/, "");
    if (trimmed === "") continue;
    if (trimmed.includes("Real:") || /^owner\b/i.test(trimmed)) break;
    const pieces = trimmed.split("|").map((piece) => piece.trim());
    const name = pieces[0] ?? "";
    if (name === "") continue;
    const point = pieces[1] ? latLng(pieces[1]) : null;
    pickups.push({
      name,
      slug: pickupSlug(name),
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
    });
  }
  const seen = new Set<string>();
  for (const pickup of pickups) {
    if (pickup.slug === "" || seen.has(pickup.slug)) return {pickups: [], collision: true};
    seen.add(pickup.slug);
  }
  return {pickups, collision: false};
}

export function normalDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cut = value.split(" (")[0] ?? "";
  const text = cut.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text;
}
