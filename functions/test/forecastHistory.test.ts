import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {planCategoryForecasts, stationIdentity, type HotspotPin} from "../src/surge/categoryPlan";
import {toFirestoreData} from "../src/surge/commit";
import {toForecastHistoryData} from "../src/surge/forecastHistoryCommit";
import {
  PRE_EVENT_LEAD_MS,
  applyRecordedOutcomes,
  mergeForecastHistory,
  postEventOutcomes,
  proposeForecastHistory,
  sameForecastHistory,
  type HistoryPin,
  type RecordedSurge,
} from "../src/surge/forecastHistory";
import {
  BASELINE_FARE,
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
  POST_EVENT_HEADERS,
  READINGS_HEADERS,
  SURGE_END,
  SURGE_START,
  TIME_UK,
  UPLIFT_PERCENT,
} from "../src/surge/headers";
import {planStadiumEvents} from "../src/surge/plan";
import {assertNoPrices} from "../src/surge/priceGuard";
import {isMissingTabError} from "../src/surge/sheets";
import {runForecastHistory} from "../src/surge/recordForecastHistory";
import {matrix} from "../src/surge/syntheticSheet";
import {parseSheetTime} from "../src/surge/time";
import {runStadiumSurgeSync} from "../src/surge/syncStadiumSurgeSheet";
import {lookupVenueLocation} from "../src/surge/venueLocations";

const START = Date.parse("2099-09-01T17:00:00.000Z");
const END = Date.parse("2099-09-01T19:00:00.000Z");
const FORECAST_START = Date.parse("2099-09-01T19:00:00.000Z");
const FORECAST_END = Date.parse("2099-09-01T22:00:00.000Z");
const GATE = "North Gate | 51.701001, -0.301001";
const HEADERS = [...EVENTS_HEADERS];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sheetPin(forecast: Record<string, unknown> = {}): HistoryPin {
  return {
    id: "sheet_2099-09-01-SYN-HIS",
    data: {
      sheetEventId: "2099-09-01-SYN-HIS",
      window_start: iso(START),
      events: {end_time: iso(END)},
      forecast: {
        state: "available",
        v: 1,
        startAt: iso(FORECAST_START),
        endAt: iso(FORECAST_END),
        strength: "medium",
        confidence: "high",
        confidencePercent: 75,
        basedOnEvents: 4,
        ...forecast,
      },
    },
  };
}

function reading(over: Record<string, unknown>): Record<string, unknown> {
  return {
    [TIME_UK]: "2099-09-01 20:10",
    [EVENT_ID]: "2099-09-01-SYN-HIS",
    [PHASE]: "Post",
    [PICKUP_POINT]: "North Gate",
    [DID_IT_SURGE]: "",
    [FARE_SHOWN]: "",
    [BASELINE_FARE]: "",
    ...over,
  };
}

function assertClean(value: unknown): void {
  const raw = JSON.stringify(value);
  for (const token of ["27.65", "18.40", "18.4", "47%", "55%", "80%", "£", "fare", "baseline", "uplift", "uber"]) {
    assert.equal(raw.toLowerCase().includes(token.toLowerCase()), false, token);
  }
  assertNoPrices(value);
}

function eventRow(
  id: string,
  day: string,
  outcome: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [EVENT_ID]: id,
    [HOME_TEAM]: "Home Side",
    [GROUND]: "Synthetic Park",
    "Away team": "Away Side",
    [KICKOFF]: `${day} 15:00`,
    [EXPECTED_FULL_TIME]: `${day} 16:55`,
    [SURGE_START]: `${day} 16:55`,
    [SURGE_END]: `${day} 19:00`,
    [HARD_STOP]: `${day} 19:55`,
    [PICKUP_POINTS]: GATE,
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: "",
    ...over,
  };
}

function recorded(id: string, surged: "yes" | "no", strength: "low" | "medium" | "high" | null): RecordedSurge {
  return {sheetEventId: id, surged, strength};
}

