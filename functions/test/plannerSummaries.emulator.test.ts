import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {GeoPoint, Timestamp} from "firebase-admin/firestore";
import {commitCategoryForecasts} from "../src/surge/categoryCommit";
import {HOTSPOTS_COLLECTION, SUMMARIES_COLLECTION} from "../src/surge/collections";
import {commitStadiumEvents} from "../src/surge/commit";
import {commitForecastHistory} from "../src/surge/forecastHistoryCommit";
import {
  AWAY_TEAM,
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  PEAK_UPLIFT,
  PICKUP_POINTS,
  PREDICTED_SURGE_CONFIDENCE,
  SURGE_END,
  SURGE_START,
} from "../src/surge/headers";
import {planStadiumEvents} from "../src/surge/plan";
import {plannerSummariesEnabled} from "../src/surge/plannerSummaries";
import {PriceLeakError} from "../src/surge/priceGuard";
import {matrix} from "../src/surge/syntheticSheet";
import {clearDb, testDb} from "./support";

const db = testDb("demo-ferromaps-stadium-surge");
const ON = {summariesEnabled: true} as const;
const HIDDEN = ["strength", "confidence", "confidencePercent", "window_start", "window_end", "removeBy", "forecast"];

function eventRow(id: string, day: string, outcome: string): Record<string, unknown> {
  return {
    [EVENT_ID]: id,
    [HOME_TEAM]: "Home Side",
    [AWAY_TEAM]: "-",
    [GROUND]: "Synthetic Park",
    [KICKOFF]: `${day} 15:00`,
    [EXPECTED_FULL_TIME]: `${day} 16:55`,
    [SURGE_START]: `${day} 16:55`,
    [SURGE_END]: `${day} 18:30`,
    [HARD_STOP]: `${day} 19:55`,
    [PICKUP_POINTS]: "North Gate | 51.701001, -0.301001",
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: outcome === "YES" ? "47%" : "",
    [PREDICTED_SURGE_CONFIDENCE]: "75%",
  };
}

function categoryPin(): Record<string, unknown> {
  return {
    name: "Hall v -",
    city: "Manchester",
    area: "Ancoats",
    location: new GeoPoint(53.48, -2.24),
    events: {
      venue_name: "The Hall",
      start_time: Timestamp.fromDate(new Date("2026-07-15T14:00:00.000Z")),
      end_time: Timestamp.fromDate(new Date("2026-07-15T16:00:00.000Z")),
    },
    window_end: Timestamp.fromDate(new Date("2026-07-15T20:00:00.000Z")),
    removeBy: Timestamp.fromDate(new Date("2026-07-15T20:00:00.000Z")),
  };
}

