/**
 * surgeReports: the phone creates a pending report with the driver's answer
 * and may read its own. A pending report may be re-sent unchanged. Settled
 * reports, other drivers' reports and deletes are refused. Project ids are demo-.
 */
const fs = require("fs");
const path = require("path");
const {describe, it, before, beforeEach, after} = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {doc, getDoc, getDocs, collection, setDoc, deleteDoc, serverTimestamp, Timestamp} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

function body(uid, extra = {}) {
  return {
    v: 2,
    uid,
    pinId: "fp_pubs-the-swan-stockwell-london",
    answer: "yes",
    reportedAt: Timestamp.now(),
    platform: "ios",
    appVersion: "1.3.1 (73)",
    status: "pending",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

describe("surge report rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-surge-reports",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "surgeReports", "settled"), {...body("ada"), status: "done", createdAt: Timestamp.now()});
      await setDoc(doc(db, "surgeReports", "rejected"), {...body("ada"), status: "error", createdAt: Timestamp.now()});
      await setDoc(doc(db, "surgeReports", "bobs"), {...body("bob"), createdAt: Timestamp.now()});
    });
  });

  after(async () => {
    await env.cleanup();
  });

  const ada = () => env.authenticatedContext("ada").firestore();

  it("lets a driver send each answer for themselves", async () => {
    for (const answer of ["yes", "no", "not_sure"]) {
      await assertSucceeds(setDoc(doc(ada(), "surgeReports", `r_${answer}`), body("ada", {answer})));
    }
  });

  it("refuses a report signed out or for another driver", async () => {
    await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), "surgeReports", "r1"), body("ada")));
    await assertFails(setDoc(doc(ada(), "surgeReports", "r1"), body("bob")));
  });

  it("refuses a body outside the contract", async () => {
    const bad = [
      body("ada", {answer: "maybe"}),
      body("ada", {answer: "high"}),
      body("ada", {v: 1}),
      body("ada", {platform: "web"}),
      body("ada", {appVersion: "x".repeat(33)}),
      body("ada", {pinId: "a/b"}),
      body("ada", {pinId: ""}),
      body("ada", {status: "done"}),
      body("ada", {createdAt: Timestamp.fromMillis(0)}),
      body("ada", {fare: 12}),
      body("ada", {latitude: 51.5}),
    ];
    for (const [i, data] of bad.entries()) {
      await assertFails(setDoc(doc(ada(), "surgeReports", `bad_${i}`), data));
    }
    const missing = body("ada");
    delete missing.reportedAt;
    await assertFails(setDoc(doc(ada(), "surgeReports", "missing"), missing));
  });

  it("allows a pending retry of the same answer and nothing else", async () => {
    await assertSucceeds(setDoc(doc(ada(), "surgeReports", "retry"), body("ada")));
    await assertSucceeds(setDoc(doc(ada(), "surgeReports", "retry"), body("ada")));
    await assertFails(setDoc(doc(ada(), "surgeReports", "retry"), body("ada", {answer: "no"})));
    await assertFails(setDoc(doc(ada(), "surgeReports", "retry"), body("ada", {pinId: "fp_other"})));
  });

  it("refuses a resend once the server has settled it, as PERMISSION_DENIED", async () => {
    for (const id of ["settled", "rejected"]) {
      const err = await assertFails(setDoc(doc(ada(), "surgeReports", id), body("ada")));
      assert.equal(err.code, "permission-denied");
    }
  });

  it("lets a driver read only their own reports, and a missing one", async () => {
    await assertSucceeds(getDoc(doc(ada(), "surgeReports", "settled")));
    await assertSucceeds(getDoc(doc(ada(), "surgeReports", "nothing-here")));
    await assertFails(getDoc(doc(ada(), "surgeReports", "bobs")));
    await assertFails(getDocs(collection(ada(), "surgeReports")));
  });

  it("never lets the phone delete a report", async () => {
    await assertFails(deleteDoc(doc(ada(), "surgeReports", "settled")));
  });
});
