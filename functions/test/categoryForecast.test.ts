import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {runCategoryForecastAttach} from "../src/surge/attachCategoryForecasts";
import {
  commitCategoryForecasts,
  toCategoryForecastData,
  type CategoryForecastPatch,
} from "../src/surge/categoryCommit";
import {
  distanceMeters,
  planCategoryForecasts,
  stationIdentity,
  VENUE_PIN_MAX_METERS,
  type HotspotPin,
} from "../src/surge/categoryPlan";
import {toFirestoreData} from "../src/surge/commit";
import {
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  GROUND,
  HOME_TEAM,
  KICKOFF,
  PEAK_UPLIFT,
} from "../src/surge/headers";
import {planStadiumEvents} from "../src/surge/plan";
import {assertNoPrices} from "../src/surge/priceGuard";
import {matrix} from "../src/surge/syntheticSheet";
import {
  DISRUPTION_ID,
  parseTpcUplift,
  TPC_LOCATION,
  TPC_LOG_HEADERS,
  TPC_READINGS_HEADERS,
} from "../src/surge/tpc";
import {lookupVenueLocation} from "../src/surge/venueLocations";

const NOW = new Date("2099-08-01T12:00:00.000Z");
const FARE_NOTE = "baseline fare £18.40 uber";
const EVENT_HEADERS = [...EVENTS_HEADERS, "Notes", "Baseline fare (£)"];

function mustVenue(name: string): {lat: number; lng: number} {
  const venue = lookupVenueLocation(name);
  if (!venue) throw new Error(`missing venue ${name}`);
  return venue;
}

function eventRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    [EVENT_ID]: "2099-05-01-HYD-A1",
    [HOME_TEAM]: "Artist One",
    [GROUND]: "OVO Hydro, Glasgow",
    [KICKOFF]: "2099-05-01 15:00",
    [DID_IT_SURGE]: "YES",
    [PEAK_UPLIFT]: "47%",
    "Notes": FARE_NOTE,
    "Baseline fare (£)": "18.40",
    ...over,
  };
}

function history(
  ground: string,
  days: string[],
  outcome: string,
  peak: string,
  home = "Artist",
): Record<string, unknown>[] {
  return days.map((day, index) => eventRow({
    [EVENT_ID]: `2099-05-${day}-HYD-H${index}${day}`,
    [HOME_TEAM]: `${home} ${day}`,
    [GROUND]: ground,
    [KICKOFF]: `2099-05-${day} 15:00`,
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: peak,
  }));
}

function pin(
  id: string,
  venue: string,
  city: string,
  coords: {lat: number; lng: number},
  over: Record<string, unknown> = {},
): HotspotPin {
  return {
    id,
    data: {
      category: "events",
      city,
      name: "Keep this name",
      description: FARE_NOTE,
      location: coords,
      starting_time: "2099-06-01T16:00:00.000Z",
      ending_time: "2099-06-01T19:00:00.000Z",
      events: {venue_name: venue},
      jobs_accepted: 4,
      ...over,
    },
  };
}

function plan(
  rows: Record<string, unknown>[],
  pins: HotspotPin[],
  tpcLog: Record<string, unknown>[] = [],
  tpcReadings: Record<string, unknown>[] = [],
) {
  return planCategoryForecasts({
    now: NOW,
    events: matrix(EVENT_HEADERS, rows),
    tpcLog: matrix(TPC_LOG_HEADERS, tpcLog),
    tpcReadings: matrix(TPC_READINGS_HEADERS, tpcReadings),
    pins,
  });
}

function patchFor(rows: Record<string, unknown>[], pins: HotspotPin[], id: string): CategoryForecastPatch {
  const found = plan(rows, pins).patches.find((item) => item.id === id);
  if (!found) throw new Error(`missing patch ${id}`);
  return found;
}

function assertClean(value: unknown): void {
  const raw = JSON.stringify(value);
  for (const token of ["18.40", "18.4", "£", "47%", "0.47", "2.95", "uber", "baseline", "fare"]) {
    assert.equal(raw.toLowerCase().includes(token.toLowerCase()), false, token);
  }
  assertNoPrices(value);
}

