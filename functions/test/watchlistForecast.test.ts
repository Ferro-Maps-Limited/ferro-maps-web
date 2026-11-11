import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {runCategoryForecastAttach} from "../src/surge/attachCategoryForecasts";
import {commitCategoryForecasts, toCategoryForecastData} from "../src/surge/categoryCommit";
import {planCategoryForecasts, type HotspotPin} from "../src/surge/categoryPlan";
import {
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  GROUND,
  HOME_TEAM,
  KICKOFF,
  PEAK_UPLIFT,
} from "../src/surge/headers";
import {assertNoPrices} from "../src/surge/priceGuard";
import {matrix} from "../src/surge/syntheticSheet";
import {DISRUPTION_ID, TPC_LOCATION, TPC_LOG_HEADERS, TPC_READINGS_HEADERS} from "../src/surge/tpc";
import {lookupVenueLocation} from "../src/surge/venueLocations";
import {
  LIVE_WATCHLIST_HEADERS,
  WATCHLIST_BASELINE_FARE,
  WATCHLIST_BUSY_SHOWN,
  WATCHLIST_DID_IT_SURGE,
  WATCHLIST_DISRUPTION_ID,
  WATCHLIST_FARE_SHOWN,
  WATCHLIST_HEADERS,
  WATCHLIST_NORMAL_PRICE,
  WATCHLIST_PHASE,
  WATCHLIST_PLACE_ID,
  WATCHLIST_PLACE_NAME,
  WATCHLIST_PLACE_SOURCE,
  WATCHLIST_PRICE_SHOWN,
  WATCHLIST_READING_TYPE,
  WATCHLIST_SURGE_SHOWN,
  WATCHLIST_TAKEN_AT,
  WATCHLIST_TIME_UK,
  WATCHLIST_TIME_UTC,
  WATCHLIST_UBER_PRODUCT,
} from "../src/surge/watchlist";

const NOW = new Date("2099-08-01T12:00:00.000Z");
const PRICE = "18.40";
const SURGE_PRICE = "27.60";
const MONEY_TOKENS = [PRICE, "18.4", SURGE_PRICE, "27.6", "1.8x", "1.8", "£", "gbp", "uber", "baseline", "fare", "ratio"];

function hydro(): {lat: number; lng: number} {
  const venue = lookupVenueLocation("OVO Hydro, Glasgow");
  if (!venue) throw new Error("missing venue");
  return venue;
}

function eventHistory(): Record<string, unknown>[] {
  return ["01", "02", "03", "04"].map((day, index) => ({
    [EVENT_ID]: `2099-05-${day}-HYD-W${index}`,
    [HOME_TEAM]: `Artist ${day}`,
    [GROUND]: "OVO Hydro, Glasgow",
    [KICKOFF]: `2099-05-${day} 15:00`,
    [DID_IT_SURGE]: "YES",
    [PEAK_UPLIFT]: "47%",
    "Baseline fare (£)": PRICE,
    "Notes": "baseline fare £18.40 uber",
  }));
}

function stationRows(): Record<string, unknown>[] {
  return ["01", "02", "03", "04"].map((day) => ({
    [DISRUPTION_ID]: `2099-05-BARK-${day}`,
    [GROUND]: "Barking",
    [KICKOFF]: `2099-05-${day} 08:00`,
    [TPC_LOCATION]: "Barking",
    [DID_IT_SURGE]: "YES",
    [PEAK_UPLIFT]: 0.47,
    "Baseline fare (£)": PRICE,
    "Uber product": "uber",
  }));
}

function reading(id: string): Record<string, unknown> {
  return {[EVENT_ID]: id, "Fare shown (£)": PRICE, "Baseline fare (£)": PRICE, "Uber product": "uber"};
}

function watchRow(
  placeId: string,
  source: string,
  disruption: string,
  day: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [WATCHLIST_PLACE_ID]: placeId,
    [WATCHLIST_PLACE_SOURCE]: source,
    [WATCHLIST_PLACE_NAME]: "Do not match this name",
    [WATCHLIST_READING_TYPE]: "During",
    [WATCHLIST_DISRUPTION_ID]: disruption,
    [WATCHLIST_TAKEN_AT]: `2099-05-${day} 18:00`,
    [WATCHLIST_PRICE_SHOWN]: SURGE_PRICE,
    [WATCHLIST_NORMAL_PRICE]: PRICE,
    [WATCHLIST_SURGE_SHOWN]: "",
    [WATCHLIST_UBER_PRODUCT]: "uber",
    "Notes": "baseline fare £18.40 ratio 1.5",
    ...over,
  };
}

