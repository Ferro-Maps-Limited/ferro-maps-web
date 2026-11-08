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
    const checker = readFileSync(join(process.cwd(), "src/ukRestrictions/readiness.ts"), "utf8");
    for (const name of ["ukRestrictions", "assessQuery", "assessSource"]) {
      assert.equal(sourceText.includes(name), false, name);
      assert.equal(built.includes(name), false, name);
    }
    assert.equal(checker.includes("Date.parse"), false);
  });

  it("rejects ambiguous, zoneless, and impossible dates without throwing", () => {
    const slash = assessSource(source({
      legalStatus: "in-force",
      legalEvidence: "synthetic instrument",
      effectiveFrom: "08/11/2026",
    }), "2026-08-15T00:00:00.000Z");
    neverAllowed(slash);
    assert.ok(slash.reasons.includes("malformed-date"));
    assert.equal(slash.reasons.includes("future-not-active"), false);
    for (const effectiveFrom of [
      "11/08/2026",
      "2026-02-31T00:00:00.000Z",
      "2026-02-29T00:00:00.000Z",
      "1900-02-29T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-11-08T25:00:00.000Z",
      "2026-11-08T12:00:00",
      "2026-11-08 12:00:00.000Z",
      "2026-11-08T12:00:00.000z",
      "2026-11-08T12:00:00.000+24:00",
    ]) {
      const bad = assessSource(source({effectiveFrom}), AS_OF);
      neverAllowed(bad);
      assert.ok(bad.reasons.includes("malformed-date"), effectiveFrom);
    }
    const leap = assessSource(source({effectiveFrom: "2024-02-29T00:00:00.000Z"}), AS_OF);
    assert.equal(leap.reasons.includes("malformed-date"), false);
    const century = assessSource(source({effectiveFrom: "2000-02-29T12:00:00.000+00:00"}), AS_OF);
    assert.equal(century.reasons.includes("malformed-date"), false);
  });

  it("compares offsets as instants and does not treat a later civil clock as earlier", () => {
    const same = assessSource(source({
      legalStatus: "in-force",
      legalEvidence: "synthetic instrument",
      effectiveFrom: "2026-11-08T13:00:00.000+01:00",
    }), AS_OF);
    assert.equal(same.reasons.includes("malformed-date"), false);
    assert.equal(same.reasons.includes("future-not-active"), false);
    const later = assessSource(source({
      legalStatus: "in-force",
      legalEvidence: "synthetic instrument",
      effectiveFrom: "2026-11-08T13:00:01.000+01:00",
    }), AS_OF);
    neverAllowed(later);
    assert.ok(later.reasons.includes("future-not-active"));
    const backwards = assessSource(source({
      effectiveFrom: "2026-11-09T00:00:00.000Z",
      effectiveUntil: "2026-11-08T00:00:00.000Z",
    }), AS_OF);
    assert.ok(backwards.reasons.includes("malformed-date"));
  });

  it("rejects malformed types, nulls, and duplicates without throwing", () => {
    const badTypes = [null, undefined, 4, {length: 1}, "waiting", ["waiting", 1], ["", "waiting"]];
    for (const restrictionTypes of badTypes) {
      const value = assert.doesNotThrow(() => assessSource(source({
        restrictionTypes: restrictionTypes as unknown as string[],
      }), AS_OF));
      assert.equal(value, undefined);
      const row = assessSource(source({restrictionTypes: restrictionTypes as unknown as string[]}), AS_OF);
      neverAllowed(row);
      assert.ok(row.reasons.includes("malformed"), JSON.stringify(restrictionTypes));
      assert.ok(row.reasons.length > 0);
    }
    const duplicates = assessSource(source({restrictionTypes: ["waiting", "waiting"]}), AS_OF);
    neverAllowed(duplicates);
    assert.ok(duplicates.reasons.includes("duplicate-restriction-type"));
    const calls = [null, undefined, {}, [], "nope", 1, {conflictsWith: null, restrictionTypes: null}];
    for (const input of calls) {
      assert.doesNotThrow(() => assessSource(input, "08/11/2026"));
      assert.doesNotThrow(() => assessQuery(input, new Date(AS_OF)));
      const row = assessSource(input, AS_OF);
      const query = assessQuery(input, AS_OF);
      neverAllowed(row);
      neverAllowed(query);
      assert.ok(row.reasons.includes("policy-unapproved"));
      assert.ok(row.reasons.includes("runtime-disabled"));
      assert.ok(query.reasons.includes("policy-unapproved"));
      assert.ok(query.reasons.includes("runtime-disabled"));
      assert.ok(query.reasons.includes("authority-coverage-unreviewed"));
    }
  });

  it("does not treat four invalid names or four sample rows as national coverage", () => {
    const unknown = assessQuery(["britain", "uk", "ireland", "channel-islands"].map((nation, index) => {
      return source({sourceId: `unknown-${index}`, nation: nation as SourceRecord["nation"]});
    }), AS_OF);
    neverAllowed(unknown);
    assert.ok(unknown.reasons.includes("nation-unknown"));
    assert.ok(unknown.reasons.includes("coverage-incomplete"));
    assert.ok(unknown.reasons.includes("authority-coverage-unreviewed"));

    const unscoped = assessQuery(["england", "wales", "scotland", "northern-ireland"].map((nation, index) => {
      return source({sourceId: `scope-${index}`, nation: nation as SourceRecord["nation"], roadOwner: "unknown"});
    }), AS_OF);
    neverAllowed(unscoped);
    assert.ok(unscoped.reasons.includes("coverage-incomplete"));

    const samples = assessQuery(["england", "wales", "scotland", "northern-ireland"].map((nation, index) => {
      return source({
        sourceId: `sample-${index}`,
        nation: nation as SourceRecord["nation"],
        licenceVerified: true,
        schemaVerified: true,
        geometryVerified: true,
        freshnessPolicy: "reviewed",
        freshnessObservation: "unknown",
        legalStatus: "in-force",
        legalEvidence: "synthetic instrument",
        coverageEvidence: "one synthetic street",
        importHealth: "succeeded",
      });
    }), AS_OF);
    neverAllowed(samples);
    assert.deepEqual(samples.reasons, [
      "authority-coverage-unreviewed",
      "freshness-unknown",
      "policy-unapproved",
      "runtime-disabled",
    ]);
    assert.equal(samples.reasons.includes("coverage-incomplete"), false);

    const repeated = assessQuery([
      source({sourceId: "same", nation: "england"}),
      source({sourceId: "same", nation: "england"}),
    ], AS_OF);
    neverAllowed(repeated);
    assert.ok(repeated.reasons.includes("duplicate-source"));
    assert.ok(repeated.reasons.includes("coverage-incomplete"));
  });

  it("keeps years 0000–0099 and checks the clock on an empty query", () => {
    const order = (effectiveFrom: string, asOf: string) => assessSource(source({
      legalStatus: "in-force",
      legalEvidence: "synthetic instrument",
      effectiveFrom,
    }), asOf);
    const early = order("0099-01-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z");
    neverAllowed(early);
    assert.equal(early.reasons.includes("malformed-date"), false);
    assert.equal(early.reasons.includes("future-not-active"), false);
    const later = order("0100-01-01T00:00:00.000Z", "0099-01-01T00:00:00.000Z");
    neverAllowed(later);
    assert.equal(later.reasons.includes("malformed-date"), false);
    assert.ok(later.reasons.includes("future-not-active"));
    const yearZero = order("0000-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z");
    assert.equal(yearZero.reasons.includes("malformed-date"), false);
    assert.equal(yearZero.reasons.includes("future-not-active"), false);
    const afterZero = order("0001-01-01T00:00:00.000Z", "0000-06-01T00:00:00.000Z");
    assert.ok(afterZero.reasons.includes("future-not-active"));
    assert.equal(afterZero.reasons.includes("malformed-date"), false);

    const sameInstant = order("0099-06-01T01:00:00.000+01:00", "0099-06-01T00:00:00.000Z");
    assert.equal(sameInstant.reasons.includes("malformed-date"), false);
    assert.equal(sameInstant.reasons.includes("future-not-active"), false);
    const oneSecond = order("0099-06-01T01:00:01.000+01:00", "0099-06-01T00:00:00.000Z");
    assert.ok(oneSecond.reasons.includes("future-not-active"));
    assert.equal(oneSecond.reasons.includes("malformed-date"), false);

    assert.equal(order("0000-02-29T00:00:00.000Z", "0001-01-01T00:00:00.000Z").reasons.includes("malformed-date"), false);
    assert.equal(order("0004-02-29T00:00:00.000Z", "0005-01-01T00:00:00.000Z").reasons.includes("malformed-date"), false);
    assert.ok(order("0100-02-29T00:00:00.000Z", "0101-01-01T00:00:00.000Z").reasons.includes("malformed-date"));
    assert.equal(
      order("0100-02-29T00:00:00.000Z", "0101-01-01T00:00:00.000Z").reasons.includes("future-not-active"),
      false,
    );

    const badClock = assessQuery(emptyRegistry(), "08/11/2026");
    neverAllowed(badClock);
    assert.ok(badClock.reasons.includes("no-results"));
    assert.ok(badClock.reasons.includes("no-sources"));
    assert.ok(badClock.reasons.includes("malformed-date"));
    assert.equal(badClock.reasons.includes("time-unknown"), false);
    assert.equal(badClock.reasons.includes("future-not-active"), false);
    const missingClock = assessQuery([], null);
    neverAllowed(missingClock);
    assert.ok(missingClock.reasons.includes("time-unknown"));
    assert.equal(missingClock.reasons.includes("malformed-date"), false);
    const goodClock = assessQuery([], AS_OF);
    assert.equal(goodClock.reasons.includes("malformed-date"), false);
    assert.equal(goodClock.reasons.includes("time-unknown"), false);
    const shaped = assessQuery(null, "not-a-clock");
    assert.ok(shaped.reasons.includes("malformed"));
    assert.ok(shaped.reasons.includes("malformed-date"));
    assert.equal(shaped.reasons.includes("time-unknown"), false);
  });
});