function northOf(origin: {lat: number; lng: number}, meters: number): {lat: number; lng: number} {
  let lat = origin.lat;
  const step = 0.00001;
  while (distanceMeters(origin, {lat, lng: origin.lng}) < meters) lat += step;
  return {lat, lng: origin.lng};
}

function tpcRow(
  id: string,
  location: string,
  day: string,
  outcome: string,
  peak: number | string,
  ground = location,
): Record<string, unknown> {
  return {
    [DISRUPTION_ID]: id,
    [GROUND]: ground,
    [KICKOFF]: `2099-05-${day} 08:00`,
    [TPC_LOCATION]: location,
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: peak,
    "Baseline fare (£)": "18.40",
    "Peak fare (£)": "£9",
    "Uber product": "uber",
    "Notes": FARE_NOTE,
  };
}

function reading(id: string): Record<string, unknown> {
  return {
    [EVENT_ID]: id,
    "Fare shown (£)": "18.40",
    "Baseline fare (£)": "18.40",
    "Uplift %": "47",
    "Uber product": "uber",
  };
}

describe("event pin forecasts", () => {
  const hydro = mustVenue("OVO Hydro, Glasgow");
  const hydroRows = history("OVO Hydro, Glasgow", ["01", "02", "03", "04"], "YES", "47%");

  it("attaches a forecast when the venue name and city match exactly and the pin is on the venue", () => {
    const rows = hydroRows.map((row) => ({...row, "Predicted surge confidence %": "12%"}));
    const found = patchFor(rows, [pin("tm_hydro", "OVO Hydro", "Glasgow", hydro)], "tm_hydro");
    assert.equal(found.forecast.state, "available");
    if (found.forecast.state !== "available") return;
    assert.equal(found.forecast.strength, "medium");
    assert.equal(found.forecast.confidence, "low");
    assert.equal(found.forecast.confidencePercent, 100);
    assert.equal("confidenceSource" in found.forecast, false);
    assert.equal(found.forecast.basedOnEvents, 4);
    assert.equal(found.forecast.v, 1);
    assert.equal(found.forecast.startAt, "2099-06-01T19:00:00.000Z");
    assert.equal(found.forecast.endAt, "2099-06-01T22:00:00.000Z");
    assert.equal(found.forecastSource, "sheet_venue_history");
    assert.deepEqual(Object.keys(found.forecast).sort(), [
      "basedOnEvents",
      "confidence",
      "confidencePercent",
      "endAt",
      "startAt",
      "state",
      "strength",
      "v",
    ]);
    assertClean(found);
  });

  it("refuses a different city and refuses three same-fixture rows", () => {
    const wrongCity = patchFor(hydroRows, [pin("tm_edin", "OVO Hydro", "Edinburgh", hydro)], "tm_edin");
    assert.equal(wrongCity.forecast.state, "no_prediction");
    assert.deepEqual(Object.keys(wrongCity.forecast), ["state"]);
    const sameFixture = history("OVO Hydro, Glasgow", ["01", "02", "03"], "YES", "47%", "Same Artist")
      .map((row) => ({...row, [HOME_TEAM]: "Same Artist"}));
    const thin = patchFor(sameFixture, [pin("tm_thin", "OVO Hydro", "Glasgow", hydro)], "tm_thin");
    assert.equal(thin.forecast.state, "no_prediction");
    assertClean(plan(hydroRows, [pin("tm_edin", "OVO Hydro", "Edinburgh", hydro)]));
  });

  it("does not pool split Utilita labels or a neighbouring name", () => {
    const birmingham = mustVenue("Utilita Arena Birmingham");
    const rows = [
      ...history("Utilita Arena Birmingham", ["01", "02", "03", "04", "05", "06"], "YES", "80%"),
      ...history("Utilita Arena Birmingham, Birmingham", ["07"], "YES", "80%"),
    ];
    const split = patchFor(rows, [
      pin("tm_util", "Utilita Arena Birmingham", "Birmingham", birmingham),
      pin("tm_nia", "National Indoor Arena", "Birmingham", birmingham),
    ], "tm_util");
    const neighbour = patchFor(rows, [
      pin("tm_nia", "National Indoor Arena", "Birmingham", birmingham),
    ], "tm_nia");
    assert.equal(split.forecast.state, "no_prediction");
    assert.equal(neighbour.forecast.state, "no_prediction");
    assertClean(plan(rows, [pin("tm_util", "Utilita Arena Birmingham", "Birmingham", birmingham)]));
  });

  it("refuses an AO Arena pin that sits about 1.57 km from the checked arena", () => {
    const arena = mustVenue("AO Arena, Manchester");
    const far = northOf(arena, 1570);
    const metres = distanceMeters(arena, far);
    assert.ok(metres > 1500 && metres < 1700);
    assert.ok(metres > VENUE_PIN_MAX_METERS);
    const rows = history("AO Arena, Manchester", ["01", "02", "03", "04"], "YES", "80%");
    const pins = [
      pin("tm_ao_near", "AO Arena", "Manchester", arena),
      pin("tm_ao_far", "AO Arena", "Manchester", far),
    ];
    const near = patchFor(rows, pins, "tm_ao_near");
    const away = patchFor(rows, pins, "tm_ao_far");
    assert.equal(near.forecast.state, "available");
    assert.equal(away.forecast.state, "no_prediction");
    assertClean(plan(rows, pins));
  });

  it("refuses the forecast when that London date is already a sheet pin", () => {
    const rows = [
      ...hydroRows,
      eventRow({
        [EVENT_ID]: "2099-06-01-HYD-SHOW",
        [KICKOFF]: "2099-06-01 18:00",
        [DID_IT_SURGE]: "PENDING",
        [PEAK_UPLIFT]: "",
      }),
    ];
    const show = pin("tm_hydro", "OVO Hydro", "Glasgow", hydro);
    const sheet: HotspotPin = {id: "sheet_2099-06-01-HYD-SHOW", data: {category: "events", name: "already"}};
    const blocked = plan(rows, [show, sheet]);
    assert.equal(blocked.patches.length, 1);
    assert.equal(blocked.patches[0].id, "tm_hydro");
    assert.equal(blocked.patches[0].forecast.state, "no_prediction");
    const open = plan(rows, [show]);
    assert.equal(open.patches[0].forecast.state, "available");
  });

  it("uses only completed rows from before the pin", () => {
    const early = history("OVO Hydro, Glasgow", ["01", "02", "03", "04"], "YES", "47%");
    const late = history("OVO Hydro, Glasgow", ["21", "22", "23", "24"], "YES", "95%");
    const rows = [...early, ...late];
    const held = pin("tm_held", "OVO Hydro", "Glasgow", hydro, {
      starting_time: "2099-05-10T16:00:00.000Z",
      ending_time: "2099-05-10T19:00:00.000Z",
    });
    const found = patchFor(rows, [held], "tm_held");
    assert.equal(found.forecast.state, "available");
    if (found.forecast.state !== "available") return;
    assert.equal(found.forecast.basedOnEvents, 4);
    assert.equal(found.forecast.strength, "medium");
    assert.equal(found.forecast.confidence, "low");
    const tooSoon = pin("tm_soon", "OVO Hydro", "Glasgow", hydro, {
      starting_time: "2099-05-04T10:00:00.000Z",
      ending_time: "2099-05-04T13:00:00.000Z",
    });
    assert.equal(patchFor(rows, [tooSoon], "tm_soon").forecast.state, "no_prediction");
  });

  it("leaves sheet pins and other categories alone, and still covers a non-tm events pin", () => {
    const rows = hydroRows;
    const result = plan(rows, [
      pin("tm_hydro", "OVO Hydro", "Glasgow", hydro),
      {id: "sheet_2099-05-01-HYD-H001", data: {category: "events", city: "Glasgow"}},
      {id: "parking_1", data: {category: "parking", name: "Bay"}},
      pin("live_events_1", "OVO Hydro", "Glasgow", hydro, {category: "events"}),
      {id: "flight_1", data: {category: "flights", city: "Glasgow"}},
    ]);
    assert.deepEqual(result.patches.map((item) => item.id), ["live_events_1", "tm_hydro"]);
    assert.equal(result.patches.every((item) => item.forecast.state === "available"), true);
  });
});

