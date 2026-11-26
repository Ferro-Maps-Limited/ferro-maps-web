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
import {type FeeUnit, type PrivatePlace, type SourceRow} from "./types.js";

/*
 * FM-PP city workbooks (Locations - <City> and Tariffs - <City>).
 * London's live feed stays ALL LONDON (clean). A city is published only when
 * FM Ready is ✅. Place ids are the workbook Location ID (FERRO-BHM-…).
 * London places stay on their sha256 id. PP-###### is reserved for London
 * and is never accepted from a city sheet.
 */

/* 44 columns, A–AR. The blank at AF is the spacer after Notes. */
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

/* 9 columns, A–I. London's tab is named Tariffs; later cities use Tariffs - <City>. */
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

export const MAX_FMPP_SOURCES = 32;

const CITY_CODE = /^[A-Z0-9]{2,8}$/;
const SHEET_ID = /^[a-zA-Z0-9_-]{15,128}$/;
const FMPP_ID = /^FERRO-([A-Z0-9]{2,8})-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const LONDON_PP_ID = /^PP-\d{1,12}$/;
const LONDON_HASH_ID = /^[0-9a-f]{64}$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export interface FmppSource {
  code: string;
  city: string;
  sheetId: string;
  locationsTab: string;
  tariffsTab: string;
}

export type FmppConfig =
  | {ok: true; sources: FmppSource[]}
  | {ok: false; reason: "fmpp-config-invalid"; detail: string};

export type PlaceOwner =
  | {kind: "london"}
  | {kind: "fmpp"; code: string};

export interface FmppTariffBand {
  locationId: string;
  duration: string;
  pricePence: number | null;
  confidence: string;
}

export interface FmppMapped {
  places: PrivatePlace[];
  readyRows: number;
  skipped: Record<string, number>;
}

/* FERRO-<CODE>-… is a city place. PP-###### and the 64-hex London hash are London. */
export function placeOwner(id: string): PlaceOwner | null {
  const fmpp = FMPP_ID.exec(id);
  if (fmpp) return {kind: "fmpp", code: fmpp[1]};
  if (LONDON_PP_ID.test(id) || LONDON_HASH_ID.test(id)) return {kind: "london"};
  return null;
}

function invalid(detail: string): FmppConfig {
  return {ok: false, reason: "fmpp-config-invalid", detail};
}

function cleanTab(value: string): string | null {
  const tab = value.trim();
  if (!tab || tab.length > 80) return null;
  if (/[\r\n\t]/.test(tab)) return null;
  return tab;
}

function defaultLocationsTab(city: string): string {
  return `Locations - ${city}`;
}

/* The London master keeps the legacy tab name Tariffs. Later cities use Tariffs - <City>. */
function defaultTariffsTab(city: string): string {
  if (city.toLowerCase() === "london") return "Tariffs";
  return `Tariffs - ${city}`;
}

/*
 * PRIVATE_PARKING_FMPP_SOURCES. Empty means no city workbooks.
 * Segments are separated by `;` or a newline. Each segment is
 * `CODE|City name|spreadsheetId` or those three fields plus `|Locations tab|Tariffs tab`.
 * Omitted tabs become `Locations - {City}` and `Tariffs - {City}`.
 */
