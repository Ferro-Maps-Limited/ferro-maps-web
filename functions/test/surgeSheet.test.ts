import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {formatCoord, normaliseName, placeId} from "../src/parking/privateSheet/mapping";
import {HOTSPOTS_COLLECTION} from "../src/surge/commit";
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
  PREDICTED_SURGE_CONFIDENCE,
  READINGS_HEADERS,
  SURGE_END,
  SURGE_START,
  TIME_UK,
} from "../src/surge/headers";
import {confidencePercent, resolveKickoff} from "../src/surge/kickoff";
import {categoryFromSheet, DEFAULT_CATEGORY, parsePredictedConfidencePercent, stadiumDocId} from "../src/surge/parse";
import {planStadiumEvents, type StadiumEventRecord} from "../src/surge/plan";
import {lookupVenueLocation, normVenueName} from "../src/surge/venueLocations";
import {assertNoPrices, PriceLeakError} from "../src/surge/priceGuard";
import {SURGE_SHEET_SCHEDULE, runStadiumSurgeSync} from "../src/surge/syncStadiumSurgeSheet";
import {matrix, SYNTHETIC_PRICE_TOKENS} from "../src/surge/syntheticSheet";
import {parseSheetTime} from "../src/surge/time";
import {
  confidenceBand,
  FIXTURE_MIN,
  GROUND_MIN,
  MIN_YES,
  MIN_YES_RATE,
  strengthBand,
} from "../src/surge/thresholds";

const NOW = new Date("2098-01-01T00:00:00.000Z");
const GATE = "North Gate | 51.701001, -0.301001";
const VENUE_HEADERS = [...EVENTS_HEADERS, "Venue type", "Venue"];

function eventRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [EVENT_ID]: "2099-06-01-SYN-AAA",
    [COMPETITION]: "Synthetic Cup",
    [HOME_TEAM]: "Home Side",
    [AWAY_TEAM]: "Away Side",
    [GROUND]: "Synthetic Park",
    [KICKOFF]: "2099-06-01 15:00",
    [EXPECTED_FULL_TIME]: "2099-06-01 16:55",
    [SURGE_START]: "2099-06-01 16:55",
    [SURGE_END]: "2099-06-01 19:00",
    [HARD_STOP]: "2099-06-01 19:55",
    [PICKUP_POINTS]: GATE,
    [DID_IT_SURGE]: "PENDING",
    [PEAK_UPLIFT]: "",
    [PREDICTED_SURGE_CONFIDENCE]: "85%",
    ...over,
  };
}

function prior(day: string, outcome: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return eventRow({
    [EVENT_ID]: `2099-05-${day}-SYN-P${day}`,
    [KICKOFF]: `2099-05-${day} 15:00`,
    [EXPECTED_FULL_TIME]: `2099-05-${day} 16:55`,
    [SURGE_START]: `2099-05-${day} 16:55`,
    [SURGE_END]: `2099-05-${day} 19:00`,
    [HARD_STOP]: `2099-05-${day} 19:55`,
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: outcome === "NO" ? "" : "47%",
    ...over,
  });
}

function reading(over: Record<string, unknown>): Record<string, unknown> {
  return {
    [TIME_UK]: "2099-06-01 18:00",
    [EVENT_ID]: "2099-06-01-SYN-AAA",
    [PHASE]: "During",
    [PICKUP_POINT]: "North Gate",
    [FARE_SHOWN]: "18.4",
    [BASELINE_FARE]: "19.5",
    "Uplift (£)": "3.5",
    [BACK_TO_BASELINE]: "",
    ...over,
  };
}

function plan(rows: Record<string, unknown>[], readings: Record<string, unknown>[] = [], now = NOW) {
  return planStadiumEvents({
    now,
    events: matrix(VENUE_HEADERS, rows),
    readings: matrix(READINGS_HEADERS, readings),
  });
}

function one(rows: Record<string, unknown>[], readings: Record<string, unknown>[] = [], now = NOW): StadiumEventRecord {
  const result = plan(rows, readings, now);
  assert.equal(result.records.length, 1);
  return result.records[0];
}

function pick(
  rows: Record<string, unknown>[],
  readings: Record<string, unknown>[] = [],
  now = NOW,
  id = "2099-06-01-SYN-AAA",
): StadiumEventRecord {
  const record = plan(rows, readings, now).records.find((item) => item.sheetEventId === id);
  if (!record) throw new Error(`missing ${id}`);
  return record;
}