describe("harmless name variants", () => {
  const hydro = mustVenue("OVO Hydro, Glasgow");
  const hydroRows = history("OVO Hydro, Glasgow", ["01", "02", "03", "04"], "YES", "47%");

  it("matches OVO Hydro when the pin city is Glasgow City", () => {
    const found = patchFor(hydroRows, [pin("tm_hydro_city", "OVO Hydro", "Glasgow City", hydro)], "tm_hydro_city");
    assert.equal(found.forecast.state, "available");
    assert.equal(found.forecastSource, "sheet_venue_history");
    if (found.forecast.state !== "available") return;
    assert.equal(found.forecast.basedOnEvents, 4);
    assertClean(found);
  });

  it("matches a venue after case, punctuation, and a leading The", () => {
    const pins = [
      pin("tm_case", "ovo hydro", "GLASGOW", hydro),
      pin("tm_punct", "OVO-Hydro", "Glasgow", hydro),
      pin("tm_the", "The OVO Hydro", "Glasgow", hydro),
    ];
    const result = plan(hydroRows, pins);
    assert.deepEqual(result.patches.map((item) => item.id), ["tm_case", "tm_punct", "tm_the"]);
    assert.equal(result.patches.every((item) => item.forecast.state === "available"), true);
    assertClean(result);
  });

  it("matches a Leeds pin named Arena or Leeds Arena onto First Direct Arena", () => {
    const leeds = mustVenue("First Direct Arena, Leeds");
    const rows = [
      ...history("First Direct Arena, Leeds", ["01", "02", "03", "04"], "YES", "80%"),
      ...history("First Direct Bank Arena, Leeds", ["05", "06", "07", "08"], "YES", "80%"),
    ];
    const pins = [
      pin("tm_arena", "Arena", "Leeds", leeds),
      pin("tm_leeds_arena", "Leeds Arena", "Leeds City", leeds),
      pin("tm_bank", "First Direct Bank Arena", "Leeds", leeds),
      pin("tm_far", "Arena", "Leeds", northOf(leeds, 1570)),
    ];
    const result = plan(rows, pins);
    const byId = new Map(result.patches.map((item) => [item.id, item]));
    for (const id of ["tm_arena", "tm_leeds_arena", "tm_bank"]) {
      const found = byId.get(id);
      assert.equal(found?.forecast.state, "available", id);
      if (found?.forecast.state !== "available") continue;
      assert.equal(found.forecastSource, "sheet_venue_history");
      assert.equal(found.forecast.basedOnEvents, 8);
    }
    assert.equal(byId.get("tm_far")?.forecast.state, "no_prediction");
    assertClean(result);
  });

  it("keeps AO Arena as no prediction when the pin is about 1.57 km away", () => {
    const arena = mustVenue("AO Arena, Manchester");
    const far = northOf(arena, 1570);
    const rows = history("AO Arena, Manchester", ["01", "02", "03", "04"], "YES", "80%");
    const held = patchFor(rows, [
      pin("tm_ao_near", "Manchester Arena", "Manchester", arena),
      pin("tm_ao_far", "AO Arena", "Manchester City", far),
    ], "tm_ao_far");
    const near = patchFor(rows, [
      pin("tm_ao_near", "Manchester Arena", "Manchester", arena),
      pin("tm_ao_far", "AO Arena", "Manchester City", far),
    ], "tm_ao_near");
    assert.equal(held.forecast.state, "no_prediction");
    assert.equal(near.forecast.state, "available");
    if (near.forecast.state === "available") assert.equal(near.forecast.basedOnEvents, 4);
    assertClean(plan(rows, [
      pin("tm_ao_near", "Manchester Arena", "Manchester", arena),
      pin("tm_ao_far", "AO Arena", "Manchester City", far),
    ]));
  });

  it("does not invent a Co-op Live prediction when that pin is absent", () => {
    const ao = mustVenue("AO Arena, Manchester");
    const rows = [
      ...history("Co-op Live, Manchester", ["01", "02", "03", "04"], "YES", "80%"),
      ...history("AO Arena, Manchester", ["11", "12", "13", "14"], "YES", "55%"),
    ];
    const result = plan(rows, [pin("tm_ao", "AO Arena", "Manchester", ao)]);
    assert.deepEqual(result.patches.map((item) => item.id), ["tm_ao"]);
    assert.equal(result.patches[0].forecast.state, "available");
    if (result.patches[0].forecast.state !== "available") return;
    assert.equal(result.patches[0].forecast.basedOnEvents, 4);
    assert.equal(result.patches[0].forecast.strength, "medium");
    assertClean(result);
  });

  it("rejects a pin that matches more than one place", () => {
    const hydroPoint = mustVenue("OVO Hydro, Glasgow");
    const rows = [
      ...history("OVO Hydro, Glasgow", ["01", "02", "03", "04"], "YES", "47%"),
      ...history("OVO Hydro Glasgow, Glasgow", ["05", "06", "07", "08"], "YES", "47%"),
    ];
    const ambiguous = patchFor(rows, [pin("tm_amb", "OVO Hydro Glasgow", "Glasgow", hydroPoint)], "tm_amb");
    assert.equal(ambiguous.forecast.state, "no_prediction");
    assert.deepEqual(Object.keys(ambiguous.forecast), ["state"]);
    const arena = mustVenue("AO Arena, Manchester");
    const notAo = patchFor(
      history("AO Arena, Manchester", ["01", "02", "03", "04"], "YES", "80%"),
      [pin("tm_short", "Arena", "Manchester", arena)],
      "tm_short",
    );
    assert.equal(notAo.forecast.state, "no_prediction");
    assertClean(plan(rows, [pin("tm_amb", "OVO Hydro Glasgow", "Glasgow", hydroPoint)]));
  });
});

