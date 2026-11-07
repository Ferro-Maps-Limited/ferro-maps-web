import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parseSheetTime} from "../src/surge/londonTime.js";
import {classifyLink, linkIsPublishable} from "../src/surge/match.js";
import {acceptReading, planReadings} from "../src/surge/plan.js";
import {publishedDocViolation} from "../src/surge/publishGuard.js";
import {readingId} from "../src/surge/readingId.js";
import {
  bandForRise,
  forecastWindowOk,
  rise,
  scoreEvent,
  windowState,
  type SurgeCheck,
} from "../src/surge/rule.js";
import {SURGE_TABS, syncSurgeOnce} from "../src/surge/syncOnce.js";

const START = new Date("2026-07-15T18:00:00.000Z");
const END = new Date("2026-07-15T21:00:00.000Z");

function check(pickupId: string, minute: number, pricePence: number, baselinePence: number | null): SurgeCheck {
  return {
    pickupId,
    takenAt: new Date(START.getTime() + minute * 60 * 1000),
    pricePence,
    baselinePence,
  };
}

describe("surge sheet time", () => {
  it("reads a London wall clock in BST and in GMT", () => {
    assert.equal(parseSheetTime("2026-07-15 13:00")?.toISOString(), "2026-07-15T12:00:00.000Z");
    assert.equal(parseSheetTime("2026-10-26T12:00")?.toISOString(), "2026-10-26T12:00:00.000Z");
  });

  it("keeps a zoned timestamp and rejects a clock-change fold", () => {
    assert.equal(parseSheetTime("2026-07-15T12:00:00Z")?.toISOString(), "2026-07-15T12:00:00.000Z");
    assert.equal(parseSheetTime("2026-07-15 01:30")?.toISOString(), "2026-07-15T00:30:00.000Z");
    assert.equal(parseSheetTime("2026-10-25 01:30"), null);
    assert.equal(parseSheetTime("2026-03-29 01:30"), null);
    assert.equal(parseSheetTime("25/10/2026 21:40"), null);
    assert.equal(parseSheetTime(""), null);
  });
});

describe("surge rule", () => {
  it("bands the rise at the contract boundaries", () => {
    assert.equal(rise(1200, 1000), 0.2);
    assert.equal(bandForRise(0.2), "low");
    assert.equal(bandForRise(0.49), "low");
    assert.equal(bandForRise(0.5), "medium");
    assert.equal(bandForRise(0.99), "medium");
    assert.equal(bandForRise(1), "high");
    assert.equal(bandForRise(0.19), "no");
    assert.equal(rise(100, 0), null);
  });

  it("needs two adjacent in-window rises and at least three checks", () => {
    const scored = scoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [check("north", 0, 1300, 1000), check("north", 30, 1250, 1000), check("north", 60, 1100, 1000)],
    });
    assert.equal(scored, "low");
    const split = scoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [check("north", 0, 1300, 1000), check("north", 30, 1000, 1000), check("north", 60, 1400, 1000)],
    });
    assert.equal(split, "no");
    const short = scoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [check("north", 0, 1300, 1000), check("north", 30, 1300, 1000)],
    });
    assert.equal(short, "unknown");
  });

  it("uses the highest pickup band and treats a missing baseline as unknown", () => {
    const scored = scoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [
        check("north", 0, 1300, 1000),
        check("north", 30, 1300, 1000),
        check("south", 10, 2500, 1000),
        check("south", 40, 2200, 1000),
      ],
    });
    assert.equal(scored, "high");
    const missing = scoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [check("north", 0, 1300, null), check("north", 30, 1300, 1000), check("north", 60, 1300, 1000)],
    });
    assert.equal(missing, "unknown");
    assert.notEqual(missing, "no");
  });

  it("ignores a check outside the window and a sheet status", () => {
    const before = check("north", -120, 5000, 1000);
    const scored = scoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [before, check("north", 0, 1000, 1000), check("north", 30, 1000, 1000), check("north", 60, 1000, 1000)],
    });
    assert.equal(scored, "no");
    assert.equal(windowState(new Date("2026-07-15T22:00:00.000Z"), END), "finished");
    assert.equal(windowState(new Date("2026-07-15T20:00:00.000Z"), END), "open");
    assert.equal(forecastWindowOk(START, new Date(START.getTime() + 6 * 60 * 60 * 1000)), true);
    assert.equal(forecastWindowOk(START, new Date(START.getTime() + 6 * 60 * 60 * 1000 + 1)), false);
  });
});

