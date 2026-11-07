import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {retrospectiveScore, type RetroReading} from "../src/surge/rule.js";

const WINDOW = new Date("2026-07-15T20:50:00.000Z");
const STOP = new Date("2026-07-15T22:55:00.000Z");

function reading(
  minute: number,
  pricePence: number | null,
  phase: RetroReading["phase"] = "during",
  extra: Partial<RetroReading> = {},
): RetroReading {
  return {
    pickupId: "north-gate",
    product: "uberx",
    destination: "centre point",
    takenAt: new Date(WINDOW.getTime() + minute * 60 * 1000),
    phase,
    pricePence,
    ...extra,
  };
}

const EXAMPLE = {exampleOnly: true} as const;

describe("retrospective rule r1", () => {
  it("illustrates the made-up worked example as medium at 22:10, not as an approved score", () => {
    const result = retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [
        reading(-240, 1000, "baseline"),
        reading(0, 1150),
        reading(10, 1300),
        reading(20, 1600),
        reading(30, 1550),
        reading(40, 1040),
      ],
    }, EXAMPLE);
    assert.equal(result.score, "unknown");
    assert.equal(result.approved, false);
    assert.equal(result.reason, "example-only");
    assert.equal(result.illustrative?.score, "medium");
    assert.equal(result.illustrative?.goTo, "north-gate");
    assert.equal(result.illustrative?.peakAt?.toISOString(), "2026-07-15T21:10:00.000Z");
    assert.equal(result.illustrative?.tie, false);
  });

  it("does not turn an unknown group into a complete-event none", () => {
    const result = retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [
        reading(-60, 1000, "baseline"),
        reading(0, 1000),
        reading(10, 1000),
        reading(20, 1000),
        reading(-60, 1000, "baseline", {pickupId: "south-gate"}),
        reading(0, 1600, "during", {pickupId: "south-gate"}),
        reading(10, 1600, "during", {pickupId: "south-gate"}),
      ],
    }, EXAMPLE);
    assert.equal(result.score, "unknown");
    assert.equal(result.illustrative?.score, "unknown");
    assert.equal(result.illustrative?.goTo, null);
    assert.ok(result.illustrative?.groups.some((group) => group.score === "unknown"));
    assert.ok(result.illustrative?.groups.some((group) => group.score === "none"));
  });

  it("does not treat a 48-hour-old baseline as an approved event score", () => {
    const result = retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [
        reading(-48 * 60, 1000, "baseline"),
        reading(0, 1000),
        reading(10, 1000),
        reading(20, 1000),
      ],
    });
    assert.equal(result.score, "unknown");
    assert.equal(result.illustrative, null);
    assert.equal(result.reason, "baseline-policy-unapproved");
  });

  it("uses integer boundaries and does not break a run on a blank fare", () => {
    const at = (prices: Array<number | null>, baseline = 10000) => retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [
        reading(-60, baseline, "baseline"),
        ...prices.map((price, index) => reading(index * 10, price)),
      ],
    }, EXAMPLE).illustrative?.score;
    assert.equal(at([12000, 12000, 11000]), "low");
    assert.equal(at([15000, 15000, 11000]), "medium");
    assert.equal(at([20000, 20000, 11000]), "high");
    assert.equal(at([11999, 11999, 11000]), "none");
    assert.equal(at([12000, 11000, 11000]), "none");
    assert.equal(at([13000, null, 13000, 10000]), "low");
    assert.equal(at([13000, 13000]), "unknown");
  });

  it("fails closed on a zero baseline, a late baseline, a tie, and two top groups", () => {
    const zero = retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [reading(-60, 0, "baseline"), reading(0, 1300), reading(10, 1300), reading(20, 1300)],
    }, EXAMPLE);
    assert.equal(zero.illustrative?.score, "unknown");
    const late = retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [reading(5, 1000, "baseline"), reading(0, 1300), reading(10, 1300), reading(20, 1300)],
    }, EXAMPLE);
    assert.equal(late.illustrative?.score, "unknown");
    const tie = retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [
        reading(-60, 1000, "baseline"),
        reading(0, 1600),
        reading(10, 1600),
        reading(20, 1100),
      ],
    }, EXAMPLE);
    assert.equal(tie.score, "unknown");
    assert.equal(tie.illustrative?.score, "medium");
    assert.equal(tie.illustrative?.peakAt, null);
    assert.equal(tie.illustrative?.goTo, null);
    assert.equal(tie.illustrative?.tie, true);
    const two = retrospectiveScore({
      windowStart: WINDOW,
      hardStopAt: STOP,
      readings: [
        reading(-60, 1000, "baseline"),
        reading(0, 1300),
        reading(10, 1300),
        reading(20, 1100),
        reading(-60, 1000, "baseline", {pickupId: "south-gate"}),
        reading(0, 1300, "during", {pickupId: "south-gate"}),
        reading(10, 1300, "during", {pickupId: "south-gate"}),
        reading(20, 1100, "during", {pickupId: "south-gate"}),
      ],
    }, EXAMPLE);
    assert.equal(two.score, "unknown");
    assert.equal(two.illustrative?.score, "low");
    assert.equal(two.illustrative?.goTo, null);
    assert.equal(two.illustrative?.tie, true);
  });
});
