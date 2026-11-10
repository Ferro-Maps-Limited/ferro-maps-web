import {rowsFromMatrix} from "../parking/privateSheet/rows.js";
import {DID_IT_SURGE, EVENT_ID, GROUND, KICKOFF, PEAK_UPLIFT} from "./headers.js";
import {parseOutcome, parseUpliftFraction, type Outcome} from "./parse.js";
import {parseSheetTime} from "./time.js";
import {normVenueName} from "./venueLocations.js";

/*
 * Column titles copied from the TPC Disruption Log and TPC Readings tabs
 * on 2026-11-10. The parser looks these up by name. Fare columns are listed
 * so the layout stays honest, and nothing reads them into a forecast.
 */
export const DISRUPTION_ID = "Disruption ID";
export const TPC_LOCATION = "Location/Station/Airport";

export const TPC_LOG_HEADERS = [
  DISRUPTION_ID,
  "Competition",
  "Home team",
  "Away team",
  GROUND,
  KICKOFF,
  "Expected full time (UK)",
  "Surge window starts (UK)",
  "Surge window ends (UK, est.)",
  "Baseline price check (UK, 4h before window)",
  "Hard stop (UK, FT + 3h)",
  "Ground capacity",
  "When to stop checking",
  "Kick-off time sources",
  "Status",
  "Notes",
  "Pickup points (name | lat,lng)",
  "Fixed destination for price checks",
  DID_IT_SURGE,
  PEAK_UPLIFT,
  "Read by (bot)",
  "Priority",
  "Pipeline note",
  "Surge Prediction (level + affected areas/routes)",
  "Surge Confidence %",
  "Surge Expected? (YES/NO)",
  "Predicted Traffic (TomTom)",
  "Expected Surge Locations",
  "Expected Surge Window (UK)",
  "Date/Time Detected (UK)",
  TPC_LOCATION,
  "Mode",
  "Type",
  "Description",
  "Expected Duration/End Time",
  "Source(s)",
  "Last Updated (UK)",
  "Uber product",
  "Baseline fare (£)",
  "Peak fare (£)",
  "Peak time (UK)",
  "Surge started (UK)",
  "Surge ended (UK, back within 5%)",
  "Surge length (min)",
  "Number of readings",
  "Month",
  "SEND DRIVER",
] as const;

export const TPC_READINGS_HEADERS = [
  "Time (UK)",
  "Time (UTC)",
  EVENT_ID,
  "Phase (Baseline / Pre / During / Post)",
  "Pickup point",
  "Latitude",
  "Longitude",
  "Distance to disrupted station (m)",
  "Destination",
  "Uber product",
  "Fare shown (£)",
  "Pickup wait (min)",
  "'Busy / fares higher' shown?",
  "Baseline fare (£)",
  "Uplift %",
  "Uplift (£)",
  "Back to baseline? (within 5%)",
  "Confidence %",
  DID_IT_SURGE,
  "Peak uplift % (so far)",
  "Source (manual / browser)",
  "Screenshot link",
  "Notes",
  "H3 cell (res 8) - technical",
  "H3 cell (res 9) - technical",
  "Month",
  "Live Traffic (TomTom)",
] as const;

export type TpcScope = "station" | "route" | "line";

export interface TpcIncident {
  id: string;
  scope: TpcScope;
  key: string | null;
  kickOffMs: number;
  outcome: Outcome;
  peakUplift: number | null;
  hasReadings: boolean;
}

/*
 * The log stores a fraction: 0.47 means 47%, and 2.95 means 295%.
 * parseUpliftFraction divides any bare number above 2, which would shrink a
 * real 295% peak below the strength floor. A bare number above 20 is a percent
 * (the events-sheet shape, such as 47). A trailing % sign is always a percent.
 */
export function parseTpcUplift(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /^n\/a/i.test(trimmed) || trimmed === "-") return null;
    if (trimmed.endsWith("%")) return parseUpliftFraction(trimmed);
    const numeric = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(numeric)) return null;
    return parseTpcUplift(numeric);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null;
    if (value > 20) return value / 100;
    return value;
  }
  return null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function lineWide(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("entire line") || lower.includes("whole line") || lower.includes("all stations");
}

function routeShaped(value: string): boolean {
  return value.includes(" – ") ||
    value.includes(" — ") ||
    value.includes(" - ") ||
    value.toLowerCase().includes(" line:") ||
    value.includes(",") ||
    value.includes(";");
}

/*
 * A line-wide row is not a surge at every station on that line.
 * A route or a list of stations matches only that full label.
 * A station row is one place, with no route separator and no comma list.
 * The label is Location/Station/Airport. The long Ground title is not a fallback.
 */
export function classifyTpcPlace(ground: string, location: string): {scope: TpcScope; key: string | null} {
  if (lineWide(ground) || lineWide(location)) return {scope: "line", key: null};
  const label = location.trim();
  if (!label) return {scope: "line", key: null};
  const key = normVenueName(label);
  if (!key) return {scope: "line", key: null};
  if (routeShaped(label)) return {scope: "route", key};
  return {scope: "station", key};
}

export function parseTpcSheet(logMatrix: unknown[][], readingsMatrix: unknown[][]): TpcIncident[] {
  const readingIds = new Set<string>();
  for (const row of rowsFromMatrix(readingsMatrix)) {
    if (row.blank) continue;
    const eventId = text(row.values[EVENT_ID]);
    if (eventId) readingIds.add(eventId);
  }
  const byId = new Map<string, TpcIncident>();
  for (const row of rowsFromMatrix(logMatrix)) {
    if (row.blank) continue;
    const id = text(row.values[DISRUPTION_ID]);
    const kickOffMs = parseSheetTime(row.values[KICKOFF], "uk");
    if (!id || kickOffMs == null) continue;
    const place = classifyTpcPlace(text(row.values[GROUND]), text(row.values[TPC_LOCATION]));
    byId.set(id, {
      id,
      scope: place.scope,
      key: place.key,
      kickOffMs,
      outcome: parseOutcome(row.values[DID_IT_SURGE]),
      peakUplift: parseTpcUplift(row.values[PEAK_UPLIFT]),
      hasReadings: readingIds.has(id),
    });
  }
  return [...byId.values()];
}