describe("surge matching", () => {
  const base = {
    occurrenceOverlap: true,
    identityMatch: true,
    contradicted: false,
    categoryMismatch: false,
    candidateCount: 1,
    airportWithoutCoordinates: false,
    pickups: [{kind: "entrance" as const, distanceM: 80, sameKind: true}],
  };

  it("publishes only confirmed and venue, in the contract order", () => {
    assert.equal(classifyLink(base), "confirmed");
    assert.equal(classifyLink({
      ...base,
      pickups: [{kind: "entrance", distanceM: 100, sameKind: true}],
    }), "confirmed");
    assert.equal(classifyLink({
      ...base,
      pickups: [{kind: "entrance", distanceM: 300, sameKind: false}],
    }), "venue");
    assert.equal(classifyLink({
      ...base,
      pickups: [{kind: "station", distanceM: 900, sameKind: false}],
    }), "eventOnly");
    assert.equal(linkIsPublishable("confirmed"), true);
    assert.equal(linkIsPublishable("venue"), true);
    assert.equal(linkIsPublishable("eventOnly"), false);
  });

  it("does not link another night, a review, or an airport without coordinates", () => {
    assert.equal(classifyLink({...base, occurrenceOverlap: false}), "review");
    assert.equal(classifyLink({...base, identityMatch: false, pickups: []}), "none");
    assert.equal(classifyLink({...base, candidateCount: 2}), "review");
    assert.equal(classifyLink({...base, categoryMismatch: true}), "review");
    assert.equal(classifyLink({...base, contradicted: true}), "none");
    assert.equal(classifyLink({...base, airportWithoutCoordinates: true}), "airportName");
    assert.equal(linkIsPublishable("airportName"), false);
  });
});

describe("surge readings", () => {
  it("hashes the same four fields to one id and does not write the second copy", () => {
    const takenAt = new Date("2026-07-15T18:00:00.000Z");
    const first = readingId({eventId: "evt-1", pickupName: "North, gate", takenAt, product: "standard"});
    const second = readingId({eventId: "evt-1", pickupName: "North, gate", takenAt, product: "standard"});
    const other = readingId({eventId: "evt-1", pickupName: "North", takenAt, product: ", gate"});
    assert.equal(first, second);
    assert.notEqual(first, other);
    const accepted = acceptReading({
      eventId: "evt-1",
      pickupName: "North gate",
      takenAt: "2026-07-15T18:00:00Z",
      phase: "during",
      product: "standard",
      pricePence: 1250,
      baselinePence: 1000,
      waitMin: 4,
      busyShown: null,
      raw: "synthetic row",
    });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    const planned = planReadings({readings: [accepted.value, accepted.value], existingIds: new Set()});
    assert.equal(planned.writes.length, 1);
    assert.equal(planned.unchanged, 1);
    const again = planReadings({readings: [accepted.value], existingIds: new Set([planned.writes[0].id])});
    assert.equal(again.writes.length, 0);
    assert.equal(again.unchanged, 1);
  });

  it("rejects a price that is not an integer and does not echo it", () => {
    const rejected = acceptReading({
      eventId: "evt-1",
      pickupName: "North gate",
      takenAt: "2026-07-15T18:00:00Z",
      phase: "during",
      product: "standard",
      pricePence: 12.5,
      baselinePence: 1000,
      waitMin: null,
      busyShown: null,
      raw: "synthetic",
    });
    assert.deepEqual(rejected, {ok: false, reason: "price"});
    assert.equal(JSON.stringify(rejected).includes("12.5"), false);
  });
});

describe("published surge docs", () => {
  it("rejects a price, a fare word, a currency sign and a percentage", () => {
    assert.equal(publishedDocViolation({
      v: 1,
      peakBand: "high",
      pickups: [{id: "north", name: "North gate", p: {lat: 51.5, lng: -0.12}}],
    }), null);
    assert.equal(publishedDocViolation({pricePence: 1000}), "banned-key:pricePence");
    assert.equal(publishedDocViolation({note: "likely fare"}), "banned-text");
    assert.equal(publishedDocViolation({note: "£"}), "banned-text");
    assert.equal(publishedDocViolation({note: "20%"}), "banned-text");
  });
});

describe("surge sync gate", () => {
  it("does not load a sheet when the switch is off or the id is blank", async () => {
    let calls = 0;
    const loadTab = async (): Promise<unknown[][]> => {
      calls += 1;
      return [["Event ID"]];
    };
    const disabled = await syncSurgeOnce({enabled: false, sheetId: "synthetic-sheet", loadTab});
    const missing = await syncSurgeOnce({enabled: true, sheetId: "  ", loadTab});
    assert.equal(disabled.status, "disabled");
    assert.equal(missing.status, "missing-params");
    assert.equal(calls, 0);
    assert.deepEqual(disabled.writes, []);
  });

  it("checks the four named tabs and stops before writing when columns are unnamed", async () => {
    const seen: string[] = [];
    const result = await syncSurgeOnce({
      enabled: true,
      sheetId: "synthetic-sheet",
      loadTab: async (_sheetId, tab) => {
        seen.push(tab);
        return [["Column"], ["1999"]];
      },
    });
    assert.deepEqual(seen, [...SURGE_TABS]);
    assert.equal(result.status, "aborted");
    assert.equal(result.abortReason, "column-map-missing");
    assert.deepEqual(result.writes, []);
    assert.equal(JSON.stringify(result).includes("1999"), false);
    assert.equal(JSON.stringify(result).includes("synthetic-sheet"), false);
  });

  it("aborts on a missing header without asking for a later tab", async () => {
    const seen: string[] = [];
    const result = await syncSurgeOnce({
      enabled: true,
      sheetId: "synthetic-sheet",
      loadTab: async (_sheetId, tab) => {
        seen.push(tab);
        return tab === "Events" ? [[""]] : [["Column"]];
      },
    });
    assert.deepEqual(seen, ["Events"]);
    assert.equal(result.abortReason, "header-missing");
    assert.deepEqual(result.writes, []);
  });
});
