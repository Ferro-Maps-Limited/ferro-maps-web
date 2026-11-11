import {
  TPC_WATCHLIST_HISTORY,
  type CategoryForecastPatch,
} from "./categoryCommit.js";
import {forecastFromPool, type Forecast} from "./forecast.js";
import {type ParsedEvent} from "./parse.js";
import {assertNoPrices} from "./priceGuard.js";
import {parseSheetTime} from "./time.js";
import {GROUND_MIN, HARD_STOP_AFTER_FULL_TIME_MS, MIN_STRENGTH_UPLIFT} from "./thresholds.js";

/*
 * TPC Watchlist Readings, one row per check at a standing place.
 * The live tab uses the older Time (UK) / Phase / Pickup point headings.
 * The names from the first draft of this reader are aliases for the same
 * fields. A row is read only through that map. A blank row, or a row whose
 * cells do not sit in those columns, is counted and skipped. Columns are
 * not shifted to force a fit.
 *
 * Fare cells are read only to decide YES, NO, and a strength band.
 * Those figures stay in this file. Nothing here returns them.
 *
 * Readings group by Place ID. One Disruption ID at that place is one episode.
 * Baseline checks are the reference, not the result. During and Post are.
 * A row with no Disruption ID is not an episode.
 *
 * Place source "Hotspot Test Pins" matches a hotspots_test doc id exactly.
 * Place source "Fixed Places" matches fixedPlaceKey on exactly one doc.
 * The place name is never used. No match, or fewer than the ground minimum
 * of scored episodes, is no_prediction when a doc was matched, and nothing
 * at all when no doc was matched. A pin that already has a venue or station
 * forecast is left on that forecast.
 */

export const WATCHLIST_READING_ID = "Reading ID";
export const WATCHLIST_PLACE_ID = "Place ID";
export const WATCHLIST_PLACE_SOURCE = "Place source";
export const WATCHLIST_PLACE_NAME = "Place name";
export const WATCHLIST_CATEGORY = "Category";
export const WATCHLIST_LATITUDE = "Latitude";
export const WATCHLIST_LONGITUDE = "Longitude";
export const WATCHLIST_PICKUP = "Pickup point used";
export const WATCHLIST_READING_TYPE = "Reading type";
export const WATCHLIST_DISRUPTION_ID = "Disruption ID";
export const WATCHLIST_DISRUPTION_TYPE = "Disruption type";
export const WATCHLIST_DISRUPTION_DESCRIPTION = "Disruption description";
export const WATCHLIST_TAKEN_AT = "Taken at (UK time)";
export const WATCHLIST_UBER_PRODUCT = "Uber product";
export const WATCHLIST_PRICE_SHOWN = "Price shown (GBP)";
export const WATCHLIST_NORMAL_PRICE = "Normal price for this trip (GBP)";
export const WATCHLIST_SURGE_SHOWN = "Surge shown in app";
export const WATCHLIST_WAIT = "Pickup wait shown (min)";
export const WATCHLIST_HOW = "How it was taken";
export const WATCHLIST_NOTES = "Notes";

export const WATCHLIST_HEADERS = [
  WATCHLIST_READING_ID,
  WATCHLIST_PLACE_ID,
  WATCHLIST_PLACE_SOURCE,
  WATCHLIST_PLACE_NAME,
  WATCHLIST_CATEGORY,
  WATCHLIST_LATITUDE,
  WATCHLIST_LONGITUDE,
  WATCHLIST_PICKUP,
  WATCHLIST_READING_TYPE,
  WATCHLIST_DISRUPTION_ID,
  WATCHLIST_DISRUPTION_TYPE,
  WATCHLIST_DISRUPTION_DESCRIPTION,
  WATCHLIST_TAKEN_AT,
  WATCHLIST_UBER_PRODUCT,
  WATCHLIST_PRICE_SHOWN,
  WATCHLIST_NORMAL_PRICE,
  WATCHLIST_SURGE_SHOWN,
  WATCHLIST_WAIT,
  WATCHLIST_HOW,
  WATCHLIST_NOTES,
] as const;