export function parseFmppSources(raw: string): FmppConfig {
  const textValue = raw.trim();
  if (!textValue) return {ok: true, sources: []};
  const chunks = textValue.split(/[;\n]+/).map((part) => part.trim()).filter((part) => part !== "");
  if (chunks.length > MAX_FMPP_SOURCES) return invalid("too many cities");
  const sources: FmppSource[] = [];
  const codes = new Set<string>();
  const sheets = new Set<string>();
  for (const chunk of chunks) {
    const parts = chunk.split("|").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 5) return invalid("each city needs 3 or 5 fields");
    const code = parts[0].toUpperCase();
    const city = parts[1];
    const sheetId = parts[2];
    if (!CITY_CODE.test(code)) return invalid("city code must be 2 to 8 letters or digits");
    if (!city || city.length > 40 || /[|;]/.test(city)) return invalid("city name is missing");
    if (!SHEET_ID.test(sheetId)) return invalid("spreadsheet id is not usable");
    const locationsTab = parts.length === 5 ? cleanTab(parts[3]) : defaultLocationsTab(city);
    const tariffsTab = parts.length === 5 ? cleanTab(parts[4]) : defaultTariffsTab(city);
    if (!locationsTab || !tariffsTab) return invalid("tab name is missing");
    if (codes.has(code)) return invalid(`duplicate code ${code}`);
    if (sheets.has(sheetId)) return invalid("duplicate spreadsheet");
    codes.add(code);
    sheets.add(sheetId);
    sources.push({code, city, sheetId, locationsTab, tariffsTab});
  }
  return {ok: true, sources};
}

export function readFmppCountMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const counts: Record<string, number> = {};
  for (const [code, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count)) counts[code] = count;
  }
  return counts;
}

function headerCell(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function fmppHeaderProblem(
  matrix: unknown[][],
  kind: "locations" | "tariffs",
): "header-missing" | "header-unexpected" | null {
  const expected = kind === "locations" ? FMPP_LOCATION_HEADERS : FMPP_TARIFF_HEADERS;
  const headerRow = matrix[0];
  if (!headerRow || headerRow.length === 0) return "header-missing";
  const names = headerRow.map(headerCell);
  while (names.length > expected.length && names[names.length - 1] === "") names.pop();
  if (names.every((name) => name === "")) return "header-missing";
  if (names.length !== expected.length) return "header-unexpected";
  for (let index = 0; index < expected.length; index += 1) {
    if (names[index] !== expected[index]) return "header-unexpected";
  }
  return null;
}

/* The sheet's AR formula writes ✅ or blank. A hand-typed Yes is not FM Ready. */
export function isFmReadyTick(value: unknown): boolean {
  return typeof value === "string" && value.trim().replace(/\uFE0F/g, "") === "✅";
}

function publishedText(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || /^not published\b/i.test(raw)) return undefined;
  return raw;
}

const LONG_MONTH = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/;

function parseFmppDate(value: unknown): string | undefined {
  const parsed = parseDate(value);
  if (parsed) return parsed;
  if (typeof value !== "string") return undefined;
  const match = LONG_MONTH.exec(value.trim());
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
  if (month < 0) return undefined;
  const iso = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return parseDate(iso);
}

/* A plain duration only. "not published (…)" and prose stay omitted. */
export function parseMaxStayMinutes(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw || /\bnot published\b/i.test(raw)) return undefined;
  const match = /^(\d+)\s*(hours?|hrs?|minutes?|mins?)$/i.exec(raw);
  if (!match) return undefined;
  const count = Number(match[1]);
  const minutes = match[2].toLowerCase().startsWith("h") ? count * 60 : count;
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 100000) return undefined;
  return minutes;
}

export function providerSlug(value: string): string {
  const folded = value.toLowerCase();
  if (folded.includes("paybyphone") || folded.includes("pay by phone") || folded.includes("pay-by-phone")) {
    return "paybyphone";
  }
  if (folded.includes("ringgo") || folded.includes("ring go")) return "ringgo";
  if (folded.includes("justpark") || folded.includes("just park")) return "justpark";
  if (folded.includes("euro car parks") || /\becp\b/.test(folded)) return "eurocarparks";
  if (folded.includes("apcoa")) return "apcoa";
  if (folded.includes("q-park") || folded.includes("qpark")) return "qpark";
  if (folded.includes("parkbee")) return "parkbee";
  if (folded.includes("mpermit") || folded.includes("mi permit")) return "mpermit";
  if (folded.startsWith("ncp") || /\bncp\b/.test(folded)) return "ncp";
  return folded.replace(/[^a-z0-9]/g, "").slice(0, 32);
}

