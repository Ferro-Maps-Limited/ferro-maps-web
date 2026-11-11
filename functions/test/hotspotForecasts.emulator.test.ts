import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {before, describe, it, mock} from "node:test";
import {GeoPoint, Timestamp} from "firebase-admin/firestore";
import {logger} from "firebase-functions/logger";
import {commitCategoryForecasts} from "../src/surge/categoryCommit";
import {planCategoryForecasts} from "../src/surge/categoryPlan";
import {FORECASTS_COLLECTION, HOTSPOTS_COLLECTION} from "../src/surge/collections";
import {commitStadiumEvents} from "../src/surge/commit";
import {PRE_EVENT_LEAD_MS} from "../src/surge/forecastHistory";
import {commitForecastHistory} from "../src/surge/forecastHistoryCommit";
import {queueForecastMirrors} from "../src/surge/forecastMirror";
import {
  AWAY_TEAM,
  BACK_TO_BASELINE,
  BASELINE_FARE,
  CHECK_IN_HEADERS,
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
  FARE_SHOWN,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  PEAK_UPLIFT,
  PHASE,
  PICKUP_POINT,
  PICKUP_POINTS,
  PREDICTED_SURGE_CONFIDENCE,
  READINGS_HEADERS,
  SURGE_END,
  SURGE_START,
  TIME_UK,
} from "../src/surge/headers";
import {planStadiumEvents} from "../src/surge/plan";
import {PriceLeakError} from "../src/surge/priceGuard";
import {runForecastHistory} from "../src/surge/recordForecastHistory";
import {matrix} from "../src/surge/syntheticSheet";
import {TPC_LOG_HEADERS, TPC_READINGS_HEADERS} from "../src/surge/tpc";
import {lookupVenueLocation} from "../src/surge/venueLocations";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-stadium-surge";
const PINS = HOTSPOTS_COLLECTION;
const FORECASTS = FORECASTS_COLLECTION;
const MONEY_KEY = /(price|fare|baseline|currency|gbp|quid|uplift|fee|multiplier|uber|bolt)/i;
const MONEY_TEXT = /[£$€]|\b(gbp|usd|eur|quid|fares?|uber|bolt|uplift|baseline|prices?)\b/i;
const PIN_ONLY = [
  "name",
  "description",
  "location",
  "pickupPoints",
  "events",
  "idSource",
  "sheetEventId",
  "category",
  "jobs_accepted",
  "baseline",
  "fareShown",
  "price",
];

const db = testDb(PROJECT);

