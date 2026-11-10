import {normVenueName} from "./venueLocations.js";

/*
 * Reviewed spellings of one real place. Membership is the whole name after
 * normalisation, not a word stripped off every venue. "Arena" is the short
 * Leeds pin name for First Direct Arena. It is not an alias for AO Arena.
 *
 * First Direct Bank Arena is the same Leeds building. The sheet uses that
 * longer sponsor spelling as well as First Direct Arena. Leeds Arena is the
 * name recorded on the checked venue row. Manchester Arena is the former name
 * recorded on the AO Arena row. A pin still needs the same city, one place
 * only, and a coordinate within VENUE_PIN_MAX_METERS of a checked point.
 */
export const VENUE_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["First Direct Arena", "First Direct Bank Arena", "Leeds Arena", "Arena"],
  ["AO Arena", "Manchester Arena"],
];

/* Case, punctuation, a leading "The", and one trailing "City". */
export function normPlaceKey(value: string): string {
  const base = normVenueName(value).replace(/^(?:the )+/, "");
  return base.replace(/ city$/, "").replace(/\s+/g, " ").trim();
}

const ALIAS_GROUP: Map<string, number> = (() => {
  const index = new Map<string, number>();
  VENUE_ALIAS_GROUPS.forEach((group, groupIndex) => {
    for (const name of group) {
      const key = normPlaceKey(name);
      if (!key) throw new Error("venue alias is blank");
      const existing = index.get(key);
      if (existing != null && existing !== groupIndex) {
        throw new Error(`venue alias ${key} is in more than one place`);
      }
      index.set(key, groupIndex);
    }
  });
  return index;
})();

function aliasGroup(name: string): number | null {
  const group = ALIAS_GROUP.get(name);
  return group == null ? null : group;
}

function splitGround(ground: string): {name: string; city: string} | null {
  const comma = ground.lastIndexOf(",");
  if (comma <= 0 || comma >= ground.length - 1) return null;
  const name = ground.slice(0, comma).trim();
  const city = ground.slice(comma + 1).trim();
  if (!name || !city) return null;
  return {name, city};
}

/*
 * One place key for every spelling of a reviewed place. Two keys means the
 * pin fits two places, which the caller rejects.
 */
function placeKey(ground: string, pinName: string): string {
  const split = splitGround(ground);
  if (!split) return `label:${normPlaceKey(ground)}`;
  const sheetName = normPlaceKey(split.name);
  const sheetGroup = aliasGroup(sheetName);
  const pinGroup = aliasGroup(pinName);
  if (sheetGroup != null && sheetGroup === pinGroup) return `group:${sheetGroup}`;
  if (sheetName === pinName) return `name:${sheetName}`;
  return `label:${normPlaceKey(ground)}`;
}

function groundMatches(ground: string, pinName: string, pinCity: string): boolean {
  const split = splitGround(ground);
  if (!split) return false;
  const sheetName = normPlaceKey(split.name);
  const sheetCity = normPlaceKey(split.city);
  if (!sheetName || sheetCity !== pinCity) return false;
  if (sheetName === pinName || normPlaceKey(ground) === pinName) return true;
  const pinGroup = aliasGroup(pinName);
  const sheetGroup = aliasGroup(sheetName);
  return pinGroup != null && pinGroup === sheetGroup;
}

/*
 * The sheet grounds for the single place this pin names. Null when none match
 * or more than one place matches. Spellings in one reviewed group are one place.
 */
export function selectVenueGrounds(
  grounds: readonly string[],
  venueName: string,
  city: string,
): string[] | null {
  const pinName = normPlaceKey(venueName);
  const pinCity = normPlaceKey(city);
  if (!pinName || !pinCity) return null;
  const hits: {ground: string; key: string}[] = [];
  const seen = new Set<string>();
  for (const ground of grounds) {
    if (seen.has(ground)) continue;
    if (!groundMatches(ground, pinName, pinCity)) continue;
    seen.add(ground);
    hits.push({ground, key: placeKey(ground, pinName)});
  }
  const keys = new Set(hits.map((hit) => hit.key));
  if (keys.size !== 1) return null;
  return hits.map((hit) => hit.ground);
}
