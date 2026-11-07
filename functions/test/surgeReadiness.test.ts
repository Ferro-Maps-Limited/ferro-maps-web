import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {assessIngestion, distanceMetres, matchHandCheck} from "../src/surge/readiness.js";
import type {ImportPlan} from "../src/surge/importSheet.js";

const EMPTY: Pick<ImportPlan, "outcome" | "rejects" | "writes" | "headerProblems"> = {
  outcome: "planned",
  rejects: [],
  writes: [],
  headerProblems: [],
};

describe("surge readiness", () => {
  it("holds every plan, including a clean one, and does not score or publish", () => {
    const ready = assessIngestion(EMPTY);
    assert.equal(ready.status, "held");
    assert.ok(ready.reasons.includes("live-ingestion-not-authorized"));
    assert.equal(ready.scoring, "unknown");
    assert.equal(ready.scoringReason, "baseline-policy-unapproved");
    assert.equal(ready.matchingReason, "link-class-policy-unapproved");
    assert.equal(ready.publishing, "blocked");
    assert.equal(JSON.stringify(ready).includes("\"none\""), false);
  });

  it("names header, reject, and missing-point holds without calling them ready", () => {
    const assessed = assessIngestion({
      outcome: "headerFail",
      rejects: [{tab: "Events", row: 2, column: "Event ID", reason: "bad-id"}],
      writes: [{
        path: "surgeEvents/example/pickups/north",
        hash: "h",
        data: {flags: ["no-usable-point", "point-tie"]},
      }],
      headerProblems: [{
        tab: "Events",
        missing: ["Event ID"],
        duplicate: ["Ground"],
        unexpected: ["Mystery"],
      }],
    });
    assert.deepEqual(assessed.reasons, [
      "header-duplicate",
      "header-fail",
      "header-missing",
      "header-unexpected",
      "live-ingestion-not-authorized",
      "pickup-point-incomplete",
      "plan-rejected",
    ]);
  });

  it("reports overlap and distance facts while the link class stays held", () => {
    const pin = {lat: 51.5, lng: -0.12};
    const north = {id: "north", lat: 51.501, lng: -0.12};
    const south = {id: "south", lat: 51.5, lng: -0.12};
    const windowA = {start: new Date("2026-11-06T18:00:00Z"), end: new Date("2026-11-06T21:00:00Z")};
    const windowB = {start: new Date("2026-11-06T19:00:00Z"), end: new Date("2026-11-06T22:00:00Z")};
    const check = matchHandCheck({
      pinWindow: windowA,
      eventWindow: windowB,
      pin,
      candidateCount: 1,
      pickups: [south, north],
    });
    const flipped = matchHandCheck({
      pinWindow: windowA,
      eventWindow: windowB,
      pin,
      candidateCount: 1,
      pickups: [north, south],
    });
    assert.equal(check.held, true);
    assert.equal(check.linkClass, null);
    assert.equal(check.publishable, false);
    assert.equal(check.reason, "link-class-policy-unapproved");
    assert.equal(check.facts.windowsOverlap, true);
    assert.equal(check.facts.candidateCount, 1);
    assert.deepEqual(check.facts.distances, flipped.facts.distances);
    assert.equal(check.facts.distances[1].pickupId, "south");
    assert.equal(check.facts.distances[1].distanceM, 0);
    assert.equal(check.facts.distances[1].reason, null);
    assert.ok((check.facts.distances[0].distanceM ?? 0) > 0);
    assert.equal(Number.isInteger(check.facts.distances[0].distanceM), true);
    assert.deepEqual(distanceMetres(pin, south), {distanceM: 0, reason: null});
  });

  it("keeps a genuine non-overlap distinct from an invalid window", () => {
    const apart = matchHandCheck({
      pinWindow: {start: new Date("2026-11-06T18:00:00Z"), end: new Date("2026-11-06T19:00:00Z")},
      eventWindow: {start: new Date("2026-11-06T20:00:00Z"), end: new Date("2026-11-06T21:00:00Z")},
      pin: {lat: 51.5, lng: -0.12},
      candidateCount: 1,
      pickups: [],
    });
    assert.equal(apart.facts.windowsOverlap, false);
    assert.equal(apart.facts.windowReason, null);
    assert.equal(apart.linkClass, null);
  });

  it("reports every non-finite timestamp endpoint as an invalid window", () => {
    const pinWindow = {start: new Date("2026-11-06T18:00:00Z"), end: new Date("2026-11-06T21:00:00Z")};
    const eventWindow = {start: new Date("2026-11-06T19:00:00Z"), end: new Date("2026-11-06T22:00:00Z")};
    const badTimes = [new Date("nope"), new Date(Infinity), new Date(NaN)];
    const slots = [
      ["pin", "start"],
      ["pin", "end"],
      ["event", "start"],
      ["event", "end"],
    ] as const;
    for (const bad of badTimes) {
      for (const [side, end] of slots) {
        const pin = side === "pin" ? {...pinWindow, [end]: bad} : pinWindow;
        const event = side === "event" ? {...eventWindow, [end]: bad} : eventWindow;
        const check = matchHandCheck({
          pinWindow: pin,
          eventWindow: event,
          pin: {lat: 51.5, lng: -0.12},
          candidateCount: 1,
          pickups: [],
        });
        assert.equal(check.facts.windowsOverlap, null, `${side} ${end}`);
        assert.equal(check.facts.windowReason, "windows-invalid", `${side} ${end}`);
      }
    }
    const bothEnds = matchHandCheck({
      pinWindow: {start: new Date("nope"), end: new Date(Infinity)},
      eventWindow,
      pin: {lat: 51.5, lng: -0.12},
      candidateCount: 1,
      pickups: [],
    });
    const bothWindows = matchHandCheck({
      pinWindow: {start: new Date("nope"), end: new Date("nope")},
      eventWindow: {start: new Date(Infinity), end: new Date(NaN)},
      pin: {lat: 51.5, lng: -0.12},
      candidateCount: 1,
      pickups: [],
    });
    assert.equal(bothEnds.facts.windowsOverlap, null);
    assert.equal(bothEnds.facts.windowReason, "windows-invalid");
    assert.equal(bothWindows.facts.windowsOverlap, null);
    assert.equal(bothWindows.facts.windowReason, "windows-invalid");
  });

  it("holds missing windows, a bad candidate count, and invalid or duplicate points", () => {
    const missing = matchHandCheck({
      pinWindow: null,
      eventWindow: null,
      pin: null,
      candidateCount: undefined,
      pickups: [{id: "north", lat: 10, lng: 0}, {id: "north", lat: 51.5, lng: -0.12}],
    });
    assert.equal(missing.facts.windowsOverlap, null);
    assert.equal(missing.facts.windowReason, "windows-missing");
    assert.equal(missing.facts.candidateReason, "candidate-count-missing");
    assert.deepEqual(missing.facts.distances.map((row) => row.reason), ["duplicate-pickup", "duplicate-pickup"]);
    const invalid = matchHandCheck({
      pinWindow: {start: new Date("2026-11-06T21:00:00Z"), end: new Date("2026-11-06T18:00:00Z")},
      eventWindow: {start: new Date("2026-11-06T18:00:00Z"), end: new Date("2026-11-06T21:00:00Z")},
      pin: {lat: 51.5, lng: -0.12},
      candidateCount: 0,
      pickups: [{id: "north", lat: null, lng: null}],
    });
    assert.equal(invalid.facts.windowsOverlap, null);
    assert.equal(invalid.facts.windowReason, "windows-invalid");
    assert.equal(invalid.facts.candidateReason, "candidate-count-invalid");
    assert.equal(invalid.facts.distances[0].reason, "invalid-point");
    assert.equal(invalid.facts.distances[0].distanceM, null);
    assert.equal(invalid.linkClass, null);
  });

  it("does not measure a non-finite or out-of-bounds coordinate", () => {
    const uk = {lat: 51.5, lng: -0.12};
    const probes = [
      {lat: Number.NaN, lng: -0.12},
      {lat: 51.5, lng: Number.NaN},
      {lat: Number.POSITIVE_INFINITY, lng: -0.12},
      {lat: 51.5, lng: Number.NEGATIVE_INFINITY},
      {lat: 10, lng: 0},
      {lat: 51.5, lng: 20},
    ];
    for (const probe of probes) {
      for (const measured of [distanceMetres(probe, uk), distanceMetres(uk, probe)]) {
        assert.deepEqual(measured, {distanceM: null, reason: "invalid-point"});
        assert.equal(Object.is(measured.distanceM, Number.NaN), false);
      }
      const check = matchHandCheck({
        pinWindow: {start: new Date("2026-11-06T18:00:00Z"), end: new Date("2026-11-06T21:00:00Z")},
        eventWindow: {start: new Date("2026-11-06T19:00:00Z"), end: new Date("2026-11-06T22:00:00Z")},
        pin: probe,
        candidateCount: 1,
        pickups: [{id: "north", lat: uk.lat, lng: uk.lng}],
      });
      assert.equal(check.facts.windowsOverlap, true);
      assert.deepEqual(check.facts.distances, [{pickupId: "north", distanceM: null, reason: "invalid-point"}]);
    }
    const pickup = matchHandCheck({
      pinWindow: {start: new Date("2026-11-06T18:00:00Z"), end: new Date("2026-11-06T21:00:00Z")},
      eventWindow: {start: new Date("2026-11-06T19:00:00Z"), end: new Date("2026-11-06T22:00:00Z")},
      pin: uk,
      candidateCount: 1,
      pickups: [{id: "north", lat: Number.NaN, lng: -0.12}],
    });
    assert.deepEqual(pickup.facts.distances, [{pickupId: "north", distanceM: null, reason: "invalid-point"}]);
  });
});
