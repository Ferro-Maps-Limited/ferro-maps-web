import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {FMPP_LOCATION_HEADERS, FMPP_TARIFF_HEADERS} from "../src/parking/privateSheet/fmpp.js";
import {
  LONDON_PART_MAX_BYTES,
  buildLondonPlaces,
  joinLondonSnapshot,
  londonHeaderProblem,
  londonSource,
  splitLondonSnapshot,
} from "../src/parking/privateSheet/londonList.js";
import {fetchLondonTabs, pageRowsFor, type SheetPayload} from "../src/parking/privateSheet/sheetsClient.js";
import {
  CELL_TTL_MS,
  syncPrivateParkingOnce,
  type LondonFolderInput,
} from "../src/parking/privateSheet/syncPlan.js";
import {
  buildTownPlaces,
  townKey,
  type TownRead,
  type TownSnapshot,
  type TownSource,
} from "../src/parking/privateSheet/towns.js";
import {type PrivatePlace} from "../src/parking/privateSheet/types.js";

const NOW = new Date("2026-11-27T15:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 60 * 60 * 1000;
/* The London list adds named columns after the FM-PP ones. */
const EXTRA = ["Geo Source", "Geo Precision"];
const LONDON_HEAD = [...FMPP_LOCATION_HEADERS, ...EXTRA];

function row(overrides: Record<string, unknown>, head: readonly string[] = LONDON_HEAD): unknown[] {
  const values: Record<string, unknown> = {
    "Location ID": "FERRO-WSM-0001",
    "Provider": "RingGo",
    "Provider Location Code": "6795",
    "Location Name": "Marylebone Road",
    "Latitude": 51.5215,
    "Longitude": -0.1610,
    "FM Ready": "✅",
    "Last Checked": "2026-11-26",
    "Geo Source": "RingGo",
    ...overrides,
  };
  return head.map((name) => (name && name in values ? values[name] : ""));
}

function londonRead(rows: Array<Record<string, unknown>>): {ok: true; locations: unknown[][]; tariffs: unknown[][]} {
  return {ok: true, locations: [LONDON_HEAD, ...rows.map((item) => row(item))], tariffs: [[...FMPP_TARIFF_HEADERS]]};
}

const LONDON: TownSource = {
  key: townKey("sheet-london"),
  sheetId: "sheet-london",
  town: "London",
  locationsTab: "Locations - London",
  tariffsTab: "Tariffs - London",
};
const WORTHING: TownSource = {
  key: townKey("sheet-worthing"),
  sheetId: "sheet-worthing",
  town: "Worthing",
  locationsTab: "Locations - Worthing",
  tariffsTab: "Tariffs - Worthing",
};
const OLD_LONDON_ID = "b".repeat(64);
const OLD_LONDON: PrivatePlace = {id: OLD_LONDON_ID, n: "Old yard", p: [51.5, -0.12], s: 1};

function worthingRead(): TownRead {
  return {
    ok: true,
    locations: [[...FMPP_LOCATION_HEADERS], row({
      "Location ID": "FERRO-WTG-CEN-0001", "Location Name": "High Street", "Latitude": 50.815, "Longitude": -0.372,
    }, FMPP_LOCATION_HEADERS)],
    tariffs: [[...FMPP_TARIFF_HEADERS]],
  };
}

describe("The London list in the town folder", () => {
  it("finds the one London workbook, not Londonderry", () => {
    const found = londonSource([
      {id: "sheet-derry", name: "FM—PP Londonderry"},
      {id: "sheet-london", name: "FM—PP London"},
      {id: "sheet-worthing", name: "FM-PP Worthing"},
    ]);
    assert.equal(found.ok, true);
    assert.deepEqual(found.ok && found.source, LONDON);
    assert.deepEqual(londonSource([{id: "sheet-derry", name: "FM—PP Londonderry"}]), {ok: false, reason: "london-not-found"});
    assert.deepEqual(
      londonSource([{id: "a-london", name: "FM—PP London"}, {id: "b-london", name: "Ferro Parking Locations - London"}]),
      {ok: false, reason: "london-ambiguous"},
    );
  });

  it("allows named columns after the FM-PP ones, and nothing else", () => {
    assert.equal(londonHeaderProblem("locations", LONDON_HEAD), null);
    assert.equal(londonHeaderProblem("locations", [...FMPP_LOCATION_HEADERS]), null);
    assert.equal(londonHeaderProblem("tariffs", [...FMPP_TARIFF_HEADERS, "Extra"]), null);
    const swapped = [...LONDON_HEAD];
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    assert.equal(londonHeaderProblem("locations", swapped), "header-unexpected");
    assert.equal(londonHeaderProblem("locations", FMPP_LOCATION_HEADERS.slice(0, 40)), "header-unexpected");
    assert.equal(londonHeaderProblem("locations", []), "header-missing");
  });

  it("keeps every borough's places, where a town keeps only its main code", () => {
    const read = londonRead([
      {},
      {"Location ID": "FERRO-WSM-0002", "Provider Location Code": "6796", "Latitude": 51.52},
      {"Location ID": "FERRO-CRY-0001", "Provider Location Code": "513", "Location Name": "Croydon", "Latitude": 51.37,
        "Longitude": -0.10},
      {"Location ID": "FERRO-CRY-0002", "FM Ready": ""},
    ]);
    const built = buildLondonPlaces(read, NOW_MS);
    assert.equal(built.ok, true);
    assert.deepEqual(built.ok && built.places.map((place) => place.id), ["FERRO-CRY-0001", "FERRO-WSM-0001", "FERRO-WSM-0002"]);
    assert.equal(built.ok && built.code, "LON");
    const asTown = buildTownPlaces(LONDON, {...read, locations: [[...FMPP_LOCATION_HEADERS], ...read.locations.slice(1)
      .map((item) => (item as unknown[]).slice(0, FMPP_LOCATION_HEADERS.length))]}, NOW_MS);
    // A town keeps one code (here the alphabetical tie-break, CRY), so two of London's three would go.
    assert.deepEqual(asTown.ok && asTown.places.map((place) => place.id), ["FERRO-CRY-0001"]);
    const priced = buildLondonPlaces({
      ...read,
      tariffs: [[...FMPP_TARIFF_HEADERS],
        ["FERRO-CRY-0001", "RingGo", "513", "For every 1 Hour — All Week", "2.50", "Verified", "", "2026-11-26", ""]],
    }, NOW_MS);
    const croydon = priced.ok ? priced.places.find((place) => place.id === "FERRO-CRY-0001") : undefined;
    const westminster = priced.ok ? priced.places.find((place) => place.id === "FERRO-WSM-0001") : undefined;
    assert.ok(croydon?.fee !== undefined || croydon?.rates !== undefined, "Croydon's prices reach its place");
    assert.equal(westminster?.fee === undefined && westminster?.rates === undefined, true);
    const badHead = {...read, locations: [[...FMPP_LOCATION_HEADERS].reverse(), ...read.locations.slice(1)]};
    assert.deepEqual(buildLondonPlaces(badHead, NOW_MS), {ok: false, reason: "header-unexpected:locations"});
  });

  it("stores a big list in parts and joins only a whole write", () => {
    const places: PrivatePlace[] = [];
    for (let index = 0; index < 3000; index += 1) {
      places.push({id: `FERRO-WSM-${String(index).padStart(5, "0")}`, n: "x".repeat(300), p: [51.5, -0.1], s: 1});
    }
    const snapshot: TownSnapshot = {key: LONDON.key, town: "London", code: "LON", places, count: places.length,
      readAtMs: NOW_MS, goodAtMs: NOW_MS};
    const {meta, parts} = splitLondonSnapshot(snapshot);
    assert.ok(parts.length >= 2);
    assert.equal(meta.parts, parts.length);
    for (const part of parts) assert.ok(Buffer.byteLength(JSON.stringify(part)) < LONDON_PART_MAX_BYTES + 1000);
    assert.equal("places" in meta, false);
    assert.deepEqual(joinLondonSnapshot(meta, [...parts].reverse()), snapshot);
    assert.equal(joinLondonSnapshot(meta, parts.slice(1)), null);
    assert.equal(joinLondonSnapshot(meta, parts.map((part) => ({...part, gen: "other"}))), null);
    assert.equal(joinLondonSnapshot(null, parts), null);
    assert.equal(splitLondonSnapshot({...snapshot, readAtMs: NOW_MS + 1}).meta.gen, meta.gen, "same places, same parts");
  });
});

describe("London from the folder instead of the old sheet", () => {
  const base = {now: NOW, enabled: true, sheetId: "sheet-id", tab: "ALL LONDON (clean)", lastGoodRowCount: 10_000};
  const towns = () => ({
    sources: [WORTHING],
    lastListedKeys: [WORTHING.key],
    snapshots: [],
    loadTown: async () => worthingRead(),
  });
  function folder(overrides: Partial<LondonFolderInput> = {}): LondonFolderInput & {oldReads: number} {
    const state = {oldReads: 0};
    const input: LondonFolderInput & {oldReads: number} = {
      source: LONDON,
      snapshot: null,
      load: async () => londonRead([{}, {"Location ID": "FERRO-CRY-0001", "Latitude": 51.37, "Longitude": -0.10}]),
      oldLondon: async () => {
        state.oldReads += 1;
        return [OLD_LONDON];
      },
      ...overrides,
      get oldReads() {
        return state.oldReads;
      },
    };
    return input;
  }
  const ids = (result: {writes: Array<{data: {places: PrivatePlace[]}}>}) =>
    result.writes.flatMap((write) => write.data.places.map((place) => place.id)).sort();
  const noSheet = async () => {
    throw new Error("the old London sheet must not be read");
  };
  const run = () => ({...base, existing: [], loadSheet: noSheet, towns: towns()});

  it("publishes the list in place of the old London, with the towns", async () => {
    const london = folder();
    const result = await syncPrivateParkingOnce({...run(), londonFolder: london});
    assert.equal(result.status, "ok");
    assert.deepEqual(ids(result), ["FERRO-CRY-0001", "FERRO-WSM-0001", "FERRO-WTG-CEN-0001"]);
    assert.equal(london.oldReads, 0, "the old London isn't read once the list is live");
    assert.equal(result.londonSnapshot?.count, 2);
    assert.equal(result.londonSnapshot?.goodAtMs, NOW_MS);
    assert.deepEqual(result.londonSummary, {found: true, read: "ok", places: 2, live: true, oldLondonKept: 0});
    assert.equal(result.config?.lastGoodRowCount, undefined, "the old sheet's count is kept");
  });

  it("removes the old London places from the cells when the list goes live", async () => {
    const old = await syncPrivateParkingOnce({
      ...base, existing: [], loadSheet: noSheet, towns: towns(),
      londonFolder: folder({load: async () => ({ok: false, reason: "tab-not-found"})}),
    });
    assert.deepEqual(ids(old), [OLD_LONDON_ID, "FERRO-WTG-CEN-0001"].sort());
    const existing = old.writes.map((write) => ({
      id: write.id,
      cell: write.data.cell,
      contentHash: write.data.contentHash,
      expiresAtMs: Date.parse(write.data.expiresAt),
    }));
    const live = await syncPrivateParkingOnce({...run(), existing, londonFolder: folder()});
    assert.ok(live.expired >= 1, "the old London car park's cell is emptied");
    assert.equal(ids(live).includes(OLD_LONDON_ID), false);
  });

  it("keeps the old London until the list has been read once", async () => {
    const london = folder({load: async () => ({ok: false, reason: "no-access"})});
    const result = await syncPrivateParkingOnce({...run(), londonFolder: london});
    assert.equal(result.status, "ok");
    assert.deepEqual(ids(result), [OLD_LONDON_ID, "FERRO-WTG-CEN-0001"].sort());
    assert.equal(london.oldReads, 1);
    assert.deepEqual(result.londonSummary, {found: true, read: "failed", reason: "no-access", places: 0, live: false,
      oldLondonKept: 1});
  });

  it("keeps the last good list when a read fails, and never reads the old London then", async () => {
    const last: TownSnapshot = {
      key: LONDON.key, town: "London", code: "LON", count: 1, readAtMs: NOW_MS - HOUR, goodAtMs: NOW_MS - 2 * HOUR,
      places: [{id: "FERRO-WSM-0001", n: "Marylebone Road", p: [51.5215, -0.161], s: 1}],
    };
    const london = folder({snapshot: last, load: async () => ({ok: false, reason: "rate-limited"})});
    const result = await syncPrivateParkingOnce({...run(), londonFolder: london});
    assert.deepEqual(ids(result), ["FERRO-WSM-0001", "FERRO-WTG-CEN-0001"]);
    assert.equal(london.oldReads, 0);
    assert.equal(result.londonSnapshot?.error, "rate-limited");
    assert.equal(result.londonSnapshot?.goodAtMs, NOW_MS - 2 * HOUR);
    const stale = folder({
      snapshot: {...last, goodAtMs: NOW_MS - CELL_TTL_MS - 1},
      source: null,
      sourceProblem: "london-not-found",
    });
    const old = await syncPrivateParkingOnce({...run(), londonFolder: stale});
    assert.deepEqual(ids(old), [OLD_LONDON_ID, "FERRO-WTG-CEN-0001"].sort());
  });

  it("stops rather than empty London when neither the list nor the old London has places", async () => {
    const london = folder({source: null, sourceProblem: "london-ambiguous", oldLondon: async () => []});
    const result = await syncPrivateParkingOnce({...run(), londonFolder: london});
    assert.equal(result.status, "aborted");
    assert.equal(result.abortReason, "london-folder-no-places");
    assert.equal(result.writes.length, 0);
    assert.equal(result.londonSummary?.reason, "london-ambiguous");
  });

  it("publishes a car park in both the London list and a borough workbook once", async () => {
    const croydon: TownSource = {key: townKey("sheet-croydon"), sheetId: "sheet-croydon", town: "Croydon",
      locationsTab: "Locations - Croydon", tariffsTab: "Tariffs - Croydon"};
    const croydonRead: TownRead = {
      ok: true,
      locations: [[...FMPP_LOCATION_HEADERS], row({"Location ID": "FERRO-CRY-0001", "Latitude": 51.37, "Longitude": -0.10},
        FMPP_LOCATION_HEADERS)],
      tariffs: [[...FMPP_TARIFF_HEADERS]],
    };
    const result = await syncPrivateParkingOnce({
      ...base, existing: [], loadSheet: noSheet,
      towns: {sources: [croydon], lastListedKeys: [croydon.key], snapshots: [], loadTown: async () => croydonRead},
      londonFolder: folder(),
    });
    assert.deepEqual(ids(result), ["FERRO-CRY-0001", "FERRO-WSM-0001"]);
  });
});

describe("Reading the London list", () => {
  function sheets(tabs: Record<string, {rowCount: number; columnCount: number}>, calls: string[] = []) {
    return async (url: string): Promise<SheetPayload> => {
      calls.push(url);
      if (!url.includes("/values/")) {
        return {sheets: Object.entries(tabs).map(([title, grid]) => ({properties: {title, gridProperties: grid}}))};
      }
      const range = decodeURIComponent(url.split("/values/")[1]?.split("?")[0] ?? "");
      const [, from, to] = /!(\d+):(\d+)$/.exec(range) ?? [];
      const values: unknown[][] = [];
      const kind = range.startsWith("'Tariffs") ? "t" : "l";
      for (let index = Number(from); index <= Number(to); index += 1) values.push([kind, index]);
      return {values};
    };
  }

  it("reads wide tabs in small pages and narrow ones in big pages, prices from Tariffs", async () => {
    assert.equal(pageRowsFor(74), 891);
    assert.equal(pageRowsFor(9), 7333);
    assert.equal(pageRowsFor(undefined), 1000);
    const calls: string[] = [];
    const read = await fetchLondonTabs(LONDON, sheets({
      "Locations - London": {rowCount: 1500, columnCount: 74},
      "Tariffs": {rowCount: 12_000, columnCount: 9},
    }, calls));
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.locations.length, 1500);
    assert.equal(read.ok && read.tariffs.length, 12_000);
    assert.deepEqual(read.ok && read.tariffs[11_999], ["t", 12_000]);
    assert.equal(calls.length, 1 + 2 + 2);
  });

  it("prefers Tariffs - London, and refuses a missing tab or an over-long one", async () => {
    const preferred = await fetchLondonTabs(LONDON, sheets({
      "Locations - London": {rowCount: 2, columnCount: 74},
      "Tariffs - London": {rowCount: 2, columnCount: 9},
      "Tariffs": {rowCount: 2, columnCount: 9},
    }));
    assert.equal(preferred.ok, true);
    assert.deepEqual(await fetchLondonTabs(LONDON, sheets({"Locations - London": {rowCount: 2, columnCount: 74}})),
      {ok: false, reason: "tab-not-found"});
    assert.deepEqual(await fetchLondonTabs(LONDON, sheets({
      "Locations - London": {rowCount: 2, columnCount: 74},
      "Tariffs": {rowCount: 250_000, columnCount: 9},
    })), {ok: false, reason: "too-large"});
  });
});
