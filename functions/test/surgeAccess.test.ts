import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {FieldValue} from "firebase-admin/firestore";
import {issueSurgeAccountBinding, fulfillSurgeAccountRequest} from "../src/surgeAccess/accountBinding.js";
import {
  ACCESS_SPLIT,
  CALENDAR_MONTH_PROPOSALS,
  CONTRACT_ID,
  FREE_OPENS,
  FUTURE_GRANT_INVARIANT,
  REQUEST_ADMISSION,
  SINGLE_SURGE,
  SurgeAccessError,
  chargesForHeldSubmission,
  proposedCalendarBoundary,
} from "../src/surgeAccess/contract.js";
import {holdSurgeIapRequest} from "../src/surgeAccess/iapRequest.js";
import {testDb} from "./support.js";

const SENTINEL = "synthetic.not-a-store-receipt." + "x".repeat(48);
const ALICE = "aliceaccount01";
const BOB = "bobaccount0001";
const REQUEST = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const IAP = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function code(err: unknown): string {
  assert.ok(err instanceof SurgeAccessError);
  assert.equal(err.message.includes(SENTINEL), false);
  return err.code;
}

describe("surge access contract", () => {
  it("keeps free monthly, single-surge, and hotspot access apart, and inactive", () => {
    assert.equal(CONTRACT_ID, "surge-access-binding/v1");
    assert.equal(REQUEST_ADMISSION.clientCreates, "denied");
    assert.equal(REQUEST_ADMISSION.grantsFinancialAuthority, false);
    assert.equal(FREE_OPENS.opens, 3);
    assert.equal(FREE_OPENS.cadence, "calendar-month");
    assert.equal(FREE_OPENS.anchor, "first-successful-server-authorized-open");
    assert.equal(FREE_OPENS.active, false);
    assert.equal(FREE_OPENS.reinstallResetsAnchor, false);
    assert.equal(SINGLE_SURGE.priceGbp, "2.99");
    assert.equal(SINGLE_SURGE.weeklyPlanContinues, true);
    assert.equal(SINGLE_SURGE.productIdVerifiedInStore, false);
    assert.equal(SINGLE_SURGE.active, false);
    assert.equal(ACCESS_SPLIT.eventCardReopenExtraCharge, false);
    assert.equal(ACCESS_SPLIT.eventCardImplemented, false);
    assert.equal(ACCESS_SPLIT.exhaustedPlanHotspotDetail, "unresolved");
    assert.equal(ACCESS_SPLIT.singlePurchaseGrantsHotspotSheet, false);
    assert.equal(FUTURE_GRANT_INVARIANT.active, false);
    assert.deepEqual(chargesForHeldSubmission(), {allowanceGrants: 0, creditGrants: 0, active: false});
    assert.equal(CALENDAR_MONTH_PROPOSALS.active, false);
    assert.deepEqual(proposedCalendarBoundary(), {active: false, reason: "calendar-semantics-not-approved"});
    assert.equal(JSON.stringify(proposedCalendarBoundary()).includes("2026-01-31"), false);
  });

  it("is not exported from the functions entrypoint", async () => {
    const source = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
    const built = readFileSync(join(process.cwd(), "lib/index.js"), "utf8");
    for (const name of [
      "surgeAccess",
      "iapRequests",
      "issueSurgeAccountBinding",
      "holdSurgeIapRequest",
      "syntheticLedger",
      "applySyntheticPurchase",
      "unavailableVerifier",
    ]) {
      assert.equal(source.includes(name), false, name);
      assert.equal(built.includes(name), false, name);
    }
  });
});

