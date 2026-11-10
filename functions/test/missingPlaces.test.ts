import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {GeoPoint, Timestamp, type Firestore} from "firebase-admin/firestore";
import {EVENTS_HEADERS, GROUND, PICKUP_POINTS} from "../src/surge/headers";
import {planMissingHotspots, runMissingHotspotCreate} from "../src/surge/missingPlaces";
import {commitNewHotspots, toPlaceData} from "../src/surge/placeCommit";
import {insideUk} from "../src/surge/placeKinds";
import {assertNoPrices} from "../src/surge/priceGuard";
import {matrix} from "../src/surge/syntheticSheet";
import {TPC_LOCATION, TPC_LOG_HEADERS} from "../src/surge/tpc";
import {lookupVenueLocation} from "../src/surge/venueLocations";

const NOW = new Date("2099-08-01T12:00:00.000Z");
const MONEY = ["18.40", "27.60", "£", "gbp", "uber", "fare", "baseline", "ratio", "1.8x"];

const FIXED_HEADERS = ["Place key", "Place name", "Category", "Latitude", "Longitude", "City"];
const WATCH_HEADERS = [
  "Place ID",
  "Place source",
  "Place name",
  "Category",
  "Latitude",
  "Longitude",
  "Price shown (GBP)",
  "Normal price for this trip (GBP)",
  "Surge shown in app",
  "Uber product",
  "Notes",
];

function mustVenue(name: string): {lat: number; lng: number} {
  const venue = lookupVenueLocation(name);
  if (!venue) throw new Error(`missing venue ${name}`);
  return {lat: venue.lat, lng: venue.lng};
}

function fixture() {
  const fixed = matrix(FIXED_HEADERS, [
    {["Place key"]: "FP-HYDRO", ["Place name"]: "OVO Hydro, Glasgow", Category: "arena"},
    {
      ["Place key"]: "FP-GUY",
      ["Place name"]: "Guy Hospital",
      Category: "hospital",
      Latitude: 51.503,
      Longitude: -0.089,
      City: "London",
    },
    {
      ["Place key"]: "FP-KEPT",
      ["Place name"]: "Kept Hospital",
      Category: "hospital",
      Latitude: 51.51,
      Longitude: -0.12,
      City: "London",
    },
    {
      ["Place key"]: "FP-ABROAD",
      ["Place name"]: "OVO Hydro, Glasgow",
      Category: "arena",
      Latitude: 53.3498,
      Longitude: -6.2603,
    },
    {["Place key"]: "A B", ["Place name"]: "Place A", Category: "hospital", Latitude: 51.5, Longitude: -0.1},
    {["Place key"]: "A-B", ["Place name"]: "Place B", Category: "hospital", Latitude: 51.5, Longitude: -0.12},
  ]);
  const watch = matrix(WATCH_HEADERS, [
    {
      ["Place ID"]: "pin_euston",
      ["Place source"]: "Hotspot Test Pins",
      ["Place name"]: "Euston",
      Category: "station",
      Latitude: 51.5282,
      Longitude: -0.1337,
      ["Price shown (GBP)"]: "27.60",
      ["Normal price for this trip (GBP)"]: "18.40",
      ["Surge shown in app"]: "1.8x",
      ["Uber product"]: "uber",
      Notes: "baseline fare £18.40 ratio",
    },
    {
      ["Place ID"]: "pin_euston",
      ["Place source"]: "Hotspot Test Pins",
      ["Place name"]: "Euston",
      Category: "station",
      Latitude: 51.5282,
      Longitude: -0.1337,
      ["Price shown (GBP)"]: "27.60",
      ["Normal price for this trip (GBP)"]: "18.40",
    },
    {
      ["Place ID"]: "pin_dublin",
      ["Place source"]: "Hotspot Test Pins",
      ["Place name"]: "Dublin Airport",
      Category: "airport",
      Latitude: 53.3498,
      Longitude: -6.2603,
      ["Price shown (GBP)"]: "£9",
    },
    {
      ["Place ID"]: "sheet_2099-06-01-O2-SHOW",
      ["Place source"]: "Hotspot Test Pins",
      ["Place name"]: "The O2 arena, London",
      Category: "arena",
      Latitude: 51.503,
      Longitude: 0.003,
    },
  ]);
  const events = matrix([...EVENTS_HEADERS, "Venue type"], [
    {[GROUND]: "Principality Stadium, Cardiff", ["Venue type"]: "stadium"},
    {[GROUND]: "Synthetic Nowhere Hall", ["Venue type"]: "stadium"},
    {
      [GROUND]: "OVO Hydro, Glasgow",
      ["Venue type"]: "arena",
      [PICKUP_POINTS]: "Gate | 48.8566, 2.3522",
    },
  ]);
  const tpc = matrix(TPC_LOG_HEADERS, [
    {[TPC_LOCATION]: "Barking", Mode: "Rail", Type: "station", [GROUND]: "Barking"},
    {[TPC_LOCATION]: "Piccadilly line: ENTIRE LINE", Mode: "Rail", [GROUND]: "Piccadilly entire line"},
  ]);
  return {events, fixedPlaces: fixed, watchlist: watch, tpcLog: tpc};
}

