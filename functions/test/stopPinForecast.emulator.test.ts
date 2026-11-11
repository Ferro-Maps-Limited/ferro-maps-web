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
  CleanupRefused,
  HOTSPOTS_TEST_FORECAST_FIELDS,
  removeHotspotsTestForecastFields,
  runCleanup,
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

  it("refuses without --project", async () => {
    await assert.rejects(
      () => runCleanup(["node", "cleanup"], {FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080"}),
      (err: unknown) => {
        assert.ok(err instanceof CleanupRefused);
        assert.match(err.message, /--project is required/);
        return true;
      },
    );
  });

  it("refuses when --apply names a different project", async () => {
    const project = "demo-ferromaps-stadium-surge";
    const emulator = {FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080"};
    await assert.rejects(
      () => runCleanup(["node", "cleanup", "--project", project, "--apply=other-project"], emulator),
      (err: unknown) => {
        assert.ok(err instanceof CleanupRefused);
        assert.match(err.message, /does not match --project/);
        return true;
      },
    );
    await assert.rejects(
      () => runCleanup(
        ["node", "cleanup", "--project", project, "--apply", "--confirm-project", "other-project"],
        emulator,
      ),
      /does not match --project/,
    );
    await assert.rejects(
      () => runCleanup(["node", "cleanup", "--project", project, "--apply"], emulator),
      /must name the project/,
    );
    await assert.rejects(
      () => runCleanup(
        ["node", "cleanup", "--project", project],
        {GOOGLE_CLOUD_PROJECT: "some-other-project"},
      ),
      /does not match the credentials/,
    );
  });

  it("pages one small page at a time, then deletes only the forecast fields", async () => {
    const windowEnd = Timestamp.fromDate(new Date("2099-09-01T21:00:00.000Z"));
    const withForecast = ["page_a", "page_b", "page_c"];
    for (const id of withForecast) {
      await db.collection(PINS).doc(id).set({
        name: id,
        note: "keep-me",
        surgeEnded: false,
        window_end: windowEnd,
        removeBy: windowEnd,
        forecast: {state: "available", strength: "low"},
        forecastHistory: {preEvent: {state: "no_prediction"}},
        forecastSource: "sheet_venue_history",
        forecastUpdatedAt: windowEnd,
      });
    }
    await db.collection(PINS).doc("page_plain").set({name: "plain", note: "keep-me", surgeEnded: true});
    const pageSize = 2;
    const dry = await removeHotspotsTestForecastFields(db, false, pageSize);
    assert.equal(dry.apply, false);
    assert.equal(dry.pages > 1, true);
    assert.equal(dry.scanned > pageSize, true);
    assert.equal(dry.pages, Math.ceil(dry.scanned / pageSize));
    const before = await db.collection(PINS).doc("page_a").get();
    assert.equal(before.get("forecast").strength, "low");
    assert.equal(before.get("name"), "page_a");

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await runCleanup(
        ["node", "cleanup", "--project", "demo-ferromaps-stadium-surge", "--page-size", "2"],
        {FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST},
      );
    } finally {
      console.log = original;
    }
    assert.equal(lines[0], "project=demo-ferromaps-stadium-surge mode=dry run");
    assert.equal((await db.collection(PINS).doc("page_b").get()).get("forecastSource"), "sheet_venue_history");

    const applied = await removeHotspotsTestForecastFields(db, true, pageSize);
    assert.equal(applied.apply, true);
    assert.equal(applied.pages, dry.pages);
    assert.equal(applied.changed, dry.changed);
    for (const id of withForecast) {
      const after = await db.collection(PINS).doc(id).get();
      assert.equal(after.exists, true, id);
      for (const key of HOTSPOTS_TEST_FORECAST_FIELDS) assert.equal(after.get(key), undefined, key);
      assert.equal(after.get("name"), id);
      assert.equal(after.get("note"), "keep-me");
      assert.equal(after.get("surgeEnded"), false);
      assert.equal(after.get("window_end").toMillis(), windowEnd.toMillis());
      assert.equal(after.get("removeBy").toMillis(), windowEnd.toMillis());
    }
    const plain = await db.collection(PINS).doc("page_plain").get();
    assert.equal(plain.exists, true);
    assert.equal(plain.get("name"), "plain");
    assert.equal(plain.get("note"), "keep-me");
    assert.equal(plain.get("surgeEnded"), true);
    const again = await removeHotspotsTestForecastFields(db, true, pageSize);
    assert.equal(again.changed, 0);
    assert.equal(again.pages, applied.pages);
  });
});
