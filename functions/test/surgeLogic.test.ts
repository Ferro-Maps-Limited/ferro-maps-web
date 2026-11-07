import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {parseSheetTime} from "../src/surge/londonTime.js";
import {classifyLink, linkIsPublishable, windowsOverlap} from "../src/surge/match.js";
import {acceptReading, planReadings, readingBodyHash} from "../src/surge/plan.js";
import {publishedDocViolation} from "../src/surge/publishGuard.js";
import {readingId} from "../src/surge/readingId.js";
import {
  forecastWindowOk,
  proposedBandForRise,
  proposedScoreEvent,
  rise,
  scoreEvent,
  windowState,
  type SurgeCheck,
} from "../src/surge/rule.js";
import {handleSurgeSync} from "../src/surge/syncOnce.js";

const START = new Date("2026-07-15T18:00:00.000Z");
const END = new Date("2026-07-15T21:00:00.000Z");

function proven(
  pickupId: string,
  minute: number,
  pricePence: number,
  baselinePence: number | null,
  extra: Partial<SurgeCheck> = {},
): SurgeCheck {
  return {
    pickupId,
    destinationId: "dest-1",
    product: "standard",
    takenAt: new Date(START.getTime() + minute * 60 * 1000),
    pricePence,
    baselinePence,
    baselineSource: "earlier-check",
    samePickup: true,
    sameDestination: true,
    sameProduct: true,
    ...extra,
  };
}

describe("surge sheet time", () => {
  it("reads a London wall clock in BST and in GMT", () => {
    assert.equal(parseSheetTime("2026-07-15 13:00")?.toISOString(), "2026-07-15T12:00:00.000Z");
    assert.equal(parseSheetTime("2026-10-26T12:00")?.toISOString(), "2026-10-26T12:00:00.000Z");
    assert.equal(parseSheetTime("2026-07-15 01:30")?.toISOString(), "2026-07-15T00:30:00.000Z");
  });

  it("keeps an explicit offset through the London fold and rejects ambiguous numbers", () => {
    assert.equal(parseSheetTime("2026-10-25T01:30:00+01:00")?.toISOString(), "2026-10-25T00:30:00.000Z");
    assert.equal(parseSheetTime("2026-10-25T01:30:00Z")?.toISOString(), "2026-10-25T01:30:00.000Z");
    assert.equal(parseSheetTime("2026-10-25 01:30"), null);
    assert.equal(parseSheetTime("2026-03-29 01:30"), null);
    assert.equal(parseSheetTime(46320), null);
    assert.equal(parseSheetTime(Date.parse("2026-07-15T12:00:00Z")), null);
    assert.equal(parseSheetTime("25/10/2026 21:40"), null);
  });
});

describe("operational surge score (held)", () => {
  it("does not turn a copied or unproven baseline into no", () => {
    const checks = [
      proven( "north", 0, 1000, 1000, {baselineSource: "copied-current"}),
      proven("north", 30, 1000, 1000, {baselineSource: "copied-current"}),
      proven("north", 60, 1000, 0, {baselineSource: "unproven", sameProduct: false}),
    ];
    assert.equal(scoreEvent({windowStart: START, windowEnd: END, checks}), "unknown");
    assert.equal(proposedScoreEvent({windowStart: START, windowEnd: END, checks}), "unknown");
  });

  it("stays unknown even when a like-for-like illustration would band", () => {
    const checks = [
      proven("north", 0, 1300, 1000),
      proven("north", 30, 1250, 1000),
      proven("north", 60, 1100, 1000),
    ];
    assert.equal(scoreEvent({windowStart: START, windowEnd: END, checks}), "unknown");
  });
});

