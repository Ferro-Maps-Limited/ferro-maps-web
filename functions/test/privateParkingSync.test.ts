import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {buildImport} from "../src/parking/privateSheet/build.js";
import {rowsFromMatrix} from "../src/parking/privateSheet/rows.js";
import {
  CELL_TTL_MS,
  cellContentHash,
  planPrivateParkingWrites,
  SHEETS_READONLY_SCOPE,
  syncPrivateParkingOnce,
  type ExistingCellDoc,
} from "../src/parking/privateSheet/syncPlan.js";

const HEAD = [
  "Location Name", "Postcode", "Latitude", "Longitude", "Location Status",
  "Evidence Type", "Who Can Park", "Verification Result",
];

const NOW = new Date("2026-11-01T00:00:00.000Z");

function sheet(rows: unknown[][]): unknown[][] {
  return [HEAD, ...rows];
}

const YARD = ["Yard", "W1 1AA", "51.50", "-0.12", "Open", "Official site: partial info", "Customers only", "Confirmed"];
const OTHER = ["Other", "W1 1AB", "51.50", "-0.12", "Open", "Google Maps only", "Anyone", ""];

describe("private parking sheet sync", () => {
  it("uses the read-only Sheets scope and the importer mapping", async () => {
    assert.equal(SHEETS_READONLY_SCOPE, "https://www.googleapis.com/auth/spreadsheets.readonly");
    let calls = 0;
    const result = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "ALL LONDON (clean)",
      existing: [],
      loadSheet: async () => {
        calls += 1;
        return sheet([YARD, OTHER]);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "ok");
    assert.equal(result.imported, 2);
    assert.equal(result.writes.length, 1);
    const write = result.writes[0];
    assert.equal(write.action, "upsert");
    assert.equal(write.data.places.length, 2);
    assert.equal(write.data.places.find((place) => place.n === "Yard")?.srcType, "official");
    assert.equal(write.data.places.find((place) => place.n === "Other")?.srcType, "gmaps");
    assert.equal(write.data.places[0].p[0], 51.5);
    assert.equal(write.data.expiresAt, new Date(NOW.getTime() + CELL_TTL_MS).toISOString());
    assert.equal(JSON.stringify(write.data).includes("official_partial"), false);
  });

  it("does not write when the content hash matches and the cell is still live", async () => {
    const first = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      existing: [],
      loadSheet: async () => sheet([YARD, OTHER]),
    });
    const written = first.writes[0];
    const existing: ExistingCellDoc[] = [{
      id: written.id,
      cell: written.data.cell,
      contentHash: written.data.contentHash,
      expiresAtMs: NOW.getTime() + CELL_TTL_MS,
    }];
    let calls = 0;
    const second = await syncPrivateParkingOnce({
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      existing,
      loadSheet: async () => {
        calls += 1;
        return sheet([YARD, OTHER]);
      },
    });
    assert.equal(calls, 1);
    assert.equal(second.writes.length, 0);
    assert.equal(second.unchanged, 1);
  });

  it("drops a place whose row disappeared and expires an empty cell", async () => {
    const first = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      existing: [],
      loadSheet: async () => sheet([YARD, OTHER]),
    });
    const cellId = first.writes[0].id;
    const existing: ExistingCellDoc[] = [{
      id: cellId,
      cell: cellId,
      contentHash: first.writes[0].data.contentHash,
      expiresAtMs: NOW.getTime() + CELL_TTL_MS,
    }];
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const dropped = await syncPrivateParkingOnce({
      now: later,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      existing,
      loadSheet: async () => sheet([YARD]),
    });
    assert.equal(dropped.writes.length, 1);
    assert.equal(dropped.writes[0].action, "upsert");
    assert.deepEqual(dropped.writes[0].data.places.map((place) => place.n), ["Yard"]);

    const emptied = await syncPrivateParkingOnce({
      now: later,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      existing,
      loadSheet: async () => sheet([]),
    });
    assert.equal(emptied.writes.length, 1);
    assert.equal(emptied.writes[0].action, "expire");
    assert.equal(emptied.writes[0].id, cellId);
    assert.deepEqual(emptied.writes[0].data.places, []);
    assert.ok(Date.parse(emptied.writes[0].data.expiresAt) < later.getTime());

    const hidden: ExistingCellDoc[] = [{
      id: cellId,
      cell: cellId,
      contentHash: emptied.writes[0].data.contentHash,
      expiresAtMs: Date.parse(emptied.writes[0].data.expiresAt),
    }];
    const again = await syncPrivateParkingOnce({
      now: later,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      existing: hidden,
      loadSheet: async () => sheet([]),
    });
    assert.equal(again.writes.length, 0);
    assert.equal(again.expired, 0);
  });

  it("expires a shard that the new sheet no longer needs", () => {
    const build = buildImport(rowsFromMatrix(sheet([YARD])), NOW);
    const cellId = build.cells[0].id;
    const plan = planPrivateParkingWrites({
      now: NOW,
      desired: build.cells.map((doc) => ({
        id: doc.id,
        cell: doc.data.cell,
        places: doc.data.places,
        shards: doc.data.shards,
      })),
      existing: [{
        id: `${cellId}_1`,
        cell: cellId,
        contentHash: "old",
        expiresAtMs: NOW.getTime() + CELL_TTL_MS,
      }],
    });
    const expired = plan.writes.find((write) => write.id === `${cellId}_1`);
    assert.equal(expired?.action, "expire");
    assert.equal(expired?.data.cell, cellId);
    assert.deepEqual(expired?.data.places, []);
  });

  it("refreshes a matching cell only when expiresAt is inside two hours", () => {
    const build = buildImport(rowsFromMatrix(sheet([YARD])), NOW);
    const doc = build.cells[0];
    const hash = cellContentHash({cell: doc.data.cell, places: doc.data.places, shards: doc.data.shards});
    const soon = planPrivateParkingWrites({
      now: NOW,
      desired: [{id: doc.id, cell: doc.data.cell, places: doc.data.places}],
      existing: [{id: doc.id, cell: doc.id, contentHash: hash, expiresAtMs: NOW.getTime() + 30 * 60 * 1000}],
    });
    assert.equal(soon.writes.length, 1);
    assert.equal(soon.writes[0].action, "refresh");
    assert.equal(soon.writes[0].data.contentHash, hash);
    const later = planPrivateParkingWrites({
      now: NOW,
      desired: [{id: doc.id, cell: doc.data.cell, places: doc.data.places}],
      existing: [{id: doc.id, cell: doc.id, contentHash: hash, expiresAtMs: NOW.getTime() + CELL_TTL_MS}],
    });
    assert.equal(later.writes.length, 0);
    assert.equal(later.unchanged, 1);
  });

  it("does not read the sheet when the job is off or the params are blank", async () => {
    let calls = 0;
    const loadSheet = async () => {
      calls += 1;
      return sheet([YARD]);
    };
    const disabled = await syncPrivateParkingOnce({
      now: NOW, enabled: false, sheetId: "sheet-id", tab: "tab", existing: [], loadSheet,
    });
    const missing = await syncPrivateParkingOnce({
      now: NOW, enabled: true, sheetId: "", tab: "tab", existing: [], loadSheet,
    });
    assert.equal(calls, 0);
    assert.equal(disabled.status, "disabled");
    assert.equal(missing.status, "missing-params");
    assert.equal(disabled.writes.length, 0);
    assert.equal(missing.writes.length, 0);
  });
});