describe("post-event checks", () => {
  it("judges a surge from post-event rows and drops the fare", () => {
    const outcomes = postEventOutcomes(matrix(READINGS_HEADERS, [
      reading({[DID_IT_SURGE]: "YES", [FARE_SHOWN]: "27.65", [BASELINE_FARE]: "18.40"}),
      reading({
        [TIME_UK]: "2099-09-01 20:25",
        [DID_IT_SURGE]: "YES",
        [FARE_SHOWN]: "27.65",
        [BASELINE_FARE]: "18.40",
      }),
      reading({[TIME_UK]: "2099-09-01 19:00", [PHASE]: "During", [FARE_SHOWN]: "27.65", [BASELINE_FARE]: "18.40"}),
    ]), matrix(POST_EVENT_HEADERS, []));
    const outcome = outcomes.get("2099-09-01-SYN-HIS");
    if (!outcome) throw new Error("missing outcome");
    assert.equal(outcome.surged, "yes");
    assert.equal(outcome.strength, "medium");
    assert.equal(outcome.readingCount, 2);
    assert.deepEqual(outcome.readingTimes, [
      iso(parseSheetTime("2099-09-01 20:10", "uk") ?? 0),
      iso(parseSheetTime("2099-09-01 20:25", "uk") ?? 0),
    ]);
    assert.equal(outcome.windowStartAt, outcome.readingTimes[0]);
    assert.equal(outcome.windowEndAt, outcome.readingTimes[1]);
    assertClean(outcome);
  });

  it("uses an explicit NO even when the fare is high, and a blank row decides nothing", () => {
    const explicit = postEventOutcomes(matrix(READINGS_HEADERS, [
      reading({[DID_IT_SURGE]: "NO", [FARE_SHOWN]: "27.65", [BASELINE_FARE]: "18.40"}),
    ]), []);
    const no = explicit.get("2099-09-01-SYN-HIS");
    assert.equal(no?.surged, "no");
    assert.equal(no?.strength, undefined);
    assert.equal(no?.windowStartAt, undefined);

    const blank = postEventOutcomes(matrix(READINGS_HEADERS, [reading({})]), []);
    const unknown = blank.get("2099-09-01-SYN-HIS");
    assert.equal(unknown?.surged, "unknown");
    assert.equal(unknown?.readingCount, 1);
    assertClean(unknown);
  });

  it("reads the proposed tab, a percent cell, and does not double-count one check", () => {
    const fromPercent = postEventOutcomes(matrix(READINGS_HEADERS, [
      reading({[TIME_UK]: "2099-09-01 20:40", [PICKUP_POINT]: "South Gate", [UPLIFT_PERCENT]: "55%"}),
    ]), []);
    assert.equal(fromPercent.get("2099-09-01-SYN-HIS")?.surged, "yes");
    assert.equal(fromPercent.get("2099-09-01-SYN-HIS")?.strength, "medium");
    assertClean(fromPercent.get("2099-09-01-SYN-HIS"));

    const doubled = postEventOutcomes(
      matrix(READINGS_HEADERS, [reading({[DID_IT_SURGE]: "YES"})]),
      matrix(POST_EVENT_HEADERS, [{
        [EVENT_ID]: "2099-09-01-SYN-HIS",
        [TIME_UK]: "2099-09-01 20:10",
        [PICKUP_POINT]: "North Gate",
        [DID_IT_SURGE]: "YES",
      }]),
    );
    assert.equal(doubled.get("2099-09-01-SYN-HIS")?.readingCount, 1);

    const clash = postEventOutcomes(
      matrix(READINGS_HEADERS, [reading({[DID_IT_SURGE]: "YES"})]),
      matrix(POST_EVENT_HEADERS, [{
        [EVENT_ID]: "2099-09-01-SYN-HIS",
        [TIME_UK]: "2099-09-01 20:10",
        [PICKUP_POINT]: "North Gate",
        [DID_IT_SURGE]: "NO",
      }]),
    );
    assert.equal(clash.get("2099-09-01-SYN-HIS")?.surged, "unknown");
  });

  it("has no outcome when the only rows are during the event", () => {
    const outcomes = postEventOutcomes(matrix(READINGS_HEADERS, [
      reading({[PHASE]: "During", [DID_IT_SURGE]: "YES", [FARE_SHOWN]: "27.65", [BASELINE_FARE]: "18.40"}),
    ]), []);
    assert.equal(outcomes.size, 0);
  });
});

