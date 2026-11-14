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
    summaryId: "sum_a",
    status: "pending",
    createdAt: serverTimestamp(),
    deviceId: DEVICE,
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
        summaryId: "sum_a",
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

  it("lets the owner create a pending request when deviceId matches the token", async () => {
    const other = "b".repeat(64);
    const database = dbFor("ada", {deviceId: other});
    await assertSucceeds(setDoc(
      doc(database, "hotspotUnlockRequests", "new_req"),
      pending("ada", {deviceId: other}),
    ));
  });

  it("requires the written deviceId to equal the token, unless grace allows a missing stamp", async () => {
    const ada = dbFor("ada", {deviceId: DEVICE});
    await assertFails(setDoc(
      doc(ada, "hotspotUnlockRequests", "wrong"),
      pending("ada", {deviceId: "b".repeat(64)}),
    ));
    const bare = pending("ada");
    delete bare.deviceId;
    const noClaim = dbFor("ada");
    await assertFails(setDoc(doc(noClaim, "hotspotUnlockRequests", "no_grace"), bare));

    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "config/deviceCheck"), {
        graceUntil: Timestamp.fromMillis(Date.now() + 86_400_000),
      });
    });
    await assertSucceeds(setDoc(doc(noClaim, "hotspotUnlockRequests", "grace"), bare));
    await assertFails(setDoc(
      doc(noClaim, "hotspotUnlockRequests", "invented"),
      pending("ada", {deviceId: DEVICE}),
    ));

    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "config/deviceCheck"), {
        graceUntil: Timestamp.fromMillis(Date.now() - 1_000),
      });
    });
    await assertFails(setDoc(doc(noClaim, "hotspotUnlockRequests", "past"), bare));
    assert.match(RULES, /request\.resource\.data\.deviceId == request\.auth\.token\.deviceId/);
  });

  it("denies a signed-out create, a foreign uid, a finished status, and extra fields", async () => {
    const signedOut = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(signedOut, "hotspotUnlockRequests", "out"), pending("ada")));
    const ada = dbFor("ada", {deviceId: DEVICE});
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "other"), pending("bob")));
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "done"), pending("ada", {status: "done"})));
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "reason"), pending("ada", {reason: "no_credit"})));
    await assertFails(setDoc(doc(ada, "hotspotUnlockRequests", "slash"), pending("ada", {summaryId: "a/b"})));
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

  it("denies every client read and write of the surge ledger", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", "ada", "surge_ledger", "grant_1"), {
        kind: "grant",
        source: "admin",
        createdAt: Timestamp.now(),
      });
    });
    const ada = dbFor("ada", {deviceId: DEVICE});
    const ledgerDoc = doc(ada, "users", "ada", "surge_ledger", "grant_1");
    await assertFails(getDoc(ledgerDoc));
    await assertFails(getDocs(collection(ada, "users", "ada", "surge_ledger")));
    await assertFails(setDoc(doc(ada, "users", "ada", "surge_ledger", "grant_2"), {kind: "grant"}));
    await assertFails(updateDoc(ledgerDoc, {kind: "spend"}));
    await assertFails(deleteDoc(ledgerDoc));
    const admin = dbFor("ada", {role: "admin", deviceId: DEVICE});
    await assertFails(getDoc(doc(admin, "users", "ada", "surge_ledger", "grant_1")));
    await assertFails(setDoc(doc(admin, "users", "ada", "surge_ledger", "admin_grant"), {kind: "grant"}));
    const bob = dbFor("bob", {deviceId: DEVICE});
    await assertFails(getDoc(doc(bob, "users", "ada", "surge_ledger", "grant_1")));
    assert.match(RULES, /match \/surge_ledger\/\{entryId\}/);
    assert.match(RULES, /allow read, write: if false;/);
  });

  it("lets the owner read surge status and denies list and every write", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "surge_status", "ada"), {
        tier: "free",
        allowance: 3,
        periodKey: "2026-11",
        periodEndsAt: Timestamp.fromMillis(Date.now() + 86_400_000),
        spentThisPeriod: 1,
        updatedAt: Timestamp.now(),
      });
    });
    const ada = dbFor("ada", {deviceId: DEVICE});
    const saved = await assertSucceeds(getDoc(doc(ada, "surge_status", "ada")));
    assert.equal(saved.get("tier"), "free");
    assert.equal(saved.get("spentThisPeriod"), 1);
    await assertFails(getDocs(collection(ada, "surge_status")));
    await assertFails(setDoc(doc(ada, "surge_status", "ada-new"), {tier: "free", allowance: 3}));
    await assertFails(updateDoc(doc(ada, "surge_status", "ada"), {spentThisPeriod: 0}));
    await assertFails(deleteDoc(doc(ada, "surge_status", "ada")));
    const bob = dbFor("bob", {deviceId: DEVICE});
    await assertFails(getDoc(doc(bob, "surge_status", "ada")));
    assert.match(RULES, /match \/surge_status\/\{uid\}/);
    assert.match(RULES, /allow get: if request\.auth != null && request\.auth\.uid == uid;/);
    assert.match(RULES, /allow list, write: if false;/);
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