function assertClean(value: unknown): void {
  const raw = JSON.stringify(value);
  for (const token of SYNTHETIC_PRICE_TOKENS) assert.equal(raw.includes(token), false, token);
  assert.equal(/[£$€]|\b(fare|fares|gbp|quid|uber|bolt|uplift|baseline)\b/i.test(raw), false);
  assertNoPrices(value);
}

describe("surge sheet parsing and clocks", () => {
  it("reads a UK winter time and a UK summer time", () => {
    assert.equal(parseSheetTime("2026-01-15 15:00", "uk"), Date.parse("2026-01-15T15:00:00.000Z"));
    assert.equal(parseSheetTime("15/01/2026 15:00", "uk"), Date.parse("2026-01-15T15:00:00.000Z"));
    assert.equal(parseSheetTime("2026-07-15 15:00", "uk"), Date.parse("2026-07-15T14:00:00.000Z"));
    assert.equal(parseSheetTime("n/a (past)", "uk"), null);
    assert.equal(parseSheetTime(45000, "uk"), null);
  });

  it("keeps a stable sheet id and ignores the name-and-coordinate place key", () => {
    assert.equal(stadiumDocId(" 2099-06-01-syn-aaa "), "sheet_2099-06-01-SYN-AAA");
    assert.equal(stadiumDocId("../etc"), null);
    const first = one([eventRow()]);
    const again = one([eventRow()]);
    assert.equal(first.id, again.id);
    assert.equal(first.idSource, "sheet_event");
    assert.deepEqual(first, again);
    const other = one([eventRow({[EVENT_ID]: "2099-06-08-SYN-BBB"})]);
    assert.notEqual(other.id, first.id);
    const key = `${normaliseName(first.name)}|${formatCoord(first.location.lat)}|${formatCoord(first.location.lng)}`;
    const both = plan([
      eventRow(),
      eventRow({[EVENT_ID]: "2099-06-08-SYN-BBB"}),
    ]);
    assert.equal(both.records.length, 2);
    const keys = both.records.map((record) => {
      return `${normaliseName(record.name)}|${formatCoord(record.location.lat)}|${formatCoord(record.location.lng)}`;
    });
    assert.equal(keys[0], keys[1]);
    assert.equal(keys[0], key);
    for (const record of both.records) {
      assert.notEqual(record.id, placeId(record.name, "", record.location.lat, record.location.lng));
      assert.equal(record.id, stadiumDocId(record.sheetEventId));
    }
  });
});

describe("venue category", () => {
  it("writes a hospital row, and a row with no venue type as event", () => {
    assert.equal(DEFAULT_CATEGORY, "event");
    assert.equal(categoryFromSheet("Hospital"), "hospital");
    assert.equal(categoryFromSheet("hospitals"), "hospital");
    assert.equal(categoryFromSheet("stadium"), "stadium");
    assert.equal(categoryFromSheet(""), "event");
    const result = plan([
      eventRow({
        [EVENT_ID]: "2099-07-04-HOSP-01",
        [COMPETITION]: "Visiting hours",
        [HOME_TEAM]: "",
        [AWAY_TEAM]: "",
        [GROUND]: "Synthetic General Hospital",
        [KICKOFF]: "2099-07-04 18:00",
        [EXPECTED_FULL_TIME]: "2099-07-04 20:00",
        [SURGE_START]: "2099-07-04 20:00",
        [SURGE_END]: "2099-07-04 22:00",
        [HARD_STOP]: "2099-07-04 23:00",
        [PICKUP_POINTS]: "Main entrance | 51.501001, -0.101001",
        "Venue type": "Hospital",
        [PREDICTED_SURGE_CONFIDENCE]: "",
      }),
      eventRow({"Venue type": ""}),
      eventRow({
        [EVENT_ID]: "2099-07-05-STN-01",
        [COMPETITION]: "",
        [HOME_TEAM]: "",
        [AWAY_TEAM]: "",
        [GROUND]: "",
        ["Venue"]: "Synthetic Station",
        "Venue type": "station",
        [KICKOFF]: "2099-07-05 18:00",
        [EXPECTED_FULL_TIME]: "2099-07-05 20:30",
        [HARD_STOP]: "2099-07-05 23:30",
        [PICKUP_POINTS]: "Concourse | 51.511001, -0.111001",
      }),
    ]);
    const hospital = result.records.find((record) => record.sheetEventId === "2099-07-04-HOSP-01");
    const plain = result.records.find((record) => record.sheetEventId === "2099-06-01-SYN-AAA");
    const station = result.records.find((record) => record.sheetEventId === "2099-07-05-STN-01");
    if (!hospital || !plain || !station) throw new Error("missing venue row");
    assert.equal(hospital.category, "hospital");
    assert.equal(hospital.name, "Synthetic General Hospital");
    assert.equal(hospital.description, "Visiting hours at Synthetic General Hospital");
    assert.equal(hospital.id, "sheet_2099-07-04-HOSP-01");
    assert.equal(hospital.idSource, "sheet_event");
    assert.deepEqual(hospital.forecast, {
      state: "no_prediction",
      confidencePercent: null,
      confidenceSource: "none",
    });
    const hospitalStop = parseSheetTime("2099-07-04 23:00", "uk");
    assert.ok(hospitalStop != null);
    assert.equal(hospital.removeBy, new Date(hospitalStop).toISOString());
    assert.equal(JSON.stringify(hospital).includes("Football"), false);
    assert.equal(plain.category, "event");
    assert.equal(plain.name, "Home Side v Away Side");
    assert.equal(station.category, "station");
    assert.equal(station.name, "Synthetic Station");
    assertClean(result);
  });
});

