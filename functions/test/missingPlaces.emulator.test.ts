import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {GeoPoint, Timestamp} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "../src/surge/commit";
import {planMissingHotspots, runMissingHotspotCreate} from "../src/surge/missingPlaces";
import {commitNewHotspots, listExistingPlaces} from "../src/surge/placeCommit";
import {matrix} from "../src/surge/syntheticSheet";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-stadium-surge";
const NOW = new Date("2099-08-01T12:00:00.000Z");

function tabs() {
  return {
    events: matrix(["Ground", "Venue type"], []),
    fixedPlaces: matrix(
      ["Place key", "Place name", "Category", "Latitude", "Longitude", "City", "Price shown (GBP)", "Notes"],
      [
        {
          "Place key": "FP-GUY",
          "Place name": "Guy Hospital",
          "Category": "hospital",
          "Latitude": 51.503,
          "Longitude": -0.089,
          "City": "London",
          "Price shown (GBP)": "18.40",
          "Notes": "uber fare £18.40",
        },
        {
          "Place key": "FP-KEPT",
          "Place name": "Kept Hospital",
          "Category": "hospital",
          "Latitude": 51.51,
          "Longitude": -0.12,
        },
      ],
    ),
    watchlist: matrix(
      ["Place ID", "Place source", "Place name", "Category", "Latitude", "Longitude", "Price shown (GBP)"],
      [{
        "Place ID": "pin_euston",
        "Place source": "Hotspot Test Pins",
        "Place name": "Euston",
        "Category": "station",
        "Latitude": 51.5282,
        "Longitude": -0.1337,
        "Price shown (GBP)": "27.60",
      }],
    ),
    tpcLog: matrix(["Location/Station/Airport", "Mode"], []),
  };
}

describe("missing places stay create-only on the emulator", () => {
  const db = testDb(PROJECT);

  before(async () => {
    await clearDb(db);
    const snap = await db.collection(HOTSPOTS_COLLECTION).get();
    if (snap.empty) return;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  });

  it("dry-run writes nothing, then a live run creates only missing docs", async () => {
    await db.collection(HOTSPOTS_COLLECTION).doc("kept_doc").set({
      name: "Kept Hospital",
      category: "hospital",
      fixedPlaceKey: "FP-KEPT",
      note: "keep-me",
      location: new GeoPoint(51.51, -0.12),
    });
    const loaded = tabs();
    const dry = await runMissingHotspotCreate({
      now: NOW,
      sheetId: "sheet-under-test",
      eventsTab: "Events",
      fixedPlacesTab: "Fixed Places",
      watchlistTab: "TPC Watchlist Readings",
      tpcLogTab: "TPC Disruption Log",
      load: async () => loaded,
      listExisting: () => listExistingPlaces(db),
      commit: (records) => commitNewHotspots(db, records, NOW),
    });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.created, 0);
    assert.deepEqual(dry.wouldCreate.map((place) => place.id), ["fp_fp-guy", "pin_euston"]);
    assert.equal(dry.alreadyPresent, 1);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).get()).size, 1);

    const live = await runMissingHotspotCreate({
      now: NOW,
      dryRun: false,
      sheetId: "sheet-under-test",
      eventsTab: "Events",
      fixedPlacesTab: "Fixed Places",
      watchlistTab: "TPC Watchlist Readings",
      tpcLogTab: "TPC Disruption Log",
      load: async () => loaded,
      listExisting: () => listExistingPlaces(db),
      commit: (records) => commitNewHotspots(db, records, NOW),
    });
    assert.equal(live.created, 2);
    const guy = await db.collection(HOTSPOTS_COLLECTION).doc("fp_fp-guy").get();
    const station = await db.collection(HOTSPOTS_COLLECTION).doc("pin_euston").get();
    assert.equal(guy.get("idSource"), "fixed_places");
    assert.equal(guy.get("category"), "hospital");
    assert.equal(guy.get("fixedPlaceKey"), "FP-GUY");
    assert.equal(guy.get("events"), undefined);
    assert.equal(guy.get("forecast"), undefined);
    assert.ok(guy.get("location") instanceof GeoPoint);
    assert.ok(guy.get("fetched_at") instanceof Timestamp);
    assert.equal(station.get("category"), "station");
    assert.equal(station.get("idSource"), "tpc_watchlist_pin");
    assert.equal(station.get("events"), undefined);
    const raw = JSON.stringify({guy: guy.data(), station: station.data()});
    for (const token of ["18.40", "27.60", "£", "uber", "fare"]) {
      assert.equal(raw.toLowerCase().includes(token.toLowerCase()), false, token);
    }
    await db.collection(HOTSPOTS_COLLECTION).doc("fp_fp-guy").set({note: "keep-guy"}, {merge: true});

    const again = await runMissingHotspotCreate({
      now: NOW,
      dryRun: false,
      sheetId: "sheet-under-test",
      eventsTab: "Events",
      fixedPlacesTab: "Fixed Places",
      watchlistTab: "TPC Watchlist Readings",
      tpcLogTab: "TPC Disruption Log",
      load: async () => loaded,
      listExisting: () => listExistingPlaces(db),
      commit: (records) => commitNewHotspots(db, records, NOW),
    });
    assert.equal(again.created, 0);
    assert.equal(again.wouldCreate.length, 0);
    assert.equal(again.alreadyPresent, 3);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc("kept_doc").get()).get("note"), "keep-me");
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc("fp_fp-guy").get()).get("note"), "keep-guy");
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc("fp_fp-guy").get()).get("name"), "Guy Hospital");
    const direct = planMissingHotspots({...loaded, existing: await listExistingPlaces(db)});
    assert.equal(direct.creates.length, 0);
  });
});