describe("travel disruption forecasts", () => {
  function days(
    prefix: string,
    location: string,
    outcome: string,
    count: number,
    peak: number | string = 0.47,
    ground?: string,
  ) {
    return Array.from({length: count}, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return tpcRow(`${prefix}-${day}`, location, day, outcome, peak, ground);
    });
  }

  it("matches a StopPoint id to that station and ignores a line, a longer name, and later rows", () => {
    const stationRows = days("2099-05-BARK", "Barking", "YES", 4);
    const extra = [
      tpcRow("2099-05-BARK-STN", "Barking station", "11", "YES", 0.9),
      tpcRow("2099-05-BARK-RIV", "Barking Riverside", "12", "YES", 0.9),
      tpcRow("2099-05-BARK-LINE", "Barking", "13", "YES", 0.9, "Suffragette entire line"),
      {...tpcRow("2099-06-BARK-AFTER", "Barking", "02", "YES", 0.9), [KICKOFF]: "2099-06-02 09:00"},
      tpcRow("2099-05-BARK-PEND", "Barking", "14", "PENDING", 0.9),
    ];
    const readings = [...stationRows, ...extra].map((row) => reading(String(row[DISRUPTION_ID])));
    const barking: HotspotPin = {
      id: "910GBARKING_2099-06-01_H09",
      data: {category: "travel disruptions", name: "Delays", description: FARE_NOTE},
    };
    const found = plan([], [barking], [...stationRows, ...extra], readings).patches[0];
    assert.equal(found.forecast.state, "available");
    if (found.forecast.state !== "available") return;
    assert.equal(found.forecastSource, "tpc_station_history");
    assert.equal(found.forecast.basedOnEvents, 4);
    assert.equal(found.forecast.strength, "medium");
    assert.equal(found.forecast.confidencePercent, 100);
    assert.equal("confidenceSource" in found.forecast, false);
    assert.equal(found.forecast.startAt, "2099-06-01T08:00:00.000Z");
    assert.equal(found.forecast.endAt, "2099-06-01T09:00:00.000Z");
    const hour = stationIdentity(barking.id);
    assert.equal(hour && hour.key, "barking");
    assertClean(found);
  });

  it("does not treat a line-wide incident as a surge at a station on that line", () => {
    const line = days("2099-05-PICC", "Piccadilly line: ENTIRE LINE (incl. Heathrow)", "YES", 6, 0.8);
    const readings = line.map((row) => reading(String(row[DISRUPTION_ID])));
    const hammersmith: HotspotPin = {
      id: "910GHAMMERSMITH_2099-06-01_H09",
      data: {category: "Travel Disruptions"},
    };
    const found = plan([], [hammersmith], line, readings).patches[0];
    assert.equal(found.forecast.state, "no_prediction");
    assert.equal(found.forecastSource, "tpc_station_history");
    assertClean(found);
  });

  it("keeps pending pending, and does not count a missing reading as NO", () => {
    const pending = days("2099-05-PEND", "Barking", "PENDING", 4);
    const unread = days("2099-05-NONE", "Barking", "YES", 4);
    const yes = days("2099-05-YES", "Woolwich", "YES", 4, 2.95);
    const nos = days("2099-05-NO", "Woolwich", "NO", 3, 0.5).map((row, index) => ({
      ...row,
      [DISRUPTION_ID]: `2099-05-NO-${index}`,
    }));
    const pendingPatch = plan([], [{
      id: "910GBARKING_2099-06-01_H09",
      data: {category: "travel disruptions"},
    }], pending, pending.map((row) => reading(String(row[DISRUPTION_ID])))).patches[0];
    assert.equal(pendingPatch.forecast.state, "no_prediction");

    const yesAndPending = days("2099-05-BOTH", "Barking", "YES", 4);
    const stillPending = days("2099-05-STILL", "Barking", "PENDING", 3);
    const diluted = plan([], [{
      id: "910GBARKING_2099-06-01_H09",
      data: {category: "travel disruptions"},
    }], [...yesAndPending, ...stillPending], [...yesAndPending, ...stillPending].map((row) => {
      return reading(String(row[DISRUPTION_ID]));
    })).patches[0];
    assert.equal(diluted.forecast.state, "available");
    if (diluted.forecast.state === "available") assert.equal(diluted.forecast.basedOnEvents, 4);

    const unreadPatch = plan([], [{
      id: "910GBARKING_2099-06-01_H09",
      data: {category: "travel disruptions"},
    }], unread, []).patches[0];
    assert.equal(unreadPatch.forecast.state, "no_prediction");

    const mixed = plan([], [{
      id: "910GWOOLWICH_2099-06-01_H09",
      data: {category: "travel disruptions"},
    }], [...yes, ...nos], yes.map((row) => reading(String(row[DISRUPTION_ID])))).patches[0];
    assert.equal(mixed.forecast.state, "available");
    if (mixed.forecast.state !== "available") return;
    assert.equal(mixed.forecast.basedOnEvents, 4);
    assert.equal(mixed.forecast.strength, "high");
    assert.equal(mixed.forecast.confidencePercent, 100);
    assertClean(mixed);
    assert.equal(parseTpcUplift(2.95), 2.95);
    assert.equal(parseTpcUplift("47%"), 0.47);
    assert.equal(parseTpcUplift(47), 0.47);
  });

  it("matches a station after a leading The or a trailing City, and not a longer name", () => {
    const theRows = days("2099-05-THEB", "The Barking", "YES", 4);
    const cityRows = days("2099-05-CITYB", "Barking City", "YES", 4);
    const longer = days("2099-05-STN", "Barking station", "YES", 4);
    const barking: HotspotPin = {
      id: "910GBARKING_2099-06-01_H09",
      data: {category: "travel disruptions"},
    };
    const read = (rows: Record<string, unknown>[]) => rows.map((row) => reading(String(row[DISRUPTION_ID])));
    const fromThe = plan([], [barking], theRows, read(theRows)).patches[0];
    const fromCity = plan([], [barking], cityRows, read(cityRows)).patches[0];
    const fromLonger = plan([], [barking], longer, read(longer)).patches[0];
    assert.equal(fromThe.forecast.state, "available");
    assert.equal(fromCity.forecast.state, "available");
    assert.equal(fromThe.forecastSource, "tpc_station_history");
    assert.equal(fromLonger.forecast.state, "no_prediction");
    assertClean(fromThe);
    assertClean(fromCity);
  });

  it("does not strip a leading The from a route label", () => {
    const route = days("2099-05-THEVAUX", "The Vauxhall – London Waterloo", "YES", 4, 0.55);
    const readings = route.map((row) => reading(String(row[DISRUPTION_ID])));
    const routePin: HotspotPin = {
      id: "route_vauxhall_the",
      data: {
        category: "travel disruptions",
        routeName: "Vauxhall – London Waterloo",
        starting_time: "2099-06-01T16:00:00.000Z",
        ending_time: "2099-06-01T18:00:00.000Z",
      },
    };
    const found = plan([], [routePin], route, readings).patches[0];
    assert.equal(found.forecast.state, "no_prediction");
    assert.equal(found.forecastSource, "tpc_route_history");
    assertClean(found);
  });

  it("matches a route only when the route label is exact", () => {
    const route = days("2099-05-VAUX", "Vauxhall – London Waterloo", "YES", 4, 0.55);
    const readings = route.map((row) => reading(String(row[DISRUPTION_ID])));
    const routePin: HotspotPin = {
      id: "route_vauxhall",
      data: {
        category: "travel disruptions",
        routeName: "Vauxhall – London Waterloo",
        starting_time: "2099-06-01T16:00:00.000Z",
        ending_time: "2099-06-01T18:00:00.000Z",
      },
    };
    const station: HotspotPin = {
      id: "910GVAUXHALL_2099-06-01_H09",
      data: {category: "travel disruptions", routeName: "Vauxhall – London Waterloo"},
    };
    const result = plan([], [routePin, station], route, readings);
    const byId = new Map(result.patches.map((item) => [item.id, item]));
    assert.equal(byId.get("route_vauxhall")?.forecast.state, "available");
    assert.equal(byId.get("route_vauxhall")?.forecastSource, "tpc_route_history");
    assert.equal(byId.get("910GVAUXHALL_2099-06-01_H09")?.forecast.state, "no_prediction");
    assert.equal(byId.get("910GVAUXHALL_2099-06-01_H09")?.forecastSource, "tpc_station_history");
    assertClean(result);
  });

  it("records the TPC headers that were on the sheet", () => {
    assert.equal(TPC_LOG_HEADERS[0], "Disruption ID");
    assert.equal((TPC_LOG_HEADERS as readonly string[]).includes("Event ID"), false);
    assert.ok(TPC_LOG_HEADERS.includes("Location/Station/Airport"));
    assert.ok(TPC_LOG_HEADERS.includes("Did it surge?"));
    assert.ok(TPC_LOG_HEADERS.includes("Peak uplift %"));
    assert.equal(TPC_READINGS_HEADERS[2], "Event ID");
    assert.ok(TPC_READINGS_HEADERS.includes("Distance to disrupted station (m)"));
  });
});

