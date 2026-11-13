import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {GeoPoint, Timestamp} from "firebase-admin/firestore";
import {commitCategoryForecasts} from "../src/surge/categoryCommit";
import {planCategoryForecasts} from "../src/surge/categoryPlan";
import {HOTSPOTS_COLLECTION} from "../src/surge/commit";
import {DID_IT_SURGE, EVENT_ID, EVENTS_HEADERS, GROUND, HOME_TEAM, KICKOFF, PEAK_UPLIFT} from "../src/surge/headers";
import {matrix} from "../src/surge/syntheticSheet";
import {TPC_LOG_HEADERS, TPC_READINGS_HEADERS} from "../src/surge/tpc";
import {lookupVenueLocation} from "../src/surge/venueLocations";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-stadium-surge";
const NOW = new Date("2099-08-01T12:00:00.000Z");
const WINDOW_END = Timestamp.fromDate(new Date("2099-06-01T19:00:00.000Z"));
const REMOVE_BY = Timestamp.fromDate(new Date("2099-06-01T22:00:00.000Z"));

function hydroRows(): Record<string, unknown>[] {
  return ["01", "02", "03", "04"].map((day, index) => ({
    [EVENT_ID]: `2099-05-${day}-HYD-E${index}`,
    [HOME_TEAM]: `Artist ${day}`,
    [GROUND]: "OVO Hydro, Glasgow",
    [KICKOFF]: `2099-05-${day} 15:00`,
    [DID_IT_SURGE]: "YES",
    [PEAK_UPLIFT]: "47%",
  }));
}

