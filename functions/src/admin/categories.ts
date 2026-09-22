/**
 * One name per kind of hotspot.
 *
 * The same thing is spelled differently depending on which collection wrote
 * it: an outcome records "event", an alert records "events", and the TfL feed
 * calls its disruptions "tfl". Left alone they count as separate kinds, and a
 * scoreboard shows the same venue twice with half the visits each.
 */
const CANONICAL: Record<string, string> = {
  "event": "events",
  "events": "events",
  "venue": "venues",
  "venues": "venues",
  "flight": "flights",
  "flights": "flights",
  "flight_disruption": "flight disruptions",
  "flight disruption": "flight disruptions",
  "flight disruptions": "flight disruptions",
  "tfl": "travel disruptions",
  "disruption": "travel disruptions",
  "disruptions": "travel disruptions",
  "travel disruption": "travel disruptions",
  "travel disruptions": "travel disruptions",
  "parking": "driver pins",
  "egg": "driver pins",
};

/**
 * The agreed name for a category as some collection spelled it.
 * @param {string | undefined} raw whatever was stored.
 * @return {string} the canonical name, or "unknown".
 */
export function canonicalCategory(raw: string | undefined): string {
  if (!raw) return "unknown";
  return CANONICAL[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase();
}