describe("writes stay merge-only and carry no prices", () => {
  it("builds a three-field payload and refuses a sheet id", async () => {
    const hydro = mustVenue("OVO Hydro, Glasgow");
    const found = patchFor(
      history("OVO Hydro, Glasgow", ["01", "02", "03", "04"], "YES", "47%"),
      [pin("tm_hydro", "OVO Hydro", "Glasgow", hydro)],
      "tm_hydro",
    );
    const data = toCategoryForecastData(found);
    assert.deepEqual(Object.keys(data).sort(), ["forecast", "forecastSource", "forecastUpdatedAt"]);
    assert.equal((data.forecast as {confidenceSource?: string}).confidenceSource, "none");
    const sourced = toCategoryForecastData({
      ...found,
      forecast: {...found.forecast, confidenceSource: "events_tab"},
    });
    assert.equal((sourced.forecast as {confidenceSource?: string}).confidenceSource, "events_tab");
    const abstained = toCategoryForecastData({
      ...found,
      forecast: {state: "no_prediction"},
    });
    assert.deepEqual(Object.keys(abstained.forecast as object).sort(), ["confidenceSource", "state"]);
    assert.equal((abstained.forecast as {confidenceSource?: string}).confidenceSource, "none");
    assert.equal("confidencePercent" in (abstained.forecast as object), false);
    assert.ok(data.forecastUpdatedAt instanceof Timestamp);
    assertClean(data);
    const ops: {op: string; id: string; data?: Record<string, unknown>}[] = [];
    const db = {
      collection() {
        return {
          doc(id: string) {
            return {
              id,
              async get() {
                return {
                  exists: true,
                  data() {
                    return {window_end: Timestamp.fromMillis(1)};
                  },
                };
              },
            };
          },
        };
      },
      batch() {
        const staged: typeof ops = [];
        return {
          set(ref: {id: string}, payload: Record<string, unknown>) {
            staged.push({op: "set", id: ref.id, data: payload});
          },
          update(ref: {id: string}, payload: Record<string, unknown>) {
            staged.push({op: "update", id: ref.id, data: payload});
          },
          delete(ref: {id: string}) {
            staged.push({op: "delete", id: ref.id});
          },
          async commit() {
            ops.push(...staged);
          },
        };
      },
    } as unknown as Firestore;
    assert.equal(await commitCategoryForecasts(db, []), 0);
    assert.equal(ops.length, 0);
    assert.equal(await commitCategoryForecasts(db, [found]), 1);
    const updates = ops.filter((op) => op.op === "update");
    const mirrors = ops.filter((op) => op.op === "set");
    assert.equal(updates.length, 0);
    assert.equal(mirrors.length, 1);
    assert.equal(mirrors[0].id, "tm_hydro");
    assert.equal((mirrors[0].data?.forecast as {state?: string}).state, "available");
    assert.equal(ops.some((op) => op.op === "delete"), false);
    await assert.rejects(() => commitCategoryForecasts(db, [{
      ...found,
      id: "sheet_2099-06-01-HYD-SHOW",
    }]));
    assert.equal(ops.filter((op) => op.op === "update").length, 0);
    assert.equal(ops.some((op) => op.op === "delete"), false);
  });

  it("keeps the sheet writer's window_end on the hard stop, later than the event end", () => {
    const record = planStadiumEvents({
      now: NOW,
      events: matrix(EVENT_HEADERS, [eventRow({
        [EVENT_ID]: "2026-11-01-LIV-ARS",
        [HOME_TEAM]: "Liverpool",
        [GROUND]: "Anfield, Liverpool",
        [KICKOFF]: "2026-11-01 16:30",
        "Expected full time (UK)": "2026-11-01 18:25",
        "Surge window starts (UK)": "2026-11-01 18:25",
        "Surge window ends (UK, est.)": "2026-11-01 19:30",
        "Hard stop (UK, FT + 3h)": "2026-11-01 21:25",
        "Pickup points (name | lat,lng)": "Main stand | 53.430001, -2.960001",
        [DID_IT_SURGE]: "PENDING",
        [PEAK_UPLIFT]: "",
      })]),
      readings: matrix(["Time (UK)"], []),
    }).records[0];
    const data = toFirestoreData(record);
    const finish = Date.parse("2026-11-01T18:25:00.000Z");
    const hardStop = Date.parse("2026-11-01T21:25:00.000Z");
    const windowEnd = data.window_end as Timestamp;
    const removeBy = data.removeBy as Timestamp;
    const endTime = (data.events as {end_time: Timestamp}).end_time;
    assert.equal(windowEnd.toMillis(), hardStop);
    assert.equal(removeBy.toMillis(), hardStop);
    assert.equal(endTime.toMillis(), finish);
    assert.notEqual(windowEnd.toMillis(), endTime.toMillis());
  });

  it("does not read or write when the spreadsheet id is blank", async () => {
    let loaded = 0;
    let listed = 0;
    let written = 0;
    const summary = await runCategoryForecastAttach({
      now: NOW,
      sheetId: "  ",
      eventsTab: "Events",
      tpcLogTab: "TPC Disruption Log",
      tpcReadingsTab: "TPC Readings",
      load: async () => {
        loaded += 1;
        return {events: [], tpcLog: [], tpcReadings: []};
      },
      listPins: async () => {
        listed += 1;
        return [];
      },
      commit: async () => {
        written += 1;
        return 0;
      },
    });
    assert.equal(summary.status, "skipped");
    assert.equal(summary.reason, "sheet-id-missing");
    assert.equal(loaded, 0);
    assert.equal(listed, 0);
    assert.equal(written, 0);
    assertClean(summary);
    const indexSrc = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    assert.match(indexSrc, /export \{attachCategoryForecasts\}/);
    const commitSrc = readFileSync(join(__dirname, "../src/surge/categoryCommit.ts"), "utf8");
    assert.equal(commitSrc.includes(".delete("), false);
    assert.equal(commitSrc.includes("merge: true"), false);
    assert.equal(commitSrc.includes("batch.update("), false);
    assert.match(commitSrc, /missing-pin/);
  });
});