describe("category forecast emulator merge", () => {
  const db = testDb(PROJECT);

  before(async () => {
    await clearDb(db);
    const snap = await db.collection(HOTSPOTS_COLLECTION).get();
    if (snap.empty) return;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  });

  it("updates only the forecast fields on pins that already exist", async () => {
    const venue = lookupVenueLocation("OVO Hydro, Glasgow");
    if (!venue) throw new Error("missing venue");
    await db.collection(HOTSPOTS_COLLECTION).doc("tm_hydro").set({
      name: "Keep this name",
      description: "keep-me",
      category: "events",
      city: "Glasgow",
      jobs_accepted: 4,
      window_end: WINDOW_END,
      removeBy: REMOVE_BY,
      location: new GeoPoint(venue.lat, venue.lng),
      starting_time: Timestamp.fromDate(new Date("2099-06-01T16:00:00.000Z")),
      ending_time: WINDOW_END,
      events: {venue_name: "OVO Hydro", end_time: WINDOW_END},
    });
    await db.collection(HOTSPOTS_COLLECTION).doc("910GBARKING_2099-06-01_H09").set({
      category: "travel disruptions",
      name: "Barking",
      note: "keep-travel",
      window_end: WINDOW_END,
    });
    await db.collection(HOTSPOTS_COLLECTION).doc("parking_1").set({
      category: "parking",
      name: "Bay",
      note: "keep-parking",
    });
    await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-05-01-HYD-E0").set({
      category: "events",
      name: "sheet pin",
      note: "keep-sheet",
    });

    const pins = (await db.collection(HOTSPOTS_COLLECTION).get()).docs.map((doc) => ({
      id: doc.id,
      data: doc.data() as Record<string, unknown>,
    }));
    const planned = planCategoryForecasts({
      now: NOW,
      events: matrix(EVENTS_HEADERS, hydroRows()),
      tpcLog: matrix(TPC_LOG_HEADERS, []),
      tpcReadings: matrix(TPC_READINGS_HEADERS, []),
      pins,
    });
    assert.deepEqual(planned.patches.map((item) => item.id).sort(), [
      "910GBARKING_2099-06-01_H09",
      "tm_hydro",
    ]);
    assert.equal(planned.patches.find((item) => item.id === "tm_hydro")?.forecast.state, "available");
    assert.equal(
      planned.patches.find((item) => item.id === "910GBARKING_2099-06-01_H09")?.forecast.state,
      "no_prediction",
    );
    assert.equal(await commitCategoryForecasts(db, planned.patches), 2);

    const hydro = await db.collection(HOTSPOTS_COLLECTION).doc("tm_hydro").get();
    assert.equal(hydro.get("name"), "Keep this name");
    assert.equal(hydro.get("description"), "keep-me");
    assert.equal(hydro.get("jobs_accepted"), 4);
    assert.equal(hydro.get("city"), "Glasgow");
    assert.equal((hydro.get("window_end") as Timestamp).toMillis(), WINDOW_END.toMillis());
    assert.equal((hydro.get("removeBy") as Timestamp).toMillis(), REMOVE_BY.toMillis());
    assert.notEqual(hydro.get("window_end").toMillis(), hydro.get("removeBy").toMillis());
    assert.equal(hydro.get("events").venue_name, "OVO Hydro");
    assert.equal(hydro.get("forecast"), undefined);
    assert.equal(hydro.get("forecastSource"), undefined);
    const hydroForecast = await db.collection("hotspot_forecasts").doc("tm_hydro").get();
    assert.equal(hydroForecast.get("forecast").state, "available");
    assert.equal(hydroForecast.get("forecastSource"), "sheet_venue_history");
    assert.ok(hydroForecast.get("forecastUpdatedAt") instanceof Timestamp);
    assert.equal(hydroForecast.get("forecast").confidencePercent, 100);
    const raw = JSON.stringify(hydro.data()) + JSON.stringify(hydroForecast.data());
    for (const token of ["47%", "£", "18.40", "fare", "uber", "baseline"]) {
      assert.equal(raw.toLowerCase().includes(token.toLowerCase()), false, token);
    }

    const travel = await db.collection(HOTSPOTS_COLLECTION).doc("910GBARKING_2099-06-01_H09").get();
    const travelForecast = await db.collection("hotspot_forecasts").doc("910GBARKING_2099-06-01_H09").get();
    assert.equal(travel.get("note"), "keep-travel");
    assert.equal(travel.get("name"), "Barking");
    assert.equal(travel.get("forecast"), undefined);
    assert.equal(travelForecast.get("forecast").state, "no_prediction");
    assert.equal(travelForecast.get("forecast").confidenceSource, "none");
    assert.deepEqual(Object.keys(travelForecast.get("forecast")).sort(), ["confidenceSource", "state"]);

    const parking = await db.collection(HOTSPOTS_COLLECTION).doc("parking_1").get();
    assert.equal(parking.get("note"), "keep-parking");
    assert.equal(parking.get("forecast"), undefined);
    const sheet = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-05-01-HYD-E0").get();
    assert.equal(sheet.get("note"), "keep-sheet");
    assert.equal(sheet.get("forecast"), undefined);

    await db.collection(HOTSPOTS_COLLECTION).doc("pin_watch").set({
      name: "Watch place",
      category: "stadium",
      note: "keep-watch",
      window_end: WINDOW_END,
    });
    const watchPins = [{
      id: "pin_watch",
      data: (await db.collection(HOTSPOTS_COLLECTION).doc("pin_watch").get()).data() as Record<string, unknown>,
    }];
    const watchPlan = planCategoryForecasts({
      now: NOW,
      events: matrix(EVENTS_HEADERS, []),
      tpcLog: matrix(TPC_LOG_HEADERS, []),
      tpcReadings: matrix(TPC_READINGS_HEADERS, []),
      pins: watchPins,
      watchlistReadings: matrix(
        [
          "Reading ID",
          "Place ID",
          "Place source",
          "Place name",
          "Category",
          "Latitude",
          "Longitude",
          "Pickup point used",
          "Reading type",
          "Disruption ID",
          "Disruption type",
          "Disruption description",
          "Taken at (UK time)",
          "Uber product",
          "Price shown (GBP)",
          "Normal price for this trip (GBP)",
          "Surge shown in app",
          "Pickup wait shown (min)",
          "How it was taken",
          "Notes",
        ],
        ["01", "02", "03", "04"].map((day, index) => ({
          "Place ID": "pin_watch",
          "Place source": "Hotspot Test Pins",
          "Place name": "Watch place",
          "Reading type": "During",
          "Disruption ID": `W-${index}`,
          "Taken at (UK time)": `2099-05-${day} 18:00`,
          "Uber product": "uber",
          "Price shown (GBP)": "27.60",
          "Normal price for this trip (GBP)": "18.40",
          "Notes": "baseline fare £18.40 ratio",
        })),
      ),
    });
    assert.equal(watchPlan.patches.length, 1);
    assert.equal(watchPlan.patches[0].forecastSource, "tpc_watchlist_history");
    await commitCategoryForecasts(db, watchPlan.patches);
    const watched = await db.collection(HOTSPOTS_COLLECTION).doc("pin_watch").get();
    const watchedForecast = await db.collection("hotspot_forecasts").doc("pin_watch").get();
    assert.equal(watched.get("note"), "keep-watch");
    assert.equal(watched.get("name"), "Watch place");
    assert.equal(watched.get("forecast"), undefined);
    assert.equal(watchedForecast.get("forecastSource"), "tpc_watchlist_history");
    assert.equal(watchedForecast.get("forecast").state, "available");
    assert.equal(watchedForecast.get("forecast").confidencePercent, 100);
    assert.equal(watchedForecast.get("forecast").basedOnEvents, 4);
    const watchedRaw = JSON.stringify(watched.data()) + JSON.stringify(watchedForecast.data());
    for (const token of ["27.60", "18.40", "£", "uber", "baseline", "fare", "ratio", "1.5"]) {
      assert.equal(watchedRaw.toLowerCase().includes(token.toLowerCase()), false, token);
    }

    const before = (await db.collection(HOTSPOTS_COLLECTION).get()).size;
    const absent = planned.patches[0];
    await assert.rejects(() => commitCategoryForecasts(db, [{...absent, id: "tm_missing"}]));
    assert.equal(await db.collection(HOTSPOTS_COLLECTION).doc("tm_missing").get().then((doc) => doc.exists), false);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).get()).size, before);
  });
});
