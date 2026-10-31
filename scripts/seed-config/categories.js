/**
 * config/categories seed. Wire keys match iOS. A category that is not in
 * the list is not filtered out. enabled: false hides that key only.
 * No minVersion and no timeRule: an absent time rule applies no extra filter.
 */

const DISPLAY = [
  ["event", "Event"],
  ["hotel", "Hotel"],
  ["hospital", "Hospital"],
  ["university", "University"],
  ["shopping", "Shopping"],
  ["sport", "Sport"],
  ["pub", "Pub"],
  ["nightclub", "Nightclub"],
  ["boosted_train", "Boosted Train"],
  ["flight", "Flights"],
  ["flight_disruption", "Flights Disruption"],
  ["tfl", "Transport Disruption"],
  ["egg", "Contribute"],
  ["parking", "Parking"],
];

function categoriesDocument() {
  return {
    categories: DISPLAY.map(([key, label], order) => ({
      key,
      label,
      icon: key,
      order,
      enabled: true,
    })),
  };
}

function parseEntries(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (Array.isArray(doc.categories)) {
    const entries = [];
    for (const row of doc.categories) {
      if (!row || typeof row !== "object") continue;
      const key = typeof row.key === "string" ? row.key.trim().toLowerCase() : "";
      if (!key) continue;
      entries.push(entryFrom(key, row));
    }
    return entries.length ? entries : null;
  }
  const entries = [];
  for (const [mapKey, row] of Object.entries(doc)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const key = typeof row.key === "string" && row.key.trim()
      ? row.key.trim().toLowerCase()
      : mapKey.trim().toLowerCase();
    if (!key) continue;
    entries.push(entryFrom(key, row));
  }
  return entries.length ? entries : null;
}

function entryFrom(key, row) {
  let enabled = true;
  if (typeof row.enabled === "boolean") enabled = row.enabled;
  else if (typeof row.on === "boolean") enabled = row.on;
  return {key, enabled, minVersion: row.minVersion};
}

/**
 * Missing or unreadable doc: hide nothing.
 * A listed key with enabled/on false, or below minVersion, is hidden.
 * A key that is not listed is not filtered out. Duplicate keys: first wins.
 */
function categoryVisible(doc, key, appVersion) {
  const entries = parseEntries(doc);
  if (!entries) return true;
  const want = String(key).trim().toLowerCase();
  const match = entries.find((entry) => entry.key === want);
  if (!match) return true;
  if (match.enabled === false) return false;
  const {versionAllows} = require("./flags");
  return versionAllows(appVersion, match.minVersion);
}

module.exports = {
  DISPLAY,
  categoriesDocument,
  categoryVisible,
};
