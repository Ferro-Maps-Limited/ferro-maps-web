import {rowsFromMatrix} from "../parking/privateSheet/rows.js";
import {
  AWAY_TEAM,
  BACK_TO_BASELINE,
  BASELINE_FARE,
  COMPETITION,
  DID_IT_SURGE,
  EVENT_ID,
  EXPECTED_FULL_TIME,
  FARE_SHOWN,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  LATITUDE,
  LONGITUDE,
  PEAK_UPLIFT,
  PHASE,
  PICKUP_POINT,
  PICKUP_POINTS,
  PREDICTED_SURGE_CONFIDENCE,
  SURGE_END,
  SURGE_START,
  TIME_UK,
  TIME_UTC,
} from "./headers.js";
import {resolveKickoff, type StartTimeSource} from "./kickoff.js";
import {parseSheetTime} from "./time.js";

export type Outcome = "yes" | "no" | "pending";
export type Phase = "baseline" | "pre" | "during" | "post" | "";

export interface PickupCoord {
  name: string;
  lat: number;
  lng: number;
}

export const DEFAULT_CATEGORY = "event";

const CATEGORY_HEADERS = ["Venue type", "Category", "Venue category", "Type"];

/* Plurals of the phone categories only. The sheet's own word is kept otherwise. */
const CATEGORY_ALIASES: Record<string, string> = {
  event: "event",
  events: "event",
  sport: "sport",
  sports: "sport",
  hospital: "hospital",
  hospitals: "hospital",
  university: "university",
  universities: "university",
  pub: "pub",
  pubs: "pub",
  shopping: "shopping",
  hotel: "hotel",
  hotels: "hotel",
  nightclub: "nightclub",
  nightclubs: "nightclub",
  station: "station",
  stations: "station",
};

/* One Events-tab row. Peak uplift stays here so a strength band can be chosen, then it is dropped. */
export interface ParsedEvent {
  sheetEventId: string;
  competition: string;
  home: string;
  away: string;
  ground: string;
  category: string;
  kickOffMs: number;
  startTimeSource: StartTimeSource;
  fullTimeMs: number | null;
  surgeStartMs: number | null;
  surgeEndMs: number | null;
  hardStopMs: number | null;
  outcome: Outcome;
  peakUplift: number | null;
  /* Whole number from the Events-tab confidence cell, or null when that cell cannot be used. */
  predictedConfidencePercent: number | null;
  pickups: PickupCoord[];
}

/* A price check with the fare already reduced to a yes/no stop flag. */
export interface ParsedReading {
  eventId: string;
  timeMs: number;
  pickupName: string;
  /* Readings col F/G. Null when either cell is blank or not a usable coordinate. */
  lat: number | null;
  lng: number | null;
  phase: Phase;
  backToBaseline: boolean | null;
  order: number;
}

export interface ParsedSheet {
  events: ParsedEvent[];
  readings: ParsedReading[];
  skipped: number;
  rejected: number;
}

/*
 * Two coordinate formats are accepted in one Events cell chunk:
 *   "Name | 53.4408,-2.9812"     and     "Name (53.4295,-2.9920)"
 * Anything after the coordinates ("| Real: …", "(approx.)") is ignored.
 * A number must end where it ends, so "53.44,-2.98x" or "53.44,-2.98.1" is refused.
 */
const NUMBER = String.raw`(-?\d+(?:\.\d+)?)(?![\d.])`;
const PIPE_POINT = new RegExp(String.raw`^(.+?)\s*\|\s*` + NUMBER + String.raw`\s*,\s*` + NUMBER + String.raw`(?:\s*$|\s*[|(].*$|\s+.*$)`);
const PAREN_POINT = new RegExp(String.raw`^(.+?)\s*\(\s*` + NUMBER + String.raw`\s*,\s*` + NUMBER + String.raw`\s*\)(?:.*)$`);

/* "1) ", "12) " in front of a pickup name. Always a list number, never part of the name. */
const NUMBER_LABEL = /^\s*\d{1,2}\)\s+/;
/*
 * "E2 ", "P3 " in front of a pickup name. A single letter and digits is also
 * how UK roads start ("A6 Stockport Road", "M60 J24"), so this label is only
 * removed when the same cell numbers at least two pickups with the same letter.
 */
const LETTER_LABEL = /^\s*([A-Za-z])(\d{1,2})\s+(?=\S)/;

/* The pickup name with a leading list number removed. Used for matching and display. */
export function stripPickupNumber(name: string): string {
  return name.replace(NUMBER_LABEL, "").trim();
}

/* UK road classes. "A6 ", "B12 ", "M60 " in front of a name is a road number, not a label. */
const ROAD_LETTERS = new Set(["A", "B", "M"]);

