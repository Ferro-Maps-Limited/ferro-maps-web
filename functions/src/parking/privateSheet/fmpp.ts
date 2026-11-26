import {
  coordinateSkip,
  firstUrl,
  formatAddr,
  mapOperator,
  parseCoord,
  parseDate,
  parseMinutes,
  poundsToPence,
  text,
} from "./mapping.js";
import {rowsFromMatrix} from "./rows.js";
import {type FeeUnit, type PrivatePlace, type SrcType} from "./types.js";

/*
 * FM-PP city workbooks (Birmingham first, then any later city).
 *
 * A city is `CODE|City Name|<spreadsheet-id>`, optionally
 * `|Locations tab|Tariffs tab`. Several cities are separated by `;` or a
 * newline. Tab names default to `Locations - {City}` and `Tariffs - {City}`.
 * The spreadsheet id is a placeholder in this repo. Real ids stay out of git.
 *
 * Only a location row whose `FM Ready` cell is exactly ✅ is published.
 * Tariffs join on Location ID. One public hourly, daily, or per-visit price
 * fills `fee` and `feeUnit`. Stepped bands do not become a fake hourly fee.
 */

export const FMPP_LOCATION_HEADERS = [
  "Location ID",
  "Provider",
  "Provider Location Code",
  "Primary Provider",
  "Merged Location ID",
  "Location Name",
  "Type",
  "Street/Address",
  "Postcode",
  "Area",
  "Borough/Operator",
  "Latitude",
  "Longitude",
  "Hours of Operation",
  "Max Stay",
  "Tariff / Prices (GBP)",
  "Restrictions & Rules",
  "Free Period (Y/N)",
  "Free Minutes",
  "Free Time Window",
  "No-Return Period (mins)",
  "Free Parking Notes",
  "Payment Options",
  "Also payable via",
  "Convenience fee",
  "Ferro Autopay",
  "Ferro Charge",
  "Example Ferro charge on a £5 session",
  "Source URL",
  "Last Checked",
  "Notes",
  "",
  "Parking Charge (£)",
  "Tariff Bands",
  "Charging Days/Hours",
  "Min Stay / Max Stay",
  "Provider Convenience/Service Fee (£)",
  "Emissions/Diesel Surcharge",
  "Tariff Source URL",
  "Tariff Last Checked",
  "Tariff Confidence",
  "Ferro total for 1h",
  "FM Ready Missing",
  "FM Ready",
] as const;

export const FMPP_TARIFF_HEADERS = [
  "Location ID",
  "Provider",
  "Provider Location Code",
  "Duration / Band",
  "Price (£)",
  "Confidence",
  "Source URL",
  "Last Checked",
  "Notes",
] as const;

export const FM_READY = "✅";

export interface FmppSource {
  code: string;
  city: string;
  sheetId: string;
  locationsTab: string;
  tariffsTab: string;
}

export interface FmppTariffBand {
  duration: string;
  pricePence: number | undefined;
  confidence: string;
  notes: string;
}

export type FmppHeaderKind = "locations" | "tariffs";

function headerName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/* Trailing empty cells from the API are ignored. A named extra column is not. */
export function fmppHeaderProblem(kind: FmppHeaderKind, header: unknown[] | undefined): string | null {
  const expected = kind === "locations" ? FMPP_LOCATION_HEADERS : FMPP_TARIFF_HEADERS;
  if (!header || header.length === 0) return "header-missing";
  const names = header.map(headerName);
  while (names.length > expected.length && names[names.length - 1] === "") names.pop();
  if (names.length !== expected.length) return "header-unexpected";
  for (let index = 0; index < expected.length; index += 1) {
    if (names[index] !== expected[index]) return "header-unexpected";
  }
  return null;
}

function cleanSheetId(value: string): string | null {
  const id = value.trim();
  if (id.length < 8 || id.length > 128) return null;
  if (/\s/.test(id) || id.includes("/") || id.includes("\\")) return null;
  const lower = id.toLowerCase();
  if (lower.includes("://") || lower.includes("docs.google") || lower.includes("spreadsheets")) return null;
  return id;
}

/*
 * Blank, or whitespace only, is no cities. Anything else that is not a list
 * of `CODE|City|<spreadsheet-id>` entries is invalid. The reason never
 * includes the spreadsheet id.
 */
