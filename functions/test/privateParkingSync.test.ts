import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";
import {join} from "node:path";
import {buildImport, MAX_DOC_BYTES} from "../src/parking/privateSheet/build.js";
import {mapPlace, poundsToPence, skipReason} from "../src/parking/privateSheet/mapping.js";
import {rowsFromMatrix} from "../src/parking/privateSheet/rows.js";
import {fetchSheetMatrix, SHEET_PAGE_ROWS} from "../src/parking/privateSheet/sheetsClient.js";
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

  it("reads the ALL LONDON (clean) header names and skips closed or not-parkable rows", () => {
    const mapping = readFileSync(join(__dirname, "../src/parking/privateSheet/mapping.ts"), "utf8");
    const used = new Set<string>();
    for (const match of mapping.matchAll(/values\["([^"]+)"\]/g)) used.add(match[1]);
    for (const match of mapping.matchAll(/values\.([A-Za-z]+)/g)) used.add(match[1]);
    for (const name of used) assert.ok(LONDON_CLEAN_HEADERS.includes(name), name);
    const open = Object.fromEntries(LONDON_CLEAN_HEADERS.map((name) => [name, null]));
    Object.assign(open, {
      "Location Name": "Morrisons Acton (King Street)",
      "Can Park? (Yes/No/Conditional)": "Conditional",
      "Who Can Park": "Customers only",
      "Location Status": "Open",
      "Price Status": "Published",
      "Tariff Type": "Free with time limit",
      "Tariff Detail": "Free for up to 2 hrs",
      "Max Stay (mins)": 120,
      "Hours (OpenStreetMap opening_hours format)": "Mo-Sa 07:00-22:00; Su 10:00-16:00",
      "Evidence Type": "Official site: clear answer",
      "Latitude": 51.508375,
      "Longitude": -0.272714,
      "Postcode": "W3 9NX",
      "Street Address": "King Street, Acton, London",
      "Parking Charge (£)": 0,
    });
    const rows = rowsFromMatrix([
      LONDON_CLEAN_HEADERS,
      LONDON_CLEAN_HEADERS.map((name) => open[name]),
      LONDON_CLEAN_HEADERS.map((name) => name === "Location Status" ? "Temporarily closed" : open[name]),
      LONDON_CLEAN_HEADERS.map((name) => name === "Can Park? (Yes/No/Conditional)" ? "No" : open[name]),
    ]);
    assert.equal(skipReason(rows[1].values), "temporarily_closed");
    assert.equal(skipReason(rows[2].values), "not_parkable");
    const build = buildImport(rows, NOW);
    assert.equal(build.imported.length, 1);
    assert.equal(build.imported[0].place.n, "Morrisons Acton (King Street)");
    assert.equal(build.imported[0].place.s, 2);
    assert.equal(build.imported[0].place.aud, "c");
    assert.equal(build.imported[0].place.max, 120);
    assert.equal(build.imported[0].place.hours, "Mo-Sa 07:00-22:00; Su 10:00-16:00");
    assert.equal(build.imported[0].place.addr, "King Street, Acton, London, W3 9NX");
    assert.equal(build.skipped.temporarily_closed, 1);
    assert.equal(build.skipped.not_parkable, 1);
  });

  it("packs about 12,500 London rows without passing the document cap", () => {
    const count = 12560;
    const body = Array.from({length: count}, (_, index) => {
      const lat = 51.30 + (index % 80) * 0.005;
      const lng = -0.50 + (index % 97) * 0.007;
      return [
        `Place ${index}`,
        "W1 1AA",
        lat,
        lng,
        index % 50 === 0 ? "Closed" : "Open",
        "Official site: clear answer",
        "Anyone",
        "",
        index % 40 === 0 ? "No" : "Yes",
      ];
    });
    const wideHead = [...HEAD, "Can Park? (Yes/No/Conditional)"];
    const build = buildImport(rowsFromMatrix([wideHead, ...body]), NOW);
    assert.equal(build.totalRows, count);
    assert.ok(build.imported.length > 12000);
    assert.ok(build.skipped.closed > 0);
    assert.ok(build.skipped.not_parkable > 0);
    assert.equal(build.shardOverflowPlaces, 0);
    for (const cell of build.cells) {
      assert.ok(Buffer.byteLength(JSON.stringify(cell.data), "utf8") <= MAX_DOC_BYTES);
    }
  });

  it("pages a wide sheet and keeps rows after an empty page boundary", async () => {
    const tab = "ALL LONDON (clean)";
    const urls: string[] = [];
    const matrix = await fetchSheetMatrix("sheet-id", tab, async (url) => {
      urls.push(url);
      if (url.includes("fields=")) {
        return {sheets: [{properties: {title: tab, gridProperties: {rowCount: 2500}}}]};
      }
      const range = decodeURIComponent(url);
      if (range.includes("!1:1000")) {
        return {values: Array.from({length: 998}, (_, index) => [`h${index}`])};
      }
      if (range.includes("!1001:2000")) {
        return {values: Array.from({length: SHEET_PAGE_ROWS}, (_, index) => [`p${index}`])};
      }
      if (range.includes("!2001:2500")) {
        return {values: Array.from({length: 500}, (_, index) => [`q${index}`])};
      }
      return {values: []};
    });
    assert.equal(urls.length, 4);
    assert.equal(matrix.length, 2500);
    assert.deepEqual(matrix[997], ["h997"]);
    assert.deepEqual(matrix[998], []);
    assert.deepEqual(matrix[999], []);
    assert.deepEqual(matrix[1000], ["p0"]);
    assert.deepEqual(matrix[2499], ["q499"]);
  });

  it("maps a displayed £ charge to a fee and rewrites that cell", async () => {
    assert.equal(poundsToPence("£0.87"), 87);
    assert.equal(poundsToPence("0.87"), 87);
    assert.equal(poundsToPence(" £ 2.50 "), 250);
    assert.equal(poundsToPence("£1,234.50"), 123450);
    assert.equal(poundsToPence(""), undefined);
    assert.equal(poundsToPence("n/a"), undefined);
    assert.equal(poundsToPence("Free"), undefined);
    assert.equal(poundsToPence("£1-2"), undefined);

    const basePlace = {
      "Location Name": "Yard",
      "Postcode": "W1 1AA",
      "Latitude": "51.50",
      "Longitude": "-0.12",
      "Can Park? (Yes/No/Conditional)": "Yes",
      "Price Status": "Published",
    };
    assert.equal(mapPlace({...basePlace, "Parking Charge (£)": "£0.87"}).fee, 87);
    for (const charge of ["", "n/a", "Free", "£1-2"]) {
      const omitted = mapPlace({...basePlace, "Parking Charge (£)": charge});
      assert.equal("fee" in omitted, false, String(charge));
    }

    const head = [...HEAD, "Price Status", "Parking Charge (£)"];
    const row = [...YARD, "Published", "£0.87"];
    const first = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: async () => [head, row],
    });
    assert.equal(first.status, "ok");
    assert.equal(first.writes.length, 1);
    const written = first.writes[0];
    assert.equal(written.action, "upsert");
    assert.equal(written.data.places[0].fee, 87);

    const storedWithoutFee = {...written.data.places[0]};
    delete storedWithoutFee.fee;
    const previousHash = cellContentHash({cell: written.data.cell, places: [storedWithoutFee]});
    assert.notEqual(previousHash, written.data.contentHash);
    const rewritten = await syncPrivateParkingOnce({
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: 1,
      existing: [{
        id: written.id,
        cell: written.data.cell,
        contentHash: previousHash,
        expiresAtMs: NOW.getTime() + CELL_TTL_MS,
      }],
      loadSheet: async () => [head, row],
    });
    assert.equal(rewritten.writes.length, 1);
    assert.equal(rewritten.writes[0].action, "upsert");
    assert.equal(rewritten.writes[0].data.places[0].fee, 87);
    assert.equal(rewritten.unchanged, 0);

    const freeRow = [...YARD, "Published", "Free"];
    const free = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: async () => [head, freeRow],
    });
    const freeWrite = free.writes[0];
    assert.equal("fee" in freeWrite.data.places[0], false);
    const held = await syncPrivateParkingOnce({
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
      enabled: true,
      sheetId: "sheet-id",
      tab: "tab",
      lastGoodRowCount: 1,
      existing: [{
        id: freeWrite.id,
        cell: freeWrite.data.cell,
        contentHash: freeWrite.data.contentHash,
        expiresAtMs: NOW.getTime() + CELL_TTL_MS,
      }],
      loadSheet: async () => [head, freeRow],
    });
    assert.equal(held.writes.length, 0);
    assert.equal(held.unchanged, 1);
  });
});

