import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {commitCategoryForecasts} from "../src/surge/categoryCommit";
import {commitStadiumEvents, HOTSPOTS_COLLECTION, toFirestoreData} from "../src/surge/commit";
import {loadRecordedSurges, commitForecastHistory} from "../src/surge/forecastHistoryCommit";
import {PRE_EVENT_LEAD_MS} from "../src/surge/forecastHistory";
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
  PHASE,
  PICKUP_POINT,
  PICKUP_POINTS,
  CHECK_IN_HEADERS,
  CHECK_IN_PHASE,
  CHECK_IN_PLACE,
  NORMAL_FARE,
  READINGS_HEADERS,
  SURGE_END,
  SURGE_START,
  TIME_UK,
} from "../src/surge/headers";
import {planStadiumEvents} from "../src/surge/plan";
import {assertNoPrices} from "../src/surge/priceGuard";
import {runForecastHistory} from "../src/surge/recordForecastHistory";
import {matrix} from "../src/surge/syntheticSheet";
import {parseSheetTime} from "../src/surge/time";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-stadium-surge";
const FORECASTS = "hotspot_forecasts";
const START = Date.parse("2099-09-01T17:00:00.000Z");
const END = Date.parse("2099-09-01T19:00:00.000Z");
const FORECAST_START = Date.parse("2099-09-01T19:00:00.000Z");
const FORECAST_END = Date.parse("2099-09-01T22:00:00.000Z");
const AT = START - PRE_EVENT_LEAD_MS;
const HIS = "sheet_2099-09-01-SYN-HIS";
const UNK = "sheet_2099-09-01-SYN-UNK";

function forecast(strength = "medium", confidencePercent = 75) {
  return {
    state: "available",
    v: 1,
    startAt: Timestamp.fromDate(new Date(FORECAST_START)),
    endAt: Timestamp.fromDate(new Date(FORECAST_END)),
    strength,
    confidence: "low",
    confidencePercent,
    basedOnEvents: 4,
  };
}

function bounds() {
  return {
    window_start: Timestamp.fromDate(new Date(START)),
    events: {
      start_time: Timestamp.fromDate(new Date(START)),
      end_time: Timestamp.fromDate(new Date(END)),
    },
  };
}

