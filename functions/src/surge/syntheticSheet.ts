import {
  AWAY_TEAM,
  BACK_TO_BASELINE,
  BASELINE_FARE,
  COMPETITION,
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
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
  READINGS_HEADERS,
  SURGE_END,
  SURGE_START,
  TIME_UK,
} from "./headers.js";

/* SYNTHETIC. Not real venues, matches, or fares. Numbers exist only so tests can prove fares stay inside the job. */
export const SYNTHETIC_NOTE = "SYNTHETIC";

export const SYNTHETIC_PRICE_TOKENS = ["18.4", "19.5", "3.5", "47%", "£"];

const GATE = "North Gate | 51.701001, -0.301001";

export function matrix(header: readonly string[], rows: Record<string, unknown>[]): unknown[][] {
  return [Array.from(header), ...rows.map((row) => header.map((column) => row[column] ?? ""))];
}

function dated(
  id: string,
  day: string,
  outcome: string,
  ground: string,
  home: string,
  away: string,
): Record<string, unknown> {
  return {
    [EVENT_ID]: id,
    [COMPETITION]: "Synthetic Cup",
    [HOME_TEAM]: home,
    [AWAY_TEAM]: away,
    [GROUND]: ground,
    [KICKOFF]: `${day} 15:00`,
    [EXPECTED_FULL_TIME]: `${day} 16:55`,
    [SURGE_START]: `${day} 16:55`,
    [SURGE_END]: `${day} 18:30`,
    [HARD_STOP]: `${day} 19:55`,
    [PICKUP_POINTS]: GATE,
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: outcome === "NO" ? "" : "47%",
  };
}

export function syntheticBacktestSheet(): {events: unknown[][]; readings: unknown[][]} {
  const events = matrix(EVENTS_HEADERS, [
    dated("2099-01-01-SYN-AAA", "2099-01-01", "YES", "Synthetic Park", "Home Side", "Away Side"),
    dated("2099-01-08-SYN-AAB", "2099-01-08", "YES", "Synthetic Park", "Home Side", "Away Side"),
    dated("2099-01-15-SYN-AAC", "2099-01-15", "YES", "Synthetic Park", "Home Side", "Away Side"),
    dated("2099-01-22-SYN-AAD", "2099-01-22", "YES", "Synthetic Park", "Home Side", "Away Side"),
    dated("2099-01-29-SYN-AAE", "2099-01-29", "NO", "Synthetic Park", "Home Side", "Away Side"),
    dated("2099-02-05-SYN-AAF", "2099-02-05", "YES", "Sample Ground", "Other Home", "Other Away"),
  ]);
  const readings = matrix(READINGS_HEADERS, [{
    [TIME_UK]: "2099-01-01 17:00",
    [EVENT_ID]: "2099-01-01-SYN-AAA",
    [PHASE]: "During",
    [PICKUP_POINT]: "North Gate",
    [FARE_SHOWN]: "18.4",
    [BASELINE_FARE]: "19.5",
    "Uplift (£)": "3.5",
    [BACK_TO_BASELINE]: "No",
  }]);
  return {events, readings};
}