function canonical(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toMillis();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const millis = value as {toMillis?: () => number};
    if (typeof millis.toMillis === "function") return millis.toMillis();
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/* Fails when a stored forecast field looks like a price, fare, baseline, or currency. */
function auditForecastValue(value: unknown, path = ""): void {
  const key = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : path.replace(/\[\d+\]$/, "");
  const bare = key.replace(/[^a-z0-9]/gi, "");
  if (bare && MONEY_KEY.test(bare)) assert.fail(`money-like key at ${path}`);
  if (typeof value === "string" && MONEY_TEXT.test(value)) assert.fail(`money-like value at ${path}`);
  if (value instanceof Timestamp) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => auditForecastValue(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    const stamp = value as {toMillis?: unknown};
    if (typeof stamp.toMillis === "function") return;
    for (const [child, nested] of Object.entries(value as Record<string, unknown>)) {
      auditForecastValue(nested, path ? `${path}.${child}` : child);
    }
  }
}

async function auditEveryForecastDoc(): Promise<number> {
  const snap = await db.collection(FORECASTS).get();
  for (const doc of snap.docs) auditForecastValue(doc.data(), doc.id);
  return snap.size;
}

function eventRow(id: string, day: string, outcome: string, confidence: string): Record<string, unknown> {
  return {
    [EVENT_ID]: id,
    [HOME_TEAM]: "Home Side",
    [AWAY_TEAM]: "Away Side",
    [GROUND]: "Synthetic Park",
    [KICKOFF]: `${day} 15:00`,
    [EXPECTED_FULL_TIME]: `${day} 16:55`,
    [SURGE_START]: `${day} 16:55`,
    [SURGE_END]: `${day} 19:00`,
    [HARD_STOP]: `${day} 19:55`,
    [PICKUP_POINTS]: "North Gate | 51.701001, -0.301001",
    [DID_IT_SURGE]: outcome,
    [PEAK_UPLIFT]: outcome === "YES" ? "47%" : "",
    [PREDICTED_SURGE_CONFIDENCE]: confidence,
  };
}

function priorRows(): Record<string, unknown>[] {
  return ["01", "08", "15"].map((day) => eventRow(`2099-10-${day}-GOLD-P${day}`, `2099-10-${day}`, "YES", "10%"));
}

function fareReadings(eventId: string): Record<string, unknown>[] {
  return ["17:00", "17:05"].map((time) => ({
    [TIME_UK]: `2099-11-02 ${time}`,
    [EVENT_ID]: eventId,
    [PHASE]: "During",
    [PICKUP_POINT]: "North Gate",
    [BACK_TO_BASELINE]: "Yes",
    [FARE_SHOWN]: "22.08",
    [BASELINE_FARE]: "19.50",
  }));
}

function categoryPatch(id: string) {
  return {
    id,
    forecast: {
      state: "available" as const,
      v: 1 as const,
      startAt: "2099-08-01T18:00:00.000Z",
      endAt: "2099-08-01T21:00:00.000Z",
      strength: "low" as const,
      confidence: "low" as const,
      confidencePercent: 50,
      basedOnEvents: 4,
    },
    forecastSource: "sheet_venue_history" as const,
    updatedAt: "2099-08-01T12:00:00.000Z",
  };
}

function captureForecastSkips(): {rows: Array<Record<string, unknown>>; stop: () => void} {
  const rows: Array<Record<string, unknown>> = [];
  const mocked = mock.method(logger, "warn", (_message: unknown, fields: unknown) => {
    if (fields && typeof fields === "object") rows.push(fields as Record<string, unknown>);
  });
  return {rows, stop: () => mocked.mock.restore()};
}

describe("hotspot_forecasts dual write", () => {
  before(async () => {
    await clearDb(db);
  });

  it("mirrors a sheet forecast, including surgeEnded and removeBy, under the same id", async () => {
    const id = "2099-11-02-GOLD-FIG";
    const docId = `sheet_${id}`;
    const open = planStadiumEvents({
      now: new Date("2099-11-02T12:00:00.000Z"),
      events: matrix(EVENTS_HEADERS, [...priorRows(), eventRow(id, "2099-11-02", "PENDING", "75%")]),
      readings: matrix(READINGS_HEADERS, []),
    });
    const record = open.records.find((item) => item.sheetEventId === id);
    if (!record || record.forecast.state !== "available") throw new Error("expected an open forecast");
    assert.equal(record.surgeEnded, false);
    await db.collection(PINS).doc("fixed_gold_decoy").set({name: "Not a sheet row", category: "parking"});
    await commitStadiumEvents(db, open.records);

    const pin = await db.collection(PINS).doc(docId).get();
    const mirrored = await db.collection(FORECASTS).doc(docId).get();
    assert.equal(mirrored.id, pin.id);
    assert.equal(mirrored.exists, true);
    assert.deepEqual(canonical(mirrored.get("forecast")), canonical(pin.get("forecast")));
    assert.equal(mirrored.get("forecast").state, "available");
    assert.equal(mirrored.get("forecast").v, 1);
    assert.equal(mirrored.get("forecast").strength, pin.get("forecast").strength);
    assert.equal(mirrored.get("forecast").confidence, pin.get("forecast").confidence);
    assert.equal(mirrored.get("forecast").confidencePercent, 75);
    assert.equal(mirrored.get("forecast").confidenceSource, "events_tab");
    assert.equal(mirrored.get("forecast").startAt.toMillis(), pin.get("forecast").startAt.toMillis());
    assert.equal(mirrored.get("forecast").endAt.toMillis(), pin.get("forecast").endAt.toMillis());
    assert.equal(mirrored.get("surgeEnded"), false);
    assert.equal(pin.get("surgeEnded"), false);
    assert.equal(mirrored.get("removeBy").toMillis(), pin.get("removeBy").toMillis());
    assert.equal(mirrored.get("window_start").toMillis(), pin.get("window_start").toMillis());
    assert.equal(mirrored.get("window_end").toMillis(), pin.get("window_end").toMillis());
    assert.equal(mirrored.get("expire_at").toMillis(), pin.get("expire_at").toMillis());
    assert.ok(mirrored.get("updatedAt") instanceof Timestamp);
    for (const key of PIN_ONLY) assert.equal(mirrored.get(key), undefined, key);
    auditForecastValue(mirrored.data(), docId);
    assert.equal((await db.collection(FORECASTS).doc("fixed_gold_decoy").get()).exists, false);

    const ended = planStadiumEvents({
      now: new Date("2099-11-02T18:00:00.000Z"),
      events: matrix(EVENTS_HEADERS, [...priorRows(), eventRow(id, "2099-11-02", "PENDING", "75%")]),
      readings: matrix(READINGS_HEADERS, fareReadings(id)),
    });
    const endedRecord = ended.records.find((item) => item.sheetEventId === id);
    if (!endedRecord) throw new Error("missing ended row");
    assert.equal(endedRecord.surgeEnded, true);
    await commitStadiumEvents(db, ended.records);

    const pinAfter = await db.collection(PINS).doc(docId).get();
    const endedDoc = await db.collection(FORECASTS).doc(docId).get();
    assert.equal(pinAfter.get("surgeEnded"), true);
    assert.equal(endedDoc.exists, true);
    assert.equal(endedDoc.get("surgeEnded"), true);
    assert.equal(endedDoc.get("forecast").state, "available");
    assert.equal(endedDoc.get("forecast").confidencePercent, 75);
    assert.equal(endedDoc.get("forecast").startAt.toMillis(), pinAfter.get("forecast").startAt.toMillis());
    assert.equal(endedDoc.get("forecast").endAt.toMillis(), pinAfter.get("forecast").endAt.toMillis());
    assert.equal(endedDoc.get("removeBy").toMillis(), pinAfter.get("removeBy").toMillis());
    auditForecastValue(endedDoc.data(), docId);
    const raw = JSON.stringify(pinAfter.data()) + JSON.stringify(endedDoc.data());
    assert.equal(raw.includes("22.08"), false);
    assert.equal(raw.includes("19.50"), false);
  });

  it("mirrors category forecasts and writes no doc for a pin with no forecast", async () => {
    const venue = lookupVenueLocation("OVO Hydro, Glasgow");
    if (!venue) throw new Error("missing venue");
    const expireAt = Timestamp.fromDate(new Date("2099-06-01T22:00:00.000Z"));
    const removeBy = Timestamp.fromDate(new Date("2099-06-01T22:00:00.000Z"));
    const windowEnd = Timestamp.fromDate(new Date("2099-06-01T21:00:00.000Z"));
    await db.collection(PINS).doc("tm_gold_hydro").set({
      name: "Keep this name",
      category: "events",
      city: "Glasgow",
      jobs_accepted: 4,
      baseline: 19.5,
      fareShown: "£18.40",
      expire_at: expireAt,
      removeBy,
      surgeEnded: false,
      window_end: windowEnd,
      location: new GeoPoint(venue.lat, venue.lng),
      starting_time: Timestamp.fromDate(new Date("2099-06-01T16:00:00.000Z")),
      ending_time: Timestamp.fromDate(new Date("2099-06-01T19:00:00.000Z")),
      events: {venue_name: "OVO Hydro"},
    });
    await db.collection(PINS).doc("gold_parking").set({
      category: "parking",
      name: "Bay",
      price: 12,
      note: "baseline fare",
    });
    const pins = await Promise.all(["tm_gold_hydro", "gold_parking"].map(async (id) => {
      const doc = await db.collection(PINS).doc(id).get();
      return {id: doc.id, data: doc.data() as Record<string, unknown>};
    }));
    const planned = planCategoryForecasts({
      now: new Date("2099-08-01T12:00:00.000Z"),
      events: matrix(EVENTS_HEADERS, ["01", "02", "03", "04"].map((day, index) => ({
        [EVENT_ID]: `2099-05-${day}-GOLD-H${index}`,
        [HOME_TEAM]: `Artist ${day}`,
        [GROUND]: "OVO Hydro, Glasgow",
        [KICKOFF]: `2099-05-${day} 15:00`,
        [DID_IT_SURGE]: "YES",
        [PEAK_UPLIFT]: "47%",
      }))),
      tpcLog: matrix(TPC_LOG_HEADERS, []),
      tpcReadings: matrix(TPC_READINGS_HEADERS, []),
      pins,
    });
    const hydro = planned.patches.find((item) => item.id === "tm_gold_hydro");
    if (!hydro || hydro.forecast.state !== "available") throw new Error("expected a hydro forecast");
    assert.equal(planned.patches.some((item) => item.id === "gold_parking"), false);
    await commitCategoryForecasts(db, planned.patches);

    const pin = await db.collection(PINS).doc("tm_gold_hydro").get();
    const mirrored = await db.collection(FORECASTS).doc("tm_gold_hydro").get();
    assert.equal(mirrored.exists, true);
    assert.equal(mirrored.id, "tm_gold_hydro");
    assert.deepEqual(canonical(mirrored.get("forecast")), canonical(pin.get("forecast")));
    assert.equal(mirrored.get("forecastSource"), pin.get("forecastSource"));
    assert.equal(mirrored.get("forecastUpdatedAt").toMillis(), pin.get("forecastUpdatedAt").toMillis());
    assert.equal(mirrored.get("expire_at").toMillis(), expireAt.toMillis());
    assert.equal(mirrored.get("removeBy").toMillis(), removeBy.toMillis());
    assert.equal(mirrored.get("surgeEnded"), false);
    assert.equal(mirrored.get("window_end").toMillis(), windowEnd.toMillis());
    assert.equal(mirrored.get("forecast").startAt.toMillis(), pin.get("forecast").startAt.toMillis());
    assert.equal(mirrored.get("forecast").endAt.toMillis(), pin.get("forecast").endAt.toMillis());
    assert.ok(mirrored.get("updatedAt") instanceof Timestamp);
    assert.equal(pin.get("name"), "Keep this name");
    assert.equal(pin.get("jobs_accepted"), 4);
    assert.equal(pin.get("baseline"), 19.5);
    for (const key of PIN_ONLY) assert.equal(mirrored.get(key), undefined, key);
    auditForecastValue(mirrored.data(), "tm_gold_hydro");
    assert.equal((await db.collection(FORECASTS).doc("gold_parking").get()).exists, false);

    const batch = db.batch();
    const ops = await queueForecastMirrors(db, batch, [{
      id: "tm_gold_hydro",
      fields: {forecast: null},
    }]);
    assert.equal(ops, 1);
    await batch.commit();
    assert.equal((await db.collection(FORECASTS).doc("tm_gold_hydro").get()).exists, false);
    const kept = await db.collection(PINS).doc("tm_gold_hydro").get();
    assert.equal(kept.get("forecast").state, "available");
    assert.equal(kept.get("forecastSource"), "sheet_venue_history");
  });

  it("mirrors forecast history and writes no doc when there is no forecast", async () => {
    const start = Date.parse("2099-12-01T17:00:00.000Z");
    const end = Date.parse("2099-12-01T19:00:00.000Z");
    const at = start - PRE_EVENT_LEAD_MS;
    const his = "sheet_2099-12-01-GOLD-HIS";
    const expireAt = Timestamp.fromDate(new Date("2099-12-01T22:00:00.000Z"));
    await db.collection(PINS).doc(his).set({
      idSource: "sheet_event",
      sheetEventId: "2099-12-01-GOLD-HIS",
      name: "Home Side v Away Side",
      category: "event",
      fareShown: "£22.08 uber",
      baseline: 19.5,
      expire_at: expireAt,
      removeBy: expireAt,
      surgeEnded: false,
      window_end: expireAt,
      window_start: Timestamp.fromDate(new Date(start)),
      events: {
        start_time: Timestamp.fromDate(new Date(start)),
        end_time: Timestamp.fromDate(new Date(end)),
      },
      forecast: {
        state: "available",
        v: 1,
        startAt: Timestamp.fromDate(new Date(end)),
        endAt: expireAt,
        strength: "medium",
        confidence: "low",
        confidencePercent: 75,
        basedOnEvents: 4,
      },
    });
    await db.collection(PINS).doc("gold_history_parking").set({
      category: "parking",
      note: "keep",
      price: 4,
    });

    const runAt = (nowMs: number) => runForecastHistory({
      now: new Date(nowMs),
      sheetId: "sheet-under-test",
      readingsTab: "Readings",
      checkInsTab: "Check-ins",
      load: async () => ({
        readings: matrix(READINGS_HEADERS, [{
          [TIME_UK]: "2099-12-01 18:00",
          [EVENT_ID]: "2099-12-01-GOLD-HIS",
          [PHASE]: "During",
          [PICKUP_POINT]: "North Gate",
          [FARE_SHOWN]: "27.65",
          [BASELINE_FARE]: "18.40",
        }]),
        checkIns: matrix(CHECK_IN_HEADERS, []),
      }),
      listPins: async () => {
        const docs = await Promise.all([his, "gold_history_parking"].map((id) => db.collection(PINS).doc(id).get()));
        return docs.filter((doc) => doc.exists).map((doc) => ({
          id: doc.id,
          data: doc.data() as Record<string, unknown>,
        }));
      },
      commit: (proposals) => commitForecastHistory(db, proposals),
    });

    const early = await runAt(at - 60_000);
    assert.equal(early.written, 0);
    assert.equal((await db.collection(FORECASTS).doc(his).get()).exists, false);
    assert.equal((await db.collection(FORECASTS).doc("gold_history_parking").get()).exists, false);

    const first = await runAt(at);
    assert.equal(first.written >= 1, true);
    const pin = await db.collection(PINS).doc(his).get();
    const mirrored = await db.collection(FORECASTS).doc(his).get();
    assert.equal(mirrored.exists, true);
    assert.equal(mirrored.id, his);
    assert.deepEqual(canonical(mirrored.get("forecastHistory")), canonical(pin.get("forecastHistory")));
    assert.equal(mirrored.get("forecastHistory").preEvent.confidencePercent, 75);
    assert.equal(mirrored.get("forecastHistory").preEvent.state, "available");
    assert.equal(mirrored.get("expire_at").toMillis(), expireAt.toMillis());
    assert.equal(mirrored.get("surgeEnded"), false);
    assert.equal(mirrored.get("removeBy").toMillis(), expireAt.toMillis());
    assert.equal(mirrored.get("forecast").state, "available");
    assert.equal(mirrored.get("forecast").startAt.toMillis(), pin.get("forecast").startAt.toMillis());
    assert.equal(mirrored.get("forecast").endAt.toMillis(), pin.get("forecast").endAt.toMillis());
    assert.ok(mirrored.get("updatedAt") instanceof Timestamp);
    assert.equal(pin.get("fareShown"), "£22.08 uber");
    for (const key of ["fareShown", "baseline", "name", "price"]) {
      assert.equal(mirrored.get(key), undefined, key);
    }
    auditForecastValue(mirrored.data(), his);
    assert.equal((await db.collection(FORECASTS).doc("gold_history_parking").get()).exists, false);

    const second = await runAt(at + 20 * 60 * 1000);
    assert.equal(second.written, 0);
    const again = await db.collection(FORECASTS).doc(his).get();
    assert.deepEqual(canonical(again.get("forecastHistory")), canonical(pin.get("forecastHistory")));
  });

  it("skips a forecast that has no window_end and logs the writer", async () => {
    const id = "gold_no_window";
    await db.collection(PINS).doc(id).set({name: "No window", category: "events", removeBy: Timestamp.now()});
    const warnings = captureForecastSkips();
    try {
      assert.equal(await commitCategoryForecasts(db, [categoryPatch(id)]), 1);
    } finally {
      warnings.stop();
    }
    const pin = await db.collection(PINS).doc(id).get();
    assert.equal(pin.get("forecast").state, "available");
    assert.equal(pin.get("forecastSource"), "sheet_venue_history");
    assert.equal(pin.get("window_end"), undefined);
    assert.equal((await db.collection(FORECASTS).doc(id).get()).exists, false);
    const logged = warnings.rows.find((row) => row.hotspotId === id);
    assert.ok(logged);
    assert.equal(logged.writer, "attachCategoryForecasts");
  });

  it("writes a forecast when window_end is a Timestamp", async () => {
    const id = "gold_with_window";
    const windowEnd = Timestamp.fromDate(new Date("2099-08-01T21:00:00.000Z"));
    await db.collection(PINS).doc(id).set({name: "Has window", category: "events", window_end: windowEnd});
    const warnings = captureForecastSkips();
    try {
      assert.equal(await commitCategoryForecasts(db, [categoryPatch(id)]), 1);
    } finally {
      warnings.stop();
    }
    const pin = await db.collection(PINS).doc(id).get();
    const mirrored = await db.collection(FORECASTS).doc(id).get();
    assert.equal(pin.get("forecast").state, "available");
    assert.equal(mirrored.exists, true);
    assert.equal(mirrored.get("window_end").toMillis(), windowEnd.toMillis());
    assert.equal(mirrored.get("forecast").startAt.toMillis(), Date.parse("2099-08-01T18:00:00.000Z"));
    assert.equal(warnings.rows.some((row) => row.hotspotId === id), false);
  });

  it("writes no forecast document for a history update when the pin has no window_end", async () => {
    const id = "gold_hist_no_window";
    await db.collection(PINS).doc(id).set({
      category: "event",
      removeBy: Timestamp.fromDate(new Date("2099-12-02T22:00:00.000Z")),
      expire_at: Timestamp.fromDate(new Date("2099-12-02T22:00:00.000Z")),
      forecast: {state: "no_prediction"},
    });
    const warnings = captureForecastSkips();
    let written = 0;
    try {
      written = await commitForecastHistory(db, [{
        id,
        preEvent: {
          snapshotAt: "2099-12-02T13:00:00.000Z",
          state: "available",
          strength: "low",
          basedOnEvents: 4,
          startAt: "2099-12-02T19:00:00.000Z",
          endAt: "2099-12-02T22:00:00.000Z",
        },
      }]);
    } finally {
      warnings.stop();
    }
    const pin = await db.collection(PINS).doc(id).get();
    assert.equal(written, 1);
    assert.equal(pin.get("forecastHistory").preEvent.state, "available");
    assert.equal(pin.get("forecast").state, "no_prediction");
    assert.equal(pin.get("window_end"), undefined);
    assert.equal((await db.collection(FORECASTS).doc(id).get()).exists, false);
    const logged = warnings.rows.find((row) => row.hotspotId === id);
    assert.ok(logged);
    assert.equal(logged.writer, "recordForecastHistory");
  });

  it("audits every hotspot_forecasts field and refuses a price payload", async () => {
    assert.throws(() => auditForecastValue({fare: "£18.40"}, "sample"), /money-like/);
    assert.throws(() => auditForecastValue({forecast: {baseline: 19.5}}, "sample"), /money-like/);
    assert.throws(() => auditForecastValue({note: "uber price"}, "sample"), /money-like value/);
    auditForecastValue({
      forecast: {state: "no_prediction", confidencePercent: null, confidenceSource: "none"},
      window_start: Timestamp.now(),
      expire_at: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }, "clean");

    const batch = db.batch();
    await assert.rejects(
      () => queueForecastMirrors(db, batch, [{
        id: "gold_poison",
        fields: {forecast: {state: "available", fare: "£18.40", baseline: 19.5}, price: 10},
      }]),
      (err: unknown) => err instanceof PriceLeakError,
    );
    await batch.commit();
    assert.equal((await db.collection(FORECASTS).doc("gold_poison").get()).exists, false);

    const skipped = db.batch();
    const ops = await queueForecastMirrors(db, skipped, [{id: "gold_empty", fields: {name: "no forecast"}}]);
    assert.equal(ops, 0);
    await skipped.commit();
    assert.equal((await db.collection(FORECASTS).doc("gold_empty").get()).exists, false);

    const scanned = await auditEveryForecastDoc();
    assert.ok(scanned > 0);

    const helper = readFileSync(join(__dirname, "../src/surge/forecastMirror.ts"), "utf8");
    const todo = "TODO: remove the forecast fields from hotspots_test in the following release.";
    assert.ok(helper.includes(todo));
    for (const name of ["commit.ts", "categoryCommit.ts", "forecastHistoryCommit.ts"]) {
      assert.ok(readFileSync(join(__dirname, "../src/surge", name), "utf8").includes(todo), name);
    }
    const sync = readFileSync(join(__dirname, "../src/hotspotTestPins/syncHotspotTestPins.ts"), "utf8");
    assert.equal(sync.includes("hotspot_forecasts"), false);
    assert.equal(sync.includes(".set("), false);
    assert.equal(sync.includes(".update("), false);
  });
});