function usableConfidence(value: string): boolean {
  const folded = value.trim().toLowerCase();
  return folded === "verified" || folded === "partial";
}

function confidenceScore(value: unknown): number | undefined {
  const folded = text(value).toLowerCase();
  if (folded === "verified") return 1;
  if (folded === "partial") return 0.6;
  return undefined;
}

/* One repeating hour. "up to 1 hour" and "every 2 hours" are not that rate. */
function hourlyRatePence(duration: string, pricePence: number): number | null {
  if (pricePence <= 0) return null;
  const folded = duration.trim().toLowerCase();
  if (/\bup to\b/.test(folded)) return null;
  const match = /\b(?:for every|per|each|every)\s+(?:(\d+)\s+)?hours?\b/.exec(folded);
  if (!match) return null;
  const count = match[1] == null ? 1 : Number(match[1]);
  if (count !== 1) return null;
  return pricePence;
}

function singleDayPence(duration: string, pricePence: number): number | null {
  if (pricePence <= 0) return null;
  const folded = duration.trim().toLowerCase();
  if (/\bup to\b/.test(folded)) return null;
  if (/\b(?:for every|per|each|every)\s+(?:24\s*hours?|1\s*day|day)\b/.test(folded)) return pricePence;
  if (/^(?:24\s*hours?|1\s*day)$/.test(folded)) return pricePence;
  if (/^24\s*hours?\s*\/\s*1\s*day$/.test(folded)) return pricePence;
  return null;
}

function singleVisitPence(duration: string, pricePence: number): number | null {
  if (pricePence <= 0) return null;
  const folded = duration.trim().toLowerCase();
  if (/\b(?:for every|per|each|every)\s+(?:visit|stay)\b/.test(folded)) return pricePence;
  return null;
}

/*
 * Fee is set only when every paid band is the same per-hour rate, or the only
 * paid band is one day or one visit. Stepped "up to N hours" totals are omitted
 * so the app does not charge a made-up hourly price.
 */
export function tariffFee(bands: FmppTariffBand[]): {fee?: number; feeUnit?: FeeUnit} {
  const paid = bands.filter((band) => {
    return band.pricePence != null && band.pricePence > 0 && usableConfidence(band.confidence);
  });
  if (paid.length === 0) return {};
  const hourly = paid.map((band) => hourlyRatePence(band.duration, band.pricePence ?? 0));
  const rate = hourly[0];
  if (rate != null && hourly.every((item) => item === rate)) {
    return {fee: rate, feeUnit: "hour"};
  }
  if (paid.length !== 1) return {};
  const only = paid[0];
  const price = only.pricePence ?? 0;
  if (hourlyRatePence(only.duration, price) != null) return {};
  const day = singleDayPence(only.duration, price);
  if (day != null) return {fee: day, feeUnit: "day"};
  const visit = singleVisitPence(only.duration, price);
  if (visit != null) return {fee: visit, feeUnit: "visit"};
  return {};
}

export function indexFmppTariffs(rows: SourceRow[]): Map<string, FmppTariffBand[]> {
  const byId = new Map<string, FmppTariffBand[]>();
  for (const row of rows) {
    if (row.blank) continue;
    const locationId = text(row.values["Location ID"]).toUpperCase();
    if (!locationId) continue;
    const band: FmppTariffBand = {
      locationId,
      duration: text(row.values["Duration / Band"]),
      pricePence: poundsToPence(row.values["Price (£)"]) ?? null,
      confidence: text(row.values.Confidence),
    };
    const list = byId.get(locationId) ?? [];
    list.push(band);
    byId.set(locationId, list);
  }
  return byId;
}

function cityPlaceId(code: string, value: unknown): string | null {
  const id = text(value).toUpperCase();
  const owner = placeOwner(id);
  if (!owner || owner.kind !== "fmpp" || owner.code !== code) return null;
  return id;
}

