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
    assert.ok((check.facts.distances[0].distanceM ?? 0) > 0);
    assert.equal(distanceMetres(pin, south), 0);
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
    assert.equal(invalid.facts.windowReason, "windows-invalid");
    assert.equal(invalid.facts.candidateReason, "candidate-count-invalid");
    assert.equal(invalid.facts.distances[0].reason, "invalid-point");
    assert.equal(invalid.linkClass, null);
  });
});
