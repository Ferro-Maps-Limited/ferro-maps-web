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
    for (const name of ["surgeAccess", "iapRequests", "issueSurgeAccountBinding", "holdSurgeIapRequest"]) {
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
    await db.collection("surgeAccountRequests").doc(REQUEST).set({
      v: 1,
      uid: ALICE,
      createdAt: FieldValue.serverTimestamp(),
    });
    const replay = await fulfillSurgeAccountRequest(db, REQUEST, ALICE, {
      v: 1,
      uid: ALICE,
      createdAt: FieldValue.serverTimestamp(),
    });
    const second = await fulfillSurgeAccountRequest(db, REQUEST, ALICE, {
      v: 1,
      uid: ALICE,
      createdAt: FieldValue.serverTimestamp(),
    });
    assert.equal(replay.appAccountToken, first.appAccountToken);
    assert.equal(second.appAccountToken, first.appAccountToken);
    const request = await db.collection("surgeAccountRequests").doc(REQUEST).get();
    assert.equal(request.get("status"), "issued");
    assert.equal(request.get("appAccountToken"), first.appAccountToken);
  });

  it("refuses a chosen token, another account, and a colliding id", async () => {
    await assert.rejects(
      fulfillSurgeAccountRequest(db, REQUEST, ALICE, {
        v: 1,
        uid: ALICE,
        createdAt: FieldValue.serverTimestamp(),
        appAccountToken: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
      (err) => code(err) === "bad-keys",
    );
    await assert.rejects(
      fulfillSurgeAccountRequest(db, REQUEST, ALICE, {v: 1, uid: BOB, createdAt: 1}),
      (err) => code(err) === "owner-mismatch",
    );
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
      await db.collection("iapRequests").doc(IAP).set({
        v: 1,
        uid: ALICE,
        platform: "apple",
        signedTransaction: SENTINEL,
        createdAt: FieldValue.serverTimestamp(),
      });
      const held = await holdSurgeIapRequest(db, IAP, ALICE, {
        v: 1,
        uid: ALICE,
        platform: "apple",
        signedTransaction: SENTINEL,
        createdAt: 1,
      });
      const again = await holdSurgeIapRequest(db, IAP, ALICE, {
        v: 1,
        uid: ALICE,
        platform: "apple",
        signedTransaction: SENTINEL,
        createdAt: 1,
      });
      assert.equal(held.delivered, false);
      assert.equal(again.granted, false);
      const stored = await db.collection("iapRequests").doc(IAP).get();
      assert.equal(stored.get("status"), "held");
      assert.equal(stored.get("outcome"), "verifier-not-implemented");
      assert.equal(String(stored.get("status")).includes(SENTINEL), false);
      assert.equal(String(stored.get("outcome")).includes(SENTINEL), false);
      for (const name of ["ledger", "entitlements", "unlocks", "storePurchases", "surgeLedger", "hotspots_test"]) {
        const snap = await db.collection(name).get();
        assert.equal(snap.size, 0, name);
      }
      assert.equal(logs.some((line) => line.includes(SENTINEL)), false);
    } finally {
      console.log = original;
    }
  });

  it("rejects forged fields without echoing the payload", async () => {
    const forged = {
      v: 1,
      uid: ALICE,
      platform: "apple",
      signedTransaction: SENTINEL,
      createdAt: 1,
      productId: "ferro.surge.single",
      transactionId: "store-1",
      grant: true,
    };
    await assert.rejects(
      holdSurgeIapRequest(db, IAP, ALICE, forged),
      (err) => code(err) === "forbidden-field",
    );
    await assert.rejects(
      holdSurgeIapRequest(db, IAP, ALICE, {
        v: 2,
        uid: ALICE,
        platform: "apple",
        signedTransaction: SENTINEL,
        createdAt: 1,
      }),
      (err) => code(err) === "bad-version",
    );
    await assert.rejects(
      holdSurgeIapRequest(db, "cccccccc-dddd-4eee-8fff-000000000009", BOB, {
        v: 1,
        uid: ALICE,
        platform: "apple",
        signedTransaction: SENTINEL,
        createdAt: 1,
      }),
      (err) => code(err) === "owner-mismatch",
    );
    await assert.rejects(
      holdSurgeIapRequest(db, IAP, ALICE, {
        v: 1,
        uid: ALICE,
        platform: "apple",
        signedTransaction: "short",
        createdAt: 1,
      }),
      (err) => code(err) === "bad-payload",
    );
  });
});
