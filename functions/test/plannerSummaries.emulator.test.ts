import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {FieldValue, GeoPoint, Timestamp} from "firebase-admin/firestore";
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
import {SUMMARY_KEYS_COLLECTION, plannerSummariesEnabled} from "../src/surge/plannerSummaries";
import {matrix} from "../src/surge/syntheticSheet";
import {clearDb, testDb} from "./support";

const db = testDb("demo-ferromaps-stadium-surge");
const ON = {summariesEnabled: true} as const;
const FORBIDDEN = [
  "name", "venue", "place", "location", "lat", "lng", "latitude", "longitude",
  "geohash", "geohash5", "hotspotId", "strength", "hasForecast", "confidencePercent", "startAt",
];

async function linked(hotspotId: string) {
  const keys = await db.collection(SUMMARY_KEYS_COLLECTION).where("hotspotId", "==", hotspotId).get();
  const rows = [];
  for (const key of keys.docs) {
    rows.push({
      id: key.id,
      key: key.data(),
      summary: await db.collection(SUMMARIES_COLLECTION).doc(key.id).get(),
    });
  }
  return rows;
}

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
    const rows = await linked(docId);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, docId);
    assert.equal(rows[0].id.includes(docId), false);
    assert.equal(rows[0].key.hotspotId, docId);
    const summary = rows[0].summary;
    assert.equal(summary.exists, true);
    assert.equal(summary.get("startAt"), undefined);
    assert.equal(summary.get("windowStart").toMillis(), pin.get("forecast").startAt.toMillis());
    assert.equal(summary.get("windowEnd").toMillis(), pin.get("forecast").endAt.toMillis());
    assert.equal(summary.get("expireAt").toMillis(), Date.parse("2026-01-16T00:00:00.000Z"));
    assert.notEqual(summary.get("expireAt").toMillis(), pin.get("removeBy").toMillis());
    assert.equal(summary.get("geohash4").length, 4);
    for (const key of FORBIDDEN) assert.equal(summary.get(key), undefined, key);
    assert.equal(JSON.stringify(summary.data()).includes(docId), false);
    assert.equal(pin.get("forecast").strength, record.forecast.state === "available" ? record.forecast.strength : undefined);

    const closed = planStadiumEvents({
      now: new Date("2026-01-15T21:00:00.000Z"),
      events: matrix(EVENTS_HEADERS, [eventRow(id, "2026-01-15", "NO")]),
      readings: matrix(["Time (UK)"], []),
    });
    const next = closed.records.find((item) => item.sheetEventId === id);
    if (!next || next.forecast.state !== "no_prediction") throw new Error("expected no prediction");
    await commitStadiumEvents(db, [next], ON);
    assert.equal((await linked(docId)).length, 0);
    assert.equal((await db.collection(SUMMARIES_COLLECTION).doc(rows[0].id).get()).exists, false);
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
    assert.equal((await linked(id)).length, 0);
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
    const first = await linked(id);
    assert.equal(first.length, 1);
    assert.notEqual(first[0].id, id);
    const stored = first[0].summary.data() ?? {};
    assert.equal(stored.confidence, 80);
    assert.equal(stored.startAt, undefined);
    assert.equal(stored.windowStart.toMillis(), Date.parse("2026-07-15T16:00:00.000Z"));
    assert.equal(stored.windowEnd.toMillis(), Date.parse("2026-07-15T18:00:00.000Z"));
    assert.equal(stored.expireAt.toMillis(), Date.parse("2026-07-15T23:00:00.000Z"));
    assert.equal(stored.geohash4.length, 4);
    for (const key of FORBIDDEN) assert.equal(stored[key], undefined, key);
    assert.equal(JSON.stringify(stored).includes("Hall"), false);
    assert.equal(JSON.stringify(stored).includes("high"), false);
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc(id).get();
    assert.equal(pin.get("forecast").strength, "high");
    assert.equal(pin.get("forecast").confidencePercent, 80);

    await commitCategoryForecasts(db, [{
      id,
      forecast: {
        state: "available",
        v: 1,
        startAt: "2026-07-15T16:00:00.000Z",
        endAt: "2026-07-15T18:00:00.000Z",
        strength: "low",
        confidence: "low",
        confidencePercent: 55,
        basedOnEvents: 4,
      },
      forecastSource: "sheet_venue_history",
      updatedAt: "2026-07-15T12:30:00.000Z",
    }], ON);
    const same = await linked(id);
    assert.equal(same.length, 1);
    assert.equal(same[0].id, first[0].id);
    assert.equal(same[0].summary.get("confidence"), 55);

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
    const afterHistory = await linked(id);
    assert.equal(afterHistory.length, 1);
    assert.equal(afterHistory[0].id, first[0].id);
    assert.equal(afterHistory[0].summary.get("strength"), undefined);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(id).get()).get("forecastHistory").preEvent.strength, "high");

    await commitCategoryForecasts(db, [{
      id,
      forecast: {state: "no_prediction"},
      forecastSource: "sheet_venue_history",
      updatedAt: "2026-07-15T13:00:00.000Z",
    }], ON);
    const gone = await linked(id);
    assert.equal(gone.length, 0);
    assert.equal((await db.collection(SUMMARIES_COLLECTION).doc(first[0].id).get()).exists, false);
    assert.equal((await db.collection(SUMMARY_KEYS_COLLECTION).doc(first[0].id).get()).exists, false);
  });

  it("keeps the summary when the event start is gone, and deletes it when the location is gone", async () => {
    const forecast = {
      state: "available" as const,
      v: 1 as const,
      startAt: "2026-07-15T16:00:00.000Z",
      endAt: "2026-07-15T18:00:00.000Z",
      strength: "low" as const,
      confidence: "low" as const,
      confidencePercent: 40,
      basedOnEvents: 4,
    };
    const source = "sheet_venue_history" as const;
    const startId = "plan3_lost_start";
    await db.collection(HOTSPOTS_COLLECTION).doc(startId).set(categoryPin());
    await commitCategoryForecasts(db, [{
      id: startId,
      forecast,
      forecastSource: source,
      updatedAt: "2026-07-15T12:00:00.000Z",
    }], ON);
    const started = await linked(startId);
    assert.equal(started.length, 1);
    await db.collection(HOTSPOTS_COLLECTION).doc(startId).update({
      events: {venue_name: "The Hall", end_time: Timestamp.fromDate(new Date("2026-07-15T16:00:00.000Z"))},
    });
    await commitCategoryForecasts(db, [{
      id: startId,
      forecast,
      forecastSource: source,
      updatedAt: "2026-07-15T12:05:00.000Z",
    }], ON);
    const kept = await linked(startId);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, started[0].id);
    assert.equal(kept[0].summary.get("startAt"), undefined);
    assert.equal(kept[0].summary.get("expireAt").toMillis(), Date.parse("2026-07-15T23:00:00.000Z"));
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(startId).get()).get("forecast").state, "available");

    const locationId = "plan3_lost_location";
    await db.collection(HOTSPOTS_COLLECTION).doc(locationId).set(categoryPin());
    await commitCategoryForecasts(db, [{
      id: locationId,
      forecast,
      forecastSource: source,
      updatedAt: "2026-07-15T12:00:00.000Z",
    }], ON);
    const located = await linked(locationId);
    assert.equal(located.length, 1);
    await db.collection(HOTSPOTS_COLLECTION).doc(locationId).update({location: FieldValue.delete()});
    await commitCategoryForecasts(db, [{
      id: locationId,
      forecast,
      forecastSource: source,
      updatedAt: "2026-07-15T12:05:00.000Z",
    }], ON);
    assert.equal((await linked(locationId)).length, 0);
    assert.equal((await db.collection(SUMMARY_KEYS_COLLECTION).doc(located[0].id).get()).exists, false);
    assert.equal((await db.collection(HOTSPOTS_COLLECTION).doc(locationId).get()).get("forecast").state, "available");
  });

  it("does not copy a fare word from the pin name onto the summary", async () => {
    const id = "plan3_price";
    await db.collection(HOTSPOTS_COLLECTION).doc(id).set({...categoryPin(), name: "Uber fare"});
    await commitCategoryForecasts(db, [{
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
    }], ON);
    const rows = await linked(id);
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows[0].summary.data()).toLowerCase().includes("uber"), false);
    assert.equal(JSON.stringify(rows[0].summary.data()).toLowerCase().includes("fare"), false);
    assert.equal(rows[0].key.hotspotId, id);
  });

  it("gives a new window a new id and drops the previous summary", async () => {
    const id = "plan3_window";
    await db.collection(HOTSPOTS_COLLECTION).doc(id).set(categoryPin());
    const source = "sheet_venue_history" as const;
    await commitCategoryForecasts(db, [{
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
      forecastSource: source,
      updatedAt: "2026-07-15T12:00:00.000Z",
    }], ON);
    const first = await linked(id);
    assert.equal(first.length, 1);
    await commitCategoryForecasts(db, [{
      id,
      forecast: {
        state: "available",
        v: 1,
        startAt: "2026-07-16T16:00:00.000Z",
        endAt: "2026-07-16T19:00:00.000Z",
        strength: "low",
        confidence: "low",
        confidencePercent: 41,
        basedOnEvents: 4,
      },
      forecastSource: source,
      updatedAt: "2026-07-15T12:10:00.000Z",
    }], ON);
    const next = await linked(id);
    assert.equal(next.length, 1);
    assert.notEqual(next[0].id, first[0].id);
    assert.equal((await db.collection(SUMMARIES_COLLECTION).doc(first[0].id).get()).exists, false);
    assert.equal(next[0].summary.get("windowStart").toMillis(), Date.parse("2026-07-16T16:00:00.000Z"));
  });
});
