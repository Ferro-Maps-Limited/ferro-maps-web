import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {GeoPoint, Timestamp, type Firestore} from "firebase-admin/firestore";
import {geohash} from "../src/parking/privateSheet/geohash";
import {
  buildPlannerSummary,
  endOfLondonDayMs,
  flagIsOn,
  opaqueSummaryId,
  planPlannerSummary,
  plannerSummariesEnabled,
  type ExistingSummaryKey,
} from "../src/surge/plannerSummaries";

const FORBIDDEN = [
  "name",
  "venue",
  "place",
  "location",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "geohash",
  "geohash5",
  "hotspotId",
  "strength",
  "hasForecast",
  "confidencePercent",
];

function pin(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Home Side v -",
    city: "London",
    area: "Greenwich",
    location: new GeoPoint(51.503, -0.003),
    events: {
      venue_name: "The O2",
      start_time: Timestamp.fromDate(new Date("2026-07-15T14:00:00.000Z")),
      end_time: Timestamp.fromDate(new Date("2026-07-15T16:00:00.000Z")),
    },
    removeBy: Timestamp.fromDate(new Date("2026-07-15T19:00:00.000Z")),
    forecast: {
      state: "available",
      startAt: Timestamp.fromDate(new Date("2026-07-15T16:00:00.000Z")),
      endAt: Timestamp.fromDate(new Date("2026-07-15T18:30:00.000Z")),
      strength: "high",
      confidence: "medium",
      confidencePercent: 75,
    },
    ...extra,
  };
}