/*
 * Matching key for a pickup name, on either tab. The list number is removed,
 * and so is a letter label ("E2 Sandhills station" matches "Sandhills station"),
 * except a road number ("A6 Stockport Road" stays "a6 stockport road").
 * Readings have no cell to compare labels against, so this is the only rule there.
 */
export function pickupKey(name: string): string {
  let cleaned = stripPickupNumber(name);
  const match = LETTER_LABEL.exec(cleaned);
  if (match && !ROAD_LETTERS.has(match[1].toUpperCase())) cleaned = cleaned.slice(match[0].length);
  return normLabel(cleaned);
}

function letterLabels(names: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const match = LETTER_LABEL.exec(stripPickupNumber(name));
    if (!match) continue;
    const letter = match[1].toUpperCase();
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= 2).map(([letter]) => letter));
}

function cleanPickupName(raw: string, labelled: Set<string>): string {
  let name = stripPickupNumber(raw);
  const match = LETTER_LABEL.exec(name);
  if (match && labelled.has(match[1].toUpperCase())) name = name.slice(match[0].length).trim();
  return name;
}

export function pickupChunks(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(/\r?\n|;|\s\|\|\s/).map((chunk) => chunk.trim()).filter(Boolean);
}

/*
 * The name is the text just before the coordinates. A note in front of it
 * ("Owner bot to set pickups … | Real: P1 Arena Way (54.9,-1.6)") is dropped:
 * only the part after the last "|" is kept, without a one-word "Real:" style tag.
 */
function nameBeforeCoords(value: string): string {
  const lastBar = value.lastIndexOf("|");
  const tail = lastBar >= 0 ? value.slice(lastBar + 1) : value;
  return tail.replace(/^\s*[A-Za-z]+:\s*/, "").trim();
}

/* One chunk to raw name and coordinates, or null when it is not a pickup. */
export function matchPickupChunk(chunk: string): {raw: string; lat: number; lng: number} | null {
  const match = PIPE_POINT.exec(chunk) ?? PAREN_POINT.exec(chunk);
  if (!match) return null;
  const raw = nameBeforeCoords(match[1]);
  if (!raw) return null;
  return {raw, lat: Number(match[2]), lng: Number(match[3])};
}

export function normLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function stadiumDocId(sheetEventId: string): string | null {
  const cleaned = sheetEventId.trim().toUpperCase();
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(cleaned)) return null;
  if (cleaned.length > 80) return null;
  return `sheet_${cleaned}`;
}

export function sheetEventKey(sheetEventId: string): string | null {
  const docId = stadiumDocId(sheetEventId);
  return docId ? docId.slice("sheet_".length) : null;
}

export function parsePickupPoints(value: unknown): PickupCoord[] {
  const matches = pickupChunks(value).map(matchPickupChunk);
  const labelled = letterLabels(matches.flatMap((match) => match ? [match.raw] : []));
  const points: PickupCoord[] = [];
  for (const match of matches) {
    if (!match) continue;
    const name = cleanPickupName(match.raw, labelled);
    if (!name || !validCoord(match.lat, match.lng)) continue;
    points.push({name, lat: match.lat, lng: match.lng});
  }
  return points;
}

/* Readings col F/G as a coordinate pair, or nulls. */
export function readingCoord(latCell: unknown, lngCell: unknown): {lat: number | null; lng: number | null} {
  const lat = coordNumber(latCell);
  const lng = coordNumber(lngCell);
  if (lat == null || lng == null || !validCoord(lat, lng)) return {lat: null, lng: null};
  return {lat, lng};
}

function coordNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return null;
  return Number(value);
}

function validCoord(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function parseOutcome(value: unknown): Outcome {
  if (typeof value !== "string") return "pending";
  const text = value.trim().toLowerCase();
  if (text === "yes" || text === "y") return "yes";
  if (text === "no" || text === "n") return "no";
  return "pending";
}

/*
 * The Events-tab cell "Predicted surge confidence %", found by that header.
 * "75%" and 75 are 75. " 80 % " is 80. Blank, "n/a", anything that is not a
 * whole number, and anything outside 0 to 100 are null. Nothing is rounded
 * or rescaled: "75.4%" stays unused, and 0.75 is not treated as 75.
 */
export function parsePredictedConfidencePercent(value: unknown): number | null {
  if (typeof value === "number") return wholePercent(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^n\/a$/i.test(trimmed)) return null;
  const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(trimmed);
  if (!match) return null;
  return wholePercent(Number(match[1]));
}

function wholePercent(value: number): number | null {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < 0 || value > 100) return null;
  return value;
}

