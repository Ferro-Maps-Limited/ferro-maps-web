import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  assessQuery,
  assessSource,
  emptyRegistry,
  type SourceRecord,
} from "../src/ukRestrictions/readiness.js";

const AS_OF = "2026-11-08T12:00:00.000Z";

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    sourceId: "synthetic-source",
    fixture: "synthetic",
    nation: "england",
    authorityId: "synthetic-authority",
    roadOwner: "local",
    place: "on-street",
    restrictionTypes: ["waiting"],
    claimedCoverage: "synthetic claim",
    coverageEvidence: null,
    licenceVerified: false,
    schemaVerified: false,
    geometryVerified: false,
    freshnessPolicy: "unreviewed",
    freshnessObservation: null,
    legalStatus: "unknown",
    legalEvidence: null,
    effectiveFrom: null,
    effectiveUntil: null,
    importHealth: "not-run",
    conflictsWith: [],
    enabled: false,
    ...overrides,
  };
}

function neverAllowed(value: {parkingAllowed: boolean; nationalComplete: boolean; verdict: string}): void {
  assert.equal(value.verdict, "not-ready");
  assert.equal(value.parkingAllowed, false);
  assert.equal(value.nationalComplete, false);
}

describe("UK restriction readiness", () => {
  it("treats an empty registry and a no-results query as not allowed", () => {
    assert.deepEqual(emptyRegistry(), []);
    const empty = assessQuery(emptyRegistry(), AS_OF);
    neverAllowed(empty);
    assert.ok(empty.reasons.includes("no-results"));
    assert.ok(empty.reasons.includes("no-sources"));
  });

  it("does not promote a successful import when coverage and licence are unverified", () => {
    const row = assessSource(source({importHealth: "succeeded", claimedCoverage: "all bays"}), AS_OF);
    neverAllowed(row);
    assert.ok(row.reasons.includes("coverage-not-promoted"));
    assert.ok(row.reasons.includes("claimed-coverage-unverified"));
    assert.ok(row.reasons.includes("licence-unverified"));
    assert.ok(row.reasons.includes("freshness-unreviewed"));
    assert.equal(row.reasons.includes("stale"), false);
  });

  it("keeps a future order inactive and does not invent a freshness age", () => {
    const future = assessSource(source({
      sourceId: "synthetic-future-order",
      legalStatus: "future",
      effectiveFrom: "2026-11-26T00:00:00.000Z",
      legalEvidence: "synthetic commencement date",
    }), AS_OF);
    neverAllowed(future);
    assert.ok(future.reasons.includes("future-not-active"));
    const old = assessSource(source({
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      freshnessPolicy: "unreviewed",
      freshnessObservation: "stale",
    }), AS_OF);
    assert.equal(old.reasons.includes("stale"), false);
    assert.ok(old.reasons.includes("freshness-unreviewed"));
    const reviewedStale = assessSource(source({
      freshnessPolicy: "reviewed",
      freshnessObservation: "stale",
    }), AS_OF);
    neverAllowed(reviewedStale);
    assert.ok(reviewedStale.reasons.includes("stale"));
  });

  it("requires evidence before expired, amended, or revoked status means anything", () => {
    for (const legalStatus of ["expired", "amended", "revoked"] as const) {
      const missing = assessSource(source({legalStatus}), AS_OF);
      neverAllowed(missing);
      assert.ok(missing.reasons.includes("applicability-evidence-missing"), legalStatus);
    }
    const shown = assessSource(source({
      legalStatus: "revoked",
      legalEvidence: "synthetic revocation instrument",
    }), AS_OF);
    neverAllowed(shown);
    assert.ok(shown.reasons.includes("revoked"));
  });

  it("keeps mixed nations incomplete and reports conflict and malformed input", () => {
    const mixed = assessQuery([
      source({sourceId: "synthetic-england", importHealth: "succeeded", coverageEvidence: "one street"}),
      source({
        sourceId: "synthetic-scotland",
        nation: "scotland",
        importHealth: "succeeded",
        coverageEvidence: null,
        conflictsWith: ["synthetic-england"],
      }),
    ], AS_OF);
    neverAllowed(mixed);
    assert.ok(mixed.reasons.includes("coverage-incomplete"));
    assert.ok(mixed.reasons.includes("mixed-coverage-not-promoted"));
    assert.ok(mixed.reasons.includes("conflict"));
    const bad = assessSource(source({
      sourceId: "",
      nation: null,
      authorityId: null,
      effectiveFrom: "not-a-date",
    }), "also-not-a-date");
    neverAllowed(bad);
    assert.ok(bad.reasons.includes("malformed"));
    assert.ok(bad.reasons.includes("malformed-date"));
    assert.ok(bad.reasons.includes("nation-unknown"));
  });

  it("refuses an enabled feed and a time with no clock", () => {
    const enabled = assessSource(source({enabled: true, fixture: "candidate"}), null);
    neverAllowed(enabled);
    assert.ok(enabled.reasons.includes("feed-not-approved"));
    assert.ok(enabled.reasons.includes("time-unknown"));
  });

  it("is not wired into the functions entrypoint", () => {
    const sourceText = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
    const built = readFileSync(join(process.cwd(), "lib/index.js"), "utf8");
    for (const name of ["ukRestrictions", "assessQuery", "assessSource"]) {
      assert.equal(sourceText.includes(name), false, name);
      assert.equal(built.includes(name), false, name);
    }
  });
});