/* Headings on the live TPC Watchlist Readings tab, read 2026-11-11. */
export const WATCHLIST_TIME_UK = "Time (UK)";
export const WATCHLIST_TIME_UTC = "Time (UTC)";
export const WATCHLIST_PHASE = "Phase (Baseline / During / Post)";
export const WATCHLIST_PICKUP_LIVE = "Pickup point";
export const WATCHLIST_FARE_SHOWN = "Fare shown (£)";
export const WATCHLIST_BASELINE_FARE = "Baseline fare (£)";
export const WATCHLIST_BUSY_SHOWN = "'Busy / fares higher' shown?";
export const WATCHLIST_DID_IT_SURGE = "Did it surge?";

export const LIVE_WATCHLIST_HEADERS = [
  WATCHLIST_TIME_UK,
  WATCHLIST_TIME_UTC,
  WATCHLIST_READING_ID,
  WATCHLIST_PLACE_ID,
  WATCHLIST_PLACE_SOURCE,
  WATCHLIST_PLACE_NAME,
  WATCHLIST_CATEGORY,
  WATCHLIST_PHASE,
  WATCHLIST_PICKUP_LIVE,
  WATCHLIST_LATITUDE,
  WATCHLIST_LONGITUDE,
  "Distance to ground (m)",
  "Destination",
  WATCHLIST_UBER_PRODUCT,
  WATCHLIST_FARE_SHOWN,
  "Pickup wait (min)",
  WATCHLIST_BUSY_SHOWN,
  WATCHLIST_BASELINE_FARE,
  "Uplift %",
  "Uplift (£)",
  "Back to baseline? (within 5%)",
  "Confidence %",
  WATCHLIST_DID_IT_SURGE,
  "Peak uplift % (so far)",
  WATCHLIST_DISRUPTION_ID,
  WATCHLIST_DISRUPTION_TYPE,
  WATCHLIST_DISRUPTION_DESCRIPTION,
  "Source (manual / browser)",
  "Screenshot link",
  "Other products shown",
  "H3 cell (res 8) - technical",
  "H3 cell (res 9) - technical",
  "Month",
  "Live Traffic (TomTom)",
  WATCHLIST_NOTES,
] as const;

const FIELD_HEADERS = {
  takenAt: [WATCHLIST_TIME_UK, WATCHLIST_TAKEN_AT],
  takenAtUtc: [WATCHLIST_TIME_UTC],
  placeId: [WATCHLIST_PLACE_ID],
  placeSource: [WATCHLIST_PLACE_SOURCE],
  readingType: [WATCHLIST_PHASE, "Phase (Baseline / Pre / During / Post)", WATCHLIST_READING_TYPE],
  disruptionId: [WATCHLIST_DISRUPTION_ID],
  priceShown: [WATCHLIST_FARE_SHOWN, WATCHLIST_PRICE_SHOWN],
  normalPrice: [WATCHLIST_BASELINE_FARE, WATCHLIST_NORMAL_PRICE],
  surgeShown: [WATCHLIST_BUSY_SHOWN, WATCHLIST_SURGE_SHOWN],
  didSurge: [WATCHLIST_DID_IT_SURGE],
  latitude: [WATCHLIST_LATITUDE],
  longitude: [WATCHLIST_LONGITUDE],
} as const;

export const HOTSPOT_TEST_PINS = "hotspot test pins";
export const FIXED_PLACES_SOURCE = "fixed places";
export const FIXED_PLACE_KEY = "fixedPlaceKey";

const SOURCE_TEXT = /[^a-z0-9]+/g;

type ReadingKind = "baseline" | "during" | "post";
type Surged = "yes" | "no";

interface WatchlistPin {
  id: string;
  data: Record<string, unknown>;
}

interface ScoredReading {
  surged: Surged;
  peak: number | null;
  timeMs: number;
}