describe("proposed surge math (not approved)", () => {
  it("illustrates the unapproved band boundaries", () => {
    assert.equal(rise(1200, 1000), 0.2);
    assert.equal(proposedBandForRise(0.2), "low");
    assert.equal(proposedBandForRise(0.49), "low");
    assert.equal(proposedBandForRise(0.5), "medium");
    assert.equal(proposedBandForRise(0.99), "medium");
    assert.equal(proposedBandForRise(1), "high");
    assert.equal(proposedBandForRise(0.19), "no");
    assert.equal(rise(100, 0), null);
  });

  it("illustrates adjacent rises only for a proven like-for-like series", () => {
    const scored = proposedScoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [
        proven("north", 0, 1300, 1000),
        proven("north", 30, 1250, 1000),
        proven("north", 60, 1100, 1000),
      ],
    });
    assert.equal(scored, "low");
    const split = proposedScoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [
        proven("north", 0, 1300, 1000),
        proven("north", 30, 1000, 1000),
        proven("north", 60, 1400, 1000),
      ],
    });
    assert.equal(split, "no");
    const short = proposedScoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [proven("north", 0, 1300, 1000), proven("north", 30, 1300, 1000)],
    });
    assert.equal(short, "unknown");
    const separated = proposedScoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [
        proven("north", 0, 1300, 1000, {product: "other"}),
        proven("north", 10, 1300, 1000),
        proven("north", 40, 1000, 1000, {product: "other"}),
      ],
    });
    assert.equal(separated, "no");
  });

  it("does not mix the illustration with a window outside the checks", () => {
    const scored = proposedScoreEvent({
      windowStart: START,
      windowEnd: END,
      checks: [
        proven("north", -120, 5000, 1000),
        proven("north", 0, 1000, 1000),
        proven("north", 30, 1000, 1000),
        proven("north", 60, 1000, 1000),
      ],
    });
    assert.equal(scored, "no");
    assert.equal(windowState(new Date("2026-07-15T22:00:00.000Z"), END), "finished");
    assert.equal(windowState(new Date("2026-07-15T20:00:00.000Z"), END), "open");
    assert.equal(forecastWindowOk(START, new Date(START.getTime() + 6 * 60 * 60 * 1000)), true);
    assert.equal(forecastWindowOk(START, new Date(START.getTime() + 6 * 60 * 60 * 1000 + 1)), false);
  });
});

describe("surge matching", () => {
  const pinNight = {start: new Date("2026-11-06T18:00:00.000Z"), end: new Date("2026-11-06T21:00:00.000Z")};
  const otherNight = {start: new Date("2026-10-23T18:00:00.000Z"), end: new Date("2026-10-23T21:00:00.000Z")};
  const sameNight = {start: new Date("2026-11-06T19:00:00.000Z"), end: new Date("2026-11-06T22:00:00.000Z")};

  it("does not treat a different night or a near pickup as the same occurrence", () => {
    assert.equal(windowsOverlap(pinNight, otherNight), false);
    const wrongNight = classifyLink({
      pinWindow: pinNight,
      eventWindow: otherNight,
      candidateCount: 1,
      pickups: [{kind: "entrance", distanceM: 40, sameKind: true}],
    });
    assert.equal(wrongNight.linkClass, "none");
    assert.equal(wrongNight.publishable, false);
    const nearOnly = classifyLink({
      pinWindow: null,
      eventWindow: sameNight,
      candidateCount: 1,
      pickups: [{kind: "entrance", distanceM: 40, sameKind: true}],
    });
    assert.equal(nearOnly.linkClass, "none");
    assert.equal(nearOnly.publishable, false);
  });

  it("holds an undefined candidate count and a wrong-kind 150m pickup", () => {
    const missingCount = classifyLink({
      pinWindow: pinNight,
      eventWindow: sameNight,
      candidateCount: undefined,
      pickups: [{kind: "entrance", distanceM: 80, sameKind: true}],
    });
    assert.equal(missingCount.linkClass, null);
    assert.equal(missingCount.held, true);
    assert.equal(missingCount.publishable, false);
    const wrongKind = classifyLink({
      pinWindow: pinNight,
      eventWindow: sameNight,
      candidateCount: 1,
      pickups: [{kind: "station", distanceM: 150, sameKind: false}],
    });
    assert.equal(wrongKind.publishable, false);
    assert.notEqual(wrongKind.linkClass, "venue");
    assert.equal(linkIsPublishable("venue"), false);
    assert.equal(linkIsPublishable("confirmed"), false);
  });
});

