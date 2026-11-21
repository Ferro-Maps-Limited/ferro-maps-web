import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  SURGE_REPORT_ERROR_TEXT,
  SURGE_REPORT_WINDOW_MS,
  decideSurgeReport,
  surgeReportsOn,
  validReport,
  type SurgeReportInput,
} from "../src/surge/onSurgeReport";

const AT = Date.parse("2026-11-21T18:00:00.000Z");

function report(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    uid: "ada",
    pinId: "fp_pubs-the-swan-stockwell-london",
    answer: "yes",
    reportedAt: Timestamp.fromMillis(AT),
    platform: "ios",
    appVersion: "1.3.1 (73)",
    status: "pending",
    createdAt: Timestamp.fromMillis(AT),
    ...extra,
  };
}

function input(extra: Partial<SurgeReportInput> = {}): SurgeReportInput {
  return {
    report: report(),
    flags: {surgeReports: {enabled: true, ios: true, android: false}},
    pinCategory: "pub",
    doneReportedAtMs: [],
    ...extra,
  };
}

describe("surge report trigger", () => {
  it("stores each answer the driver can tap", () => {
    for (const answer of ["yes", "no", "not_sure"]) {
      assert.deepEqual(decideSurgeReport(input({report: report({answer})})), {status: "done"});
    }
  });

  it("leaves a report that is already settled", () => {
    for (const status of ["done", "error"]) {
      assert.deepEqual(decideSurgeReport(input({report: report({status})})), {status: "ignore"});
    }
  });

  it("refuses a body outside the contract", () => {
    const bad = [
      report({answer: "maybe"}),
      report({answer: "high"}),
      report({band: "high"}),
      report({v: 1}),
      report({platform: "web"}),
      report({appVersion: "x".repeat(33)}),
      report({reportedAt: "18:00"}),
      report({fare: 12}),
    ];
    for (const body of bad) {
      assert.equal(validReport(body), false, JSON.stringify(body));
      assert.deepEqual(decideSurgeReport(input({report: body})), {status: "error", errorCode: "invalid-payload"});
    }
  });

  it("refuses a pin id that is not a document id", () => {
    assert.deepEqual(decideSurgeReport(input({report: report({pinId: "a/b"})})),
      {status: "error", errorCode: "invalid-pin"});
  });

  it("follows the platform switch in config/flags", () => {
    assert.equal(surgeReportsOn(true, "ios"), true);
    assert.equal(surgeReportsOn(undefined, "ios"), false);
    assert.equal(surgeReportsOn({enabled: true}, "ios"), true);
    assert.equal(surgeReportsOn({enabled: true, ios: false}, "ios"), false);
    assert.equal(surgeReportsOn({enabled: false, ios: true}, "ios"), true);
    assert.equal(surgeReportsOn({enabled: true, ios: true, android: false}, "android"), false);
    assert.equal(surgeReportsOn({ios: {enabled: true}}, "ios"), true);
    assert.deepEqual(decideSurgeReport(input({flags: {}})), {status: "error", errorCode: "flag-off"});
    assert.deepEqual(decideSurgeReport(input({report: report({platform: "android"})})),
      {status: "error", errorCode: "flag-off"});
  });

  it("refuses categories with nothing to report", () => {
    for (const category of ["egg", "parking", "contribute", "Parking"]) {
      assert.deepEqual(decideSurgeReport(input({pinCategory: category})),
        {status: "error", errorCode: "not-reportable"});
    }
    assert.deepEqual(decideSurgeReport(input({pinCategory: null})), {status: "done"},
      "a pin that is not a Firestore document is still stored");
  });

  it("keeps one done report per driver per pin per 20 minutes", () => {
    assert.deepEqual(decideSurgeReport(input({doneReportedAtMs: [AT - SURGE_REPORT_WINDOW_MS + 1000]})),
      {status: "error", errorCode: "rate-limited"});
    assert.deepEqual(decideSurgeReport(input({doneReportedAtMs: [AT - SURGE_REPORT_WINDOW_MS]})), {status: "done"});
  });

  it("gives every error words the phone can show", () => {
    for (const text of Object.values(SURGE_REPORT_ERROR_TEXT)) {
      assert.ok(text.length > 0);
      assert.ok(!/£|\bfare|multiplier|\d+(\.\d+)?x\b/i.test(text), text);
    }
  });
});