export function parseFmppSources(raw: string): {ok: true; sources: FmppSource[]} | {ok: false; reason: string} {
  const trimmed = raw.trim();
  if (!trimmed) return {ok: true, sources: []};
  const entries = trimmed.split(/[;\r\n]+/).map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) return {ok: true, sources: []};
  const sources: FmppSource[] = [];
  const codes = new Set<string>();
  const sheetIds = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split("|").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 5) return {ok: false, reason: "fmpp-sources-invalid"};
    const code = (parts[0] ?? "").toUpperCase();
    const city = parts[1] ?? "";
    const sheetId = cleanSheetId(parts[2] ?? "");
    if (!/^[A-Z0-9]{2,8}$/.test(code) || city === "" || city.length > 80 || sheetId == null) {
      return {ok: false, reason: "fmpp-sources-invalid"};
    }
    const locationsTab = parts.length === 5 ? (parts[3] ?? "") : `Locations - ${city}`;
    const tariffsTab = parts.length === 5 ? (parts[4] ?? "") : `Tariffs - ${city}`;
    if (locationsTab === "" || tariffsTab === "" || locationsTab.length > 100 || tariffsTab.length > 100) {
      return {ok: false, reason: "fmpp-sources-invalid"};
    }
    if (codes.has(code) || sheetIds.has(sheetId)) return {ok: false, reason: "fmpp-sources-invalid"};
    codes.add(code);
    sheetIds.add(sheetId);
    sources.push({code, city, sheetId, locationsTab, tariffsTab});
  }
  return {ok: true, sources};
}

function containsNotPublished(value: unknown): boolean {
  return text(value).toLowerCase().includes("not published");
}

function publishedText(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || containsNotPublished(raw)) return undefined;
  return raw;
}

/* City ids are `FERRO-<CODE>-...`. London sha256 and `PP-######` ids are refused. */
export function cityLocationId(code: string, value: unknown): string | null {
  const id = text(value).toUpperCase();
  if (!new RegExp(`^FERRO-${code}-[A-Z0-9]+(?:-[A-Z0-9]+)*$`).test(id)) return null;
  if (/^[0-9A-F]{64}$/.test(id) || /^PP-\d+$/.test(id)) return null;
  return id;
}

export function fmppProviderSlug(provider: string): string | undefined {
  const compact = provider.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact || compact === "notpublished") return undefined;
  if (compact.includes("paybyphone")) return "paybyphone";
  if (compact.includes("ringgo")) return "ringgo";
  if (compact.includes("justpark")) return "justpark";
  if (compact.includes("eurocarparks") || compact.includes("ecpparkbuddy")) return "eurocarparks";
  if (compact.includes("parkbuddy")) return "parkbuddy";
  if (compact.includes("apcoa")) return "apcoa";
  if (compact.includes("evology")) return "evology";
  if (compact.includes("mipermit")) return "mipermit";
  if (compact.startsWith("ncp") || compact.includes("nationalcarparks")) return "ncp";
  if (compact.includes("qpark")) return "qpark";
  if (compact.includes("parkbee")) return "parkbee";
  return compact.slice(0, 32);
}

function locationCodeOf(value: unknown): string | null {
  const code = text(value);
  if (!code || containsNotPublished(code) || /\s/.test(code) || code.length > 64) return null;
  return code;
}

function providerOf(values: Record<string, unknown>): string | null {
  const named = publishedText(values.Provider) ?? publishedText(values["Primary Provider"]);
  if (!named) return null;
  return mapOperator(named) ?? null;
}

/* A clear max stay such as `6 hours` or `90 minutes`. Prose is omitted. */
export function parseMaxStayMinutes(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw || containsNotPublished(raw)) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)$/i.exec(raw);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const minutes = /hour|hr/i.test(match[2] ?? "") ? amount * 60 : amount;
  const rounded = Math.round(minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || Math.abs(minutes - rounded) > 1e-6) return undefined;
  if (rounded > 14 * 24 * 60) return undefined;
  return rounded;
}

function confidenceOk(value: string): boolean {
  const folded = value.trim().toLowerCase();
  return folded === "verified" || folded === "partial";
}

function isConcession(duration: string, notes: string): boolean {
  return /\b(?:blue badge|concession|twilight|validated)\b/i.test(`${duration} ${notes}`);
}

/* One repeating public price. A ladder of durations is not an hourly fee. */
export function tariffUnit(duration: string): FeeUnit | null {
  const folded = duration.trim().toLowerCase().replace(/\s+/g, " ");
  if (!folded) return null;
  if (/\b(?:per hour|an hour|every hour|each hour|hourly)\b/.test(folded) ||
    /^for every 1 hour\b/.test(folded) ||
    /^every 1 hour\b/.test(folded)) {
    return "hour";
  }
  if (/^(?:up to )?(?:1 hour|60 minutes|one hour)\b/.test(folded)) return "hour";
  if (/\b(?:per 24 hours|per day|a day|daily)\b/.test(folded)) return "day";
  if (/^(?:up to )?(?:24 hours|1 day|one day)\b/.test(folded)) return "day";
  if (/\b(?:per visit|per stay)\b/.test(folded)) return "visit";
  return null;
}