interface Episode {
  outcome: Surged;
  peak: number | null;
  timeMs: number;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function sourceKind(value: unknown): "hotspot" | "fixed" | null {
  const key = text(value).toLowerCase().replace(SOURCE_TEXT, " ").trim();
  if (key === HOTSPOT_TEST_PINS) return "hotspot";
  if (key === FIXED_PLACES_SOURCE) return "fixed";
  return null;
}

function readingKind(value: unknown): ReadingKind | null {
  const key = text(value).toLowerCase();
  if (key === "baseline" || key === "during" || key === "post") return key;
  return null;
}

function money(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[£,\s]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/* Price over the normal price for this trip. Missing or unusable numbers are not a guess. */
function priceUplift(shown: unknown, normal: unknown): number | null {
  const price = money(shown);
  const base = money(normal);
  if (price == null || base == null || price < 0 || base <= 0) return null;
  const uplift = price / base - 1;
  if (!Number.isFinite(uplift)) return null;
  return uplift;
}

/*
 * What the app itself showed.
 * A trailing x is a multiplier (1.5x means half again).
 * A trailing % or a bare number of 10 or more is a percent.
 * A bare number from 1 up to 10 is a multiplier. Below 1 it is already a fraction.
 * YES and NO are explicit. A blank cell is not.
 */
function shownUplift(value: number): {explicit: Surged; uplift: number | null} {
  let uplift: number;
  if (value >= 10) uplift = value / 100;
  else if (value >= 1) uplift = value - 1;
  else uplift = value;
  if (!Number.isFinite(uplift) || uplift < 0) return {explicit: "no", uplift: null};
  if (uplift >= MIN_STRENGTH_UPLIFT) return {explicit: "yes", uplift};
  return {explicit: "no", uplift: null};
}

function parseSurgeShown(value: unknown): {explicit: Surged | null; uplift: number | null} {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return {explicit: null, uplift: null};
    return shownUplift(value);
  }
  if (typeof value !== "string") return {explicit: null, uplift: null};
  const trimmed = value.trim();
  if (!trimmed || /^n\/a/i.test(trimmed) || trimmed === "-") return {explicit: null, uplift: null};
  const lower = trimmed.toLowerCase();
  if (lower === "yes" || lower === "y" || lower === "true" || lower === "shown") {
    return {explicit: "yes", uplift: null};
  }
  if (lower === "no" || lower === "n" || lower === "false" || lower === "none") {
    return {explicit: "no", uplift: null};
  }
  if (lower === "low") return {explicit: "yes", uplift: MIN_STRENGTH_UPLIFT};
  if (lower === "medium") return {explicit: "yes", uplift: 0.4};
  if (lower === "high") return {explicit: "yes", uplift: 0.7};
  const multiplier = /^(\d+(?:\.\d+)?)\s*x$/i.exec(trimmed);
  if (multiplier) return shownUplift(Number(multiplier[1]));
  if (trimmed.endsWith("%")) {
    const numeric = Number(trimmed.slice(0, -1).replace(/,/g, "").trim());
    if (!Number.isFinite(numeric) || numeric < 0) return {explicit: null, uplift: null};
    const uplift = numeric / 100;
    if (uplift >= MIN_STRENGTH_UPLIFT) return {explicit: "yes", uplift};
    return {explicit: "no", uplift: null};
  }
  const numeric = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return {explicit: null, uplift: null};
  return shownUplift(numeric);
}

/*
 * An explicit NO stays NO. The price cannot overrule it.
 * An explicit YES stays YES. The price supplies the strength when it clears 20%.
 * A blank app cell is judged from the two prices. Under 20% is NO.
 */
function scoreReading(reading: AlignedReading): ScoredReading | null {
  const shown = parseSurgeShown(reading.surgeShown);
  const fromPrice = priceUplift(reading.priceShown, reading.normalPrice);
  if (reading.timeMs == null) return null;
  if (shown.explicit === "no") return {surged: "no", peak: null, timeMs: reading.timeMs};
  if (shown.explicit === "yes") {
    const pricePeak = fromPrice != null && fromPrice >= MIN_STRENGTH_UPLIFT ? fromPrice : null;
    const shownPeak = shown.uplift != null && shown.uplift >= MIN_STRENGTH_UPLIFT ? shown.uplift : null;
    return {surged: "yes", peak: pricePeak ?? shownPeak, timeMs: reading.timeMs};
  }
  if (fromPrice == null) return null;
  if (fromPrice >= MIN_STRENGTH_UPLIFT) return {surged: "yes", peak: fromPrice, timeMs: reading.timeMs};
  return {surged: "no", peak: null, timeMs: reading.timeMs};
}

function higher(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function episodesFor(rows: AlignedReading[], nowMs: number): Episode[] {
  const byDisruption = new Map<string, ScoredReading[]>();
  for (const reading of rows) {
    if (reading.phase !== "during" && reading.phase !== "post") continue;
    if (!reading.disruptionId || reading.timeMs == null || reading.timeMs >= nowMs) continue;
    const scored = scoreReading(reading);
    if (!scored) continue;
    const list = byDisruption.get(reading.disruptionId) ?? [];
    list.push(scored);
    byDisruption.set(reading.disruptionId, list);
  }
  const episodes: Episode[] = [];
  for (const readings of byDisruption.values()) {
    const yes = readings.filter((reading) => reading.surged === "yes");
    if (yes.length > 0) {
      const times = yes.map((reading) => reading.timeMs);
      episodes.push({
        outcome: "yes",
        peak: yes.reduce<number | null>((peak, reading) => higher(peak, reading.peak), null),
        timeMs: Math.min(...times),
      });
      continue;
    }
    if (readings.some((reading) => reading.surged === "no")) {
      episodes.push({
        outcome: "no",
        peak: null,
        timeMs: Math.min(...readings.map((reading) => reading.timeMs)),
      });
    }
  }
  return episodes;
}

function historyEvent(episode: Episode, index: number): ParsedEvent {
  return {
    sheetEventId: `watch-${index}`,
    competition: "",
    home: "",
    away: "",
    ground: "",
    category: "events",
    kickOffMs: episode.timeMs,
    startTimeSource: "sheet_exact",
    fullTimeMs: null,
    surgeStartMs: null,
    surgeEndMs: null,
    hardStopMs: null,
    outcome: episode.outcome,
    peakUplift: episode.peak,
    predictedConfidencePercent: null,
    pickups: [],
  };
}

function standingTarget(nowMs: number): ParsedEvent {
  const end = nowMs + HARD_STOP_AFTER_FULL_TIME_MS;
  return {
    sheetEventId: "place",
    competition: "",
    home: "",
    away: "",
    ground: "",
    category: "events",
    kickOffMs: nowMs,
    startTimeSource: "sheet_exact",
    fullTimeMs: nowMs,
    surgeStartMs: nowMs,
    surgeEndMs: end,
    hardStopMs: end,
    outcome: "pending",
    peakUplift: null,
    predictedConfidencePercent: null,
    pickups: [],
  };
}

function forecastForEpisodes(episodes: Episode[], nowMs: number): Forecast {
  const pool = episodes.length >= GROUND_MIN ? episodes.map(historyEvent) : null;
  return forecastFromPool(standingTarget(nowMs), pool);
}

function fixedKey(pin: WatchlistPin): string | null {
  const value = pin.data[FIXED_PLACE_KEY];
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key ? key : null;
}

function writableId(id: string): boolean {
  return Boolean(id) && !id.startsWith("sheet_") && !id.includes("/");
}

interface AlignedReading {
  placeId: string;
  source: "hotspot" | "fixed";
  phase: ReadingKind;
  disruptionId: string;
  timeMs: number | null;
  priceShown: unknown;
  normalPrice: unknown;
  surgeShown: unknown;
}

interface PlaceGroup {
  kind: "hotspot" | "fixed";
  placeId: string;
  rows: AlignedReading[];
}

function headerCells(row: unknown[]): string[] {
  return row.map((cell) => text(cell));
}

function columnsByName(header: string[]): Map<string, number[]> {
  const columns = new Map<string, number[]>();
  header.forEach((name, index) => {
    if (!name) return;
    const list = columns.get(name) ?? [];
    list.push(index);
    columns.set(name, list);
  });
  return columns;
}

function presentCells(row: unknown[], columns: Map<string, number[]>, names: readonly string[]): unknown[] {
  const found: unknown[] = [];
  for (const name of names) {
    for (const index of columns.get(name) ?? []) {
      const value = row[index];
      if (value == null || value === "") continue;
      if (typeof value === "string" && value.trim() === "") continue;
      found.push(value);
    }
  }
  return found;
}

function rowIsBlank(row: unknown[]): boolean {
  return row.every((cell) => cell == null || cell === "" || (typeof cell === "string" && cell.trim() === ""));
}

function sameText(values: unknown[]): boolean {
  const labels = values.map((value) => text(value));
  return labels.every((label) => label === labels[0]);
}

function clockMs(values: unknown[], zone: "uk" | "utc"): number | null | "bad" {
  if (values.length === 0) return null;
  if (!sameText(values)) return "bad";
  const parsed = parseSheetTime(values[0], zone);
  return parsed == null ? "bad" : parsed;
}

function coordinate(values: unknown[], limit: number): number | null | "bad" {
  if (values.length === 0) return null;
  if (!sameText(values)) return "bad";
  const numeric = typeof values[0] === "number" ? values[0] : Number(text(values[0]));
  if (!Number.isFinite(numeric) || numeric < -limit || numeric > limit) return "bad";
  return numeric;
}

function yesNoCell(values: unknown[]): "yes" | "no" | "" | "bad" {
  if (values.length === 0) return "";
  if (!sameText(values)) return "bad";
  const label = text(values[0]).toLowerCase();
  if (!label) return "";
  if (label === "yes" || label === "y") return "yes";
  if (label === "no" || label === "n") return "no";
  return "bad";
}

/*
 * One value per field. Two headings for the same field must agree.
 * A time that is not a time, a phase that is not a phase, or a coordinate
 * that is not a coordinate means the row was written in the wrong columns.
 */
function alignRow(row: unknown[], columns: Map<string, number[]>): AlignedReading | "misaligned" {
  const takenAt = clockMs(presentCells(row, columns, FIELD_HEADERS.takenAt), "uk");
  const takenAtUtc = clockMs(presentCells(row, columns, FIELD_HEADERS.takenAtUtc), "utc");
  if (takenAt === "bad" || takenAtUtc === "bad") return "misaligned";
  if (takenAt != null && takenAtUtc != null && takenAt !== takenAtUtc) return "misaligned";
  const timeMs = takenAt ?? takenAtUtc;
  const placeIds = presentCells(row, columns, FIELD_HEADERS.placeId);
  const sources = presentCells(row, columns, FIELD_HEADERS.placeSource);
  const phases = presentCells(row, columns, FIELD_HEADERS.readingType);
  const disruptions = presentCells(row, columns, FIELD_HEADERS.disruptionId);
  const prices = presentCells(row, columns, FIELD_HEADERS.priceShown);
  const normals = presentCells(row, columns, FIELD_HEADERS.normalPrice);
  const surges = presentCells(row, columns, FIELD_HEADERS.surgeShown);
  const marked = yesNoCell(presentCells(row, columns, FIELD_HEADERS.didSurge));
  const latitude = coordinate(presentCells(row, columns, FIELD_HEADERS.latitude), 90);
  const longitude = coordinate(presentCells(row, columns, FIELD_HEADERS.longitude), 180);
  if (!sameText(placeIds) || !sameText(sources) || !sameText(phases) || !sameText(disruptions)) {
    return "misaligned";
  }
  if (!sameText(prices) || !sameText(normals) || !sameText(surges)) return "misaligned";
  if (marked === "bad" || latitude === "bad" || longitude === "bad") return "misaligned";
  if ((latitude == null) !== (longitude == null)) return "misaligned";
  const placeId = text(placeIds[0]);
  const source = sourceKind(sources[0]);
  const phase = readingKind(phases[0]);
  if (!placeId || !source || !phase || timeMs == null) return "misaligned";
  if (surges.length > 0 && !surgeCellRecognized(surges[0])) return "misaligned";
  if (marked !== "" && surges.length > 0) {
    const fromApp = parseSurgeShown(surges[0]);
    if (fromApp.explicit && fromApp.explicit !== marked) return "misaligned";
  }
  let surgeShown: unknown = surges[0] ?? "";
  if (marked === "yes" && surges.length === 0) surgeShown = "YES";
  if (marked === "no") surgeShown = "NO";
  return {
    placeId,
    source,
    phase,
    disruptionId: text(disruptions[0]),
    timeMs,
    priceShown: prices[0],
    normalPrice: normals[0],
    surgeShown,
  };
}

function surgeCellRecognized(value: unknown): boolean {
  if (value == null || value === "") return true;
  if (typeof value === "number" && Number.isFinite(value)) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (["yes", "y", "true", "shown", "no", "n", "false", "none", "low", "medium", "high"].includes(lower)) {
    return true;
  }
  if (/^(\d+(?:\.\d+)?)\s*x$/i.test(trimmed)) return true;
  if (trimmed.endsWith("%")) return Number.isFinite(Number(trimmed.slice(0, -1).replace(/,/g, "")));
  return Number.isFinite(Number(trimmed.replace(/,/g, "")));
}

function readWatchlist(matrix: unknown[][]): {groups: PlaceGroup[]; blank: number; misaligned: number} {
  const header = headerCells(matrix[0] ?? []);
  const columns = columnsByName(header);
  const groups = new Map<string, PlaceGroup>();
  let blank = 0;
  let misaligned = 0;
  for (let index = 1; index < matrix.length; index += 1) {
    const row = matrix[index] ?? [];
    if (rowIsBlank(row)) {
      blank += 1;
      continue;
    }
    const aligned = alignRow(row, columns);
    if (aligned === "misaligned") {
      misaligned += 1;
      continue;
    }
    const mapKey = `${aligned.source}\n${aligned.placeId}`;
    const existing = groups.get(mapKey);
    if (existing) {
      existing.rows.push(aligned);
      continue;
    }
    groups.set(mapKey, {kind: aligned.source, placeId: aligned.placeId, rows: [aligned]});
  }
  return {groups: [...groups.values()], blank, misaligned};
}

function matchIds(group: PlaceGroup, pins: WatchlistPin[]): string[] {
  if (group.kind === "hotspot") {
    return pins.filter((pin) => pin.id === group.placeId).map((pin) => pin.id);
  }
  return pins.filter((pin) => fixedKey(pin) === group.placeId).map((pin) => pin.id);
}

function patch(id: string, forecast: Forecast, updatedAt: string): CategoryForecastPatch {
  const result: CategoryForecastPatch = {
    id,
    forecast,
    forecastSource: TPC_WATCHLIST_HISTORY,
    updatedAt,
  };
  assertNoPrices(result);
  return result;
}

function sameForecast(left: Forecast, right: Forecast): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/*
 * One patch per matched doc. Two place groups that land on the same doc and
 * disagree are no_prediction. A doc already forecast from venue or station
 * history is not in the result.
 */
export function watchlistForecastPatches(input: {
  now: Date;
  rows: unknown[][];
  pins: WatchlistPin[];
  claimedIds: ReadonlySet<string>;
}): {patches: CategoryForecastPatch[]; blank: number; misaligned: number} {
  const nowMs = input.now.getTime();
  const updatedAt = input.now.toISOString();
  const byId = new Map<string, CategoryForecastPatch>();
  const conflicted = new Set<string>();
  const read = readWatchlist(input.rows);
  for (const group of read.groups) {
    const ids = matchIds(group, input.pins).filter((id) => writableId(id) && !input.claimedIds.has(id));
    if (ids.length !== 1) continue;
    const id = ids[0];
    const forecast = forecastForEpisodes(episodesFor(group.rows, nowMs), nowMs);
    const next = patch(id, forecast, updatedAt);
    const prior = byId.get(id);
    if (prior && !sameForecast(prior.forecast, next.forecast)) {
      conflicted.add(id);
      continue;
    }
    byId.set(id, next);
  }
  for (const id of conflicted) {
    byId.set(id, patch(id, {state: "no_prediction"}, updatedAt));
  }
  return {patches: [...byId.values()], blank: read.blank, misaligned: read.misaligned};
}
