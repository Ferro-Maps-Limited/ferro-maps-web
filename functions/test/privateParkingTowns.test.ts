import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {FMPP_LOCATION_HEADERS, FMPP_TARIFF_HEADERS} from "../src/parking/privateSheet/fmpp.js";
import {
  cleanFolderId,
  driveFolderPageUrl,
  fetchTownTabs,
  listFolderSpreadsheets,
  townBatchUrl,
} from "../src/parking/privateSheet/sheetsClient.js";
import {
  CELL_TTL_MS,
  syncPrivateParkingOnce,
  type SheetLoader,
} from "../src/parking/privateSheet/syncPlan.js";
import {
  TOWN_DROP_GRACE_MS,
  buildTownPlaces,
  dominantCode,
  publishTownPlaces,
  runTowns,
  townFromWorkbookName,
  townKey,
  townSources,
  type TownLoader,
  type TownRead,
  type TownSnapshot,
  type TownSource,
} from "../src/parking/privateSheet/towns.js";
import {type PrivatePlace} from "../src/parking/privateSheet/types.js";

const NOW = new Date("2026-11-26T21:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 60 * 60 * 1000;

function row(overrides: Record<string, unknown>): unknown[] {
  const values: Record<string, unknown> = {
    "Location ID": "FERRO-WTG-CEN-0001",
    "Provider": "RingGo",
    "Provider Location Code": "1234",
    "Location Name": "High Street",
    "Latitude": 50.8150,
    "Longitude": -0.3720,
    "FM Ready": "✅",
    "Last Checked": "2026-11-25",
    ...overrides,
  };
  return FMPP_LOCATION_HEADERS.map((name) => (name && name in values ? values[name] : ""));
}

function workbook(rows: Array<Record<string, unknown>>): {ok: true; locations: unknown[][]; tariffs: unknown[][]} {
  return {ok: true, locations: [[...FMPP_LOCATION_HEADERS], ...rows.map(row)], tariffs: [[...FMPP_TARIFF_HEADERS]]};
}

function source(town: string, sheetId = `sheet-${town.toLowerCase().replace(/\W+/g, "-")}`): TownSource {
  return {key: townKey(sheetId), sheetId, town, locationsTab: `Locations - ${town}`, tariffsTab: `Tariffs - ${town}`};
}

function loader(books: Record<string, TownRead>, seen: string[] = []): TownLoader {
  return async (src) => {
    seen.push(src.town);
    return books[src.town] ?? {ok: false, reason: "tab-not-found"};
  };
}

function place(id: string, lat: number, lng: number): PrivatePlace {
  return {id, n: id, p: [lat, lng], s: 1, q: "known", aud: "a", auto: true, payMode: "inapp"};
}

function snapshot(src: TownSource, places: PrivatePlace[], overrides: Partial<TownSnapshot> = {}): TownSnapshot {
  return {
    key: src.key,
    town: src.town,
    places,
    count: places.length,
    readAtMs: NOW_MS - HOUR,
    goodAtMs: NOW_MS - HOUR,
    ...overrides,
  };
}

const WORTHING = source("Worthing");
const OXFORD = source("Oxford");
const LIVERPOOL = source("Liverpool");
const LIVINGSTON = source("Livingston");

describe("Town workbooks in the folder", () => {
  it("reads the town from each workbook name and skips London only", () => {
    assert.equal(townFromWorkbookName("FM-PP Birmingham"), "Birmingham");
    assert.equal(townFromWorkbookName("FM—PP Newport (Isle of Wight)"), "Newport (Isle of Wight)");
    assert.equal(townFromWorkbookName("Ferro Parking Locations - Stockton-on-Tees"), "Stockton-on-Tees");
    assert.equal(townFromWorkbookName("107 - FM PP Locations (for the app)"), null);
    assert.equal(townFromWorkbookName("Notes"), null);
    const sources = townSources([
      {id: "id-london", name: "FM—PP London"},
      {id: "id-derry", name: "FM—PP Londonderry"},
      {id: "id-bhm", name: "FM-PP Birmingham"},
      {id: "id-bhm", name: "FM-PP Birmingham"},
      {id: "id-notes", name: "Read me"},
    ]);
    assert.deepEqual(sources.map((item) => item.town), ["Birmingham", "Londonderry"]);
    assert.equal(sources[0]?.locationsTab, "Locations - Birmingham");
    assert.equal(sources[0]?.tariffsTab, "Tariffs - Birmingham");
    assert.equal(sources[0]?.key, townKey("id-bhm"));
    assert.equal(sources[0]?.key.includes("id-bhm"), false);
  });

  it("takes the town code most rows use, and an empty workbook has no places", () => {
    const book = workbook([
      {"Location ID": "FERRO-BHM-CEN-0001"},
      {"Location ID": "FERRO-BHM-CEN-0002"},
      {"Location ID": "FERRO-WTG-CEN-0001"},
    ]);
    assert.equal(dominantCode(book.locations), "BHM");
    assert.equal(dominantCode([[...FMPP_LOCATION_HEADERS]]), null);
    const built = buildTownPlaces(source("Birmingham"), book);
    assert.ok(built.ok);
    assert.equal(built.code, "BHM");
    assert.deepEqual(built.places.map((item) => item.id), ["FERRO-BHM-CEN-0001", "FERRO-BHM-CEN-0002"]);
    const empty = buildTownPlaces(source("Yate"), workbook([]));
    assert.deepEqual(empty, {ok: true, places: []});
    const wrong = buildTownPlaces(source("Yate"), {locations: [["Location ID"]], tariffs: [[...FMPP_TARIFF_HEADERS]]});
    assert.deepEqual(wrong, {ok: false, reason: "header-unexpected:locations"});
  });
});

describe("Town runs", () => {
  it("publishes Worthing's car parks once when other towns hold copies of them", async () => {
    const copy = workbook([{"Location ID": "FERRO-WTG-CEN-0001"}, {"Location ID": "FERRO-WTG-CEN-0002", "Latitude": 50.8160}]);
    const run = await runTowns({
      nowMs: NOW_MS,
      sources: [WORTHING, OXFORD],
      lastListedKeys: null,
      snapshots: [],
      loadTown: loader({Worthing: copy, Oxford: copy}),
    });
    assert.deepEqual(run.places.map((item) => item.id), ["FERRO-WTG-CEN-0001", "FERRO-WTG-CEN-0002"]);
    assert.equal(run.summary.duplicateCopies, 2);
    assert.deepEqual(run.summary.collisions, []);
    assert.equal(run.changed.length, 2);
  });

  it("publishes neither car park when two towns use one id for different places", async () => {
    const run = await runTowns({
      nowMs: NOW_MS,
      sources: [LIVERPOOL, LIVINGSTON],
      lastListedKeys: null,
      snapshots: [],
      loadTown: loader({
        Liverpool: workbook([
          {"Location ID": "FERRO-LIV-CEN-0001", "Latitude": 53.4084, "Longitude": -2.9916},
          {"Location ID": "FERRO-LIV-CEN-0009", "Latitude": 53.4090, "Longitude": -2.9900},
        ]),
        Livingston: workbook([{"Location ID": "FERRO-LIV-CEN-0001", "Latitude": 55.8865, "Longitude": -3.5230}]),
      }),
    });
    assert.deepEqual(run.places.map((item) => item.id), ["FERRO-LIV-CEN-0009"]);
    assert.deepEqual(run.summary.collisions, ["FERRO-LIV-CEN-0001"]);
  });

  it("keeps a failing town's last good car parks and still updates the others", async () => {
    const old = snapshot(OXFORD, [place("FERRO-OXF-CEN-0001", 51.752, -1.2577)]);
    const run = await runTowns({
      nowMs: NOW_MS,
      sources: [OXFORD, WORTHING],
      lastListedKeys: null,
      snapshots: [old],
      loadTown: loader({Worthing: workbook([{}])}),
    });
    assert.deepEqual(run.places.map((item) => item.id), ["FERRO-OXF-CEN-0001", "FERRO-WTG-CEN-0001"]);
    assert.deepEqual(run.summary.failed, [{town: "Oxford", reason: "tab-not-found"}]);
    const oxford = run.changed.find((item) => item.town === "Oxford");
    assert.equal(oxford?.goodAtMs, old.goodAtMs);
    assert.equal(oxford?.readAtMs, NOW_MS);
    assert.equal(oxford?.error, "tab-not-found");
  });

  it("holds a drop of more than 10% for six hours, then accepts it", async () => {
    const ten = Array.from({length: 10}, (_, index) => place(`FERRO-WTG-CEN-${index + 10}`, 50.815, -0.372));
    const old = snapshot(WORTHING, ten);
    const fewer = workbook([{"Location ID": "FERRO-WTG-CEN-0001"}]);
    const first = await runTowns({
      nowMs: NOW_MS,
      sources: [WORTHING],
      lastListedKeys: null,
      snapshots: [old],
      loadTown: loader({Worthing: fewer}),
    });
    assert.equal(first.places.length, 10);
    assert.equal(first.changed[0]?.error, "dropped");
    assert.equal(first.changed[0]?.dropSinceMs, NOW_MS);
    const held = first.changed[0];
    assert.ok(held);
    const later = await runTowns({
      nowMs: NOW_MS + TOWN_DROP_GRACE_MS,
      sources: [WORTHING],
      lastListedKeys: null,
      snapshots: [held],
      loadTown: loader({Worthing: fewer}),
    });
    assert.deepEqual(later.places.map((item) => item.id), ["FERRO-WTG-CEN-0001"]);
    assert.equal(later.changed[0]?.error, undefined);
    assert.equal(later.changed[0]?.dropCount, undefined);
  });

  it("reads towns never read first, stops on a rate limit, and publishes the rest from snapshots", async () => {
    const towns = ["Aberdeen", "Bath", "Cardiff", "Dundee"].map((town) => source(town));
    const [aberdeen, bath, cardiff, dundee] = towns;
    assert.ok(aberdeen && bath && cardiff && dundee);
    const snapshots = [
      snapshot(aberdeen, [place("FERRO-ABD-CEN-0001", 57.15, -2.1)], {readAtMs: NOW_MS - 3 * HOUR}),
      snapshot(bath, [place("FERRO-BTH-CEN-0001", 51.38, -2.36)], {readAtMs: NOW_MS - HOUR}),
      snapshot(cardiff, [place("FERRO-CDF-CEN-0001", 51.48, -3.18)], {readAtMs: NOW_MS - 2 * HOUR}),
    ];
    const seen: string[] = [];
    const run = await runTowns({
      nowMs: NOW_MS,
      sources: towns,
      lastListedKeys: null,
      snapshots,
      maxReads: 3,
      loadTown: loader({
        Dundee: workbook([{"Location ID": "FERRO-DND-CEN-0001", "Latitude": 56.46, "Longitude": -2.97}]),
        Aberdeen: {ok: false, reason: "rate-limited", stop: true},
      }, seen),
    });
    assert.deepEqual(seen, ["Dundee", "Aberdeen"]);
    assert.equal(run.summary.read, 1);
    assert.equal(run.summary.stopped, "rate-limited");
    assert.deepEqual(run.places.map((item) => item.id).sort(), [
      "FERRO-ABD-CEN-0001", "FERRO-BTH-CEN-0001", "FERRO-CDF-CEN-0001", "FERRO-DND-CEN-0001",
    ]);
    const deadline = await runTowns({
      nowMs: NOW_MS,
      sources: towns,
      lastListedKeys: null,
      snapshots,
      loadTown: loader({}, seen),
      keepReading: () => false,
    });
    assert.equal(deadline.summary.read, 0);
    assert.equal(deadline.summary.stopped, "deadline");
    assert.equal(deadline.places.length, 3);
  });

  it("drops a town taken out of the folder, but not when the listing fails or shrinks", async () => {
    const snapshots = [
      snapshot(WORTHING, [place("FERRO-WTG-CEN-0001", 50.815, -0.372)]),
      snapshot(OXFORD, [place("FERRO-OXF-CEN-0001", 51.752, -1.2577)]),
    ];
    const both = [WORTHING.key, OXFORD.key].sort();
    const removed = await runTowns({
      nowMs: NOW_MS,
      sources: [WORTHING],
      lastListedKeys: [WORTHING.key],
      snapshots,
      maxReads: 0,
      loadTown: loader({}),
    });
    assert.deepEqual(removed.places.map((item) => item.id), ["FERRO-WTG-CEN-0001"]);
    assert.deepEqual(removed.listedKeys, [WORTHING.key]);
    const failed = await runTowns({
      nowMs: NOW_MS,
      sources: null,
      lastListedKeys: both,
      snapshots,
      loadTown: loader({}),
    });
    assert.equal(failed.summary.listProblem, "list-failed");
    assert.equal(failed.listedKeys, null);
    assert.equal(failed.places.length, 2);
    const shrunk = await runTowns({
      nowMs: NOW_MS,
      sources: [WORTHING],
      lastListedKeys: both,
      snapshots,
      maxReads: 0,
      loadTown: loader({}),
    });
    assert.equal(shrunk.summary.listProblem, "list-dropped");
    assert.equal(shrunk.places.length, 2);
  });

  it("stops publishing a town whose last good read is older than the cell lifetime", () => {
    const stale = snapshot(OXFORD, [place("FERRO-OXF-CEN-0001", 51.752, -1.2577)], {
      goodAtMs: NOW_MS - CELL_TTL_MS - 1,
    });
    assert.equal(publishTownPlaces([stale], NOW_MS).places.length, 0);
  });
});

describe("Town folder sync alongside London", () => {
  const HEAD = [
    "Location Name", "Postcode", "Latitude", "Longitude", "Location Status",
    "Evidence Type", "Who Can Park", "Verification Result",
  ];
  const YARD = ["Yard", "W1 1AA", "51.50", "-0.12", "Open", "Official site: clear answer", "Customers only", "Confirmed"];
  const london: SheetLoader = async () => [HEAD, YARD];

  it("writes London and town cells, and a London abort reads no town", async () => {
    const seen: string[] = [];
    const base = {
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "ALL LONDON (clean)",
      existing: [],
      loadSheet: london,
    };
    const towns = {
      sources: [WORTHING],
      lastListedKeys: null,
      snapshots: [],
      loadTown: loader({Worthing: workbook([{}])}, seen),
    };
    const result = await syncPrivateParkingOnce({...base, lastGoodRowCount: null, fmppSources: "BAD", towns});
    assert.equal(result.status, "ok");
    assert.equal(result.imported, 2);
    const ids = result.writes.flatMap((write) => write.data.places.map((item) => item.id));
    assert.equal(ids.includes("FERRO-WTG-CEN-0001"), true);
    assert.equal(ids.some((id) => /^[0-9a-f]{64}$/.test(id)), true);
    assert.deepEqual(result.config?.townsListedKeys, [WORTHING.key]);
    assert.equal(result.config?.townsLastRun?.places, 1);
    assert.equal(result.townSnapshots?.length, 1);
    const dropped = await syncPrivateParkingOnce({...base, lastGoodRowCount: 100, towns});
    assert.equal(dropped.status, "aborted");
    assert.deepEqual(seen, ["Worthing"]);
  });

  it("keeps the cell hash when a town comes from its stored snapshot instead of a fresh read", async () => {
    const base = {
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: london,
    };
    const fresh = await syncPrivateParkingOnce({
      ...base,
      towns: {sources: [WORTHING], lastListedKeys: null, snapshots: [], loadTown: loader({Worthing: workbook([{}])})},
    });
    const stored = fresh.townSnapshots?.[0];
    assert.ok(stored);
    const reordered = stored.places.map((item) => {
      const record = item as unknown as Record<string, unknown>;
      const entries = Object.keys(record).reverse().map((key) => [key, record[key]]);
      return Object.fromEntries(entries) as unknown as PrivatePlace;
    });
    const later = await syncPrivateParkingOnce({
      ...base,
      towns: {
        sources: [WORTHING],
        lastListedKeys: [WORTHING.key],
        snapshots: [{...stored, places: reordered}],
        loadTown: loader({}),
        maxReads: 0,
      },
    });
    const hashes = (result: typeof fresh) => result.writes.map((write) => write.data.contentHash).sort();
    assert.deepEqual(hashes(later), hashes(fresh));
  });
});

describe("Town reads and the folder listing", () => {
  it("asks for both tabs in one request and maps Sheets errors", async () => {
    const url = townBatchUrl(source("Newport (Isle of Wight)", "abc123"));
    assert.match(url, /spreadsheets\/abc123\/values:batchGet\?/);
    assert.equal(url.includes("ranges=" + encodeURIComponent("'Locations - Newport (Isle of Wight)'")), true);
    assert.equal(url.includes("ranges=" + encodeURIComponent("'Tariffs - Newport (Isle of Wight)'")), true);
    const ok = await fetchTownTabs(WORTHING, async () => ({valueRanges: [{values: [["a"]]}, {}]}), 0);
    assert.deepEqual(ok, {ok: true, locations: [["a"]], tariffs: []});
    const failing = (status: number) => async () => {
      throw Object.assign(new Error("gaxios"), {response: {status}});
    };
    assert.deepEqual(await fetchTownTabs(WORTHING, failing(400), 0), {ok: false, reason: "tab-not-found"});
    assert.deepEqual(await fetchTownTabs(WORTHING, failing(403), 0), {ok: false, reason: "no-access"});
    assert.deepEqual(await fetchTownTabs(WORTHING, failing(500), 0), {ok: false, reason: "read-error:500"});
    assert.deepEqual(await fetchTownTabs(WORTHING, failing(429), 0), {ok: false, reason: "rate-limited", stop: true});
    let calls = 0;
    const once = await fetchTownTabs(WORTHING, async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("gaxios"), {response: {status: 429}});
      return {valueRanges: [{values: [["b"]]}]};
    }, 0);
    assert.equal(once.ok, true);
    assert.equal(calls, 2);
  });

  it("lists spreadsheets in the folder page by page and refuses a bad folder id", async () => {
    const url = driveFolderPageUrl("folder_ID-123", "next");
    const query = new URL(url).searchParams;
    assert.equal(query.get("q"), "'folder_ID-123' in parents and " +
      "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false");
    assert.equal(query.get("pageToken"), "next");
    assert.equal(cleanFolderId("abc' or name contains 'x"), null);
    const pages: string[] = [];
    const files = await listFolderSpreadsheets("folder_ID-123", async (pageUrl) => {
      pages.push(new URL(pageUrl).searchParams.get("pageToken") ?? "");
      return pages.length === 1 ?
        {files: [{id: "a", name: "FM-PP A"}, {id: 7, name: "bad"}], nextPageToken: "p2"} :
        {files: [{id: "b", name: "FM-PP B"}]};
    });
    assert.deepEqual(files, [{id: "a", name: "FM-PP A"}, {id: "b", name: "FM-PP B"}]);
    assert.deepEqual(pages, ["", "p2"]);
    await assert.rejects(listFolderSpreadsheets("bad'id", async () => ({})), /folder-id-invalid/);
  });
});