describe("removeBy, surgeEnded, and forecast", () => {
  it("puts removeBy on every record and falls back when the hard stop is blank", () => {
    const stated = one([eventRow()]);
    const hardStop = parseSheetTime("2099-06-01 19:55", "uk");
    assert.equal(Date.parse(stated.removeBy), hardStop);
    const fromFinish = one([eventRow({[HARD_STOP]: ""})]);
    const finish = parseSheetTime("2099-06-01 16:55", "uk");
    assert.ok(finish != null);
    assert.equal(Date.parse(fromFinish.removeBy), finish + 3 * 60 * 60 * 1000);
    const fromKickoff = one([eventRow({
      [HARD_STOP]: "n/a",
      [EXPECTED_FULL_TIME]: "",
    })]);
    const kickoff = parseSheetTime("2099-06-01 15:00", "uk");
    assert.ok(kickoff != null);
    assert.equal(Date.parse(fromKickoff.removeBy), kickoff + (115 + 180) * 60 * 1000);
    for (const record of [stated, fromFinish, fromKickoff]) assert.ok(record.removeBy);
  });

  it("sets surgeEnded only after two during checks are back, or when removeBy has passed", () => {
    const quiet = one([eventRow()], [
      reading({[BACK_TO_BASELINE]: "Yes", [TIME_UK]: "2099-06-01 18:00"}),
    ]);
    assert.equal(quiet.surgeEnded, false);
    const broken = one([eventRow()], [
      reading({[BACK_TO_BASELINE]: "Yes", [TIME_UK]: "2099-06-01 18:00"}),
      reading({[BACK_TO_BASELINE]: "No", [TIME_UK]: "2099-06-01 18:05"}),
      reading({[BACK_TO_BASELINE]: "Yes", [TIME_UK]: "2099-06-01 18:10"}),
    ]);
    assert.equal(broken.surgeEnded, false);
    const split = one([eventRow()], [
      reading({[BACK_TO_BASELINE]: "Yes", [PICKUP_POINT]: "North Gate"}),
      reading({[BACK_TO_BASELINE]: "Yes", [PICKUP_POINT]: "South Gate", [TIME_UK]: "2099-06-01 18:05"}),
    ]);
    assert.equal(split.surgeEnded, false);
    const baseline = one([eventRow()], [
      reading({[PHASE]: "Baseline", [BACK_TO_BASELINE]: "Yes", [TIME_UK]: "2099-06-01 12:00"}),
      reading({[PHASE]: "Baseline", [BACK_TO_BASELINE]: "Yes", [TIME_UK]: "2099-06-01 12:05"}),
    ]);
    assert.equal(baseline.surgeEnded, false);
    const ended = one([eventRow()], [
      reading({[BACK_TO_BASELINE]: "Yes", [TIME_UK]: "2099-06-01 18:00"}),
      reading({[BACK_TO_BASELINE]: "Yes", [TIME_UK]: "2099-06-01 18:05"}),
    ]);
    assert.equal(ended.surgeEnded, true);
    const fromFares = one([eventRow()], [
      reading({[FARE_SHOWN]: "30.25", [TIME_UK]: "2099-06-01 18:00"}),
      reading({[FARE_SHOWN]: "19.7", [TIME_UK]: "2099-06-01 18:05"}),
      reading({[FARE_SHOWN]: "19.4", [TIME_UK]: "2099-06-01 18:10"}),
    ]);
    assert.equal(fromFares.surgeEnded, true);
    const fareText = JSON.stringify(fromFares);
    assert.equal(fareText.includes("30.25"), false);
    assert.equal(fareText.includes("19.7"), false);
    assert.equal(fareText.includes("19.4"), false);
    assertClean(fromFares);
    const atStop = one([eventRow()], [], new Date(quiet.removeBy));
    assert.equal(atStop.surgeEnded, true);
  });

  it("keeps a thin history as no_prediction and still stores the sheet percent", () => {
    const thin = pick([
      prior("01", "YES"),
      eventRow({[PREDICTED_SURGE_CONFIDENCE]: "85%"}),
    ]);
    assert.equal(thin.forecast.state, "no_prediction");
    if (thin.forecast.state !== "no_prediction") throw new Error("expected no prediction");
    assert.equal(thin.forecast.confidencePercent, 85);
    assert.equal(thin.forecast.confidenceSource, "events_tab");
    assert.equal(JSON.stringify(thin).includes("85%"), false);
    assert.equal("startAt" in thin.forecast, false);
    assert.equal("strength" in thin.forecast, false);
    assert.equal("confidence" in thin.forecast, false);
    assert.equal("basedOnEvents" in thin.forecast, false);
    const enoughHistory = [
      prior("01", "YES"),
      prior("08", "YES"),
      prior("15", "YES"),
    ];
    const noWindow = pick([
      ...enoughHistory,
      eventRow({[SURGE_START]: "", [EXPECTED_FULL_TIME]: "", [SURGE_END]: ""}),
    ]);
    assert.deepEqual(noWindow.forecast, {
      state: "no_prediction",
      confidencePercent: 85,
      confidenceSource: "events_tab",
    });
    assert.ok(noWindow.removeBy);
    const lowRate = pick([
      prior("01", "NO"),
      prior("08", "NO"),
      prior("15", "NO"),
      prior("22", "NO"),
      eventRow(),
    ]);
    assert.deepEqual(lowRate.forecast, {
      state: "no_prediction",
      confidencePercent: 85,
      confidenceSource: "events_tab",
    });
  });

  it("forecasts from fixture history, bands strength, and clamps the window to 6 hours", () => {
    assert.equal(FIXTURE_MIN, 3);
    assert.equal(GROUND_MIN, 4);
    assert.equal(MIN_YES, 3);
    assert.equal(MIN_YES_RATE, 0.6);
    assert.equal(strengthBand(0.47), "medium");
    assert.equal(strengthBand(0.25), "low");
    assert.equal(strengthBand(0.7), "high");
    assert.equal(confidenceBand(3, 1), "low");
    assert.equal(confidenceBand(5, 0.6), "medium");
    assert.equal(confidenceBand(8, 0.75), "high");
    const forecasted = pick([
      prior("01", "YES"),
      prior("08", "YES"),
      prior("15", "YES"),
      eventRow(),
    ]);
    assert.equal(forecasted.forecast.state, "available");
    if (forecasted.forecast.state !== "available") throw new Error("expected a forecast");
    assert.equal(forecasted.forecast.strength, "medium");
    assert.equal(forecasted.forecast.confidence, "low");
    assert.equal(forecasted.forecast.v, 1);
    assert.equal(typeof forecasted.forecast.confidence, "string");
    assert.equal(forecasted.forecast.confidencePercent, 85);
    assert.equal(forecasted.forecast.confidenceSource, "events_tab");
    assert.equal(forecasted.forecast.basedOnEvents, 3);
    assert.deepEqual(Object.keys(forecasted.forecast).sort(), [
      "basedOnEvents",
      "confidence",
      "confidencePercent",
      "confidenceSource",
      "endAt",
      "startAt",
      "state",
      "strength",
      "v",
    ]);
    const preferred = pick([
      prior("01", "YES"),
      prior("08", "YES"),
      prior("15", "YES"),
      prior("02", "NO", {[HOME_TEAM]: "Other Home", [AWAY_TEAM]: "Other Away"}),
      prior("03", "NO", {[HOME_TEAM]: "Other Home", [AWAY_TEAM]: "Other Away"}),
      prior("04", "NO", {[HOME_TEAM]: "Other Home", [AWAY_TEAM]: "Other Away"}),
      prior("05", "NO", {[HOME_TEAM]: "Other Home", [AWAY_TEAM]: "Other Away"}),
      prior("06", "NO", {[HOME_TEAM]: "Other Home", [AWAY_TEAM]: "Other Away"}),
      eventRow(),
    ]);
    assert.equal(preferred.forecast.state, "available");
    const longWindow = pick([
      prior("01", "YES"),
      prior("08", "YES"),
      prior("15", "YES"),
      eventRow({[SURGE_START]: "2099-06-01 16:55", [SURGE_END]: "2099-06-02 04:00"}),
    ]);
    assert.equal(longWindow.forecast.state, "available");
    if (longWindow.forecast.state !== "available") throw new Error("expected a forecast");
    const span = Date.parse(longWindow.forecast.endAt) - Date.parse(longWindow.forecast.startAt);
    assert.equal(span, 6 * 60 * 60 * 1000);
    assertClean(forecasted);
  });

  it("hides a pickup until that point has two earlier events of its own", () => {
    const rows = [prior("01", "YES"), prior("08", "YES"), eventRow()];
    const readings = ["2099-05-01", "2099-05-08"].flatMap((day) => ([
      reading({
        [EVENT_ID]: `2099-05-${day.slice(-2)}-SYN-P${day.slice(-2)}`,
        [TIME_UK]: `${day} 18:00`,
        [BACK_TO_BASELINE]: "No",
      }),
      reading({
        [EVENT_ID]: `2099-05-${day.slice(-2)}-SYN-P${day.slice(-2)}`,
        [TIME_UK]: `${day} 18:05`,
        [BACK_TO_BASELINE]: "No",
      }),
    ]));
    const record = pick(rows, readings);
    assert.equal(record.pickupPoints[0].verified, true);
    assert.equal(record.pickupPoints[0].confidence, "low");
    assert.equal(record.pickupPoints[0].confidencePercent, 100);
    const fresh = one([eventRow()]);
    assert.equal(fresh.pickupPoints[0].verified, false);
    assert.equal("confidence" in fresh.pickupPoints[0], false);
    assert.equal("confidencePercent" in fresh.pickupPoints[0], false);
  });

  it("drops a row whose name would publish a fare word, and never returns the fare", () => {
    const result = plan([
      eventRow({
        [EVENT_ID]: "2099-06-02-SYN-BAD",
        [HOME_TEAM]: "Uber Side",
        [AWAY_TEAM]: "Bolt Side",
      }),
      eventRow(),
    ], [reading({[FARE_SHOWN]: "18.4"})]);
    assert.equal(result.rejected, 1);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].name, "Home Side v Away Side");
    assertClean(result);
  });
});