describe("forecast history emulator", () => {
  const db = testDb(PROJECT);

  before(async () => {
    await clearDb(db);
    const snap = await db.collection(HOTSPOTS_COLLECTION).get();
    if (snap.empty) return;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  });

  async function runAt(
    nowMs: number,
    readings: Record<string, unknown>[] = [],
    post: Record<string, unknown>[] = [],
  ) {
    return runForecastHistory({
      now: new Date(nowMs),
      sheetId: "sheet-under-test",
      readingsTab: "Readings",
      checkInsTab: "Check-ins",
      load: async () => ({
        readings: matrix(READINGS_HEADERS, readings),
        checkIns: matrix(CHECK_IN_HEADERS, post),
      }),
      listPins: async () => {
        const snap = await db.collection(HOTSPOTS_COLLECTION).get();
        return snap.docs.map((doc) => ({id: doc.id, data: doc.data() as Record<string, unknown>}));
      },
      commit: (proposals) => commitForecastHistory(db, proposals),
    });
  }

  it("writes the snapshot once at T-4h and does not overwrite it", async () => {
    await db.collection(HOTSPOTS_COLLECTION).doc(HIS).set({
      idSource: "sheet_event",
      sheetEventId: "2099-09-01-SYN-HIS",
      name: "Home Side v Away Side",
      category: "event",
      jobs_accepted: 4,
      surgeEnded: false,
      ...bounds(),
      window_end: Timestamp.fromDate(new Date(END + 3 * 60 * 60 * 1000)),
      forecast: forecast(),
    });
    await db.collection(HOTSPOTS_COLLECTION).doc("tm_hist").set({
      name: "Keep this name",
      category: "events",
      city: "Glasgow",
      jobs_accepted: 4,
      starting_time: Timestamp.fromDate(new Date(START)),
      ending_time: Timestamp.fromDate(new Date(END)),
      window_end: Timestamp.fromDate(new Date(END + 3 * 60 * 60 * 1000)),
      forecast: forecast(),
    });
    await db.collection(HOTSPOTS_COLLECTION).doc(UNK).set({
      idSource: "sheet_event",
      sheetEventId: "2099-09-01-SYN-UNK",
      name: "No checks",
      category: "event",
      ...bounds(),
      window_end: Timestamp.fromDate(new Date(END + 3 * 60 * 60 * 1000)),
      forecast: {state: "no_prediction"},
    });
    await db.collection(HOTSPOTS_COLLECTION).doc("parking_keep").set({
      category: "parking",
      note: "keep-parking",
    });

    const early = await runAt(AT - 60 * 1000);
    assert.equal(early.written, 0);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(HIS).get()).get("forecastHistory"), undefined);

    const first = await runAt(AT);
    assert.equal(first.written, 3);
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc(HIS).get();
    const forecastPin = await db.collection(FORECASTS).doc(HIS).get();
    assert.equal(pin.get("forecastHistory"), undefined);
    const preEvent = forecastPin.get("forecastHistory").preEvent;
    assert.equal(preEvent.state, "available");
    assert.equal(preEvent.snapshotAt.toMillis(), AT);
    assert.equal(preEvent.strength, "medium");
    assert.equal(preEvent.confidencePercent, 75);
    assert.equal(preEvent.basedOnEvents, 4);
    assert.equal(preEvent.startAt.toMillis(), FORECAST_START);
    assert.equal(preEvent.endAt.toMillis(), FORECAST_END);
    assert.equal(preEvent.confidence, undefined);
    assert.equal(forecastPin.get("forecastHistory").outcome, undefined);
    assert.equal(pin.get("forecast").confidencePercent, 75);
    assert.equal(pin.get("jobs_accepted"), 4);

    const category = await db.collection(FORECASTS).doc("tm_hist").get();
    assert.equal(category.get("forecastHistory").preEvent.confidencePercent, 75);
    assert.equal(category.get("forecastHistory").preEvent.snapshotAt.toMillis(), AT);
    const unknown = await db.collection(FORECASTS).doc(UNK).get();
    assert.equal(unknown.get("forecastHistory").preEvent.state, "no_prediction");
    assert.deepEqual(Object.keys(unknown.get("forecastHistory").preEvent).sort(), ["snapshotAt", "state"]);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc("parking_keep").get()).get("forecastHistory"), undefined);

    await db.collection(HOTSPOTS_COLLECTION).doc(HIS).update({
      forecast: forecast("high", 10),
    });
    const second = await runAt(AT + 20 * 60 * 1000);
    assert.equal(second.written, 0);
    const kept = await db.collection(HOTSPOTS_COLLECTION).doc(HIS).get();
    const keptForecast = await db.collection(FORECASTS).doc(HIS).get();
    assert.equal(kept.get("forecast").confidencePercent, 10);
    assert.equal(kept.get("forecastHistory"), undefined);
    assert.equal(keptForecast.get("forecastHistory").preEvent.confidencePercent, 75);
    assert.equal(keptForecast.get("forecastHistory").preEvent.strength, "medium");
    assert.equal(keptForecast.get("forecastHistory").preEvent.snapshotAt.toMillis(), AT);
  });

  it("records unknown when there are no post-event checks, then the outcome from the checks", async () => {
    const beforeReadings = await runAt(END);
    assert.equal(beforeReadings.unknown >= 1, true);
    const bare = await db.collection(FORECASTS).doc(HIS).get();
    assert.equal(bare.get("forecastHistory").outcome.surged, "unknown");
    assert.equal(bare.get("forecastHistory").outcome.readingCount, 0);
    assert.deepEqual(bare.get("forecastHistory").outcome.readingTimes, []);
    assert.equal(bare.get("forecastHistory").preEvent.snapshotAt.toMillis(), AT);
    assert.equal((await db.collection(FORECASTS).doc(UNK).get()).get("forecastHistory").outcome.surged, "unknown");

    const post = {
      [CHECK_IN_PLACE]: "2099-09-01-SYN-HIS",
      [TIME_UK]: "2099-09-01 20:10",
      [CHECK_IN_PHASE]: "Post",
      [PICKUP_POINT]: "North Gate",
      [DID_IT_SURGE]: "YES",
      [FARE_SHOWN]: "27.65",
      [NORMAL_FARE]: "18.40",
    };
    const ignored = [
      {...post, [TIME_UK]: "2099-09-01 13:00", [CHECK_IN_PHASE]: "Pre"},
      {...post, [TIME_UK]: "2099-09-01 20:40", [CHECK_IN_PHASE]: "Fixed", [DID_IT_SURGE]: "NO"},
    ];
    const after = await runAt(END + 60 * 60 * 1000, [
      {
        [TIME_UK]: "2099-09-01 20:25",
        [EVENT_ID]: "2099-09-01-SYN-HIS",
        [PHASE]: "Post",
        [PICKUP_POINT]: "North Gate",
        [DID_IT_SURGE]: "YES",
        [FARE_SHOWN]: "27.65",
        [BASELINE_FARE]: "18.40",
      },
      {
        [TIME_UK]: "2099-09-01 19:00",
        [EVENT_ID]: "2099-09-01-SYN-HIS",
        [PHASE]: "During",
        [PICKUP_POINT]: "North Gate",
        [FARE_SHOWN]: "27.65",
        [BASELINE_FARE]: "18.40",
        "Uplift %": "47%",
      },
    ], [post, ...ignored]);
    assert.equal(after.known, 1);
    const pin = await db.collection(FORECASTS).doc(HIS).get();
    const outcome = pin.get("forecastHistory").outcome;
    assert.equal(outcome.surged, "yes");
    assert.equal(outcome.strength, "medium");
    assert.equal(outcome.readingCount, 2);
    assert.equal(outcome.windowStartAt.toMillis(), parseSheetTime("2099-09-01 20:10", "uk"));
    assert.equal(outcome.windowEndAt.toMillis(), parseSheetTime("2099-09-01 20:25", "uk"));
    assert.equal(outcome.readingTimes.length, 2);
    assert.equal(pin.get("forecastHistory").preEvent.confidencePercent, 75);
    assert.equal(pin.get("forecastHistory").preEvent.snapshotAt.toMillis(), AT);
    const pinData = (await db.collection(HOTSPOTS_COLLECTION).doc(HIS).get()).data();
    const raw = JSON.stringify(pin.data()) + JSON.stringify(pinData);
    for (const token of ["27.65", "18.40", "18.4", "47%", "£", "fare", "baseline", "uplift", "uber", "price"]) {
      assert.equal(raw.toLowerCase().includes(token.toLowerCase()), false, token);
    }
    assertNoPrices(pin.get("forecastHistory"));
    const stillUnknown = await db.collection(FORECASTS).doc(UNK).get();
    assert.equal(stillUnknown.get("forecastHistory").outcome.surged, "unknown");
    assert.equal(stillUnknown.get("forecastHistory").outcome.readingCount, 0);
    const categoryPin = await db.collection(HOTSPOTS_COLLECTION).doc("tm_hist").get();
    const category = await db.collection(FORECASTS).doc("tm_hist").get();
    assert.equal(category.get("forecastHistory").outcome.surged, "unknown");
    assert.equal(categoryPin.get("name"), "Keep this name");
    assert.equal(categoryPin.get("forecastHistory"), undefined);

    const again = await runAt(END + 60 * 60 * 1000, [
      {
        [TIME_UK]: "2099-09-01 20:25",
        [EVENT_ID]: "2099-09-01-SYN-HIS",
        [PHASE]: "Post",
        [PICKUP_POINT]: "North Gate",
        [DID_IT_SURGE]: "YES",
        [FARE_SHOWN]: "27.65",
        [BASELINE_FARE]: "18.40",
      },
    ], [post, ...ignored]);
    assert.equal(again.written, 0);
    const recorded = await loadRecordedSurges(db);
    assert.deepEqual(recorded.map((item) => item.sheetEventId).sort(), ["2099-09-01-SYN-HIS"]);
    assert.equal(recorded[0].surged, "yes");
    assert.equal(recorded[0].strength, "medium");
  });

  it("leaves sync and category forecast writes on their own fields", async () => {
    const hospital = planStadiumEvents({
      now: new Date("2099-07-04T10:00:00.000Z"),
      events: matrix([...EVENTS_HEADERS, "Venue type"], [{
        [EVENT_ID]: "2099-07-04-HOSP-01",
        [HOME_TEAM]: "",
        "Away team": "",
        [GROUND]: "Synthetic General Hospital",
        [KICKOFF]: "2099-07-04 18:00",
        [EXPECTED_FULL_TIME]: "2099-07-04 20:00",
        [SURGE_START]: "2099-07-04 20:00",
        [SURGE_END]: "2099-07-04 22:00",
        [HARD_STOP]: "2099-07-04 23:00",
        [PICKUP_POINTS]: "Main entrance | 51.501001, -0.101001",
        [DID_IT_SURGE]: "PENDING",
        "Venue type": "Hospital",
      }]),
      readings: matrix(READINGS_HEADERS, []),
    });
    assert.equal(hospital.records.length, 1);
    assert.equal(hospital.records[0].forecast.state, "no_prediction");
    assert.equal(hospital.records[0].category, "hospital");
    assert.equal(hospital.records[0].surgeEnded, false);
    assert.equal("forecastHistory" in toFirestoreData(hospital.records[0]), false);
    await commitStadiumEvents(db, hospital.records);
    const quiet = await runAt(Date.parse("2099-07-04T10:00:00.000Z"));
    assert.equal(quiet.written, 0);
    const hosp = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-07-04-HOSP-01").get();
    const hospForecast = await db.collection(FORECASTS).doc("sheet_2099-07-04-HOSP-01").get();
    assert.equal(hosp.get("forecast"), undefined);
    assert.equal(hospForecast.get("forecast").state, "no_prediction");
    assert.equal(hospForecast.get("forecast").confidencePercent, null);
    assert.equal(hospForecast.get("forecast").confidenceSource, "none");
    assert.deepEqual(Object.keys(hospForecast.get("forecast")).sort(), [
      "confidencePercent",
      "confidenceSource",
      "state",
    ]);
    assert.equal(hosp.get("category"), "hospital");
    assert.equal(hosp.get("surgeEnded"), false);
    assert.equal(hosp.get("forecastHistory"), undefined);
    assert.equal(hosp.get("idSource"), "sheet_event");

    const replay = planStadiumEvents({
      now: new Date("2099-09-01T12:00:00.000Z"),
      events: matrix(EVENTS_HEADERS, [{
        [EVENT_ID]: "2099-09-01-SYN-HIS",
        [HOME_TEAM]: "Home Side",
        "Away team": "Away Side",
        [GROUND]: "Synthetic Park",
        [KICKOFF]: "2099-09-01 18:00",
        [EXPECTED_FULL_TIME]: "2099-09-01 20:00",
        [SURGE_START]: "2099-09-01 20:00",
        [SURGE_END]: "2099-09-01 22:00",
        [HARD_STOP]: "2099-09-01 23:00",
        [PICKUP_POINTS]: "North Gate | 51.701001, -0.301001",
        [DID_IT_SURGE]: "PENDING",
      }]),
      readings: matrix(READINGS_HEADERS, []),
    });
    await commitStadiumEvents(db, replay.records);
    const afterSync = await db.collection(HOTSPOTS_COLLECTION).doc(HIS).get();
    const afterSyncForecast = await db.collection(FORECASTS).doc(HIS).get();
    assert.equal(afterSync.get("jobs_accepted"), 4);
    assert.equal(afterSyncForecast.get("forecast").state, "no_prediction");
    assert.equal(afterSyncForecast.get("forecast").startAt, undefined);
    assert.equal(afterSyncForecast.get("forecastHistory").preEvent.confidencePercent, 75);
    assert.equal(afterSyncForecast.get("forecastHistory").preEvent.snapshotAt.toMillis(), AT);
    assert.equal(afterSyncForecast.get("forecastHistory").outcome.surged, "yes");
    assert.equal(afterSync.get("surgeEnded"), false);

    const beforeCategory = await db.collection(FORECASTS).doc("tm_hist").get();
    const snapshotAt = beforeCategory.get("forecastHistory").preEvent.snapshotAt.toMillis();
    await commitCategoryForecasts(db, [{
      id: "tm_hist",
      forecast: {state: "no_prediction"},
      forecastSource: "sheet_venue_history",
      updatedAt: "2099-09-01T21:00:00.000Z",
    }]);
    const afterCategory = await db.collection(HOTSPOTS_COLLECTION).doc("tm_hist").get();
    const afterCategoryForecast = await db.collection(FORECASTS).doc("tm_hist").get();
    assert.equal(afterCategory.get("name"), "Keep this name");
    assert.equal(afterCategory.get("jobs_accepted"), 4);
    assert.equal(afterCategory.get("forecastSource"), undefined);
    assert.equal(afterCategoryForecast.get("forecast").state, "no_prediction");
    assert.equal(afterCategoryForecast.get("forecastSource"), "sheet_venue_history");
    assert.ok(afterCategoryForecast.get("forecastUpdatedAt") instanceof Timestamp);
    assert.equal(afterCategoryForecast.get("forecastHistory").preEvent.snapshotAt.toMillis(), snapshotAt);
    assert.equal(afterCategoryForecast.get("forecastHistory").outcome.surged, "unknown");
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc("parking_keep").get()).get("note"), "keep-parking");
  });
});
