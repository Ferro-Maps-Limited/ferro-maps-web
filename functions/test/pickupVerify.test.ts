import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {toFirestoreData} from "../src/surge/commit";
import {metresBetween, pointHistory} from "../src/surge/forecast";
import {FORECAST_MIRROR_FIELDS, forecastMirrorFields} from "../src/surge/forecastMirror";
import {
  AWAY_TEAM,
  BACK_TO_BASELINE,
  COMPETITION,
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  LATITUDE,
  LONGITUDE,
  PEAK_UPLIFT,
  PHASE,
  PICKUP_POINT,
  PICKUP_POINTS,
  READINGS_HEADERS,
  SURGE_END,
  SURGE_START,
  TIME_UK,
} from "../src/surge/headers";
import {parsePickupPoints, parseSurgeSheet, pickupKey, readingCoord} from "../src/surge/parse";
import {planStadiumEvents, type StadiumEventRecord} from "../src/surge/plan";
import {assertNoPrices} from "../src/surge/priceGuard";
import {matrix} from "../src/surge/syntheticSheet";
import {PICKUP_MATCH_RADIUS_M} from "../src/surge/thresholds";

const NOW = new Date("2098-01-01T00:00:00.000Z");
const GATE_LAT = 51.701001;
const GATE_LNG = -0.301001;
const VENUE_HEADERS = [...EVENTS_HEADERS, "Venue type", "Venue"];

function eventRow(
  day: string,
  month: string,
  outcome: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const date = `2099-${month}-${day}`;
  return {
    [EVENT_ID]: `${date}-SYN-E${month}${day}`,
    [COMPETITION]: "Synthetic Cup",
    [HOME_TEAM]: "Home Side",
    [AWAY_TEAM]: "Away Side",
    [GROUND]: "Synthetic Park",
    [KICKOFF]: `${date} 15:00`,
    [EXPECTED_FULL_TIME]: `${date} 16:55`,
    [SURGE_START]: `${date} 16:55`,
    [SURGE_END]: `${date} 19:00`,
    [HARD_STOP]: `${date} 19:55`,
    [PICKUP_POINTS]: `1) North Gate | ${GATE_LAT}, ${GATE_LNG}`,
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: outcome === "YES" ? "47%" : "",
    ...over,
  };
}

const CURRENT = eventRow("01", "06", "PENDING");
const CURRENT_ID = "2099-06-01-SYN-E0601";

/* Two readings for one event, with no fare cells at all. */
function readingsFor(eventId: string, date: string, over: Record<string, unknown>): Record<string, unknown>[] {
  return ["18:00", "18:05"].map((time) => ({
    [TIME_UK]: `${date} ${time}`,
    [EVENT_ID]: eventId,
    [PHASE]: "During",
    [PICKUP_POINT]: "North Gate",
    [BACK_TO_BASELINE]: "No",
    ...over,
  }));
}

function plan(rows: Record<string, unknown>[], readings: Record<string, unknown>[]) {
  return planStadiumEvents({
    now: NOW,
    events: matrix(VENUE_HEADERS, rows),
    readings: matrix(READINGS_HEADERS, readings),
  });
}

function current(rows: Record<string, unknown>[], readings: Record<string, unknown>[]): StadiumEventRecord {
  const record = plan(rows, readings).records.find((item) => item.sheetEventId === CURRENT_ID);
  if (!record) throw new Error("missing current event");
  return record;
}

/* Readings under another name, about 55 m north of North Gate. */
const NEAR = {[PICKUP_POINT]: "Car park B", [LATITUDE]: "51.701500", [LONGITUDE]: String(GATE_LNG)};
/* Readings under another name, about 220 m north of North Gate. */
const FAR = {[PICKUP_POINT]: "Car park B", [LATITUDE]: "51.703000", [LONGITUDE]: String(GATE_LNG)};

describe("pickup labels", () => {
  it("drops a list number from the name drivers see and from the match key", () => {
    const points = parsePickupPoints("1) Walton Breck Rd / Main Stand | 53.4310,-2.9610\n12) Stanley Park | 53.4330,-2.9600");
    assert.deepEqual(points.map((point) => point.name), ["Walton Breck Rd / Main Stand", "Stanley Park"]);
    assert.equal(pickupKey("3)  Walton   Lane "), "walton lane");
    assert.equal(pickupKey("walton lane"), "walton lane");
  });

  it("drops a letter label only when the cell numbers two or more pickups with that letter", () => {
    const labelled = parsePickupPoints(
      "E2 Sandhills station L5 9XJ (53.4295,-2.9920); E3 Great Howard St at Boundary St L5 9TZ (53.4247,-2.9966)",
    );
    assert.deepEqual(labelled.map((point) => point.name), [
      "Sandhills station L5 9XJ",
      "Great Howard St at Boundary St L5 9TZ",
    ]);
  });

  it("keeps names that only happen to start with letters and digits", () => {
    const roads = parsePickupPoints("A6 Stockport Road | 53.4500,-2.1500; M60 J24 slip | 53.4400,-2.1200");
    assert.deepEqual(roads.map((point) => point.name), ["A6 Stockport Road", "M60 J24 slip"]);
    assert.deepEqual(parsePickupPoints("E2 Sandhills | 53.4295,-2.9920").map((point) => point.name), ["E2 Sandhills"]);
    assert.deepEqual(parsePickupPoints("10 Downing St | 51.5034,-0.1276").map((point) => point.name), ["10 Downing St"]);
    assert.deepEqual(parsePickupPoints("2nd Avenue Gate | 51.5000,-0.1000").map((point) => point.name), ["2nd Avenue Gate"]);
    assert.deepEqual(parsePickupPoints("Gate 12) East | 51.5000,-0.1000").map((point) => point.name), ["Gate 12) East"]);
  });
});

