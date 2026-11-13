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
  plannerSummariesEnabled,
  summaryDecision,
  summaryPlace,
  summaryVenue,
} from "../src/surge/plannerSummaries";
import {PriceLeakError} from "../src/surge/priceGuard";

const HIDDEN = [
  "strength",
  "confidence",
  "confidencePercent",
  "window_start",
  "window_end",
  "removeBy",
  "forecast",
  "fare",
  "price",
  "baseline",
  "percent",
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

  it("stores the event start and the end of that UK day, and nothing hidden", () => {
    const data = buildPlannerSummary(pin());
    if (!data) throw new Error("expected a summary");
    assert.equal(data.hasForecast, true);
    assert.equal(data.name, "Home Side v -");
    assert.equal(data.venue, "The O2");
    assert.equal(data.place, "London");
    assert.equal((data.startAt as Timestamp).toMillis(), Date.parse("2026-07-15T14:00:00.000Z"));
    assert.notEqual((data.startAt as Timestamp).toMillis(), Date.parse("2026-07-15T16:00:00.000Z"));
    assert.equal((data.expireAt as Timestamp).toMillis(), Date.parse("2026-07-15T23:00:00.000Z"));
    assert.notEqual((data.expireAt as Timestamp).toMillis(), Date.parse("2026-07-15T19:00:00.000Z"));
    assert.equal(data.geohash, geohash(51.503, -0.003, 5));
    assert.equal(String(data.geohash).length, 5);
    for (const key of Object.keys(data)) assert.equal(HIDDEN.includes(key), false, key);
    assert.equal(JSON.stringify(data).includes("75"), false);
    assert.equal(JSON.stringify(data).includes("high"), false);
  });

  it("uses the pin name as the venue, and area when city is missing", () => {
    const named = pin({events: {start_time: Timestamp.fromDate(new Date("2026-01-15T15:00:00.000Z"))}});
    assert.equal(summaryVenue(named, "Home Side v -"), "Home Side v -");
    assert.equal(summaryPlace({area: "Ancoats"}), "Ancoats");
    assert.equal(summaryPlace({}), "");
    const data = buildPlannerSummary(named);
    if (!data) throw new Error("expected a summary");
    assert.equal(data.venue, "Home Side v -");
    assert.equal(Object.prototype.hasOwnProperty.call(data, "place"), true);
  });

  it("omits place when neither city nor area is stored", () => {
    const data = buildPlannerSummary(pin({city: "", area: "  "}));
    if (!data) throw new Error("expected a summary");
    assert.equal(Object.prototype.hasOwnProperty.call(data, "place"), false);
  });

  it("deletes a stale summary when an available forecast loses its start or location", () => {
    assert.equal(buildPlannerSummary(pin({events: {}})), null);
    assert.equal(buildPlannerSummary(pin({location: null})), null);
    assert.equal(summaryDecision(pin({events: {}})).op, "delete");
    assert.equal(summaryDecision(pin({location: null})).op, "delete");
    assert.equal(summaryDecision(pin({name: ""})).op, "none");
  });

  it("deletes on a clear and on no_prediction, and skips a pin with no forecast field", () => {
    assert.equal(summaryDecision(pin({forecast: null})).op, "delete");
    assert.equal(summaryDecision(pin({forecast: {state: "no_prediction"}})).op, "delete");
    const rest = pin();
    delete rest.forecast;
    assert.equal(summaryDecision(rest).op, "none");
  });

  it("refuses a price or a fare in the public name before the write", () => {
    assert.throws(() => buildPlannerSummary(pin({name: "Uber fare"})), (err: unknown) => err instanceof PriceLeakError);
    assert.throws(() => buildPlannerSummary(pin({events: {
      venue_name: "Price £12",
      start_time: Timestamp.fromDate(new Date("2026-01-15T15:00:00.000Z")),
    }})), (err: unknown) => err instanceof PriceLeakError);
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