function fourEpisodes(placeId: string, source: string, over: Record<string, unknown> = {}): Record<string, unknown>[] {
  return ["01", "02", "03", "04"].map((day, index) => watchRow(placeId, source, `D-${placeId}-${index}`, day, over));
}

function pin(id: string, data: Record<string, unknown> = {}): HotspotPin {
  return {id, data};
}

function plan(pins: HotspotPin[], watchlist: Record<string, unknown>[], extras?: {
  events?: Record<string, unknown>[];
  tpcLog?: Record<string, unknown>[];
  tpcReadings?: Record<string, unknown>[];
}) {
  return planCategoryForecasts({
    now: NOW,
    events: matrix(EVENTS_HEADERS, extras?.events ?? []),
    tpcLog: matrix(TPC_LOG_HEADERS, extras?.tpcLog ?? []),
    tpcReadings: matrix(TPC_READINGS_HEADERS, extras?.tpcReadings ?? []),
    watchlistReadings: matrix(WATCHLIST_HEADERS, watchlist),
    pins,
  });
}

function assertNoMoney(value: unknown): void {
  const raw = JSON.stringify(value);
  for (const token of MONEY_TOKENS) {
    assert.equal(raw.toLowerCase().includes(token.toLowerCase()), false, token);
  }
  const bannedKey = /fare|price|uplift|baseline|gbp|ratio|uber|quid/i;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (node instanceof Timestamp) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      assert.equal(bannedKey.test(key), false, key);
      walk(child);
    }
  };
  walk(value);
  assertNoPrices(value);
}

