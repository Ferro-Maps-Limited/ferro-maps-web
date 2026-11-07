import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  BANNED_NAME_WORDS,
  buildSurgeForecastAlert,
  londonHHmm,
  usableName,
} from "../src/surge/forecastAlertText.js";

// 2026-07-15 is BST (UTC+1). 21:40-22:20 London = 20:40-21:20 UTC.
const BST_START = "2026-07-15T20:40:00.000Z";
const BST_END = "2026-07-15T21:20:00.000Z";
// 2026-10-26 is GMT (UTC+0), the day after the clocks went back.
const GMT_START = "2026-10-26T21:40:00.000Z";
const GMT_END = "2026-10-26T22:20:00.000Z";

function title(name: string | undefined): string {
  return buildSurgeForecastAlert({name, startAt: BST_START, endAt: BST_END}).title;
}

describe("surge_forecast alert text (§11.1)", () => {
  it("matches the contract example", () => {
    const out = buildSurgeForecastAlert({name: "Oxford Circus", startAt: BST_START, endAt: BST_END, peakBand: "high"});
    assert.deepEqual(out, {title: "Oxford Circus · likely surge 21:40–22:20", body: "High"});
  });

  it("uses space U+00B7 space and an unspaced en dash U+2013", () => {
    const t = title("Oxford Circus");
    assert.ok(t.includes(" \u00B7 "));
    assert.ok(t.includes("21:40\u201322:20"));
    assert.ok(!t.includes("-"));
    assert.ok(!t.includes("\u2014"));
  });

  it("trims the name", () => {
    assert.equal(title("  Wembley Stadium \n"), "Wembley Stadium · likely surge 21:40–22:20");
  });

  it("collapses whitespace runs to one space before the length check", () => {
    assert.equal(title("Oxford   Circus"), "Oxford Circus · likely surge 21:40–22:20");
    assert.equal(title("Oxford\t\n Circus"), "Oxford Circus · likely surge 21:40–22:20");
    const spaced = `${"A".repeat(29)}    ${"B".repeat(28)}`; // 61 chars raw, 58 after collapsing
    assert.equal(spaced.length, 61);
    assert.equal(usableName(spaced), `${"A".repeat(29)} ${"B".repeat(28)}`);
    const sixtyAfter = `${"A".repeat(30)}   ${"B".repeat(29)}`; // 62 raw, 60 after
    assert.equal(usableName(sixtyAfter), `${"A".repeat(30)} ${"B".repeat(29)}`);
    const sixtyOneAfter = `${"A".repeat(30)}   ${"B".repeat(30)}`; // 63 raw, 61 after
    assert.equal(usableName(sixtyOneAfter), undefined);
  });

  it("falls back when the name is missing, blank or whitespace", () => {
    for (const name of [undefined, "", "   ", "\t\n"]) {
      assert.equal(title(name), "Likely surge 21:40–22:20");
    }
    assert.equal(buildSurgeForecastAlert({name: null, startAt: BST_START, endAt: BST_END}).title,
      "Likely surge 21:40–22:20");
  });

  it("keeps a 60-character name and drops a 61-character one without shortening", () => {
    const sixty = "A".repeat(60);
    const sixtyOne = "A".repeat(61);
    assert.equal(title(sixty), `${sixty} · likely surge 21:40–22:20`);
    assert.equal(title(` ${sixty} `), `${sixty} · likely surge 21:40–22:20`);
    assert.equal(title(sixtyOne), "Likely surge 21:40–22:20");
    assert.ok(!title(sixtyOne).includes("A"));
  });

  it("drops a name with a currency symbol", () => {
    for (const name of ["£ Arena", "Club $", "Halle €", "Yen ¥ Hall", "Rupee ₹ Ground"]) {
      assert.equal(usableName(name), undefined, name);
      assert.equal(title(name), "Likely surge 21:40–22:20");
    }
  });

  it("drops a name with a money amount", () => {
    for (const name of ["5p off", "Pay 50 p", "GBP 10", "Tickets 12.50", "10 pounds entry", "pence night"]) {
      assert.equal(usableName(name), undefined, name);
    }
  });

  it("drops a name with a banned word, any case, whole words only", () => {
    for (const word of BANNED_NAME_WORDS) {
      assert.equal(usableName(`Big ${word} night`), undefined, word);
      assert.equal(usableName(`Big ${word.toUpperCase()} night`), undefined, word);
    }
    assert.equal(usableName("Bolton Wanderers"), "Bolton Wanderers");
    assert.equal(usableName("Welfare Ground"), "Welfare Ground");
  });

  it("keeps ordinary names with digits", () => {
    assert.equal(usableName("O2 Arena"), "O2 Arena");
    assert.equal(usableName("Stadium 2"), "Stadium 2");
  });

  it("maps each band, any case, and omits the body otherwise", () => {
    const body = (peakBand?: string | null) =>
      buildSurgeForecastAlert({name: "X", startAt: BST_START, endAt: BST_END, peakBand}).body;
    assert.equal(body("low"), "Low");
    assert.equal(body("medium"), "Medium");
    assert.equal(body("high"), "High");
    assert.equal(body("HIGH"), "High");
    assert.equal(body(" Medium "), "Medium");
    for (const b of [undefined, null, "", "extreme", "3"]) {
      const out = buildSurgeForecastAlert({name: "X", startAt: BST_START, endAt: BST_END, peakBand: b});
      assert.equal(out.body, undefined);
      assert.ok(!("body" in out));
    }
  });

  it("formats London time in GMT and BST", () => {
    assert.equal(buildSurgeForecastAlert({startAt: GMT_START, endAt: GMT_END}).title, "Likely surge 21:40–22:20");
    assert.equal(buildSurgeForecastAlert({startAt: BST_START, endAt: BST_END}).title, "Likely surge 21:40–22:20");
    // Same UTC clock time reads one hour apart.
    assert.equal(londonHHmm("2026-07-15T12:00:00Z"), "13:00");
    assert.equal(londonHHmm("2026-10-26T12:00:00Z"), "12:00");
  });

  it("uses 24-hour time with leading zeros", () => {
    assert.equal(londonHHmm("2026-10-26T00:05:00Z"), "00:05");
    assert.equal(londonHHmm("2026-10-26T23:59:00Z"), "23:59");
    assert.equal(londonHHmm("2026-07-15T23:30:00Z"), "00:30");
  });

  it("accepts epoch ms, numeric strings, Dates and Timestamp-like values", () => {
    const ms = Date.parse(BST_START);
    const endMs = Date.parse(BST_END);
    const expected = "Likely surge 21:40–22:20";
    assert.equal(buildSurgeForecastAlert({startAt: ms, endAt: endMs}).title, expected);
    assert.equal(buildSurgeForecastAlert({startAt: String(ms), endAt: String(endMs)}).title, expected);
    assert.equal(buildSurgeForecastAlert({startAt: new Date(ms), endAt: new Date(endMs)}).title, expected);
    assert.equal(buildSurgeForecastAlert({startAt: {toMillis: () => ms}, endAt: {toMillis: () => endMs}}).title,
      expected);
  });

  it("throws on an invalid time", () => {
    assert.throws(() => buildSurgeForecastAlert({startAt: "not a date", endAt: BST_END}), RangeError);
  });

  it("never outputs distance, confidence, price or currency, and ignores area", () => {
    const input = {
      name: "Oxford Circus", startAt: BST_START, endAt: BST_END, peakBand: "high",
      area: "gcpvj", conf: 0.9, distanceKm: 1.2,
    };
    const out = buildSurgeForecastAlert(input);
    const text = `${out.title} ${out.body}`;
    assert.ok(!/gcpvj|0\.9|1\.2|km|mi\b|%|[£$€\p{Sc}]|conf/iu.test(text), text);
  });
});