describe("Events-tab predicted surge confidence", () => {
  const history = [
    prior("01", "YES"),
    prior("08", "YES"),
    prior("15", "YES"),
  ];

  function forecasted(confidence: unknown) {
    const record = pick([
      ...history,
      eventRow({[PREDICTED_SURGE_CONFIDENCE]: confidence}),
    ]);
    if (record.forecast.state !== "available") throw new Error("expected a forecast");
    return record.forecast;
  }

  it("parses the cell as a whole number from 0 to 100", () => {
    assert.equal(parsePredictedConfidencePercent("75%"), 75);
    assert.equal(parsePredictedConfidencePercent(75), 75);
    assert.equal(parsePredictedConfidencePercent(" 80 % "), 80);
    assert.equal(parsePredictedConfidencePercent("n/a"), null);
    assert.equal(parsePredictedConfidencePercent("N/A"), null);
    assert.equal(parsePredictedConfidencePercent(""), null);
    assert.equal(parsePredictedConfidencePercent("   "), null);
    assert.equal(parsePredictedConfidencePercent(null), null);
    assert.equal(parsePredictedConfidencePercent("120%"), null);
    assert.equal(parsePredictedConfidencePercent(120), null);
    assert.equal(parsePredictedConfidencePercent("75.4%"), null);
    assert.equal(parsePredictedConfidencePercent(0.75), null);
    assert.equal(parsePredictedConfidencePercent("0%"), 0);
    assert.equal(parsePredictedConfidencePercent("100"), 100);
    assert.equal(parsePredictedConfidencePercent("75.0%"), 75);
  });

  it("reads the column by its header and stores that integer on the event pin", () => {
    const moved = [
      PREDICTED_SURGE_CONFIDENCE,
      ...EVENTS_HEADERS.filter((header) => header !== PREDICTED_SURGE_CONFIDENCE),
    ];
    assert.equal(moved[0], PREDICTED_SURGE_CONFIDENCE);
    assert.notEqual(
      moved.indexOf(PREDICTED_SURGE_CONFIDENCE),
      EVENTS_HEADERS.indexOf(PREDICTED_SURGE_CONFIDENCE),
    );
    const fromMovedColumn = planStadiumEvents({
      now: NOW,
      events: matrix(moved, [
        ...history,
        eventRow({[PREDICTED_SURGE_CONFIDENCE]: "75%"}),
      ]),
      readings: matrix(READINGS_HEADERS, []),
    }).records.find((item) => item.sheetEventId === "2099-06-01-SYN-AAA");
    if (!fromMovedColumn || fromMovedColumn.forecast.state !== "available") {
      throw new Error("expected a forecast");
    }
    assert.equal(fromMovedColumn.forecast.confidencePercent, 75);
    assert.equal(fromMovedColumn.forecast.confidenceSource, "events_tab");
    assert.equal(fromMovedColumn.forecast.basedOnEvents, 3);
    assert.equal(fromMovedColumn.forecast.confidence, "low");
    assert.equal(fromMovedColumn.forecast.strength, "medium");

    const blank = forecasted("");
    assert.equal(blank.confidencePercent, null);
    assert.equal(blank.confidenceSource, "none");
    assert.equal(blank.basedOnEvents, 3);
    const missing = forecasted("n/a");
    assert.equal(missing.confidencePercent, null);
    assert.equal(missing.confidenceSource, "none");
    const tooHigh = forecasted("120%");
    assert.equal(tooHigh.confidencePercent, null);
    assert.equal(tooHigh.confidenceSource, "none");
    const spaced = forecasted(" 80 % ");
    assert.equal(spaced.confidencePercent, 80);
    assert.equal(spaced.confidenceSource, "events_tab");
    assert.equal(JSON.stringify(spaced).includes("%"), false);
    const numeric = forecasted(75);
    assert.equal(numeric.confidencePercent, 75);
    assert.equal(numeric.confidenceSource, "events_tab");
  });
});