function assertNoMoney(value: unknown): void {
  const raw = JSON.stringify(value).toLowerCase();
  for (const token of MONEY) assert.equal(raw.includes(token.toLowerCase()), false, token);
  assertNoPrices(value);
}

describe("missing hotspot places", () => {
  it("keeps a point inside the UK and rejects Dublin, Paris, and 0,0", () => {
    assert.equal(insideUk(51.507, -0.128), true);
    assert.equal(insideUk(55.86, -4.25), true);
    assert.equal(insideUk(54.597, -5.93), true);
    assert.equal(insideUk(49.92, -6.32), true);
    assert.equal(insideUk(53.3498, -6.2603), false);
    assert.equal(insideUk(48.8566, 2.3522), false);
    assert.equal(insideUk(0, 0), false);
  });

  it("dry-run lists checked places and writes nothing", async () => {
    const tabs = fixture();
    const existing = [{id: "kept_doc", fixedPlaceKey: "FP-KEPT"}];
    const planned = planMissingHotspots({...tabs, existing});
    assert.deepEqual(planned.creates.map((place) => place.id), [
      "fp_fp-guy",
      "fp_fp-hydro",
      "pin_euston",
      "place_stadium-principality-stadium-cardiff",
    ]);
    assert.equal(planned.alreadyPresent, 1);
    assert.equal(planned.skippedUnverified, 8);
    const hydro = mustVenue("OVO Hydro, Glasgow");
    const principality = mustVenue("Principality Stadium, Cardiff");
    const byId = new Map(planned.creates.map((place) => [place.id, place]));
    const guy = byId.get("fp_fp-guy");
    const arena = byId.get("fp_fp-hydro");
    const station = byId.get("pin_euston");
    const stadium = byId.get("place_stadium-principality-stadium-cardiff");
    if (!guy || !arena || !station || !stadium) throw new Error("missing planned place");
    assert.equal(guy.category, "hospital");
    assert.equal(guy.idSource, "fixed_places");
    assert.equal(guy.fixedPlaceKey, "FP-GUY");
    assert.equal(guy.city, "London");
    assert.equal(guy.positionSource, "sheet_coordinates");
    assert.equal(arena.category, "arena");
    assert.equal(arena.positionSource, "venue_lookup");
    assert.equal(arena.fixedPlaceKey, "FP-HYDRO");
    assert.deepEqual(arena.location, hydro);
    assert.equal(station.category, "station");
    assert.equal(station.idSource, "tpc_watchlist_pin");
    assert.equal(station.fixedPlaceKey, undefined);
    assert.equal(stadium.category, "stadium");
    assert.equal(stadium.idSource, "surge_events_place");
    assert.deepEqual(stadium.location, principality);
    assert.equal(stadium.positionSource, "venue_lookup");
    assertNoMoney(planned);

    let commits = 0;
    const summary = await runMissingHotspotCreate({
      now: NOW,
      sheetId: "sheet-under-test",
      eventsTab: "Events",
      fixedPlacesTab: "Fixed Places",
      watchlistTab: "TPC Watchlist Readings",
      tpcLogTab: "TPC Disruption Log",
      load: async () => tabs,
      listExisting: async () => existing,
      commit: async () => {
        commits += 1;
        return 0;
      },
    });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.created, 0);
    assert.equal(commits, 0);
    assert.deepEqual(summary.wouldCreate.map((place) => place.id), planned.creates.map((place) => place.id));
    assert.equal(summary.skippedUnverified, 8);
    assertNoMoney(summary);
  });

  it("creates only missing docs, and the category shape differs by place type", async () => {
    const tabs = fixture();
    const existing = [{id: "kept_doc", fixedPlaceKey: "FP-KEPT"}];
    const summary = await runMissingHotspotCreate({
      now: NOW,
      dryRun: false,
      sheetId: "sheet-under-test",
      eventsTab: "Events",
      fixedPlacesTab: "Fixed Places",
      watchlistTab: "TPC Watchlist Readings",
      tpcLogTab: "TPC Disruption Log",
      load: async () => tabs,
      listExisting: async () => existing,
      commit: async (records) => records.length,
    });
    assert.equal(summary.dryRun, false);
    assert.equal(summary.created, 4);
    const guy = toPlaceData(summary.wouldCreate[0], NOW);
    const arena = toPlaceData(summary.wouldCreate[1], NOW);
    const station = toPlaceData(summary.wouldCreate[2], NOW);
    const stadium = toPlaceData(summary.wouldCreate[3], NOW);
    assert.equal("events" in guy, false);
    assert.equal(guy.fixedPlaceKey, "FP-GUY");
    assert.deepEqual(Object.keys(guy).sort(), [
      "category",
      "city",
      "country",
      "description",
      "fetched_at",
      "fixedPlaceKey",
      "idSource",
      "location",
      "name",
      "positionSource",
    ]);
    assert.deepEqual((arena.events as {venue_name: string}).venue_name, "OVO Hydro, Glasgow");
    assert.equal("events" in station, false);
    assert.equal(station.category, "station");
    assert.deepEqual(Object.keys(stadium.events as object), ["venue_name"]);
    assert.equal(stadium.category, "stadium");
    for (const data of [guy, arena, station, stadium]) {
      assert.ok(data.location instanceof GeoPoint);
      assert.ok(data.fetched_at instanceof Timestamp);
      assert.equal(data.country, "United Kingdom");
      assert.equal("forecast" in data, false);
      assertNoMoney(data);
    }
    const ops: string[] = [];
    const db = {
      collection() {
        return {doc(id: string) {
          return {id};
        }};
      },
      batch() {
        const staged: string[] = [];
        return {
          create(ref: {id: string}) {
            staged.push(`create:${ref.id}`);
          },
          set() {
            staged.push("set");
          },
          update() {
            staged.push("update");
          },
          delete() {
            staged.push("delete");
          },
          async commit() {
            ops.push(...staged);
          },
        };
      },
    } as unknown as Firestore;
    assert.equal(await commitNewHotspots(db, summary.wouldCreate, NOW), 4);
    assert.deepEqual(ops, [
      "create:fp_fp-guy",
      "create:fp_fp-hydro",
      "create:pin_euston",
      "create:place_stadium-principality-stadium-cardiff",
    ]);
  });

  it("does not replace a checked venue when the sheet point is outside the UK", () => {
    const planned = planMissingHotspots({
      ...fixture(),
      existing: [],
    });
    assert.equal(planned.creates.some((place) => place.fixedPlaceKey === "FP-ABROAD"), false);
    assert.equal(planned.creates.some((place) => place.id.startsWith("place_arena-ovo")), false);
  });

  it("skips a name that would publish a fare word", () => {
    const planned = planMissingHotspots({
      events: matrix([...EVENTS_HEADERS, "Venue type"], [{
        [GROUND]: "Uber fare baseline £18.40",
        ["Venue type"]: "stadium",
        [PICKUP_POINTS]: "Gate | 51.501, -0.141",
      }]),
      fixedPlaces: [],
      watchlist: [],
      tpcLog: [],
      existing: [],
    });
    assert.equal(planned.creates.length, 0);
    assert.equal(planned.skippedUnverified, 1);
    assertNoMoney(planned);
  });

  it("does not read when the spreadsheet id is blank, and dry-run stays the default", async () => {
    let loaded = 0;
    const summary = await runMissingHotspotCreate({
      now: NOW,
      sheetId: "  ",
      eventsTab: "Events",
      fixedPlacesTab: "Fixed Places",
      watchlistTab: "TPC Watchlist Readings",
      tpcLogTab: "TPC Disruption Log",
      load: async () => {
        loaded += 1;
        return {events: [], fixedPlaces: [], watchlist: [], tpcLog: []};
      },
      listExisting: async () => [],
      commit: async () => 1,
    });
    assert.equal(summary.status, "skipped");
    assert.equal(summary.reason, "sheet-id-missing");
    assert.equal(summary.dryRun, true);
    assert.equal(loaded, 0);
    const src = readFileSync(join(__dirname, "../src/surge/syncStadiumSurgeSheet.ts"), "utf8");
    const places = readFileSync(join(__dirname, "../src/surge/missingPlaces.ts"), "utf8");
    assert.match(places, /SURGE_CREATE_PLACES_DRY_RUN", \{default: "true"\}/);
    assert.match(src, /dryRunEnabled\(surgeCreatePlacesDryRun\.value\(\)\)/);
    assert.match(src, /proposed: summary\.wouldCreate\.length/);
    assert.equal(src.includes("summary.wouldCreate,"), false);
    assert.equal(src.includes("summary.wouldCreate)"), false);
    const commitSrc = readFileSync(join(__dirname, "../src/surge/placeCommit.ts"), "utf8");
    assert.match(commitSrc, /batch\.create\(/);
    assert.equal(commitSrc.includes(".delete("), false);
    assert.equal(commitSrc.includes("merge: true"), false);
    const indexSrc = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    assert.equal(indexSrc.includes("createMissingHotspots"), false);
    assert.match(indexSrc, /export \{syncSurgeSheetEvents\}/);
    assertNoMoney(summary);
  });
});
