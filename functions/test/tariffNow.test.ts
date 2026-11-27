import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  clockLabel,
  daysLabel,
  londonInstant,
  londonMoment,
  priceExtension,
  priceStay,
  tariffNow,
  upToLabel,
  type PricedStay,
  type PriceRefusal,
} from "../src/parking/tariffNow.js";
import type {PlaceRates} from "../src/parking/privateSheet/types.js";

interface Cases {
  rates: Record<string, PlaceRates>;
  now: Array<{name: string; rates: string; at: string; max?: number; expect: Record<string, unknown>}>;
  stay: Array<{
    name: string;
    rates: string;
    at: string;
    minutes: number;
    max?: number;
    expect: Record<string, unknown>;
  }>;
  extend: Array<{
    name: string;
    rates: string;
    at: string;
    max?: number;
    minutes: number;
    stay: {start: string; paidUntil: string; paidPence: number};
    expect: Record<string, unknown>;
  }>;
}

const cases = JSON.parse(readFileSync(join(__dirname, "fixtures", "tariff-now-cases.json"), "utf-8")) as Cases;
const ms = (iso: string): number => Date.parse(iso);
const iso = (value: number | null): string | null => value === null ? null : new Date(value).toISOString().replace(".000Z", "Z");

function checkPriced(result: PricedStay | PriceRefusal, expect: Record<string, unknown>): void {
  if (expect.refused !== undefined) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal((result as PriceRefusal).code, expect.refused);
    return;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  const priced = result as PricedStay;
  assert.equal(priced.pence, expect.pence);
  if (expect.minutes !== undefined) assert.equal(priced.minutes, expect.minutes);
  if (expect.label !== undefined) assert.equal(priced.label, expect.label);
}

describe("stepped prices: the shared cases", () => {
  for (const c of cases.now) {
    it(`now: ${c.name}`, () => {
      const got = tariffNow(cases.rates[c.rates], ms(c.at), c.max);
      assert.equal(got.state, c.expect.state, JSON.stringify(got));
      if (got.state === "charging") {
        if (c.expect.endsAt !== undefined) assert.equal(iso(got.endsAtMs), c.expect.endsAt);
        if (c.expect.options !== undefined) {
          assert.deepEqual(got.options.map((o) => [o.upTo, o.minutes, o.pence]), c.expect.options);
        }
      } else if (got.state === "unknown") {
        assert.equal(got.reason, c.expect.reason);
      } else if (c.expect.until !== undefined) {
        assert.equal(iso(got.untilMs), c.expect.until);
      }
    });
  }
  for (const c of cases.stay) {
    it(`stay: ${c.name}`, () => {
      checkPriced(priceStay(cases.rates[c.rates], ms(c.at), c.minutes, c.max), c.expect);
    });
  }
  for (const c of cases.extend) {
    it(`added time: ${c.name}`, () => {
      const stay = {startMs: ms(c.stay.start), paidUntilMs: ms(c.stay.paidUntil), paidPence: c.stay.paidPence};
      checkPriced(priceExtension(cases.rates[c.rates], ms(c.at), stay, c.minutes, c.max), c.expect);
    });
  }
});

describe("stepped prices: UK time", () => {
  it("reads the London clock across the clock changes", () => {
    assert.deepEqual(londonMoment(ms("2026-03-29T00:59:00Z")), {day: "2026-03-29", minute: 59});
    assert.deepEqual(londonMoment(ms("2026-03-29T01:00:00Z")), {day: "2026-03-29", minute: 120});
    assert.deepEqual(londonMoment(ms("2026-10-25T00:30:00Z")), {day: "2026-10-25", minute: 90});
    assert.deepEqual(londonMoment(ms("2026-10-25T01:30:00Z")), {day: "2026-10-25", minute: 90});
  });

  it("finds the instant for a London time, midnight and the skipped spring hour", () => {
    assert.equal(iso(londonInstant("2026-06-01", 480)), "2026-06-01T07:00:00Z");
    assert.equal(iso(londonInstant("2026-11-27", 1440)), "2026-11-28T00:00:00Z");
    assert.equal(iso(londonInstant("2026-03-29", 90)), "2026-03-29T01:00:00Z");
    // The repeated autumn hour: the first time the clock shows it.
    assert.equal(iso(londonInstant("2026-10-25", 90)), "2026-10-25T00:30:00Z");
  });

  it("names days, times and bands the way the desk shows them", () => {
    assert.equal(daysLabel(63), "Mon–Sat");
    assert.equal(daysLabel(31, 1), "Mon–Fri, bank holidays");
    assert.equal(daysLabel(96), "Sat, Sun");
    assert.equal(daysLabel(64 | 1), "Mon, Sun");
    assert.equal(daysLabel(0, 1), "bank holidays");
    assert.equal(daysLabel(127, 1), "every day incl. bank holidays");
    assert.equal(clockLabel(480), "8am");
    assert.equal(clockLabel(1110), "6:30pm");
    assert.equal(clockLabel(720), "noon");
    assert.equal(clockLabel(1440), "midnight");
    assert.equal(upToLabel(30), "Up to 30 min");
    assert.equal(upToLabel(60), "Up to 1 hour");
    assert.equal(upToLabel(90), "Up to 1 h 30 min");
    assert.equal(upToLabel(1440), "All day");
  });
});