describe("the scheduled job stays off the network in tests", () => {
  it("is every 15 minutes in europe-west2 on the default runtime account", () => {
    assert.equal(SURGE_SHEET_SCHEDULE.schedule, "*/15 * * * *");
    assert.equal(SURGE_SHEET_SCHEDULE.region, "europe-west2");
    assert.equal(SURGE_SHEET_SCHEDULE.timeZone, "Europe/London");
    assert.equal("serviceAccount" in SURGE_SHEET_SCHEDULE, false);
    assert.equal(HOTSPOTS_COLLECTION, "hotspots_test");
    const commitSrc = readFileSync(join(__dirname, "../src/surge/commit.ts"), "utf8");
    assert.equal(commitSrc.includes(".delete("), false);
    assert.equal(commitSrc.includes("recursiveDelete"), false);
    assert.equal(commitSrc.includes("merge: true"), true);
    const indexSrc = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    assert.match(indexSrc, /export \{syncSurgeSheetEvents\}/);
  });

  it("does not read or write when the spreadsheet id is blank", async () => {
    let loaded = 0;
    let written = 0;
    const summary = await runStadiumSurgeSync({
      now: NOW,
      sheetId: "  ",
      eventsTab: "Events",
      readingsTab: "Readings",
      load: async () => {
        loaded += 1;
        return {events: [], readings: []};
      },
      commit: async () => {
        written += 1;
        return 0;
      },
    });
    assert.equal(summary.status, "skipped");
    assert.equal(summary.reason, "sheet-id-missing");
    assert.equal(loaded, 0);
    assert.equal(written, 0);
    assertClean(summary);
  });

  it("the built entrypoint exports the scheduled function", async () => {
    const built = join(__dirname, "../lib/index.js");
    const mod = (await import(built)) as {syncSurgeSheetEvents?: unknown};
    assert.equal(typeof mod.syncSurgeSheetEvents, "function");
  });
});

