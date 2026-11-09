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
  PEAK_UPLIFT,
  PHASE,
  PICKUP_POINT,
  PICKUP_POINTS,
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
  pickups: PickupCoord[];
}

/* A price check with the fare already reduced to a yes/no stop flag. */
export interface ParsedReading {
  eventId: string;
  timeMs: number;
  pickupName: string;
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

const POINT = /^(.+?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

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
  if (typeof value !== "string") return [];
  const chunks = value.split(/\r?\n|;|\s\|\|\s/).map((chunk) => chunk.trim()).filter(Boolean);
  const points: PickupCoord[] = [];
  for (const chunk of chunks) {
    const match = POINT.exec(chunk);
    if (!match) continue;
    const lat = Number(match[2]);
    const lng = Number(match[3]);
    const name = match[1].trim();
    if (!name || !validCoord(lat, lng)) continue;
    points.push({name, lat, lng});
  }
  return points;
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
      phase: parsePhase(values[PHASE]),
      backToBaseline: backFlag(values[BACK_TO_BASELINE], values[FARE_SHOWN], values[BASELINE_FARE]),
      order,
    });
    order += 1;
  }
  return {events, readings, skipped, rejected};
}