describe("pickup coordinate formats", () => {
  it("reads both the pipe and the bracket format", () => {
    assert.deepEqual(parsePickupPoints("North Gate | 51.701001, -0.301001"), [{name: "North Gate", lat: 51.701001, lng: -0.301001}]);
    assert.deepEqual(parsePickupPoints("Times Square / Centre for Life (54.9672,-1.6195)"), [
      {name: "Times Square / Centre for Life", lat: 54.9672, lng: -1.6195},
    ]);
  });

  it("ignores text after the coordinates", () => {
    assert.deepEqual(parsePickupPoints("4) Kirkdale station | 53.4408,-2.9812 | Real: E1 Regent Rd"), [
      {name: "Kirkdale station", lat: 53.4408, lng: -2.9812},
    ]);
    assert.deepEqual(parsePickupPoints("2) Priory Rd | 53.4330,-2.9600 (approx.)"), [
      {name: "Priory Rd", lat: 53.433, lng: -2.96},
    ]);
    assert.deepEqual(parsePickupPoints("Velopark (53.4850,-2.1900) side entrance"), [
      {name: "Velopark", lat: 53.485, lng: -2.19},
    ]);
  });

  it("drops a note in front of the name, and a one-word tag like Real:", () => {
    const cell = "Owner bot to set pickups + baseline drop-off (3-5 miles) and verify | Real: P1 Arena Way main entrance " +
      "(54.9600,-1.6200); P2 Central Station portico (54.9690,-1.6170)";
    assert.deepEqual(parsePickupPoints(cell).map((point) => point.name), ["Arena Way main entrance", "Central Station portico"]);
  });

  it("still refuses chunks that are not pickups", () => {
    assert.deepEqual(parsePickupPoints("Owner bot to set pickups + baseline drop-off (3-5 miles) and verify"), []);
    assert.deepEqual(parsePickupPoints("C3 Rowsley Street & Ashton New Road (Beswick, M11 3)"), []);
    assert.deepEqual(parsePickupPoints("Gate | 53.44,-2.98x"), []);
    assert.deepEqual(parsePickupPoints("Gate | 53.44.1,-2.98"), []);
    assert.deepEqual(parsePickupPoints("Gate | 0,0"), []);
    assert.deepEqual(parsePickupPoints("Gate | 95.1,-2.98"), []);
  });
});

describe("reading coordinates", () => {
  it("parses Readings Latitude and Longitude, or leaves both null", () => {
    assert.deepEqual(readingCoord("53.4295", " -2.9920 "), {lat: 53.4295, lng: -2.992});
    assert.deepEqual(readingCoord(53.4295, -2.992), {lat: 53.4295, lng: -2.992});
    assert.deepEqual(readingCoord("", "-2.99"), {lat: null, lng: null});
    assert.deepEqual(readingCoord("53.4N", "-2.99"), {lat: null, lng: null});
    assert.deepEqual(readingCoord("0", "0"), {lat: null, lng: null});
    const sheet = parseSurgeSheet(matrix(VENUE_HEADERS, [CURRENT]), matrix(READINGS_HEADERS, readingsFor(CURRENT_ID, "2099-06-01", NEAR)));
    assert.equal(sheet.readings[0].lat, 51.7015);
    assert.equal(sheet.readings[0].lng, GATE_LNG);
  });

  it("uses a 150 m radius", () => {
    assert.equal(PICKUP_MATCH_RADIUS_M, 150);
    assert.ok(metresBetween(GATE_LAT, GATE_LNG, 51.7015, GATE_LNG) < PICKUP_MATCH_RADIUS_M);
    assert.ok(metresBetween(GATE_LAT, GATE_LNG, 51.703, GATE_LNG) > PICKUP_MATCH_RADIUS_M);
  });
});

