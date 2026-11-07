import {
  DISRUPTION_HEADERS,
  EVENT_HEADERS,
  READING_HEADERS,
} from "../../../src/surge/importSheet.js";

export const FIXTURE_READER = "Fixture Reader";

export function syntheticMap(): {id: "synthetic-v1"} {
  return {id: "synthetic-v1"};
}

function line(headers: readonly string[], values: Record<string, unknown>): unknown[] {
  return headers.map((header) => values[header] ?? "");
}

export function eventLine(values: Record<string, unknown>): unknown[] {
  return line(EVENT_HEADERS, values);
}

export function readingLine(values: Record<string, unknown>): unknown[] {
  return line(READING_HEADERS, values);
}

const EVENT = {
  "Event ID": "2026-07-15-ALPHA-BETA",
  "Competition": "Friendly",
  "Home team": "Alpha",
  "Away team": "Beta",
  "Ground": "Fixture Ground",
  "Kick-off (UK)": "2026-07-15 19:00",
  "Expected full time (UK)": "2026-07-15 21:00",
  "Surge window starts (UK)": "2026-07-15 18:00",
  "Surge window ends (UK, est.)": "2026-07-15 22:00",
  "Baseline price check (UK, 4h before window)": "2026-07-15 14:00",
  "Hard stop (UK, FT + 3h)": "2026-07-15 23:00",
  "Ground capacity": "~1000",
  "Predicted surge confidence %": "65%",
  "Priority": "high",
  "Status": "Scheduled",
  "Did it surge?": "YES",
  "Peak uplift %": "50%",
  "Pickup points (name | lat,lng)": "1) North Gate | 51.50,-0.12; Real: ignore this note",
  "Fixed destination for price checks": "Centre Point | 51.51,-0.11 | 1 km",
};

export function baseEvent(overrides: Record<string, unknown> = {}): unknown[] {
  return eventLine({...EVENT, ...overrides});
}

export function baseReading(overrides: Record<string, unknown> = {}): unknown[] {
  return readingLine({
    "Time (UK)": "2026-07-15 18:10",
    "Time (UTC)": "2026-07-15 17:10",
    "Event ID": "2026-07-15-ALPHA-BETA",
    "Phase (Baseline / Pre / During / Post)": "during",
    "Pickup point": "North Gate",
    "Latitude": 51.5,
    "Longitude": -0.12,
    "Destination": "Centre Point",
    "Uber product": "UberX",
    "Fare shown (£)": "£12.96",
    "Baseline fare (£)": "10.00",
    "Pickup wait (min)": "3-5",
    "'Busy / fares higher' shown?": "No",
    "Source": FIXTURE_READER,
    ...overrides,
  });
}

export function workbook(events: unknown[][], readings: unknown[][]): Record<string, unknown[][]> {
  const readingHeader = [...READING_HEADERS, "Source"];
  return {
    "Events": [[...EVENT_HEADERS], ...events],
    "TPC Disruption Log": [[...DISRUPTION_HEADERS]],
    "Readings": [readingHeader, ...readings],
    "TPC Readings": [[...READING_HEADERS]],
  };
}