/* A peak-uplift cell as a fraction. "47%" and 47 both mean 0.47. A fraction already in 0..2 is kept. */
export function parseUpliftFraction(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null;
    return value > 2 ? value / 100 : value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^n\/a/i.test(trimmed) || trimmed === "-") return null;
  const percent = trimmed.endsWith("%");
  const numeric = Number(trimmed.replace("%", "").replace(/,/g, "").trim());
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  if (percent || numeric > 2) return numeric / 100;
  return numeric;
}

function parsePhase(value: unknown): Phase {
  if (typeof value !== "string") return "";
  const text = value.trim().toLowerCase();
  if (text.startsWith("baseline")) return "baseline";
  if (text === "pre") return "pre";
  if (text === "during") return "during";
  if (text === "post") return "post";
  return "";
}

function yesNo(value: unknown): "yes" | "no" | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "yes" || text === "y" || text === "true") return "yes";
  if (text === "no" || text === "n" || text === "false") return "no";
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

function backFlag(flag: unknown, fare: unknown, baseline: unknown): boolean | null {
  const marked = yesNo(flag);
  if (marked === "yes") return true;
  if (marked === "no") return false;
  const fareN = money(fare);
  const baseN = money(baseline);
  if (fareN == null || baseN == null || baseN <= 0) return null;
  return Math.abs(fareN / baseN - 1) <= 0.05;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/* Venue type from the sheet, or `event` when the cell is missing or unusable. */
export function categoryFromSheet(value: unknown): string {
  const cleaned = text(value).toLowerCase().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 40 || !/^[a-z][a-z ]*$/.test(cleaned)) return DEFAULT_CATEGORY;
  return CATEGORY_ALIASES[cleaned] ?? cleaned;
}

function placeName(values: Record<string, unknown>): string {
  return text(values[GROUND]) || text(values.Venue) || text(values["Venue name"]);
}

function categoryValue(values: Record<string, unknown>): string {
  for (const key of CATEGORY_HEADERS) {
    if (text(values[key])) return categoryFromSheet(values[key]);
  }
  return DEFAULT_CATEGORY;
}

export function parseSurgeSheet(eventsMatrix: unknown[][], readingsMatrix: unknown[][]): ParsedSheet {
  const events: ParsedEvent[] = [];
  let skipped = 0;
  let rejected = 0;
  for (const row of rowsFromMatrix(eventsMatrix)) {
    if (row.blank) continue;
    const values = row.values;
    const sheetEventId = sheetEventKey(text(values[EVENT_ID]));
    if (!sheetEventId) {
      skipped += 1;
      continue;
    }
    const fullTimeMs = parseSheetTime(values[EXPECTED_FULL_TIME], "uk");
    const kickoff = resolveKickoff({
      sheetEventId,
      kickoffCell: values[KICKOFF],
      fullTimeMs,
    });
    if (kickoff.status === "skip") {
      skipped += 1;
      continue;
    }
    if (kickoff.status === "reject") {
      rejected += 1;
      continue;
    }
    const hardStopMs = parseSheetTime(values[HARD_STOP], "uk");
    events.push({
      sheetEventId,
      competition: text(values[COMPETITION]),
      home: text(values[HOME_TEAM]),
      away: text(values[AWAY_TEAM]),
      ground: placeName(values),
      category: categoryValue(values),
      kickOffMs: kickoff.kickOffMs,
      startTimeSource: kickoff.startTimeSource,
      fullTimeMs,
      surgeStartMs: parseSheetTime(values[SURGE_START], "uk"),
      surgeEndMs: parseSheetTime(values[SURGE_END], "uk"),
      hardStopMs: hardStopMs != null && hardStopMs > kickoff.kickOffMs ? hardStopMs : null,
      outcome: parseOutcome(values[DID_IT_SURGE]),
      peakUplift: parseUpliftFraction(values[PEAK_UPLIFT]),
      predictedConfidencePercent: parsePredictedConfidencePercent(values[PREDICTED_SURGE_CONFIDENCE]),
      pickups: parsePickupPoints(values[PICKUP_POINTS]),
    });
  }

  const readings: ParsedReading[] = [];
  let order = 0;
  for (const row of rowsFromMatrix(readingsMatrix)) {
    if (row.blank) continue;
    const values = row.values;
    const eventId = sheetEventKey(text(values[EVENT_ID]));
    const timeMs = parseSheetTime(values[TIME_UK], "uk") ?? parseSheetTime(values[TIME_UTC], "utc");
    if (!eventId || timeMs == null) continue;
    readings.push({
      eventId,
      timeMs,
      pickupName: text(values[PICKUP_POINT]),
      ...readingCoord(values[LATITUDE], values[LONGITUDE]),
      phase: parsePhase(values[PHASE]),
      backToBaseline: backFlag(values[BACK_TO_BASELINE], values[FARE_SHOWN], values[BASELINE_FARE]),
      order,
    });
    order += 1;
  }
  return {events, readings, skipped, rejected};
}