describe("kick-off notes and confidence percent", () => {
  const finish = "2026-10-20 22:00";
  const finishMs = parseSheetTime(finish, "uk");

  function resolved(cell: string, id = "2026-10-20-O2-JCOLE", full = finish) {
    return resolveKickoff({
      sheetEventId: id,
      kickoffCell: cell,
      fullTimeMs: full ? parseSheetTime(full, "uk") : null,
    });
  }

  it("keeps a full kick-off and recovers the other sheet wordings", () => {
    assert.equal(confidencePercent(2, 3), 67);
    assert.equal(confidencePercent(3, 4), 75);
    const exact = resolved("2026-10-20 20:00");
    assert.equal(exact.status, "ok");
    if (exact.status !== "ok") return;
    assert.equal(exact.startTimeSource, "sheet_exact");
    assert.equal(exact.kickOffMs, parseSheetTime("2026-10-20 20:00", "uk"));

    const cases: Array<[string, "sheet_start" | "sheet_doors" | "derived_from_finish", string]> = [
      ["Doors 18:30", "sheet_doors", "2026-10-20 18:30"],
      ["Start doors 18:30", "sheet_doors", "2026-10-20 18:30"],
      ["Doors 18:00/18:30", "sheet_doors", "2026-10-20 18:00"],
      ["Doors 20:00-22:30 entry", "sheet_doors", "2026-10-20 20:00"],
      ["Start 19:00", "sheet_start", "2026-10-20 19:00"],
      ["Start doors 18:30, start 19:00", "sheet_start", "2026-10-20 19:00"],
      ["Start listed 18:00", "sheet_start", "2026-10-20 18:00"],
      ["Start 18:30 (listing)", "sheet_start", "2026-10-20 18:30"],
      ["Doors 18:30 / Start 19:00", "sheet_start", "2026-10-20 19:00"],
      ["Start 19:00 face-off", "sheet_start", "2026-10-20 19:00"],
      ["19:00 (Dice)", "sheet_start", "2026-10-20 19:00"],
      ["Start doors 18:30, show 20:00", "sheet_start", "2026-10-20 20:00"],
      ["19:30 (doors 18:30)", "sheet_start", "2026-10-20 19:30"],
      ["Ringwalks ~22:00", "sheet_start", "2026-10-20 22:00"],
      ["Doors 18:00 / Show 20:00 (venue approx end 22:25)", "sheet_start", "2026-10-20 20:00"],
    ];
    for (const [cell, source, clock] of cases) {
      const result = resolved(cell);
      assert.equal(result.status, "ok", cell);
      if (result.status !== "ok") continue;
      assert.equal(result.startTimeSource, source, cell);
      assert.equal(result.kickOffMs, parseSheetTime(clock, "uk"), cell);
    }
    for (const cell of [
      "Doors not given",
      "Start TBC",
      "Start doors TBC",
      "Start TBC (venue: TBA)",
      "Doors TBA",
      "Times TBA",
      "Not published (SURGE 5 readings from 22:30)",
    ]) {
      const result = resolved(cell);
      assert.equal(result.status, "ok", cell);
      if (result.status !== "ok") continue;
      assert.equal(result.startTimeSource, "derived_from_finish", cell);
      assert.equal(result.kickOffMs, (finishMs ?? 0) - 3 * 60 * 60 * 1000, cell);
      assert.notEqual(result.kickOffMs, parseSheetTime("2026-10-20 22:30", "uk"), cell);
    }
  });

  it("uses London time, rejects an impossible date, and rejects a start after the finish", () => {
    const winter = resolved("Start 15:00", "2026-01-15-SYN-GMT", "2026-01-15 18:00");
    const summer = resolved("Start 15:00", "2026-07-15-SYN-BST", "2026-07-15 18:00");
    assert.equal(winter.status, "ok");
    assert.equal(summer.status, "ok");
    if (winter.status !== "ok" || summer.status !== "ok") return;
    assert.equal(winter.kickOffMs, Date.parse("2026-01-15T15:00:00.000Z"));
    assert.equal(summer.kickOffMs, Date.parse("2026-07-15T14:00:00.000Z"));
    assert.equal(winter.startTimeSource, "sheet_start");
    const missing = resolved("Start 19:00", "2026-02-31-SYN-BAD", "2026-02-28 21:00");
    assert.equal(missing.status, "skip");
    const late = resolved("Start 23:00", "2026-10-20-O2-JCOLE", "2026-10-20 20:00");
    assert.equal(late.status, "reject");
    const noClock = resolved("Times TBA", "2026-10-20-O2-JCOLE", "");
    assert.equal(noClock.status, "skip");
    const gap = resolved("Start 01:30", "2026-03-29-SYN-DST", "2026-03-29 18:00");
    assert.equal(gap.status, "ok");
    if (gap.status !== "ok") return;
    assert.equal(gap.startTimeSource, "derived_from_finish");
    assert.equal(gap.kickOffMs, (parseSheetTime("2026-03-29 18:00", "uk") ?? 0) - 3 * 60 * 60 * 1000);
  });

  it("uses a recovered start, keeps the history count, and stores the sheet percent", () => {
    const result = plan([
      prior("01", "YES", {[KICKOFF]: "Start 19:00", [EXPECTED_FULL_TIME]: "2099-05-01 21:55"}),
      prior("08", "YES", {[KICKOFF]: "Doors 18:30", [EXPECTED_FULL_TIME]: "2099-05-08 21:55"}),
      prior("15", "NO", {[KICKOFF]: "Times TBA", [EXPECTED_FULL_TIME]: "2099-05-15 21:55"}),
      prior("22", "YES", {[KICKOFF]: "19:00 (Dice)", [EXPECTED_FULL_TIME]: "2099-05-22 21:55"}),
      eventRow(),
      eventRow({
        [EVENT_ID]: "2099-06-02-SYN-LATE",
        [KICKOFF]: "Start 23:00",
        [EXPECTED_FULL_TIME]: "2099-06-02 16:55",
      }),
    ]);
    assert.equal(result.rejected, 1);
    const record = result.records.find((item) => item.sheetEventId === "2099-06-01-SYN-AAA");
    if (!record || record.forecast.state !== "available") throw new Error("expected a forecast");
    assert.equal(record.startTimeSource, "sheet_exact");
    assert.equal(record.forecast.basedOnEvents, 4);
    assert.equal(record.forecast.confidencePercent, 85);
    assert.equal(record.forecast.confidenceSource, "events_tab");
    assert.equal(record.forecast.confidence, "low");
    const doors = result.records.find((item) => item.sheetEventId === "2099-05-08-SYN-P08");
    const derived = result.records.find((item) => item.sheetEventId === "2099-05-15-SYN-P15");
    if (!doors || !derived) throw new Error("recovered rows missing");
    assert.equal(doors.startTimeSource, "sheet_doors");
    assert.equal(derived.startTimeSource, "derived_from_finish");
    assert.equal(JSON.stringify(result).includes("47%"), false);
    assert.equal(JSON.stringify(result).includes("uplift"), false);
  });
});