describe("planner summary document", () => {
  it("ends the UK day at the next London midnight, in winter and in summer", () => {
    const winter = Date.parse("2026-01-15T15:00:00.000Z");
    const summer = Date.parse("2026-07-15T14:00:00.000Z");
    assert.equal(endOfLondonDayMs(winter), Date.parse("2026-01-16T00:00:00.000Z"));
    assert.equal(endOfLondonDayMs(summer), Date.parse("2026-07-15T23:00:00.000Z"));
    assert.equal(endOfLondonDayMs(Date.parse("2026-07-15T23:30:00.000Z")), Date.parse("2026-07-16T23:00:00.000Z"));
  });

  it("stores the window, the percent, and a precision-4 geohash, and nothing that names the venue", () => {
    const data = buildPlannerSummary(pin());
    if (!data) throw new Error("expected a summary");
    assert.equal((data.windowStart as Timestamp).toMillis(), Date.parse("2026-07-15T16:00:00.000Z"));
    assert.equal((data.windowEnd as Timestamp).toMillis(), Date.parse("2026-07-15T18:30:00.000Z"));
    assert.equal((data.startAt as Timestamp).toMillis(), Date.parse("2026-07-15T14:00:00.000Z"));
    assert.equal(data.confidence, 75);
    assert.equal(data.geohash4, geohash(51.503, -0.003, 4));
    assert.equal(String(data.geohash4).length, 4);
    assert.equal((data.expireAt as Timestamp).toMillis(), Date.parse("2026-07-15T23:00:00.000Z"));
    for (const key of FORBIDDEN) assert.equal(Object.prototype.hasOwnProperty.call(data, key), false, key);
    assert.equal(JSON.stringify(data).includes("The O2"), false);
    assert.equal(JSON.stringify(data).includes("high"), false);
    assert.equal(JSON.stringify(data).includes("medium"), false);
  });

  it("uses a new opaque id per window and keeps the id when the same window is written again", () => {
    const hotspotId = "sheet_o2";
    const ids = ["aaaa", "bbbb"];
    const first = planPlannerSummary(hotspotId, pin(), [], () => ids.shift() ?? "cccc");
    if (!first.upsert) throw new Error("expected a summary");
    assert.equal(first.upsert.id, "aaaa");
    assert.notEqual(first.upsert.id, hotspotId);
    assert.equal(first.upsert.key.hotspotId, hotspotId);
    const kept: ExistingSummaryKey = {
      id: first.upsert.id,
      windowStart: first.upsert.key.windowStart,
      windowEnd: first.upsert.key.windowEnd,
    };
    const again = planPlannerSummary(hotspotId, pin(), [kept], () => "bbbb");
    assert.equal(again.upsert?.id, "aaaa");
    assert.deepEqual(again.deletes, []);
    const moved = pin({
      forecast: {
        state: "available",
        startAt: Timestamp.fromDate(new Date("2026-07-16T16:00:00.000Z")),
        endAt: Timestamp.fromDate(new Date("2026-07-16T18:30:00.000Z")),
        strength: "low",
        confidencePercent: 40,
      },
    });
    const next = planPlannerSummary(hotspotId, moved, [kept], () => "bbbb");
    assert.equal(next.upsert?.id, "bbbb");
    assert.deepEqual(next.deletes, ["aaaa"]);
    const fresh = opaqueSummaryId();
    assert.notEqual(fresh, hotspotId);
    assert.equal(fresh.includes(hotspotId), false);
  });

  it("deletes the summary and its key when the forecast is cleared, empty, or has lost its start or location", () => {
    const existing: ExistingSummaryKey[] = [{
      id: "kept",
      windowStart: Timestamp.fromDate(new Date("2026-07-15T16:00:00.000Z")),
      windowEnd: Timestamp.fromDate(new Date("2026-07-15T18:30:00.000Z")),
    }];
    assert.deepEqual(planPlannerSummary("pin", pin({forecast: null}), existing).deletes, ["kept"]);
    assert.equal(planPlannerSummary("pin", pin({forecast: null}), existing).upsert, null);
    assert.deepEqual(planPlannerSummary("pin", pin({forecast: {state: "no_prediction"}}), existing).deletes, ["kept"]);
    assert.deepEqual(planPlannerSummary("pin", pin({events: {}}), existing).deletes, ["kept"]);
    assert.deepEqual(planPlannerSummary("pin", pin({location: null}), existing).deletes, ["kept"]);
    const rest = pin();
    delete rest.forecast;
    assert.deepEqual(planPlannerSummary("pin", rest, existing).deletes, []);
    assert.equal(planPlannerSummary("pin", rest, existing).upsert, null);
  });

  it("treats a missing flag as off", () => {
    assert.equal(flagIsOn(undefined), false);
    assert.equal(flagIsOn(false), false);
    assert.equal(flagIsOn("true"), false);
    assert.equal(flagIsOn({}), false);
    assert.equal(flagIsOn({enabled: false}), false);
    assert.equal(flagIsOn(true), true);
    assert.equal(flagIsOn({enabled: true}), true);
  });

  it("gates all three forecast writers on the server switch", () => {
    for (const name of ["syncStadiumSurgeSheet.ts", "attachCategoryForecasts.ts", "recordForecastHistory.ts"]) {
      const source = readFileSync(join(__dirname, "../src/surge", name), "utf8");
      assert.equal(source.includes("plannerSummariesEnabled"), true, name);
      assert.equal(source.includes("summariesEnabled: await plannerSummariesEnabled"), true, name);
    }
  });
});

describe("plannerSummariesEnabled", () => {
  it("is on only when both switches are on", async () => {
    const docs = new Map<string, Record<string, unknown> | undefined>([
      ["config/flags", undefined],
      ["config/plannerSummaries", undefined],
    ]);
    const db = {
      doc(path: string) {
        return {
          async get() {
            const data = docs.get(path);
            return {get: (key: string) => data?.[key]};
          },
        };
      },
    } as unknown as Firestore;
    assert.equal(await plannerSummariesEnabled(db), false);
    docs.set("config/flags", {plannerSummaries: true});
    assert.equal(await plannerSummariesEnabled(db), false);
    docs.set("config/plannerSummaries", {enabled: true});
    assert.equal(await plannerSummariesEnabled(db), true);
    docs.set("config/flags", {});
    assert.equal(await plannerSummariesEnabled(db), false);
  });
});