describe("surge account binding emulator", () => {
  const db = testDb("demo-surge-access");

  it("issues once under concurrency and isolates accounts", async () => {
    const issued = await Promise.all(
      Array.from({length: 8}, () => issueSurgeAccountBinding(db, ALICE)),
    );
    const first = issued[0];
    for (const row of issued) {
      assert.equal(row.appAccountToken, first.appAccountToken);
      assert.equal(row.playObfuscatedId, first.playObfuscatedId);
    }
    assert.notEqual(first.appAccountToken, first.playObfuscatedId);
    assert.notEqual(first.appAccountToken, ALICE);
    const again = await issueSurgeAccountBinding(db, ALICE);
    assert.equal(again.created, false);
    assert.equal(again.appAccountToken, first.appAccountToken);
    const bob = await issueSurgeAccountBinding(db, BOB);
    assert.notEqual(bob.appAccountToken, first.appAccountToken);
    const token = await db.collection("surgeAccountTokens").doc(first.appAccountToken).get();
    assert.equal(token.get("uid"), ALICE);
    const replay = await fulfillSurgeAccountRequest(db, REQUEST, ALICE);
    const second = await fulfillSurgeAccountRequest(db, REQUEST, ALICE);
    assert.equal(replay.appAccountToken, first.appAccountToken);
    assert.equal(second.appAccountToken, first.appAccountToken);
    const request = await db.collection("surgeAccountRequests").doc(REQUEST).get();
    assert.equal(request.get("status"), "issued");
    assert.equal(request.get("appAccountToken"), first.appAccountToken);
    assert.notEqual(request.get("appAccountToken"), "client-chosen-token");
  });

  it("accepts hyphen, dot, and underscore uids and rejects path-illegal ones", async () => {
    const hyphen = "user-with.dot_1";
    const bound = await issueSurgeAccountBinding(db, hyphen);
    assert.equal(bound.uid, hyphen);
    assert.notEqual(bound.appAccountToken, hyphen);
    for (const bad of ["", "a".repeat(129), ".", "..", "ab/cd", "__bad__", "has\nline"]) {
      await assert.rejects(issueSurgeAccountBinding(db, bad), (err) => code(err) === "bad-uid");
    }
    const longId = "a".repeat(129);
    assert.equal((await db.collection("surgeBillingAccounts").doc(longId).get()).exists, false);
  });

  it("caps account requests and ignores another account's stored uid", async () => {
    const uid = "floodaccount01";
    const ids = Array.from({length: 6}, (_, index) => `11111111-2222-4333-8444-55555555555${index}`);
    const results = await Promise.allSettled(ids.map((id) => fulfillSurgeAccountRequest(db, id, uid)));
    const ok = results.filter((row) => row.status === "fulfilled");
    const full = results.filter((row) => row.status === "rejected" && code(row.reason) === "admission-full");
    assert.equal(ok.length, REQUEST_ADMISSION.maxOpenPerUid);
    assert.equal(full.length, ids.length - REQUEST_ADMISSION.maxOpenPerUid);
    const stored = await db.collection("surgeAccountRequests").where("uid", "==", uid).get();
    assert.equal(stored.size, REQUEST_ADMISSION.maxOpenPerUid);
    const other = "22222222-3333-4444-8555-666666666666";
    await db.collection("surgeAccountRequests").doc(other).set({
      v: 1,
      uid: BOB,
      createdAt: FieldValue.serverTimestamp(),
    });
    await assert.rejects(fulfillSurgeAccountRequest(db, other, uid), (err) => code(err) === "owner-mismatch");
    await db.collection("surgeAdmission").doc(uid).delete();
    const extra = "11111111-2222-4333-8444-555555555559";
    await assert.rejects(fulfillSurgeAccountRequest(db, extra, uid), (err) => code(err) === "admission-full");
    const afterDelete = await db.collection("surgeAccountRequests").where("uid", "==", uid).get();
    assert.equal(afterDelete.size, REQUEST_ADMISSION.maxOpenPerUid);
  });

  it("refuses a preseeded ask that carries a grant", async () => {
    const uid = "preseedaccount";
    const id = "12121212-3434-4545-8656-787878787878";
    await db.collection("surgeAccountRequests").doc(id).set({
      v: 1,
      uid,
      createdAt: FieldValue.serverTimestamp(),
      grant: true,
      appAccountToken: "client-chosen-token",
    });
    await assert.rejects(fulfillSurgeAccountRequest(db, id, uid), (err) => code(err) === "unadmitted");
    const stored = await db.collection("surgeAccountRequests").doc(id).get();
    assert.equal(stored.get("grant"), true);
    assert.equal(stored.get("status"), undefined);
    assert.equal((await db.collection("surgeBillingAccounts").doc(uid).get()).exists, false);
  });

  it("refuses a colliding id", async () => {
    const taken = "cccccccc-dddd-4eee-8fff-000000000001";
    await db.collection("surgeAccountTokens").doc(taken).set({v: 1, uid: BOB});
    await assert.rejects(
      issueSurgeAccountBinding(db, "carolaccount1", () => ({
        appAccountToken: taken,
        playObfuscatedId: "dddddddd-eeee-4fff-8000-000000000002",
      })),
      (err) => code(err) === "binding-collision",
    );
    const carol = await db.collection("surgeBillingAccounts").doc("carolaccount1").get();
    assert.equal(carol.exists, false);
  });
});