describe("hotspot_forecast_summaries", () => {
  before(async () => {
    await clearDb(db);
  });

  it("stays off when either switch is missing", async () => {
    assert.equal(await plannerSummariesEnabled(db), false);
    await db.doc("config/flags").set({plannerSummaries: true});
    assert.equal(await plannerSummariesEnabled(db), false);
    await db.doc("config/flags").set({plannerSummaries: {enabled: true}});
    await db.doc("config/plannerSummaries").set({enabled: false});
    assert.equal(await plannerSummariesEnabled(db), false);
    await db.doc("config/plannerSummaries").set({enabled: true});
    assert.equal(await plannerSummariesEnabled(db), true);
  });

  it("writes a locked summary from the sheet writer and deletes it for no_prediction", async () => {
    const id = "2026-01-15-PLAN-SUM";
    const open = planStadiumEvents({
      now: new Date("2026-01-15T12:00:00.000Z"),
      events: matrix(EVENTS_HEADERS, [
        eventRow("2025-12-01-PLAN-A1", "2025-12-01", "YES"),
        eventRow("2025-12-08-PLAN-A2", "2025-12-08", "YES"),
        eventRow("2025-12-15-PLAN-A3", "2025-12-15", "YES"),
        eventRow(id, "2026-01-15", "PENDING"),
      ]),
      readings: matrix(["Time (UK)"], []),
    });
    const record = open.records.find((item) => item.sheetEventId === id);
    if (!record || record.forecast.state !== "available") throw new Error("expected a real forecast");
    await commitStadiumEvents(db, [record], ON);
    const docId = `sheet_${id}`;
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc(docId).get();
    const summary = await db.collection(SUMMARIES_COLLECTION).doc(docId).get();
    assert.equal(summary.exists, true);
    assert.equal(summary.get("hasForecast"), true);
    assert.equal(summary.get("name"), pin.get("name"));
    assert.equal(summary.get("venue"), pin.get("name"));
    assert.equal(summary.get("startAt").toMillis(), pin.get("events").start_time.toMillis());
    assert.notEqual(summary.get("startAt").toMillis(), pin.get("forecast").startAt.toMillis());
    assert.equal(summary.get("expireAt").toMillis(), Date.parse("2026-01-16T00:00:00.000Z"));
    assert.notEqual(summary.get("expireAt").toMillis(), pin.get("removeBy").toMillis());
    assert.equal(summary.get("location").latitude, pin.get("location").latitude);
    assert.equal(typeof summary.get("geohash"), "string");
    assert.equal(summary.get("geohash").length, 5);
    for (const key of HIDDEN) assert.equal(summary.get(key), undefined, key);
    assert.equal(pin.get("forecast").strength, record.forecast.state === "available" ? record.forecast.strength : undefined);
    assert.equal(JSON.stringify(summary.data()).includes("removeBy"), false);

    const closed = planStadiumEvents({
      now: new Date("2026-01-15T21:00:00.000Z"),
      events: matrix(EVENTS_HEADERS, [eventRow(id, "2026-01-15", "NO")]),
      readings: matrix(["Time (UK)"], []),
    });
    const next = closed.records.find((item) => item.sheetEventId === id);
    if (!next || next.forecast.state !== "no_prediction") throw new Error("expected no prediction");
    await commitStadiumEvents(db, [next], ON);
    assert.equal((await db.collection(SUMMARIES_COLLECTION).doc(docId).get()).exists, false);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(docId).get()).get("forecast").state, "no_prediction");
  });

  it("does not write a summary while the switch is off", async () => {
    const id = "plan3_off";
    await db.collection(HOTSPOTS_COLLECTION).doc(id).set(categoryPin());
    await commitCategoryForecasts(db, [{
      id,
      forecast: {
        state: "available",
        v: 1,
        startAt: "2026-07-15T16:00:00.000Z",
        endAt: "2026-07-15T18:00:00.000Z",
        strength: "low",
        confidence: "low",
        confidencePercent: 50,
        basedOnEvents: 4,
      },
      forecastSource: "sheet_venue_history",
      updatedAt: "2026-07-15T12:00:00.000Z",
    }]);
    assert.equal((await db.collection(SUMMARIES_COLLECTION).doc(id).get()).exists, false);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(id).get()).get("forecast").strength, "low");
  });

  it("writes from the category writer, keeps the hidden pin forecast, and deletes on no_prediction", async () => {
    const id = "plan3_cat";
    await db.collection(HOTSPOTS_COLLECTION).doc(id).set(categoryPin());
    await commitCategoryForecasts(db, [{
      id,
      forecast: {
        state: "available",
        v: 1,
        startAt: "2026-07-15T16:00:00.000Z",
        endAt: "2026-07-15T18:00:00.000Z",
        strength: "high",
        confidence: "medium",
        confidencePercent: 80,
        basedOnEvents: 4,
      },
      forecastSource: "sheet_venue_history",
      updatedAt: "2026-07-15T12:00:00.000Z",
    }], ON);
    const summary = await db.collection(SUMMARIES_COLLECTION).doc(id).get();
    const stored = summary.data() ?? {};
    assert.equal(stored.hasForecast, true);
    assert.equal(stored.name, "Hall v -");
    assert.equal(stored.venue, "The Hall");
    assert.equal(stored.place, "Manchester");
    assert.equal(stored.startAt.toMillis(), Date.parse("2026-07-15T14:00:00.000Z"));
    assert.equal(stored.expireAt.toMillis(), Date.parse("2026-07-15T23:00:00.000Z"));
    assert.notEqual(stored.expireAt.toMillis(), Date.parse("2026-07-15T20:00:00.000Z"));
    for (const key of HIDDEN) assert.equal(stored[key], undefined, key);
    assert.equal(JSON.stringify(stored).includes("80"), false);
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc(id).get();
    assert.equal(pin.get("forecast").strength, "high");
    assert.equal(pin.get("forecast").confidencePercent, 80);

    await commitForecastHistory(db, [{
      id,
      preEvent: {
        snapshotAt: "2026-07-15T10:00:00.000Z",
        state: "available",
        strength: "high",
        confidencePercent: 80,
        basedOnEvents: 4,
        startAt: "2026-07-15T16:00:00.000Z",
        endAt: "2026-07-15T18:00:00.000Z",
      },
    }], ON);
    const afterHistory = await db.collection(SUMMARIES_COLLECTION).doc(id).get();
    assert.equal(afterHistory.get("venue"), "The Hall");
    assert.equal(afterHistory.get("strength"), undefined);
    assert.equal(afterHistory.get("confidencePercent"), undefined);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(id).get()).get("forecastHistory").preEvent.strength, "high");

    await commitCategoryForecasts(db, [{
      id,
      forecast: {state: "no_prediction"},
      forecastSource: "sheet_venue_history",
      updatedAt: "2026-07-15T13:00:00.000Z",
    }], ON);
    assert.equal((await db.collection(SUMMARIES_COLLECTION).doc(id).get()).exists, false);
  });

  it("does not write a summary whose name carries a fare, and leaves the pin unchanged", async () => {
    const id = "plan3_price";
    await db.collection(HOTSPOTS_COLLECTION).doc(id).set({...categoryPin(), name: "Uber fare"});
    await assert.rejects(() => commitCategoryForecasts(db, [{
      id,
      forecast: {
        state: "available",
        v: 1,
        startAt: "2026-07-15T16:00:00.000Z",
        endAt: "2026-07-15T18:00:00.000Z",
        strength: "low",
        confidence: "low",
        confidencePercent: 40,
        basedOnEvents: 4,
      },
      forecastSource: "sheet_venue_history",
      updatedAt: "2026-07-15T12:00:00.000Z",
    }], ON), (err: unknown) => err instanceof PriceLeakError);
    assert.equal((await db.collection(SUMMARIES_COLLECTION).doc(id).get()).exists, false);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(id).get()).get("forecast"), undefined);
  });
});
