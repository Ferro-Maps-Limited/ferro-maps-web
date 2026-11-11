import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {commitCategoryForecasts} from "../src/surge/categoryCommit";
import {commitStadiumEvents} from "../src/surge/commit";
import {HOTSPOTS_COLLECTION} from "../src/surge/collections";
import {
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  PICKUP_POINTS,
  SURGE_END,
  SURGE_START,
} from "../src/surge/headers";
import {planStadiumEvents} from "../src/surge/plan";
import {matrix} from "../src/surge/syntheticSheet";
import {
  HOTSPOTS_TEST_FORECAST_FIELDS,
  removeHotspotsTestForecastFields,
} from "../scripts/removeHotspotsTestForecastFields";
import {clearDb, testDb} from "./support";

const db = testDb("demo-ferromaps-stadium-surge");
const PINS = HOTSPOTS_COLLECTION;
const FORECASTS = "hotspot_forecasts";

describe("forecasts leave hotspots_test", () => {
  before(async () => {
    await clearDb(db);
  });

  it("writes the forecast only on hotspot_forecasts", async () => {
    const planned = planStadiumEvents({
      now: new Date("2099-07-04T10:00:00.000Z"),
      events: matrix([...EVENTS_HEADERS, "Venue type"], [{
        [EVENT_ID]: "2099-07-11-GOLD-PIN",
        [HOME_TEAM]: "",
        [GROUND]: "Synthetic General Hospital",
        [KICKOFF]: "2099-07-11 18:00",
        [EXPECTED_FULL_TIME]: "2099-07-11 20:00",
        [SURGE_START]: "2099-07-11 20:00",
        [SURGE_END]: "2099-07-11 22:00",
        [HARD_STOP]: "2099-07-11 23:00",
        [PICKUP_POINTS]: "Main entrance | 51.501001, -0.101001",
        [DID_IT_SURGE]: "PENDING",
        "Venue type": "Hospital",
      }]),
      readings: matrix(["Time (UK)"], []),
    });
    assert.equal(planned.records.length, 1);
    await commitStadiumEvents(db, planned.records);
    const pin = await db.collection(PINS).doc("sheet_2099-07-11-GOLD-PIN").get();
    const forecast = await db.collection(FORECASTS).doc(pin.id).get();
    assert.equal(pin.get("forecast"), undefined);
    assert.equal(pin.get("forecastHistory"), undefined);
    assert.equal(pin.get("forecastSource"), undefined);
    assert.equal(pin.get("forecastUpdatedAt"), undefined);
    assert.equal(pin.get("surgeEnded"), false);
    assert.ok(pin.get("removeBy") instanceof Timestamp);
    assert.ok(pin.get("window_end") instanceof Timestamp);
    assert.equal(forecast.get("forecast").state, "no_prediction");
    assert.equal(forecast.get("surgeEnded"), false);
    assert.equal(forecast.get("window_end").toMillis(), pin.get("window_end").toMillis());

    const windowEnd = Timestamp.fromDate(new Date("2099-08-01T21:00:00.000Z"));
    await db.collection(PINS).doc("tm_only_forecast").set({
      name: "Keep",
      category: "events",
      window_end: windowEnd,
      surgeEnded: false,
    });
    await commitCategoryForecasts(db, [{
      id: "tm_only_forecast",
      forecast: {
        state: "available",
        v: 1,
        startAt: "2099-08-01T18:00:00.000Z",
        endAt: "2099-08-01T21:00:00.000Z",
        strength: "low",
        confidence: "low",
        confidencePercent: 50,
        basedOnEvents: 4,
      },
      forecastSource: "sheet_venue_history",
      updatedAt: "2099-08-01T12:00:00.000Z",
    }]);
    const categoryPin = await db.collection(PINS).doc("tm_only_forecast").get();
    const categoryForecast = await db.collection(FORECASTS).doc("tm_only_forecast").get();
    assert.equal(categoryPin.get("name"), "Keep");
    assert.equal(categoryPin.get("forecast"), undefined);
    assert.equal(categoryPin.get("forecastSource"), undefined);
    assert.equal(categoryForecast.get("forecast").state, "available");
    assert.equal(categoryForecast.get("forecast").confidenceSource, "none");
    assert.equal(categoryForecast.get("forecastSource"), "sheet_venue_history");
  });

  it("dry run changes nothing and apply removes only the forecast fields", async () => {
    const windowEnd = Timestamp.fromDate(new Date("2099-08-04T21:00:00.000Z"));
    await db.collection(PINS).doc("leftover_forecast").set({
      name: "Stay",
      note: "keep-me",
      surgeEnded: true,
      window_end: windowEnd,
      removeBy: windowEnd,
      forecast: {state: "available", strength: "low", confidencePercent: 10},
      forecastHistory: {preEvent: {state: "no_prediction", snapshotAt: windowEnd}},
      forecastSource: "sheet_venue_history",
      forecastUpdatedAt: windowEnd,
    });
    const dry = await removeHotspotsTestForecastFields(db, false);
    assert.equal(dry.apply, false);
    assert.equal(dry.changed >= 1, true);
    const before = await db.collection(PINS).doc("leftover_forecast").get();
    assert.equal(before.get("forecast").state, "available");
    assert.equal(before.get("name"), "Stay");
    assert.equal((await db.collection(PINS).get()).size >= 1, true);

    const applied = await removeHotspotsTestForecastFields(db, true);
    assert.equal(applied.apply, true);
    assert.equal(applied.changed, dry.changed);
    const after = await db.collection(PINS).doc("leftover_forecast").get();
    assert.equal(after.exists, true);
    for (const key of HOTSPOTS_TEST_FORECAST_FIELDS) assert.equal(after.get(key), undefined, key);
    assert.equal(after.get("name"), "Stay");
    assert.equal(after.get("note"), "keep-me");
    assert.equal(after.get("surgeEnded"), true);
    assert.equal(after.get("window_end").toMillis(), windowEnd.toMillis());
    assert.equal(after.get("removeBy").toMillis(), windowEnd.toMillis());
    const again = await removeHotspotsTestForecastFields(db, true);
    assert.equal(again.changed, 0);
  });
});
