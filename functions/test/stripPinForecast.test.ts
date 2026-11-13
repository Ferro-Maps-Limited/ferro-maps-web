import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  PIN_FORECAST_FIELDS,
  flagIsOn,
  omitPinForecastFields,
} from "../src/surge/stripPinForecast";

describe("stripPinForecastFields flag", () => {
  it("is off unless the value is true or {enabled: true}", () => {
    for (const value of [undefined, null, false, 0, "true", "", {enabled: false}, {enabled: "true"}]) {
      assert.equal(flagIsOn(value), false);
    }
    assert.equal(flagIsOn(true), true);
    assert.equal(flagIsOn({enabled: true}), true);
  });

  it("drops only the forecast fields and leaves event times and pickup confidence", () => {
    const windowStart = Timestamp.fromDate(new Date("2099-11-13T15:00:00.000Z"));
    const kept = omitPinForecastFields({
      name: "Home Side v Away Side",
      window_start: windowStart,
      window_end: windowStart,
      removeBy: windowStart,
      expire_at: windowStart,
      pickupPoints: [{name: "North Gate", confidence: "high", confidencePercent: 80}],
      forecast: {state: "available", strength: "high", confidence: "medium", startAt: windowStart, endAt: windowStart},
      forecastHistory: {preEvent: {state: "available", strength: "high"}},
      forecastSource: "sheet_venue_history",
      forecastUpdatedAt: windowStart,
      surgeEnded: false,
    });
    for (const key of PIN_FORECAST_FIELDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(kept, key), false);
    }
    assert.equal(kept.name, "Home Side v Away Side");
    assert.equal(kept.window_start, windowStart);
    assert.equal(kept.window_end, windowStart);
    assert.equal(kept.removeBy, windowStart);
    assert.equal(kept.expire_at, windowStart);
    assert.deepEqual(kept.pickupPoints, [{name: "North Gate", confidence: "high", confidencePercent: 80}]);
  });

  it("is read by each forecast writer and passed into its pin commit", () => {
    for (const file of [
      "src/surge/syncStadiumSurgeSheet.ts",
      "src/surge/attachCategoryForecasts.ts",
      "src/surge/recordForecastHistory.ts",
    ]) {
      const source = readFileSync(join(__dirname, "..", file), "utf8");
      assert.match(source, /stripPinForecastFields:\s*await stripPinForecastFieldsEnabled\(db\)/);
    }
  });
});