describe("surge readings", () => {
  function sample(pricePence: number) {
    const accepted = acceptReading({
      eventId: "evt-1",
      pickupName: "North gate",
      takenAt: "2026-07-15T18:00:00Z",
      phase: "during",
      product: "standard",
      pricePence,
      baselinePence: 1000,
      waitMin: 4,
      busyShown: null,
      raw: "synthetic row",
    });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) throw new Error("fixture");
    return accepted.value;
  }

  it("hashes identity fields and reports a changed price instead of keeping either copy", () => {
    const takenAt = new Date("2026-07-15T18:00:00.000Z");
    const first = readingId({eventId: "evt-1", pickupName: "North, gate", takenAt, product: "standard"});
    const second = readingId({eventId: "evt-1", pickupName: "North, gate", takenAt, product: "standard"});
    const other = readingId({eventId: "evt-1", pickupName: "North", takenAt, product: ", gate"});
    assert.equal(first, second);
    assert.notEqual(first, other);
    const low = sample(1000);
    const high = sample(1250);
    const conflict = planReadings({readings: [low, high], existingHashes: new Map()});
    assert.equal(conflict.writes.length, 0);
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0].reason, "payload-differs");
    assert.equal(JSON.stringify(conflict.conflicts).includes("1250"), false);
    const stored = planReadings({readings: [low], existingHashes: new Map()});
    const again = planReadings({
      readings: [high],
      existingHashes: new Map([[stored.writes[0].id, readingBodyHash(stored.writes[0].data)]]),
    });
    assert.equal(again.writes.length, 0);
    assert.equal(again.conflicts.length, 1);
    const same = planReadings({
      readings: [low],
      existingHashes: new Map([[stored.writes[0].id, readingBodyHash(stored.writes[0].data)]]),
    });
    assert.equal(same.writes.length, 0);
    assert.equal(same.unchanged, 1);
    assert.equal(same.conflicts.length, 0);
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

describe("published-doc helper (not a publish gate)", () => {
  it("rejects money-like keys, multiplier text, and a cycle", () => {
    assert.equal(publishedDocViolation({
      v: 1,
      peakBand: "high",
      pickups: [{id: "north", name: "North gate"}],
    }), null);
    assert.equal(publishedDocViolation({price_pence: 1000}), "banned-key:price_pence");
    assert.equal(publishedDocViolation({Fare: "x"}), "banned-key:Fare");
    assert.equal(publishedDocViolation({multiplier: 2}), "banned-key:multiplier");
    assert.equal(publishedDocViolation({note: "2x"}), "banned-text");
    assert.equal(publishedDocViolation({note: "20%"}), "banned-text");
    const cyclic: {name: string; self?: unknown} = {name: "North gate"};
    cyclic.self = cyclic;
    assert.equal(publishedDocViolation(cyclic), "cycle");
  });
});

describe("surge sync handler", () => {
  async function run(enabled: unknown) {
    let calls = 0;
    const result = await handleSurgeSync({
      enabled,
      columnMap: null,
      loadTab: async () => {
        calls += 1;
        return [["Column"], ["1999"]];
      },
    });
    return {result, calls};
  }

  it("does not load or write for missing, false, the string true, or true without a map", async () => {
    for (const enabled of [undefined, false, "true", true]) {
      const {result, calls} = await run(enabled);
      assert.equal(calls, 0);
      assert.deepEqual(result.writes, []);
      assert.equal(result.loadCalls, 0);
      assert.equal(result.status, enabled === true ? "column-map-missing" : "disabled");
      assert.equal(JSON.stringify(result).includes("1999"), false);
    }
  });
});

describe("compiled functions entrypoint", () => {
  it("does not export the surge sync or register its params", async () => {
    const builtIndex = join(__dirname, "..", "lib", "index.js");
    const source = readFileSync(builtIndex, "utf8");
    assert.equal(source.includes("syncSurgeSheet"), false);
    assert.equal(source.includes("SURGE_SHEET_ID"), false);
    assert.equal(source.includes("SURGE_SYNC_SERVICE_ACCOUNT"), false);
    assert.equal(source.includes("handleSurgeSync"), false);
    const mod = (await import(builtIndex)) as Record<string, unknown>;
    assert.equal("syncSurgeSheet" in mod, false);
    assert.ok(typeof mod.syncPrivateParkingSheet === "function");
  });
});
