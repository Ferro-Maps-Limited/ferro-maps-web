import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {planParkingPlaceIndex} from "../src/parking/privateSheet/placeIndex.js";
import {syncPrivateParkingOnce} from "../src/parking/privateSheet/syncPlan.js";

const NOW = new Date("2026-11-01T00:00:00.000Z");

describe("parking place index diff", () => {
  it("creates new ids, updates a changed cell, deletes gone ids, and writes nothing when unchanged", () => {
    const desired = [
      {placeId: "keep", cellId: "aaaaaa"},
      {placeId: "move", cellId: "bbbbbb"},
      {placeId: "new", cellId: "cccccc"},
    ];
    const existing = [
      {placeId: "keep", cellId: "aaaaaa"},
      {placeId: "move", cellId: "zzzzzz"},
      {placeId: "gone", cellId: "dddddd"},
    ];
    assert.deepEqual(planParkingPlaceIndex({desired, existing}), [
      {placeId: "gone", action: "delete"},
      {placeId: "move", action: "upsert", cellId: "bbbbbb"},
      {placeId: "new", action: "upsert", cellId: "cccccc"},
    ]);
    assert.deepEqual(planParkingPlaceIndex({
      desired,
      existing: desired.map((row) => ({placeId: row.placeId, cellId: row.cellId})),
    }), []);
  });

  it("does not index places when the sheet sync aborts on a mass drop", async () => {
    const head = ["Location Name", "Postcode", "Latitude", "Longitude", "Location Status", "Evidence Type"];
    const rows = Array.from({length: 89}, (_, index) => [
      `Place ${index}`, "W1 1AA", (51.5 + index * 0.0001).toFixed(5), "-0.12", "Open", "",
    ]);
    const aborted = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet",
      tab: "tab",
      lastGoodRowCount: 100,
      existing: [],
      loadSheet: async () => [head, ...rows],
    });
    assert.equal(aborted.status, "aborted");
    assert.equal(aborted.abortReason, "usable-row-count-dropped");
    assert.deepEqual(aborted.indexedPlaces, []);
    assert.equal(aborted.writes.length, 0);
  });
});