/* Header row of spreadsheet 1VHtzY1001e0aRSXE6s_-IJU9YioJtjSNZ5WCOt1IO-o, tab ALL LONDON (clean). */
const LONDON_CLEAN_HEADERS = [
  "Location Name", "Brand", "Place Category", "Type (as captured)", "Area Type",
  "Street Address", "Postcode", "Postcode Area", "Borough",
  "Can Park? (Yes/No/Conditional)", "Who Can Park", "Location Status", "Rules Summary",
  "Cost Type", "Price Status", "Tariff Type", "Tariff Detail", "Charges (as published)",
  "Max Stay (mins)", "Max Stay (as captured)",
  "Hours (OpenStreetMap opening_hours format)", "Hours Basis", "Hours (as captured)",
  "Parking Control Type (Cameras / Barrier / Patrol)", "Operator",
  "PCN (Penalty Charge Notice) amount (£)", "Enforcement Details", "Evidence Type",
  "Evidence Detail (what the source shows)", "Source URLs (primary first)",
  "Source Tier", "Specificity", "Rules Stated", "Prices Stated", "Evidence Age",
  "Agreeing Sources", "Conflict", "Confidence (1-5)", "Captured By", "Date Captured",
  "Verified By", "Verified Date", "Verification Result", "Change Made (Yes/No)",
  "Latitude", "Longitude", "Geo Source", "Geo Precision", "Geo (as captured)", "Notes",
  "Review Flag", "Flag Status", "Free Stay Countdown (mins)", "Ferro Autopay",
  "Parking Charge (£)", "Total incl. Ferro Fee (£)", "Decision Reason", "Place ID",
  "Evidence Level", "OSM ID", "Postcode (derived from pin)", "Pin to postcode distance (m)",
  "Place Type", "Terminal", "Penalty Note", "Entry Note",
];
