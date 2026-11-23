/**
 * Driver surge reports. A signed-in driver creates a pending v2 row for
 * their own uid and may read that row, including a missing id. A pending
 * retry may repeat the same pin and answer. List and delete stay closed.
 * Project ids are demo- so the emulator cannot reach a real project.
 */
const {describe, it, before, after} = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const REPORTED_AT = Timestamp.fromDate(new Date("2026-11-22T12:00:00Z"));

function reportBody(uid, extra = {}) {
  return {
    v: 2,
    uid,
    pinId: "pin-1",
    answer: "yes",
    reportedAt: REPORTED_AT,
    platform: "ios",
    appVersion: "2.4.0",
    status: "pending",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

describe("surgeReports rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-surge-reports",
      firestore: {rules: RULES},
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("lets a signed-in driver create a valid v2 pending report for their own uid", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "surgeReports", "alice-yes"), reportBody("alice")));
    const saved = await assertSucceeds(getDoc(doc(alice, "surgeReports", "alice-yes")));
    assert.equal(saved.get("v"), 2);
    assert.equal(saved.get("uid"), "alice");
    assert.equal(saved.get("pinId"), "pin-1");
    assert.equal(saved.get("answer"), "yes");
    assert.equal(saved.get("status"), "pending");
    assert.equal(saved.get("platform"), "ios");
    assert.equal(saved.get("price"), undefined);
  });

  it("lets the owner get their own report and a missing one", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "surgeReports", "alice-own"), reportBody("alice")));
    const own = await assertSucceeds(getDoc(doc(alice, "surgeReports", "alice-own")));
    assert.equal(own.exists(), true);
    assert.equal(own.get("uid"), "alice");
    const missing = await assertSucceeds(getDoc(doc(alice, "surgeReports", "not-written")));
    assert.equal(missing.exists(), false);
  });

  it("refuses a get of someone else's report", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "surgeReports", "bobs"), {
        v: 2,
        uid: "bob",
        pinId: "pin-9",
        answer: "no",
        reportedAt: REPORTED_AT,
        platform: "android",
        appVersion: "1.8.0",
        status: "pending",
        createdAt: REPORTED_AT,
      });
    });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(alice, "surgeReports", "bobs")));
  });

  it("denies list", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "surgeReports", "alice-listed"), reportBody("alice")));
    await assertFails(getDocs(collection(alice, "surgeReports")));
  });

  it("denies a create with an extra field, the wrong uid, or an answer outside yes/no/not_sure", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "surgeReports", "priced"), {
      ...reportBody("alice"),
      price: 250,
    }));
    await assertFails(setDoc(doc(alice, "surgeReports", "forged"), reportBody("bob")));
    await assertFails(setDoc(doc(alice, "surgeReports", "bad-answer"), reportBody("alice", {
      answer: "maybe",
    })));
  });

  it("allows a pending retry with the same pin and answer and denies a changed answer", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const ref = doc(alice, "surgeReports", "alice-retry");
    await assertSucceeds(setDoc(ref, reportBody("alice")));
    await assertSucceeds(setDoc(ref, reportBody("alice", {
      appVersion: "2.4.1",
    })));
    await assertFails(setDoc(ref, reportBody("alice", {answer: "no"})));
    const saved = await assertSucceeds(getDoc(ref));
    assert.equal(saved.get("answer"), "yes");
    assert.equal(saved.get("pinId"), "pin-1");
    assert.equal(saved.get("appVersion"), "2.4.1");
  });

  it("denies delete", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const ref = doc(alice, "surgeReports", "alice-delete");
    await assertSucceeds(setDoc(ref, reportBody("alice")));
    await assertFails(deleteDoc(ref));
    const saved = await assertSucceeds(getDoc(ref));
    assert.equal(saved.exists(), true);
  });

  it("denies unauthenticated access", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "surgeReports", "seeded"), {
        v: 2,
        uid: "alice",
        pinId: "pin-1",
        answer: "not_sure",
        reportedAt: REPORTED_AT,
        platform: "ios",
        appVersion: "2.4.0",
        status: "pending",
        createdAt: REPORTED_AT,
      });
    });
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "surgeReports", "missing")));
    await assertFails(getDoc(doc(anon, "surgeReports", "seeded")));
    await assertFails(getDocs(collection(anon, "surgeReports")));
    await assertFails(setDoc(doc(anon, "surgeReports", "open"), reportBody("alice")));
    await assertFails(setDoc(doc(anon, "surgeReports", "seeded"), reportBody("alice")));
    await assertFails(deleteDoc(doc(anon, "surgeReports", "seeded")));
  });
});
