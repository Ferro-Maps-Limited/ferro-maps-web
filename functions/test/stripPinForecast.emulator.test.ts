import assert from "node:assert/strict";
import {after, before, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {commitCategoryForecasts} from "../src/surge/categoryCommit";
import {FORECASTS_COLLECTION, HOTSPOTS_COLLECTION} from "../src/surge/collections";
import {commitStadiumEvents} from "../src/surge/commit";
import {commitForecastHistory} from "../src/surge/forecastHistoryCommit";
import {type StadiumEventRecord} from "../src/surge/plan";
import {PIN_FORECAST_FIELDS, stripPinForecastFieldsEnabled} from "../src/surge/stripPinForecast";
import {testDb} from "./support";

const PROJECT = "demo-ferromaps-stadium-surge";
const db = testDb(PROJECT);
const WINDOW = Timestamp.fromDate(new Date("2099-11-13T19:55:00.000Z"));

function record(id: string): StadiumEventRecord {
  const sheetEventId = id.slice("sheet_".length);
  return {
    id,
    idSource: "sheet_event",
    sheetEventId,
    name: "Home Side v Away Side",
    description: "match",
    category: "event",
    country: "United Kingdom",
    startTimeSource: "sheet_exact",
    positionSource: "venue_lookup",
    location: {lat: 51.5, lng: -0.1},
    windowStart: "2099-11-13T15:00:00.000Z",
    matchEnd: "2099-11-13T16:55:00.000Z",
    removeBy: "2099-11-13T19:55:00.000Z",
    surgeEnded: false,
    updatedFromSheetAt: "2099-11-13T12:00:00.000Z",
    pickupPoints: [{
      name: "North Gate",
      lat: 51.501,
      lng: -0.101,
      verified: true,
      confidence: "high",
      confidencePercent: 80,
    }],
    forecast: {
      state: "available",
      v: 1,
      startAt: "2099-11-13T16:55:00.000Z",
      endAt: "2099-11-13T19:00:00.000Z",
      strength: "high",
      confidence: "medium",
      confidencePercent: 75,
      confidenceSource: "events_tab",
      basedOnEvents: 4,
    },
  };
}

function categoryPatch(id: string) {
  return {
    id,
    forecastSource: "sheet_venue_history" as const,
    updatedAt: "2099-11-13T12:00:00.000Z",
    forecast: {
      state: "available" as const,
      v: 1 as const,
      startAt: "2099-11-13T16:55:00.000Z",
      endAt: "2099-11-13T19:00:00.000Z",
      strength: "medium" as const,
      confidence: "low" as const,
      confidencePercent: 60,
      confidenceSource: "events_tab" as const,
      basedOnEvents: 5,
    },
  };
}

const historyProposal = {
  preEvent: {
    snapshotAt: "2099-11-13T11:00:00.000Z",
    state: "available" as const,
    strength: "high" as const,
    confidencePercent: 70,
    basedOnEvents: 4,
    startAt: "2099-11-13T16:55:00.000Z",
    endAt: "2099-11-13T19:00:00.000Z",
  },
};

async function wipe(ids: string[]): Promise<void> {
  const batch = db.batch();
  for (const id of ids) {
    batch.delete(db.collection(HOTSPOTS_COLLECTION).doc(id));
    batch.delete(db.collection(FORECASTS_COLLECTION).doc(id));
  }
  batch.delete(db.doc("config/flags"));
  await batch.commit();
}

describe("pin forecast fields stay until the flag is on", () => {
  const ids = [
    "sheet_2099-11-13-PIN-OFF",
    "sheet_2099-11-13-PIN-ON",
    "sheet_2099-11-13-PIN-KEEP",
    "pin_cat_off",
    "pin_cat_on",
    "pin_cat_keep",
    "pin_hist_off",
    "pin_hist_on",
    "pin_hist_keep",
  ];

  before(async () => {
    await wipe(ids);
  });

  after(async () => {
    await wipe(ids);
  });

  it("treats a missing flag as off and still writes the forecast onto the pin", async () => {
    const id = "sheet_2099-11-13-PIN-OFF";
    assert.equal(await stripPinForecastFieldsEnabled(db), false);
    await db.doc("config/flags").set({stripPinForecastFields: false});
    assert.equal(await stripPinForecastFieldsEnabled(db), false);
    await db.doc("config/flags").set({stripPinForecastFields: {enabled: false}});
    assert.equal(await stripPinForecastFieldsEnabled(db), false);

    await commitStadiumEvents(db, [record(id)]);
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc(id).get();
    const gold = await db.collection(FORECASTS_COLLECTION).doc(id).get();
    assert.equal(pin.get("forecast").strength, "high");
    assert.equal(pin.get("forecast").confidence, "medium");
    assert.equal(pin.get("forecast").startAt.toMillis(), Date.parse("2099-11-13T16:55:00.000Z"));
    assert.equal(pin.get("surgeEnded"), false);
    assert.equal(pin.get("window_start").toMillis(), Date.parse("2099-11-13T15:00:00.000Z"));
    assert.equal(pin.get("pickupPoints")[0].confidence, "high");
    assert.equal(gold.get("forecast").strength, "high");
    assert.equal(gold.get("surgeEnded"), false);
  });

  it("with the flag on, a new pin gets no forecast fields and the gold copy still does", async () => {
    const id = "sheet_2099-11-13-PIN-ON";
    await db.doc("config/flags").set({stripPinForecastFields: true});
    const strip = await stripPinForecastFieldsEnabled(db);
    assert.equal(strip, true);

    await commitStadiumEvents(db, [record(id)], {stripPinForecastFields: strip});
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc(id).get();
    const gold = await db.collection(FORECASTS_COLLECTION).doc(id).get();
    for (const key of PIN_FORECAST_FIELDS) assert.equal(pin.get(key), undefined, key);
    assert.equal(pin.get("name"), "Home Side v Away Side");
    assert.equal(pin.get("window_start").toMillis(), Date.parse("2099-11-13T15:00:00.000Z"));
    assert.equal(pin.get("window_end").toMillis(), WINDOW.toMillis());
    assert.equal(pin.get("removeBy").toMillis(), WINDOW.toMillis());
    assert.equal(pin.get("expire_at").toMillis(), WINDOW.toMillis());
    assert.equal(pin.get("events").start_time.toMillis(), Date.parse("2099-11-13T15:00:00.000Z"));
    assert.equal(pin.get("pickupPoints")[0].confidencePercent, 80);
    assert.equal(gold.get("forecast").strength, "high");
    assert.equal(gold.get("forecast").confidence, "medium");
    assert.equal(gold.get("forecast").confidencePercent, 75);
    assert.equal(gold.get("surgeEnded"), false);
    assert.equal(gold.get("window_end").toMillis(), WINDOW.toMillis());
  });

  it("with the flag on, a later write leaves forecast fields already on the pin", async () => {
    const id = "sheet_2099-11-13-PIN-KEEP";
    const oldForecast = {state: "available", strength: "low", confidence: "low"};
    const oldUpdated = Timestamp.fromDate(new Date("2099-11-01T00:00:00.000Z"));
    await db.collection(HOTSPOTS_COLLECTION).doc(id).set({
      jobs_accepted: 4,
      forecast: oldForecast,
      surgeEnded: true,
      forecastSource: "sheet_venue_history",
      forecastUpdatedAt: oldUpdated,
      forecastHistory: {preEvent: {state: "no_prediction"}},
    });
    await commitStadiumEvents(db, [record(id)], {stripPinForecastFields: true});
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc(id).get();
    assert.equal(pin.get("jobs_accepted"), 4);
    assert.deepEqual(pin.get("forecast"), oldForecast);
    assert.equal(pin.get("surgeEnded"), true);
    assert.equal(pin.get("forecastSource"), "sheet_venue_history");
    assert.equal(pin.get("forecastUpdatedAt").toMillis(), oldUpdated.toMillis());
    assert.equal(pin.get("forecastHistory").preEvent.state, "no_prediction");
    assert.equal(pin.get("window_end").toMillis(), WINDOW.toMillis());
    const gold = await db.collection(FORECASTS_COLLECTION).doc(id).get();
    assert.equal(gold.get("forecast").strength, "high");
  });

  it("category and history writers follow the same flag", async () => {
    await db.doc("config/flags").delete();
    assert.equal(await stripPinForecastFieldsEnabled(db), false);

    await db.collection(HOTSPOTS_COLLECTION).doc("pin_cat_off").set({
      name: "Station",
      window_end: WINDOW,
    });
    await commitCategoryForecasts(db, [categoryPatch("pin_cat_off")]);
    const off = await db.collection(HOTSPOTS_COLLECTION).doc("pin_cat_off").get();
    assert.equal(off.get("forecast").strength, "medium");
    assert.equal(off.get("forecastSource"), "sheet_venue_history");
    assert.equal(
      (await db.collection(FORECASTS_COLLECTION).doc("pin_cat_off").get()).get("forecast").strength,
      "medium",
    );

    await db.collection(HOTSPOTS_COLLECTION).doc("pin_hist_off").set({
      category: "event",
      window_end: WINDOW,
    });
    await commitForecastHistory(db, [{id: "pin_hist_off", ...historyProposal}]);
    const histOff = await db.collection(HOTSPOTS_COLLECTION).doc("pin_hist_off").get();
    assert.equal(histOff.get("forecastHistory").preEvent.strength, "high");
    assert.equal(histOff.get("forecastHistory").preEvent.confidencePercent, 70);

    await db.doc("config/flags").set({stripPinForecastFields: {enabled: true}});
    const strip = await stripPinForecastFieldsEnabled(db);
    assert.equal(strip, true);

    await db.collection(HOTSPOTS_COLLECTION).doc("pin_cat_on").set({
      name: "Airport",
      window_end: WINDOW,
      jobs_accepted: 2,
    });
    await commitCategoryForecasts(db, [categoryPatch("pin_cat_on")], {stripPinForecastFields: strip});
    const catOn = await db.collection(HOTSPOTS_COLLECTION).doc("pin_cat_on").get();
    assert.equal(catOn.get("forecast"), undefined);
    assert.equal(catOn.get("forecastSource"), undefined);
    assert.equal(catOn.get("forecastUpdatedAt"), undefined);
    assert.equal(catOn.get("jobs_accepted"), 2);
    assert.equal(catOn.get("window_end").toMillis(), WINDOW.toMillis());
    const catGold = await db.collection(FORECASTS_COLLECTION).doc("pin_cat_on").get();
    assert.equal(catGold.get("forecast").confidence, "low");
    assert.equal(catGold.get("forecastSource"), "sheet_venue_history");

    const keptForecast = {state: "available", strength: "high", confidence: "high"};
    await db.collection(HOTSPOTS_COLLECTION).doc("pin_cat_keep").set({
      name: "Route",
      window_end: WINDOW,
      forecast: keptForecast,
      forecastSource: "tpc_route_history",
    });
    await commitCategoryForecasts(db, [categoryPatch("pin_cat_keep")], {stripPinForecastFields: true});
    const catKeep = await db.collection(HOTSPOTS_COLLECTION).doc("pin_cat_keep").get();
    assert.deepEqual(catKeep.get("forecast"), keptForecast);
    assert.equal(catKeep.get("forecastSource"), "tpc_route_history");
    assert.equal(
      (await db.collection(FORECASTS_COLLECTION).doc("pin_cat_keep").get()).get("forecast").strength,
      "medium",
    );

    await db.collection(HOTSPOTS_COLLECTION).doc("pin_hist_on").set({
      category: "event",
      window_end: WINDOW,
    });
    const written = await commitForecastHistory(db, [{id: "pin_hist_on", ...historyProposal}], {
      stripPinForecastFields: true,
    });
    const histOn = await db.collection(HOTSPOTS_COLLECTION).doc("pin_hist_on").get();
    assert.equal(written, 0);
    assert.equal(histOn.get("forecastHistory"), undefined);
    assert.equal(
      (await db.collection(FORECASTS_COLLECTION).doc("pin_hist_on").get()).get("forecastHistory").preEvent.strength,
      "high",
    );

    await db.collection(HOTSPOTS_COLLECTION).doc("pin_hist_keep").set({
      category: "event",
      window_end: WINDOW,
      forecastHistory: {preEvent: "leave-this"},
    });
    await commitForecastHistory(db, [{id: "pin_hist_keep", ...historyProposal}], {stripPinForecastFields: true});
    const histKeep = await db.collection(HOTSPOTS_COLLECTION).doc("pin_hist_keep").get();
    assert.equal(histKeep.get("forecastHistory").preEvent, "leave-this");
    assert.equal(
      (await db.collection(FORECASTS_COLLECTION).doc("pin_hist_keep").get()).get("forecastHistory").preEvent.strength,
      "high",
    );
  });
});