describe("pickup verification", () => {
  const priors = [eventRow("01", "05", "YES"), eventRow("08", "05", "NO")];

  it("matches by name once the list number is gone on the Events side", () => {
    const readings = [
      ...readingsFor("2099-05-01-SYN-E0501", "2099-05-01", {}),
      ...readingsFor("2099-05-08-SYN-E0508", "2099-05-08", {}),
    ];
    const pickup = current([...priors, CURRENT], readings).pickupPoints[0];
    assert.equal(pickup.name, "North Gate");
    assert.equal(pickup.verified, true);
    assert.equal(pickup.confidence, "low");
    assert.equal(pickup.confidencePercent, 50);
  });

  it("matches by location when the reading names differ", () => {
    const readings = [
      ...readingsFor("2099-05-01-SYN-E0501", "2099-05-01", NEAR),
      ...readingsFor("2099-05-08-SYN-E0508", "2099-05-08", NEAR),
    ];
    const pickup = current([...priors, CURRENT], readings).pickupPoints[0];
    assert.equal(pickup.verified, true);
    assert.equal(pickup.confidence, "low");
    assert.equal(pickup.confidencePercent, 50);
    const sheet = parseSurgeSheet(matrix(VENUE_HEADERS, [...priors, CURRENT]), matrix(READINGS_HEADERS, readings));
    const event = sheet.events.find((item) => item.sheetEventId === CURRENT_ID);
    if (!event) throw new Error("missing event");
    const prior = sheet.events.filter((item) => item.sheetEventId !== CURRENT_ID);
    const history = pointHistory("1) North Gate", event, prior, sheet.readings, {lat: GATE_LAT, lng: GATE_LNG});
    assert.deepEqual(history, {events: 2, yes: 1, byName: 0, byLocation: 2});
    assert.equal(pointHistory("1) North Gate", event, prior, sheet.readings).events, 0);
  });

  it("does not count readings outside the radius", () => {
    const readings = [
      ...readingsFor("2099-05-01-SYN-E0501", "2099-05-01", FAR),
      ...readingsFor("2099-05-08-SYN-E0508", "2099-05-08", FAR),
    ];
    const pickup = current([...priors, CURRENT], readings).pickupPoints[0];
    assert.equal(pickup.verified, false);
    assert.equal("confidence" in pickup, false);
    assert.equal("confidencePercent" in pickup, false);
  });

  it("does not count a later event, even one that already has an outcome", () => {
    const later = eventRow("08", "06", "YES");
    const readings = [
      ...readingsFor("2099-05-01-SYN-E0501", "2099-05-01", NEAR),
      ...readingsFor("2099-06-08-SYN-E0608", "2099-06-08", NEAR),
    ];
    const pickup = current([eventRow("01", "05", "YES"), CURRENT, later], readings).pickupPoints[0];
    assert.equal(pickup.verified, false);
  });

  it("needs two readings per earlier event", () => {
    const readings = [
      ...readingsFor("2099-05-01-SYN-E0501", "2099-05-01", NEAR).slice(0, 1),
      ...readingsFor("2099-05-08-SYN-E0508", "2099-05-08", NEAR),
    ];
    assert.equal(current([...priors, CURRENT], readings).pickupPoints[0].verified, false);
  });
});

describe("hotspot_forecasts output is unchanged", () => {
  it("keeps the same mirror fields and never mirrors pickups", () => {
    assert.deepEqual([...FORECAST_MIRROR_FIELDS], [
      "forecast",
      "window_start",
      "window_end",
      "removeBy",
      "surgeEnded",
      "forecastHistory",
      "forecastSource",
      "forecastUpdatedAt",
      "expire_at",
    ]);
    const readings = [
      ...readingsFor("2099-05-01-SYN-E0501", "2099-05-01", NEAR),
      ...readingsFor("2099-05-08-SYN-E0508", "2099-05-08", NEAR),
    ];
    const record = current([eventRow("01", "05", "YES"), eventRow("08", "05", "NO"), CURRENT], readings);
    const data = toFirestoreData(record);
    assert.ok(Array.isArray(data.pickupPoints));
    const mirrored = forecastMirrorFields(data);
    assert.equal("pickupPoints" in mirrored, false);
    const allowed: readonly string[] = FORECAST_MIRROR_FIELDS;
    for (const key of Object.keys(mirrored)) assert.ok(allowed.includes(key), key);
  });

  it("leaves out a pickup whose name has a fare word but keeps the event", () => {
    const row = eventRow("01", "06", "PENDING", {
      [PICKUP_POINTS]: "1) North Gate | 51.701001, -0.301001\n2) Station forecourt (Uber label) | 51.702000, -0.302000",
    });
    const result = plan([row], []);
    assert.equal(result.rejected, 0);
    assert.equal(result.droppedPickups, 1);
    assert.deepEqual(result.records[0].pickupPoints.map((point) => point.name), ["North Gate"]);
    assertNoPrices(result.records[0]);
  });

  it("still passes the price guard", () => {
    const readings = [
      ...readingsFor("2099-05-01-SYN-E0501", "2099-05-01", {...NEAR, "Fare shown (£)": "18.4", "Baseline fare (£)": "19.5"}),
      ...readingsFor("2099-05-08-SYN-E0508", "2099-05-08", NEAR),
    ];
    const result = plan([eventRow("01", "05", "YES"), eventRow("08", "05", "NO"), CURRENT], readings);
    assertNoPrices(result);
    for (const record of result.records) assertNoPrices(toFirestoreData(record));
    assert.equal(JSON.stringify(result).includes("18.4"), false);
    assert.equal(JSON.stringify(result).includes("19.5"), false);
  });
});