describe("surge iap request emulator", () => {
  const db = testDb("demo-surge-access");

  it("holds a submission and writes no grant", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const otherBlob = "y".repeat(80);
      const held = await holdSurgeIapRequest(db, IAP, ALICE, SENTINEL);
      const again = await holdSurgeIapRequest(db, IAP, ALICE, otherBlob);
      assert.equal(held.delivered, false);
      assert.equal(again.granted, false);
      const stored = await db.collection("iapRequests").doc(IAP).get();
      assert.equal(stored.get("status"), "held");
      assert.equal(stored.get("outcome"), "verifier-not-implemented");
      assert.equal(stored.get("signedTransaction"), SENTINEL);
      assert.equal(String(stored.get("status")).includes(SENTINEL), false);
      assert.equal(String(stored.get("outcome")).includes(otherBlob), false);
      for (const name of ["ledger", "entitlements", "unlocks", "storePurchases", "surgeLedger", "hotspots_test"]) {
        const snap = await db.collection(name).get();
        assert.equal(snap.size, 0, name);
      }
      assert.equal(logs.some((line) => line.includes(SENTINEL)), false);
    } finally {
      console.log = original;
    }
  });

  it("judges the stored snapshot and caps new blobs", async () => {
    const badId = "cccccccc-dddd-4eee-8fff-000000000009";
    await db.collection("iapRequests").doc(badId).set({
      v: 1,
      uid: ALICE,
      platform: "apple",
      signedTransaction: SENTINEL,
      createdAt: FieldValue.serverTimestamp(),
      grant: true,
    });
    await assert.rejects(
      holdSurgeIapRequest(db, badId, ALICE, "z".repeat(80)),
      (err) => code(err) === "unadmitted" && String(err).includes(SENTINEL) === false,
    );
    assert.equal((await db.collection("iapRequests").doc(badId).get()).get("grant"), true);
    const unchanged = await db.collection("iapRequests").doc(badId).get();
    assert.equal(unchanged.get("status"), undefined);
    await assert.rejects(holdSurgeIapRequest(db, IAP, BOB), (err) => code(err) === "owner-mismatch");
    await assert.rejects(
      holdSurgeIapRequest(db, "dddddddd-eeee-4fff-8000-000000000099", ALICE),
      (err) => code(err) === "bad-payload",
    );
    const uid = "iapflooduser1";
    const ids = Array.from({length: 6}, (_, index) => `33333333-4444-4555-8666-77777777777${index}`);
    const results = await Promise.allSettled(ids.map((id, index) => {
      return holdSurgeIapRequest(db, id, uid, `${SENTINEL}${index}`);
    }));
    const ok = results.filter((row) => row.status === "fulfilled");
    const full = results.filter((row) => row.status === "rejected" && code(row.reason) === "admission-full");
    assert.equal(ok.length, REQUEST_ADMISSION.maxOpenPerUid);
    assert.equal(full.length, ids.length - REQUEST_ADMISSION.maxOpenPerUid);
    const docs = await db.collection("iapRequests").where("uid", "==", uid).get();
    assert.equal(docs.size, REQUEST_ADMISSION.maxOpenPerUid);
    assert.equal(docs.docs.some((row) => row.get("status") === "delivered"), false);
    const user = await db.collection("users").doc(uid).get();
    assert.equal(user.exists, false);
    await db.collection("surgeAdmission").doc(uid).delete();
    const extra = "33333333-4444-4555-8666-777777777779";
    await assert.rejects(
      holdSurgeIapRequest(db, extra, uid, SENTINEL),
      (err) => code(err) === "admission-full",
    );
    const afterDelete = await db.collection("iapRequests").where("uid", "==", uid).get();
    assert.equal(afterDelete.size, REQUEST_ADMISSION.maxOpenPerUid);
  });
});

describe("surge access stays off the production deploy path", () => {
  it("keeps firebase.json on the baseline rules and out of the prototype", () => {
    const root = readFileSync(join(process.cwd(), "../firebase.json"), "utf8");
    const config = JSON.parse(root) as {firestore: {rules: string}};
    assert.equal(config.firestore.rules, "firestore.rules");
    const rules = readFileSync(join(process.cwd(), "../firestore.rules"), "utf8");
    const deploy = readFileSync(join(process.cwd(), "DEPLOY.md"), "utf8");
    const script = readFileSync(join(process.cwd(), "scripts/deploy-default.cjs"), "utf8");
    for (const marker of ["iapRequests", "surgeAccountRequests", "surgeAdmission", "surge-access.prototype"]) {
      assert.equal(rules.includes(marker), false, marker);
    }
    assert.equal(root.includes("surge-access.prototype"), false);
    assert.match(script, /\['deploy', '--only', 'functions:default', '-P', alias\]/);
    assert.equal(script.includes("surge-access.prototype"), false);
    assert.equal(deploy.includes("firestore.surge-access.prototype.rules"), true);
    assert.equal(deploy.includes("There is no production deploy path for that draft."), true);
  });

  it("does not put proposed surge product ids on the web Gold path", () => {
    const proposed = [
      "ferro.surge.premium.weekly",
      "ferro.surge.ultimate.weekly",
      "ferro.surge.stardust.weekly",
      "ferro.surge.single",
    ];
    const files = [
      "src/index.ts",
      "src/play/handlePlayPurchase.ts",
      "src/play/subscription.ts",
      "src/play/play.test.ts",
      "../firestore.rules",
    ];
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const id of proposed) assert.equal(text.includes(id), false, `${file} ${id}`);
    }
    const handler = readFileSync(join(process.cwd(), "src/play/handlePlayPurchase.ts"), "utf8");
    assert.equal(handler.includes("config.productIds.includes"), true);
  });
});