describe("pre-event snapshot", () => {
  const at = START - PRE_EVENT_LEAD_MS;

  it("freezes the forecast at four hours before the start and not a minute earlier", () => {
    assert.equal(proposeForecastHistory(sheetPin(), at - 60 * 1000, new Map()), null);
    const proposal = proposeForecastHistory(sheetPin(), at, new Map());
    if (!proposal?.preEvent || proposal.preEvent.state !== "available") throw new Error("missing snapshot");
    assert.equal(proposal.preEvent.snapshotAt, iso(at));
    assert.equal(proposal.preEvent.strength, "medium");
    assert.equal(proposal.preEvent.confidencePercent, 75);
    assert.equal(proposal.preEvent.basedOnEvents, 4);
    assert.equal(proposal.preEvent.startAt, iso(FORECAST_START));
    assert.equal(proposal.preEvent.endAt, iso(FORECAST_END));
    assert.equal("confidence" in proposal.preEvent, false);
    assert.equal(proposal.outcome, undefined);
    assertClean(proposal);
  });

  it("does not invent a snapshot after the event has started", () => {
    const started = proposeForecastHistory(sheetPin(), START, new Map());
    assert.equal(started, null);
    const finished = proposeForecastHistory(sheetPin(), END, new Map());
    assert.equal(finished?.preEvent, undefined);
    assert.equal(finished?.outcome?.surged, "unknown");
    assert.equal(finished?.outcome?.readingCount, 0);
  });

  it("keeps the first snapshot and does not wipe a yes when the next read is empty", () => {
    const first = proposeForecastHistory(sheetPin(), at, new Map());
    if (!first?.preEvent) throw new Error("missing snapshot");
    const later = proposeForecastHistory(sheetPin({confidencePercent: 10, strength: "high"}), at + 20 * 60 * 1000, new Map());
    const kept = mergeForecastHistory({preEvent: first.preEvent}, later ?? {id: first.id});
    assert.equal(kept?.preEvent?.confidencePercent, 75);
    assert.equal(kept?.preEvent?.strength, "medium");
    assert.equal(kept?.preEvent?.snapshotAt, iso(at));

    const withYes = mergeForecastHistory(kept, {
      id: first.id,
      outcome: {
        surged: "yes",
        strength: "medium",
        readingCount: 1,
        readingTimes: [iso(END)],
        windowStartAt: iso(END),
        windowEndAt: iso(END),
      },
    });
    const still = mergeForecastHistory(withYes, {
      id: first.id,
      outcome: {surged: "unknown", readingCount: 0, readingTimes: []},
    });
    assert.equal(still?.outcome?.surged, "yes");
    assert.equal(still?.preEvent?.snapshotAt, iso(at));
    assert.equal(sameForecastHistory(withYes, still), true);
  });

  it("leaves a category pin unknown when no check names that pin", () => {
    const outcomes = postEventOutcomes(matrix(READINGS_HEADERS, [
      reading({[DID_IT_SURGE]: "YES", [FARE_SHOWN]: "27.65", [BASELINE_FARE]: "18.40"}),
    ]), []);
    const pin: HistoryPin = {
      id: "tm_hist",
      data: {
        category: "events",
        starting_time: iso(START),
        ending_time: iso(END),
        forecast: sheetPin().data.forecast,
      },
    };
    const proposal = proposeForecastHistory(pin, END, outcomes);
    assert.equal(proposal?.outcome?.surged, "unknown");
    assert.equal(proposal?.outcome?.readingCount, 0);
  });

  it("uses the same hour window a station pin already uses", () => {
    const id = "910GBARKING_2099-06-01_H09";
    const station = stationIdentity(id);
    if (!station) throw new Error("missing station");
    const now = station.startMs - PRE_EVENT_LEAD_MS;
    const pin: HistoryPin = {id, data: {category: "travel disruptions", forecast: {state: "no_prediction"}}};
    const proposal = proposeForecastHistory(pin, now, new Map());
    assert.equal(proposal?.preEvent?.state, "no_prediction");
    assert.deepEqual(Object.keys(proposal?.preEvent ?? {}).sort(), ["snapshotAt", "state"]);
    assert.equal(proposeForecastHistory(pin, now - 1, new Map()), null);
    const clash: HistoryPin = {
      id,
      data: {
        forecast: {state: "no_prediction"},
        starting_time: iso(station.startMs + 60 * 1000),
        ending_time: iso(station.endMs + 60 * 1000),
      },
    };
    assert.equal(proposeForecastHistory(clash, now, new Map()), null);
  });
});

