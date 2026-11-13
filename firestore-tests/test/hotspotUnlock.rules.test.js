/**
 * hotspotUnlockRequests: the phone creates a pending row and may read its own.
 * hotspot_unlocks stay server-written. Project ids are demo-.
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
const {
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const DEVICE = "a".repeat(64);

function pending(uid, extra = {}) {
  return {
    uid,
    hotspotId: "sheet_a",
    status: "pending",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

describe("hotspot unlock request rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-unlock",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "users", "ada"), {activeDeviceId: DEVICE, name: "Ada"});
      await setDoc(doc(db, "users", "ada", "hotspot_unlocks", "sheet_a"), {
        validUntil: Timestamp.fromMillis(Date.now() + 3_600_000),
      });
      await setDoc(doc(db, "hotspotUnlockRequests", "owned"), {
        uid: "ada",
        hotspotId: "sheet_a",
        status: "done",
        createdAt: Timestamp.now(),
      });
    });
  });

  after(async () => {
    await env.cleanup();
  });

  function dbFor(uid, claims) {
    return env.authenticatedContext(uid, claims).firestore();
  }

  it("lets the owner create a pending request, including from another device", async () => {
    const database = dbFor("ada", {deviceId: "b".repeat(64)});
    await assertSucceeds(setDoc(doc(database, "hotspotUnlockRequests", "new_req"), pending("ada")));
  });

  it("denies a signed-out create, a foreign uid, a finished status, and extra fields", async () => {
    const signedOut = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(signedOut, "hotspotUnlockRequests", "out"), pending("ada")));
    const ada = dbFor("ada", {deviceId: DEVICE});
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "other"), pending("bob")));
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "done"), pending("ada", {status: "done"})));
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "reason"), pending("ada", {reason: "no_credit"})));
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "slash"), pending("ada", {hotspotId: "a/b"})));
  });

  it("lets the owner read the request and denies list, update, and delete", async () => {
    const ada = dbFor("ada", {deviceId: DEVICE});
    const saved = await assertSucceeds(getDoc(doc(ada, "hotspotUnlockRequests", "owned")));
    assert.equal(saved.get("status"), "done");
    await assertFails(getDocs(collection(ada, "hotspotUnlockRequests")));
    await assertFails(updateDoc(doc(ada, "hotspotUnlockRequests", "owned"), {status: "pending"}));
    await assertFails(deleteDoc(doc(ada, "hotspotUnlockRequests", "owned")));
    const bob = dbFor("bob", {deviceId: DEVICE});
    await assertFails(getDoc(doc(bob, "hotspotUnlockRequests", "owned")));
  });

  it("still refuses client writes to hotspot_unlocks", async () => {
    const ada = dbFor("ada", {deviceId: DEVICE});
    await assertSucceeds(getDoc(doc(ada, "users", "ada", "hotspot_unlocks", "sheet_a")));
    await assertFails(setDoc(doc(ada, "users", "ada", "hotspot_unlocks", "sheet_b"), {
      validUntil: Timestamp.fromMillis(Date.now() + 1_000),
    }));
    await assertFails(updateDoc(doc(ada, "users", "ada", "hotspot_unlocks", "sheet_a"), {
      validUntil: Timestamp.fromMillis(Date.now() + 9_000),
    }));
    await assertFails(deleteDoc(doc(ada, "users", "ada", "hotspot_unlocks", "sheet_a")));
  });

  it("names the denial reasons in the trigger and not as rule strings", () => {
    const trigger = fs.readFileSync(
      path.join(__dirname, "../../functions/src/surge/onHotspotUnlockRequest.ts"),
      "utf8",
    );
    for (const reason of ["device_revoked", "no_credit", "not_eligible", "flag_off", "invalid"]) {
      assert.equal(trigger.includes(`"${reason}"`), true, reason);
    }
    assert.equal(RULES.includes("allow write: if false;"), true);
  });
});
