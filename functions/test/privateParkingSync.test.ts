import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {buildImport} from "../src/parking/privateSheet/build.js";
import {rowsFromMatrix} from "../src/parking/privateSheet/rows.js";
import {loadInAppPlaceIds} from "../src/parking/privateSheet/payMode.js";
import {
  CELL_TTL_MS,
  cellContentHash,
  MIN_REMAINING_MS,
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
      lastGoodRowCount: null,
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
    assert.equal(write.data.places.every((place) => place.payMode === "handoff"), true);
  });

  it("does not write when the content hash matches and the cell is still live", async () => {
    const first = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: null,
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
      lastGoodRowCount: 2,
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
      lastGoodRowCount: null,
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
      lastGoodRowCount: 1,
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
      lastGoodRowCount: 2,
      existing,
      loadSheet: async () => sheet([]),
    });
    assert.equal(emptied.status, "aborted");
    assert.equal(emptied.abortReason, "usable-row-count-zero");
    assert.equal(emptied.writes.length, 0);
    assert.equal(emptied.config?.lastAbortReason, "usable-row-count-zero");
    assert.equal(emptied.config?.lastGoodRowCount, undefined);
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

  it("refreshes a matching cell when fewer than 7 days remain", () => {
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
    assert.equal(soon.writes[0].data.expiresAt, new Date(NOW.getTime() + CELL_TTL_MS).toISOString());
    const exact = planPrivateParkingWrites({
      now: NOW,
      desired: [{id: doc.id, cell: doc.data.cell, places: doc.data.places}],
      existing: [{id: doc.id, cell: doc.id, contentHash: hash, expiresAtMs: NOW.getTime() + MIN_REMAINING_MS}],
    });
    assert.equal(exact.writes.length, 0);
    const justUnder = planPrivateParkingWrites({
      now: NOW,
      desired: [{id: doc.id, cell: doc.data.cell, places: doc.data.places}],
      existing: [{id: doc.id, cell: doc.id, contentHash: hash, expiresAtMs: NOW.getTime() + MIN_REMAINING_MS - 1}],
    });
    assert.equal(justUnder.writes[0].action, "refresh");
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
      now: NOW, enabled: false, sheetId: "sheet-id", tab: "tab", lastGoodRowCount: null, existing: [], loadSheet,
    });
    const missing = await syncPrivateParkingOnce({
      now: NOW, enabled: true, sheetId: "", tab: "tab", lastGoodRowCount: null, existing: [], loadSheet,
    });
    assert.equal(calls, 0);
    assert.equal(disabled.status, "disabled");
    assert.equal(missing.status, "missing-params");
    assert.equal(disabled.writes.length, 0);
    assert.equal(missing.writes.length, 0);
    assert.equal(disabled.config, null);
  });

  it("aborts a Sheets error, a zero count, an 11% drop, and not a 9% drop or a first run", async () => {
    const base = {
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      existing: [] as ExistingCellDoc[],
    };
    const failed = await syncPrivateParkingOnce({
      ...base,
      lastGoodRowCount: 100,
      loadSheet: async () => {
        throw new Error("sheets down");
      },
    });
    assert.equal(failed.status, "aborted");
    assert.equal(failed.abortReason, "sheets-read-error:Error");
    assert.equal(failed.writes.length, 0);
    assert.equal(failed.config?.lastGoodRowCount, undefined);

    const zero = await syncPrivateParkingOnce({
      ...base,
      lastGoodRowCount: 100,
      loadSheet: async () => sheet([]),
    });
    assert.equal(zero.status, "aborted");
    assert.equal(zero.abortReason, "usable-row-count-zero");
    assert.equal(zero.writes.length, 0);

    const rows = (count: number) => Array.from({length: count}, (_, index) => [
      `Place ${index}`, "W1 1AA", (51.5 + index * 0.0001).toFixed(5), "-0.12", "Open", "", "", "",
    ]);
    const dropped = await syncPrivateParkingOnce({
      ...base,
      lastGoodRowCount: 100,
      loadSheet: async () => sheet(rows(89)),
    });
    assert.equal(dropped.usableRows, 89);
    assert.equal(dropped.status, "aborted");
    assert.equal(dropped.abortReason, "usable-row-count-dropped");
    assert.equal(dropped.writes.length, 0);
    assert.equal(dropped.config?.lastAbortReason, "usable-row-count-dropped");

    const kept = await syncPrivateParkingOnce({
      ...base,
      lastGoodRowCount: 100,
      loadSheet: async () => sheet(rows(91)),
    });
    assert.equal(kept.usableRows, 91);
    assert.equal(kept.status, "ok");
    assert.ok(kept.writes.length > 0);
    assert.equal(kept.config?.lastGoodRowCount, 91);
    assert.equal(kept.config?.lastAbortReason, null);

    const first = await syncPrivateParkingOnce({
      ...base,
      lastGoodRowCount: null,
      loadSheet: async () => sheet([YARD]),
    });
    assert.equal(first.status, "ok");
    assert.equal(first.config?.lastGoodRowCount, 1);
    assert.equal(first.config?.lastGoodRunAt, NOW.toISOString());
    assert.ok(first.writes.length > 0);
  });

  it("copies payMode into the content hash and rewrites when a place becomes inapp", async () => {
    const handoff = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: async () => sheet([YARD]),
    });
    const written = handoff.writes[0];
    assert.equal(written.data.places[0].payMode, "handoff");
    const placeId = written.data.places[0].id;
    let loads = 0;
    const inapp = await syncPrivateParkingOnce({
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: 1,
      existing: [{
        id: written.id,
        cell: written.data.cell,
        contentHash: written.data.contentHash,
        expiresAtMs: NOW.getTime() + CELL_TTL_MS,
      }],
      loadSheet: async () => sheet([YARD]),
      loadInAppPlaceIds: async () => {
        loads += 1;
        return new Set([placeId]);
      },
    });
    assert.equal(loads, 1);
    assert.equal(inapp.writes.length, 1);
    assert.equal(inapp.writes[0].action, "upsert");
    assert.equal(inapp.writes[0].data.places[0].payMode, "inapp");
    assert.notEqual(inapp.writes[0].data.contentHash, written.data.contentHash);
    const again = cellContentHash({
      cell: inapp.writes[0].data.cell,
      places: inapp.writes[0].data.places,
      shards: inapp.writes[0].data.shards,
    });
    assert.equal(again, inapp.writes[0].data.contentHash);

    let abortedLoads = 0;
    const aborted = await syncPrivateParkingOnce({
      now: NOW,
      enabled: false,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: async () => sheet([YARD]),
      loadInAppPlaceIds: async () => {
        abortedLoads += 1;
        return new Set([placeId]);
      },
    });
    assert.equal(aborted.status, "disabled");
    assert.equal(abortedLoads, 0);
  });

  it("reads inapp place ids with one payMode query and ignores every other value", async () => {
    const seen: string[] = [];
    const ids = await loadInAppPlaceIds({
      collection(name) {
        seen.push(name);
        return {
          where(field: string, op: "==", value: string) {
            seen.push(`${field}${op}${value}`);
            return {
              select(...fields: string[]) {
                seen.push(fields.join(","));
                return {
                  async get() {
                    return {
                      docs: [
                        {id: "in", get: (field: string) => field === "payMode" ? "inapp" : null},
                        {id: "hand", get: () => "handoff"},
                        {id: "off", get: () => "off"},
                        {id: "odd", get: () => "InApp"},
                        {id: "blank", get: () => undefined},
                      ],
                    };
                  },
                };
              },
            };
          },
        };
      },
    });
    assert.deepEqual(seen, ["places", "payMode==inapp", "payMode"]);
    assert.deepEqual([...ids], ["in"]);
  });
});