describe("recorded outcomes stay inside the existing history rules", () => {
  const future = eventRow("2099-06-01-SYN-AAA", "2099-06-01", "PENDING");

  function sheet(rows: Record<string, unknown>[], recordedOutcomes?: RecordedSurge[]) {
    return planStadiumEvents({
      now: new Date("2099-08-01T12:00:00.000Z"),
      events: matrix(HEADERS, rows),
      readings: matrix(READINGS_HEADERS, []),
      recordedOutcomes,
    });
  }

  function forecastOf(rows: Record<string, unknown>[], recordedOutcomes?: RecordedSurge[]) {
    const found = sheet(rows, recordedOutcomes).records.find((item) => item.sheetEventId === "2099-06-01-SYN-AAA");
    if (!found) throw new Error("missing future event");
    return found.forecast;
  }

  it("counts a pending row once a recorded yes exists, and still requires three", () => {
    const two = ["01", "08"].map((day) => eventRow(`2099-05-${day}-SYN-P${day}`, `2099-05-${day}`, "PENDING"));
    const three = [...two, eventRow("2099-05-15-SYN-P15", "2099-05-15", "PENDING")];
    const recordedYes = three.map((row) => recorded(String(row[EVENT_ID]), "yes", "medium"));
    assert.equal(forecastOf([...two, future]).state, "no_prediction");
    assert.equal(forecastOf([...two, future], recordedYes.slice(0, 2)).state, "no_prediction");
    const forecast = forecastOf([...three, future], recordedYes);
    if (forecast.state !== "available") throw new Error("expected a forecast");
    assert.equal(forecast.confidencePercent, 100);
    assert.equal(forecast.basedOnEvents, 3);
    assert.equal(forecast.strength, "medium");
    assert.equal(forecast.confidence, "low");
    assertClean(forecast);
  });

  it("does not let a recorded answer replace a yes or no already on the sheet", () => {
    const priors = ["01", "08", "15"].map((day) => eventRow(
      `2099-05-${day}-SYN-P${day}`,
      `2099-05-${day}`,
      "YES",
      {[PEAK_UPLIFT]: "47%"},
    ));
    const closedNo = eventRow("2099-05-22-SYN-P22", "2099-05-22", "NO");
    const forecast = forecastOf(
      [...priors, closedNo, future],
      [recorded("2099-05-22-SYN-P22", "yes", "high")],
    );
    if (forecast.state !== "available") throw new Error("expected a forecast");
    assert.equal(forecast.confidencePercent, 75);
    assert.equal(forecast.basedOnEvents, 4);
    assert.equal(forecast.strength, "medium");

    const bare = ["01", "08", "15"].map((day) => eventRow(`2099-05-${day}-SYN-P${day}`, `2099-05-${day}`, "YES"));
    const unchanged = forecastOf(bare.concat(future), bare.map((row) => recorded(String(row[EVENT_ID]), "yes", "high")));
    assert.equal(unchanged.state, "no_prediction");

    const peaked = ["01", "08", "15"].map((day) => eventRow(
      `2099-05-${day}-SYN-P${day}`,
      `2099-05-${day}`,
      "PENDING",
      {[PEAK_UPLIFT]: "80%"},
    ));
    const keptPeak = forecastOf(peaked.concat(future), peaked.map((row) => recorded(String(row[EVENT_ID]), "yes", "low")));
    if (keptPeak.state !== "available") throw new Error("expected the sheet peak");
    assert.equal(keptPeak.strength, "high");
    assertClean(sheet(peaked.concat(future), peaked.map((row) => recorded(String(row[EVENT_ID]), "yes", "low"))));
  });

  it("still withholds a category forecast until the venue has four completed rows", () => {
    const venue = lookupVenueLocation("OVO Hydro, Glasgow");
    if (!venue) throw new Error("missing venue");
    const rows = ["01", "02", "03", "04"].map((day, index) => ({
      [EVENT_ID]: `2099-05-${day}-HYD-H${index}`,
      [HOME_TEAM]: `Artist ${day}`,
      [GROUND]: "OVO Hydro, Glasgow",
      [KICKOFF]: `2099-05-${day} 15:00`,
      [DID_IT_SURGE]: "PENDING",
      [PEAK_UPLIFT]: "",
    }));
    const pin: HotspotPin = {
      id: "tm_hydro",
      data: {
        category: "events",
        city: "Glasgow",
        location: venue,
        starting_time: "2099-06-01T16:00:00.000Z",
        ending_time: "2099-06-01T19:00:00.000Z",
        events: {venue_name: "OVO Hydro"},
      },
    };
    const recordedAll = rows.map((row) => recorded(String(row[EVENT_ID]), "yes", "medium"));
    const plan = (count: number) => planCategoryForecasts({
      now: new Date("2099-08-01T12:00:00.000Z"),
      events: matrix(HEADERS, rows),
      tpcLog: matrix(["Disruption ID"], []),
      tpcReadings: matrix(["Event ID"], []),
      pins: [pin],
      recordedOutcomes: recordedAll.slice(0, count),
    }).patches.find((item) => item.id === "tm_hydro");
    assert.equal(plan(0)?.forecast.state, "no_prediction");
    assert.equal(plan(3)?.forecast.state, "no_prediction");
    const full = plan(4)?.forecast;
    if (!full || full.state !== "available") throw new Error("expected a venue forecast");
    assert.equal(full.basedOnEvents, 4);
    assert.equal(full.confidencePercent, 100);
    assert.equal(full.strength, "medium");
    assertClean(full);
  });

  it("passes recorded outcomes through the existing runners and leaves their writes alone", async () => {
    const priors = ["01", "08", "15"].map((day) => eventRow(`2099-05-${day}-SYN-P${day}`, `2099-05-${day}`, "PENDING"));
    const recordedYes = priors.map((row) => recorded(String(row[EVENT_ID]), "yes", "medium"));
    const events = matrix(HEADERS, [...priors, future]);
    let seen = "";
    await runStadiumSurgeSync({
      now: new Date("2099-08-01T12:00:00.000Z"),
      sheetId: "sheet-under-test",
      eventsTab: "Events",
      readingsTab: "Readings",
      recordedOutcomes: recordedYes,
      load: async () => ({events, readings: matrix(READINGS_HEADERS, [])}),
      commit: async (records) => {
        const found = records.find((record) => record.sheetEventId === "2099-06-01-SYN-AAA");
        seen = found?.forecast.state ?? "";
        const data = found ? toFirestoreData(found) : {};
        assert.equal("forecastHistory" in data, false);
        return records.length;
      },
    });
    assert.equal(seen, "available");

    let loaded = 0;
    const skipped = await runForecastHistory({
      now: new Date("2099-09-01T14:00:00.000Z"),
      sheetId: "  ",
      readingsTab: "Readings",
      postEventTab: "Post-event checks",
      load: async () => {
        loaded += 1;
        return {readings: [], postEvent: []};
      },
      listPins: async () => [],
      commit: async () => 0,
    });
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.reason, "sheet-id-missing");
    assert.equal(loaded, 0);

    const payload = toForecastHistoryData({
      preEvent: {
        snapshotAt: iso(START - PRE_EVENT_LEAD_MS),
        state: "available",
        strength: "medium",
        confidencePercent: 75,
        basedOnEvents: 4,
        startAt: iso(FORECAST_START),
        endAt: iso(FORECAST_END),
      },
      outcome: {surged: "unknown", readingCount: 0, readingTimes: []},
    });
    assert.ok(payload.preEvent && (payload.preEvent as {snapshotAt: Timestamp}).snapshotAt instanceof Timestamp);
    assert.equal("confidence" in (payload.preEvent as object), false);
    assertClean(payload);
    assert.equal(applyRecordedOutcomes([], recordedYes).length, 0);
  });
});