export function simpleFee(
  bands: FmppTariffBand[],
  parkingChargePence: number | undefined,
): {fee: number; feeUnit: FeeUnit} | undefined {
  const paid = bands.filter((band) => {
    return confidenceOk(band.confidence) &&
      band.pricePence != null &&
      band.pricePence >= 1 &&
      !isConcession(band.duration, band.notes);
  });
  if (paid.length > 0) {
    const units = paid.map((band) => tariffUnit(band.duration));
    const unit = units[0];
    const fee = paid[0]?.pricePence;
    if (unit == null || fee == null || fee < 1) return undefined;
    if (units.some((item) => item !== unit)) return undefined;
    if (paid.some((band) => band.pricePence !== fee)) return undefined;
    return {fee, feeUnit: unit};
  }
  if (bands.length > 0) return undefined;
  if (parkingChargePence != null && parkingChargePence >= 1) {
    return {fee: parkingChargePence, feeUnit: "hour"};
  }
  return undefined;
}

function indexTariffs(matrix: unknown[][]): Map<string, FmppTariffBand[]> {
  const byId = new Map<string, FmppTariffBand[]>();
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const id = text(row.values["Location ID"]).toUpperCase();
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push({
      duration: text(row.values["Duration / Band"]),
      pricePence: poundsToPence(row.values["Price (£)"]),
      confidence: text(row.values.Confidence),
      notes: text(row.values.Notes),
    });
    byId.set(id, list);
  }
  return byId;
}

function assign<K extends keyof PrivatePlace>(place: PrivatePlace, key: K, value: PrivatePlace[K] | undefined): void {
  if (value !== undefined) place[key] = value;
}

/* Null means the row is FM Ready on the sheet but not safe to publish. */
export function mapFmppPlace(
  code: string,
  values: Record<string, unknown>,
  bands: FmppTariffBand[],
): PrivatePlace | null {
  if (text(values["FM Ready"]) !== FM_READY) return null;
  const id = cityLocationId(code, values["Location ID"]);
  const name = publishedText(values["Location Name"]);
  const provider = providerOf(values);
  const slug = provider ? fmppProviderSlug(provider) : undefined;
  const locationCode = locationCodeOf(values["Provider Location Code"]);
  if (!id || !name || !provider || !slug || !locationCode) return null;
  if (coordinateSkip(values.Latitude, values.Longitude)) return null;
  const lat = parseCoord(values.Latitude);
  const lng = parseCoord(values.Longitude);
  if (lat == null || lng == null) return null;
  const priced = simpleFee(bands, poundsToPence(values["Parking Charge (£)"]));
  const checkedAt = parseDate(values["Last Checked"]);
  const src = firstUrl(values["Source URL"]);
  const place: PrivatePlace = {
    id,
    n: name,
    p: [lat, lng],
    s: 1,
    q: "known",
    aud: "a",
    auto: true,
    payMode: "inapp",
    operator: provider,
    locationCode,
    locationProvider: slug,
  };
  if (text(values["Free Period (Y/N)"]).toUpperCase() === "Y") {
    assign(place, "free", parseMinutes(values["Free Minutes"]));
  }
  assign(place, "max", parseMaxStayMinutes(values["Max Stay"]));
  assign(place, "fee", priced?.fee);
  assign(place, "feeUnit", priced?.feeUnit);
  assign(place, "hours", publishedText(values["Hours of Operation"]));
  assign(place, "addr", formatAddr(publishedText(values["Street/Address"]), publishedText(values.Postcode)));
  assign(place, "src", src);
  const srcType: SrcType | undefined = src ? "official" : undefined;
  assign(place, "srcType", srcType);
  assign(place, "verifiedAt", checkedAt);
  const notes = text(values.Notes);
  if (/centroid|not a bay-accurate|area centre|area center/i.test(notes)) place.approx = true;
  return place;
}

export function buildFmppPlaces(
  source: FmppSource,
  locationMatrix: unknown[][],
  tariffMatrix: unknown[][],
): {ok: true; places: PrivatePlace[]} | {ok: false; reason: string} {
  const tariffs = indexTariffs(tariffMatrix);
  const places: PrivatePlace[] = [];
  const seen = new Set<string>();
  for (const row of rowsFromMatrix(locationMatrix)) {
    if (row.blank) continue;
    if (text(row.values["FM Ready"]) !== FM_READY) continue;
    const id = cityLocationId(source.code, row.values["Location ID"]);
    const bands = tariffs.get(text(row.values["Location ID"]).toUpperCase()) ?? [];
    const place = mapFmppPlace(source.code, row.values, bands);
    if (!place || !id) continue;
    if (seen.has(place.id)) return {ok: false, reason: `fmpp-duplicate-id:${source.code}`};
    seen.add(place.id);
    places.push(place);
  }
  places.sort((a, b) => a.id.localeCompare(b.id));
  return {ok: true, places};
}
