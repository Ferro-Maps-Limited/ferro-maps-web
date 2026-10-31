/**
 * Client flag resolution from the backend contract, section 1.
 * The seed document is bare booleans and contains no minVersion.
 * pinsV1 stays false until the static pin seed has run and a dry run
 * reports no g5 tile over 500.
 */

const FLAG_DEFAULTS = {
  surge: true,
  parking: true,
  traffic: false,
  privateParking: false,
  tickets: false,
  insights: false,
  payOrIgnore: false,
  pinsV1: false,
  surgeReports: false,
};

function knownDefault(key) {
  const canon = String(key).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS, canon)) {
    return FLAG_DEFAULTS[canon];
  }
  return false;
}

function lookup(doc, key) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const want = String(key).toLowerCase();
  for (const [name, value] of Object.entries(doc)) {
    if (name.toLowerCase() === want) return {found: true, value};
  }
  return {found: false};
}

function parseVersion(value) {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const parts = text.split(".");
  const nums = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return nums;
}

function compareVersion(left, right) {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Blank or unreadable minimum: no minimum. Unreadable app version: the minimum passes. */
function versionAllows(appVersion, minVersion) {
  if (minVersion == null || minVersion === "") return true;
  const min = parseVersion(minVersion);
  if (!min) return true;
  if (appVersion == null || appVersion === "") return true;
  const app = parseVersion(appVersion);
  if (!app) return true;
  return compareVersion(app, min) >= 0;
}

function resolveValue(value, platform, appVersion, fallback) {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;

  let enabled = typeof value.enabled === "boolean" ? value.enabled : fallback;
  let minVersion = value.minVersion;
  const platformValue = value[platform];
  if (typeof platformValue === "boolean") {
    enabled = platformValue;
  } else if (platformValue && typeof platformValue === "object" && !Array.isArray(platformValue)) {
    if (typeof platformValue.enabled === "boolean") enabled = platformValue.enabled;
    if (platformValue.minVersion != null && platformValue.minVersion !== "") {
      minVersion = platformValue.minVersion;
    }
  }
  if (!versionAllows(appVersion, minVersion)) return false;
  return enabled;
}

function resolveFlag(doc, key, platform, appVersion) {
  const fallback = knownDefault(key);
  if (doc == null) return fallback;
  const found = lookup(doc, key);
  if (!found || !found.found || found.value == null) return fallback;
  return resolveValue(found.value, platform, appVersion, fallback);
}

function assertPinsV1Off(doc) {
  for (const platform of ["android", "ios"]) {
    if (resolveFlag(doc, "pinsV1", platform, "9.9.9") !== false) {
      throw new Error(
          "pinsV1 must stay off until the static pin seed has run and a dry run reports no g5 tile over 500",
      );
    }
  }
}

function flagsDocument() {
  const doc = {};
  for (const [key, value] of Object.entries(FLAG_DEFAULTS)) {
    doc[key] = value;
  }
  assertPinsV1Off(doc);
  return doc;
}

function containsMinVersion(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsMinVersion);
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "minversion") return true;
    if (containsMinVersion(child)) return true;
  }
  return false;
}

module.exports = {
  FLAG_DEFAULTS,
  resolveFlag,
  assertPinsV1Off,
  flagsDocument,
  containsMinVersion,
  versionAllows,
};