describe("the history job does not take over the other writers", () => {
  it("keeps the sheet reads read-only and exports the new function beside the old ones", () => {
    const root = join(__dirname, "../src/surge");
    const sheets = readFileSync(join(root, "sheets.ts"), "utf8");
    assert.match(sheets, /spreadsheets\.readonly/);
    assert.equal(/values:append|batchUpdate|spreadsheets\.values\.update/.test(sheets), false);
    const historyCommit = readFileSync(join(root, "forecastHistoryCommit.ts"), "utf8");
    assert.equal(historyCommit.includes(".delete("), false);
    assert.equal(historyCommit.includes("recursiveDelete"), false);
    assert.equal(readFileSync(join(root, "commit.ts"), "utf8").includes("forecastHistory"), false);
    assert.equal(readFileSync(join(root, "categoryCommit.ts"), "utf8").includes("forecastHistory"), false);
    assert.equal(readFileSync(join(root, "backtest.ts"), "utf8").includes("forecastHistory"), false);
    const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    assert.match(index, /export \{syncSurgeSheetEvents\}/);
    assert.match(index, /export \{attachCategoryForecasts\}/);
    assert.match(index, /export \{recordForecastHistory\}/);
    const job = readFileSync(join(root, "recordForecastHistory.ts"), "utf8");
    assert.match(job, /onSchedule\(SURGE_SHEET_SCHEDULE/);
    assert.equal(job.includes("serviceAccount"), false);
    assert.equal(isMissingTabError(new Error("Unable to parse range: 'Post-event checks'")), true);
    assert.equal(isMissingTabError({response: {status: 404}}), true);
    assert.equal(isMissingTabError({response: {status: 500}}), false);
    assert.equal(POST_EVENT_HEADERS.includes("Did it surge?"), true);
  });
});