function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

function mapReadyRow(
  values: Record<string, unknown>,
  code: string,
  bands: FmppTariffBand[],
): {place: PrivatePlace} | {skip: string} {
  const id = cityPlaceId(code, values["Location ID"]);
  if (!id) return {skip: "bad_id"};
  const name = publishedText(values["Location Name"]);
  if (!name) return {skip: "missing_name"};
  if (coordinateSkip(values.Latitude, values.Longitude)) return {skip: "bad_coordinates"};
  const lat = parseCoord(values.Latitude);
  const lng = parseCoord(values.Longitude);
  if (lat == null || lng == null) return {skip: "bad_coordinates"};
  const providerName = publishedText(values["Primary Provider"]) ?? publishedText(values.Provider);
  const operator = providerName ? mapOperator(providerName) : undefined;
  const slug = providerName ? providerSlug(providerName) : "";
  if (!operator || !slug) return {skip: "missing_provider"};
  const locationCode = publishedText(values["Provider Location Code"]);
  if (!locationCode || locationCode.length > 64) return {skip: "missing_code"};
  if (!isFmReadyTick(values["Ferro Autopay"])) return {skip: "not_autopay"};
  const place: PrivatePlace = {
    id,
    n: name,
    p: [lat, lng],
    s: 1,
    q: "known",
    aud: "a",
    auto: true,
    payMode: "inapp",
    operator,
    srcType: "official",
    locationCode,
    locationProvider: slug,
  };
  const conf = confidenceScore(values["Tariff Confidence"]);
  if (conf !== undefined) place.conf = conf;
  if (text(values["Free Period (Y/N)"]).toUpperCase() === "Y") {
    const free = parseMinutes(values["Free Minutes"]);
    if (free != null && free > 0) place.free = free;
  }
  const max = parseMaxStayMinutes(values["Max Stay"]);
  if (max !== undefined) place.max = max;
  const priced = tariffFee(bands);
  if (priced.fee !== undefined) place.fee = priced.fee;
  if (priced.feeUnit !== undefined) place.feeUnit = priced.feeUnit;
  const src = firstUrl(values["Source URL"]);
  if (src) place.src = src;
  const checked = parseFmppDate(values["Last Checked"]);
  if (checked) {
    place.capturedAt = checked;
    place.verifiedAt = checked;
  }
  const hours = publishedText(values["Hours of Operation"]);
  if (hours) place.hours = hours;
  const addr = formatAddr(publishedText(values["Street/Address"]), publishedText(values.Postcode));
  if (addr) place.addr = addr;
  return {place};
}

/* FM Ready rows only. The first row wins when a Location ID is repeated. */
export function mapFmppLocations(
  rows: SourceRow[],
  tariffs: Map<string, FmppTariffBand[]>,
  code: string,
): FmppMapped {
  const cityCode = code.trim().toUpperCase();
  const skipped: Record<string, number> = {};
  const places: PrivatePlace[] = [];
  const seen = new Set<string>();
  let readyRows = 0;
  for (const row of rows) {
    if (row.blank) continue;
    if (!isFmReadyTick(row.values["FM Ready"])) continue;
    readyRows += 1;
    const bands = tariffs.get(text(row.values["Location ID"]).toUpperCase()) ?? [];
    const mapped = mapReadyRow(row.values, cityCode, bands);
    if ("skip" in mapped) {
      bump(skipped, mapped.skip);
      continue;
    }
    if (seen.has(mapped.place.id)) {
      bump(skipped, "duplicate_id");
      continue;
    }
    seen.add(mapped.place.id);
    places.push(mapped.place);
  }
  return {places, readyRows, skipped};
}

export function fmppPlacesFromMatrices(
  locations: unknown[][],
  tariffs: unknown[][],
  code: string,
): FmppMapped {
  return mapFmppLocations(rowsFromMatrix(locations), indexFmppTariffs(rowsFromMatrix(tariffs)), code);
}