describe("price guard", () => {
  it("rejects a fare field and a numeric confidence", () => {
    assert.throws(() => assertNoPrices({fare: "18.4"}), PriceLeakError);
    assert.throws(() => assertNoPrices({confidence: 0.8}), PriceLeakError);
    assert.doesNotThrow(() => assertNoPrices({
      confidence: "high",
      confidencePercent: 75,
      basedOnEvents: 4,
      state: "available",
      v: 1,
    }));
  });
});

describe("venue location lookup for rows without pickups", () => {
  it("looks up a known venue and refuses an unchecked name", () => {
    const o2 = lookupVenueLocation("The O2 arena, London");
    assert.ok(o2);
    assert.equal(o2.lat > 51 && o2.lat < 52, true);
    assert.equal(normVenueName("  The   O2 arena, London "), "the o2 arena london");
    assert.equal(lookupVenueLocation("Depot Mayfield (Warehouse Project), Manchester"), null);
  });

  it("places a no-pickup row at the venue table pin with empty pickups", () => {
    const result = plan([
      eventRow({
        [EVENT_ID]: "2099-08-01-O2-LOOKUP",
        [GROUND]: "The O2 arena, London",
        [PICKUP_POINTS]: "",
      }),
    ]);
    assert.equal(result.venueLookup, 1);
    assert.equal(result.skippedVenueUnverified, 0);
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record.positionSource, "venue_lookup");
    assert.deepEqual(record.pickupPoints, []);
    const known = lookupVenueLocation("The O2 arena, London");
    assert.ok(known);
    assert.equal(record.location.lat, known.lat);
    assert.equal(record.location.lng, known.lng);
    assert.equal(record.forecast.state, "no_prediction");
  });

  it("keeps an unchecked no-pickup venue off the map", () => {
    const result = plan([
      eventRow({
        [EVENT_ID]: "2099-08-02-UNK-LOOKUP",
        [GROUND]: "Depot Mayfield (Warehouse Project), Manchester",
        [PICKUP_POINTS]: "",
      }),
    ]);
    assert.equal(result.records.length, 0);
    assert.equal(result.venueLookup, 0);
    assert.equal(result.skippedVenueUnverified, 1);
    assert.equal(result.skipped >= 1, true);
  });

  it("still uses the pickup centroid when pickups exist", () => {
    const record = one([eventRow()]);
    assert.equal(record.positionSource, "pickup_centroid");
    assert.equal(record.pickupPoints.length > 0, true);
  });
});
