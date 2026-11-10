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
    assert.equal(hydro.get("forecast").state, "available");
    assert.equal(hydro.get("forecastSource"), "sheet_venue_history");
    assert.ok(hydro.get("forecastUpdatedAt") instanceof Timestamp);
    assert.equal(hydro.get("forecast").confidencePercent, 100);
    const raw = JSON.stringify(hydro.data());
    for (const token of ["47%", "£", "18.40", "fare", "uber", "baseline"]) {
      assert.equal(raw.toLowerCase().includes(token.toLowerCase()), false, token);
    }

    const travel = await db.collection(HOTSPOTS_COLLECTION).doc("910GBARKING_2099-06-01_H09").get();
    assert.equal(travel.get("note"), "keep-travel");
    assert.equal(travel.get("name"), "Barking");
    assert.equal(travel.get("forecast").state, "no_prediction");
    assert.deepEqual(Object.keys(travel.get("forecast")), ["state"]);

    const parking = await db.collection(HOTSPOTS_COLLECTION).doc("parking_1").get();
    assert.equal(parking.get("note"), "keep-parking");
    assert.equal(parking.get("forecast"), undefined);
    const sheet = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-05-01-HYD-E0").get();
    assert.equal(sheet.get("note"), "keep-sheet");
    assert.equal(sheet.get("forecast"), undefined);

    const before = (await db.collection(HOTSPOTS_COLLECTION).get()).size;
    const absent = planned.patches[0];
    await assert.rejects(() => commitCategoryForecasts(db, [{...absent, id: "tm_missing"}]));
    assert.equal(await db.collection(HOTSPOTS_COLLECTION).doc("tm_missing").get().then((doc) => doc.exists), false);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).get()).size, before);
  });
});
