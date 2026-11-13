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

  it("drops forecast fields, and the pin windows only when a forecast is present", () => {
    const windowStart = Timestamp.fromDate(new Date("2099-11-13T15:00:00.000Z"));
    const withForecast = omitPinForecastFields({
      name: "Home Side v Away Side",
      window_start: windowStart,
      window_end: windowStart,
      removeBy: windowStart,
      expire_at: windowStart,
      events: {start_time: windowStart},
      pickupPoints: [{name: "North Gate", confidence: "high", confidencePercent: 80}],
      forecast: {state: "available", strength: "high", confidence: "medium", startAt: windowStart, endAt: windowStart},
      forecastHistory: {preEvent: {state: "available", strength: "high"}},
      forecastSource: "sheet_venue_history",
      forecastUpdatedAt: windowStart,
      surgeEnded: false,
    });
    for (const key of PIN_FORECAST_FIELDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(withForecast, key), false);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(withForecast, "window_start"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(withForecast, "window_end"), false);
    assert.equal(withForecast.name, "Home Side v Away Side");
    assert.equal(withForecast.removeBy, windowStart);
    assert.equal(withForecast.expire_at, windowStart);
    assert.deepEqual(withForecast.events, {start_time: windowStart});
    assert.deepEqual(withForecast.pickupPoints, [{name: "North Gate", confidence: "high", confidencePercent: 80}]);

    const withoutForecast = omitPinForecastFields({
      name: "Place only",
      window_start: windowStart,
      window_end: windowStart,
      removeBy: windowStart,
      forecastHistory: {preEvent: {state: "no_prediction"}},
      surgeEnded: true,
    });
    assert.equal(withoutForecast.window_start, windowStart);
    assert.equal(withoutForecast.window_end, windowStart);
    assert.equal(withoutForecast.removeBy, windowStart);
    assert.equal(Object.prototype.hasOwnProperty.call(withoutForecast, "forecastHistory"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(withoutForecast, "surgeEnded"), false);

    const cleared = omitPinForecastFields({
      window_start: windowStart,
      window_end: windowStart,
      forecast: null,
    });
    assert.equal(cleared.window_start, windowStart);
    assert.equal(cleared.window_end, windowStart);
    assert.equal(Object.prototype.hasOwnProperty.call(cleared, "forecast"), false);
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