describe("TPC watchlist history", () => {
  it("records the watchlist header row and scores a hotspot doc id", () => {
    assert.deepEqual(WATCHLIST_HEADERS, [
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
    ]);
    const found = plan(
      [pin("pin_hydro", {name: "Somewhere else", category: "stadium"})],
      fourEpisodes("pin_hydro", "Hotspot Test Pins"),
    ).patches.find((item) => item.id === "pin_hydro");
    if (!found || found.forecast.state !== "available") throw new Error("expected a watchlist forecast");
    assert.equal(found.forecastSource, "tpc_watchlist_history");
    assert.equal(found.forecast.strength, "medium");
    assert.equal(found.forecast.confidence, "low");
    assert.equal(found.forecast.confidencePercent, 100);
    assert.equal(found.forecast.basedOnEvents, 4);
    assert.equal(found.forecast.startAt, "2099-08-01T12:00:00.000Z");
    assert.equal(found.forecast.endAt, "2099-08-01T15:00:00.000Z");
    assertNoMoney(found);
    assertNoMoney(toCategoryForecastData(found));
  });

  it("matches a fixed place key exactly and ignores the place name", () => {
    const rows = fourEpisodes("FP-O2", "Fixed Places", {[WATCHLIST_PLACE_NAME]: "The O2 arena, London"});
    const result = plan([
      pin("by_name", {name: "The O2 arena, London", category: "arena", fixedPlaceKey: "FP-O2-OTHER"}),
      pin("by_key", {name: "Keep", category: "arena", fixedPlaceKey: "FP-O2"}),
      pin("by_case", {name: "Keep", category: "arena", fixedPlaceKey: "fp-o2"}),
    ], rows);
    assert.deepEqual(result.patches.map((item) => item.id), ["by_key"]);
    assert.equal(result.patches[0].forecastSource, "tpc_watchlist_history");
    assert.equal(result.patches[0].forecast.state, "available");
    assertNoMoney(result);
  });

  it("writes nothing when the place matches no doc, two docs, or a sheet id", () => {
    const none = plan([pin("other", {fixedPlaceKey: "OTHER"})], fourEpisodes("pin_missing", "Hotspot Test Pins"));
    assert.equal(none.patches.length, 0);
    const both = plan([
      pin("one", {fixedPlaceKey: "FP-BOTH"}),
      pin("two", {fixedPlaceKey: "FP-BOTH"}),
    ], fourEpisodes("FP-BOTH", "Fixed Places"));
    assert.equal(both.patches.length, 0);
    const sheet = plan(
      [pin("sheet_2099-06-01-O2-SHOW", {category: "events"})],
      fourEpisodes("sheet_2099-06-01-O2-SHOW", "Hotspot Test Pins"),
    );
    assert.equal(sheet.patches.length, 0);
    assertNoMoney(none);
    assertNoMoney(both);
  });

  it("leaves a thin history as no prediction and does not count baseline rows", () => {
    const thin = plan(
      [pin("pin_thin")],
      ["01", "02", "03"].map((day, index) => watchRow("pin_thin", "Hotspot Test Pins", `T-${index}`, day)),
    ).patches[0];
    assert.equal(thin.forecast.state, "no_prediction");
    assert.equal(thin.forecastSource, "tpc_watchlist_history");
    assert.deepEqual(Object.keys(thin.forecast), ["state"]);
    const baselineOnly = plan(
      [pin("pin_base")],
      ["01", "02", "03", "04"].map((day, index) => watchRow("pin_base", "Hotspot Test Pins", `B-${index}`, day, {
        [WATCHLIST_READING_TYPE]: "Baseline",
      })),
    ).patches[0];
    assert.equal(baselineOnly.forecast.state, "no_prediction");
    assertNoMoney(toCategoryForecastData(thin));
    assertNoMoney(toCategoryForecastData(baselineOnly));
  });

  it("uses the app surge when the price is blank, and an explicit NO over a higher price", () => {
    const fromApp = plan(
      [pin("pin_app")],
      fourEpisodes("pin_app", "Hotspot Test Pins", {
        [WATCHLIST_PRICE_SHOWN]: "",
        [WATCHLIST_NORMAL_PRICE]: "",
        [WATCHLIST_SURGE_SHOWN]: "1.8x",
      }),
    ).patches[0];
    if (fromApp.forecast.state !== "available") throw new Error("expected the app multiplier to score");
    assert.equal(fromApp.forecast.strength, "high");
    assert.equal(fromApp.forecast.confidencePercent, 100);
    assert.equal(fromApp.forecast.basedOnEvents, 4);

    const overruled = plan(
      [pin("pin_no")],
      fourEpisodes("pin_no", "Hotspot Test Pins", {[WATCHLIST_SURGE_SHOWN]: "NO"}),
    ).patches[0];
    assert.equal(overruled.forecast.state, "no_prediction");

    const mixed = fourEpisodes("pin_mix", "Hotspot Test Pins");
    mixed[3] = watchRow("pin_mix", "Hotspot Test Pins", "D-pin_mix-3", "04", {
      [WATCHLIST_PRICE_SHOWN]: PRICE,
      [WATCHLIST_NORMAL_PRICE]: PRICE,
      [WATCHLIST_SURGE_SHOWN]: "",
    });
    const threeOfFour = plan([pin("pin_mix")], mixed).patches[0];
    if (threeOfFour.forecast.state !== "available") throw new Error("expected three yes and one no");
    assert.equal(threeOfFour.forecast.confidencePercent, 75);
    assert.equal(threeOfFour.forecast.basedOnEvents, 4);
    assert.equal(threeOfFour.forecast.strength, "medium");
    assertNoMoney(fromApp);
    assertNoMoney(threeOfFour);
  });

  it("does not replace sheet venue history or station history", () => {
    const venue = hydro();
    const barking: HotspotPin = {id: "910GBARKING_2099-06-01_H09", data: {category: "travel disruptions"}};
    const eventPin: HotspotPin = {
      id: "tm_hydro",
      data: {
        category: "events",
        city: "Glasgow",
        location: venue,
        starting_time: "2099-06-01T16:00:00.000Z",
        ending_time: "2099-06-01T19:00:00.000Z",
        events: {venue_name: "OVO Hydro"},
      },
    };
    const stadium: HotspotPin = {id: "pin_stadium", data: {category: "stadium", name: "OVO Hydro"}};
    const log = stationRows();
    const result = plan(
      [eventPin, barking, stadium],
      [
        ...fourEpisodes("tm_hydro", "Hotspot Test Pins"),
        ...fourEpisodes("910GBARKING_2099-06-01_H09", "Hotspot Test Pins"),
        ...fourEpisodes("pin_stadium", "Hotspot Test Pins"),
      ],
      {events: eventHistory(), tpcLog: log, tpcReadings: log.map((row) => reading(String(row[DISRUPTION_ID])))},
    );
    const byId = new Map(result.patches.map((item) => [item.id, item]));
    assert.equal(byId.get("tm_hydro")?.forecastSource, "sheet_venue_history");
    assert.equal(byId.get("tm_hydro")?.forecast.state, "available");
    assert.equal(byId.get("910GBARKING_2099-06-01_H09")?.forecastSource, "tpc_station_history");
    assert.equal(byId.get("910GBARKING_2099-06-01_H09")?.forecast.state, "available");
    const stadiumForecast = byId.get("pin_stadium");
    assert.equal(stadiumForecast?.forecastSource, "tpc_watchlist_history");
    if (!stadiumForecast || stadiumForecast.forecast.state !== "available") {
      throw new Error("expected a watchlist forecast on the stadium pin");
    }
    assert.equal(stadiumForecast.forecast.confidencePercent, 100);
    assert.equal(stadiumForecast.forecast.basedOnEvents, 4);
    assertNoMoney(result);
  });

  it("writes no money-like fields", async () => {
    const found = plan(
      [pin("pin_hydro", {description: "baseline fare £18.40 uber", name: "Keep"})],
      fourEpisodes("pin_hydro", "Hotspot Test Pins"),
    ).patches[0];
    const data = toCategoryForecastData(found);
    assert.deepEqual(Object.keys(data).sort(), ["forecast", "forecastSource", "forecastUpdatedAt"]);
    assert.equal(data.forecastSource, "tpc_watchlist_history");
    assertNoMoney(data);
    const ops: {id: string; data: Record<string, unknown>; op?: string}[] = [];
    const db = {
      collection() {
        return {doc(id: string) {
          return {
            id,
            async get() {
              return {exists: false, get() {
                return undefined;
              }};
            },
          };
        }};
      },
      batch() {
        const staged: typeof ops = [];
        return {
          update(ref: {id: string}, payload: Record<string, unknown>) {
            staged.push({id: ref.id, data: payload});
          },
          set(ref: {id: string}, payload: Record<string, unknown>) {
            staged.push({id: ref.id, data: payload, op: "set"});
          },
          async commit() {
            ops.push(...staged);
          },
        };
      },
    } as unknown as Firestore;
    assert.equal(await commitCategoryForecasts(db, [found]), 1);
    const pinWrite = ops.find((op) => op.op !== "set");
    const mirror = ops.find((op) => op.op === "set");
    if (!pinWrite || !mirror) throw new Error("expected a pin update and a forecast mirror");
    assert.equal(pinWrite.id, "pin_hydro");
    assert.equal(mirror.id, "pin_hydro");
    assert.deepEqual(Object.keys(pinWrite.data).sort(), ["forecast", "forecastSource", "forecastUpdatedAt"]);
    assertNoMoney(pinWrite.data);
    assertNoMoney(mirror.data);
    const summary = await runCategoryForecastAttach({
      now: NOW,
      sheetId: "sheet-under-test",
      eventsTab: "Events",
      tpcLogTab: "TPC Disruption Log",
      tpcReadingsTab: "TPC Readings",
      load: async () => ({
        events: matrix(EVENTS_HEADERS, []),
        tpcLog: matrix(TPC_LOG_HEADERS, []),
        tpcReadings: matrix(TPC_READINGS_HEADERS, []),
        watchlist: matrix(WATCHLIST_HEADERS, fourEpisodes("pin_hydro", "Hotspot Test Pins")),
      }),
      listPins: async () => [pin("pin_hydro")],
      commit: async (patches) => {
        assertNoMoney(patches);
        assert.equal(patches.length, 1);
        assert.equal(patches[0].forecastSource, "tpc_watchlist_history");
        return patches.length;
      },
    });
    assert.equal(summary.status, "ok");
    assert.equal(summary.written, 1);
    assert.equal(summary.available, 1);
    assert.equal(summary.watchlistBlank, 0);
    assert.equal(summary.watchlistMisaligned, 0);
    assertNoMoney(summary);
  });

  it("reads the live headings and counts a blank row and a shifted row", () => {
    assert.deepEqual([...LIVE_WATCHLIST_HEADERS], [
      "Time (UK)",
      "Time (UTC)",
      "Reading ID",
      "Place ID",
      "Place source",
      "Place name",
      "Category",
      "Phase (Baseline / During / Post)",
      "Pickup point",
      "Latitude",
      "Longitude",
      "Distance to ground (m)",
      "Destination",
      "Uber product",
      "Fare shown (£)",
      "Pickup wait (min)",
      "'Busy / fares higher' shown?",
      "Baseline fare (£)",
      "Uplift %",
      "Uplift (£)",
      "Back to baseline? (within 5%)",
      "Confidence %",
      "Did it surge?",
      "Peak uplift % (so far)",
      "Disruption ID",
      "Disruption type",
      "Disruption description",
      "Source (manual / browser)",
      "Screenshot link",
      "Other products shown",
      "H3 cell (res 8) - technical",
      "H3 cell (res 9) - technical",
      "Month",
      "Live Traffic (TomTom)",
      "Notes",
    ]);
    const live = (placeId: string, disruption: string, day: string, over: Record<string, unknown> = {}) => ({
      [WATCHLIST_TIME_UK]: `2099-05-${day} 18:00`,
      [WATCHLIST_PLACE_ID]: placeId,
      [WATCHLIST_PLACE_SOURCE]: "Hotspot Test Pins",
      [WATCHLIST_PHASE]: "During",
      [WATCHLIST_DISRUPTION_ID]: disruption,
      [WATCHLIST_FARE_SHOWN]: SURGE_PRICE,
      [WATCHLIST_BASELINE_FARE]: PRICE,
      [WATCHLIST_BUSY_SHOWN]: "",
      Latitude: 51.5,
      Longitude: -0.12,
      ...over,
    });
    const rows = ["01", "02", "03", "04"].map((day, index) => live("pin_live", `D-${index}`, day));
    const shifted = {
      [WATCHLIST_TIME_UK]: "TPCW-shifted",
      [WATCHLIST_PHASE]: "51.4713",
      [WATCHLIST_PLACE_ID]: "pin_live",
      [WATCHLIST_PLACE_SOURCE]: "Hotspot Test Pins",
      [WATCHLIST_FARE_SHOWN]: SURGE_PRICE,
      [WATCHLIST_BASELINE_FARE]: PRICE,
    };
    const conflict = live("pin_live", "D-conflict", "05", {
      [WATCHLIST_BUSY_SHOWN]: "NO",
      [WATCHLIST_DID_IT_SURGE]: "YES",
    });
    const clocks = live("pin_live", "D-clock", "06", {
      [WATCHLIST_TIME_UK]: "2099-06-01 18:00",
      [WATCHLIST_TIME_UTC]: "2099-06-01 18:00",
    });
    const result = planCategoryForecasts({
      now: NOW,
      events: matrix(EVENTS_HEADERS, []),
      tpcLog: matrix(TPC_LOG_HEADERS, []),
      tpcReadings: matrix(TPC_READINGS_HEADERS, []),
      watchlistReadings: matrix(LIVE_WATCHLIST_HEADERS, [...rows, shifted, {}, conflict, clocks]),
      pins: [pin("pin_live")],
    });
    assert.equal(result.watchlistBlank, 1);
    assert.equal(result.watchlistMisaligned, 3);
    const found = result.patches.find((item) => item.id === "pin_live");
    if (!found || found.forecast.state !== "available") throw new Error("expected the aligned rows to score");
    assert.equal(found.forecast.strength, "medium");
    assert.equal(found.forecast.confidencePercent, 100);
    assert.equal(found.forecast.basedOnEvents, 4);
    assert.equal(found.forecastSource, "tpc_watchlist_history");
    const blocked = planCategoryForecasts({
      now: NOW,
      events: matrix(EVENTS_HEADERS, []),
      tpcLog: matrix(TPC_LOG_HEADERS, []),
      tpcReadings: matrix(TPC_READINGS_HEADERS, []),
      watchlistReadings: matrix(LIVE_WATCHLIST_HEADERS, ["01", "02", "03", "04"].map((day, index) => {
        return live("pin_busy", `B-${index}`, day, {[WATCHLIST_BUSY_SHOWN]: "NO"});
      })),
      pins: [pin("pin_busy")],
    });
    assert.equal(blocked.patches[0]?.forecast.state, "no_prediction");
    assert.equal(blocked.watchlistMisaligned, 0);
    assertNoMoney(result);
    assertNoMoney(blocked);
    assert.equal(JSON.stringify(result).includes("TPCW-shifted"), false);
  });
});
