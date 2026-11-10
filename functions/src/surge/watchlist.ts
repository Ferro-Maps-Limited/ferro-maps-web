import {rowsFromMatrix} from "../parking/privateSheet/rows.js";
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
 * Header row copied from the Ferro SURGE sheet, columns A to T.
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
function scoreReading(values: Record<string, unknown>, timeMs: number): ScoredReading | null {
  const shown = parseSurgeShown(values[WATCHLIST_SURGE_SHOWN]);
  const fromPrice = priceUplift(values[WATCHLIST_PRICE_SHOWN], values[WATCHLIST_NORMAL_PRICE]);
  if (shown.explicit === "no") return {surged: "no", peak: null, timeMs};
  if (shown.explicit === "yes") {
    const pricePeak = fromPrice != null && fromPrice >= MIN_STRENGTH_UPLIFT ? fromPrice : null;
    const shownPeak = shown.uplift != null && shown.uplift >= MIN_STRENGTH_UPLIFT ? shown.uplift : null;
    return {surged: "yes", peak: pricePeak ?? shownPeak, timeMs};
  }
  if (fromPrice == null) return null;
  if (fromPrice >= MIN_STRENGTH_UPLIFT) return {surged: "yes", peak: fromPrice, timeMs};
  return {surged: "no", peak: null, timeMs};
}

function higher(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function episodesFor(rows: Record<string, unknown>[], nowMs: number): Episode[] {
  const byDisruption = new Map<string, ScoredReading[]>();
  for (const values of rows) {
    const kind = readingKind(values[WATCHLIST_READING_TYPE]);
    if (kind !== "during" && kind !== "post") continue;
    const disruptionId = text(values[WATCHLIST_DISRUPTION_ID]);
    const timeMs = parseSheetTime(values[WATCHLIST_TAKEN_AT], "uk");
    if (!disruptionId || timeMs == null || timeMs >= nowMs) continue;
    const scored = scoreReading(values, timeMs);
    if (!scored) continue;
    const list = byDisruption.get(disruptionId) ?? [];
    list.push(scored);
    byDisruption.set(disruptionId, list);
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

interface PlaceGroup {
  kind: "hotspot" | "fixed";
  placeId: string;
  rows: Record<string, unknown>[];
}

function groupPlaces(matrix: unknown[][]): PlaceGroup[] {
  const groups = new Map<string, PlaceGroup>();
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const kind = sourceKind(row.values[WATCHLIST_PLACE_SOURCE]);
    const placeId = text(row.values[WATCHLIST_PLACE_ID]);
    if (!kind || !placeId) continue;
    const mapKey = `${kind}\n${placeId}`;
    const existing = groups.get(mapKey);
    if (existing) {
      existing.rows.push(row.values);
      continue;
    }
    groups.set(mapKey, {kind, placeId, rows: [row.values]});
  }
  return [...groups.values()];
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
}): CategoryForecastPatch[] {
  const nowMs = input.now.getTime();
  const updatedAt = input.now.toISOString();
  const byId = new Map<string, CategoryForecastPatch>();
  const conflicted = new Set<string>();
  for (const group of groupPlaces(input.rows)) {
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
  return [...byId.values()];
}
