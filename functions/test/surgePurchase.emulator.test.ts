import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {surgeAccountToken} from "../src/surge/accountToken";
import {handleHotspotUnlockRequest, type CallerAuth} from "../src/surge/onHotspotUnlockRequest";
import {
  SURGE_PURCHASE_CLAIMS,
  SURGE_PURCHASES_DOC,
  handleSurgePurchaseRequest,
} from "../src/surge/onSurgePurchaseRequest";
import {
  SURGE_PRODUCT_PREMIUM,
  SURGE_PRODUCT_SINGLE,
  SURGE_PRODUCT_STARDUST,
} from "../src/surge/purchaseVerifier";
import {SURGE_LEDGER, purchaseCreditId} from "../src/surge/surgeLedger";
import {SURGE_STATUS} from "../src/surge/surgeStatus";
import {fixtureKeys, fixtureVerifier, sandboxPayload} from "./appleJwsFixture";
import {clearDb, testDb} from "./support";

const db = testDb("demo-ferromaps-stadium-surge");
const NOW = new Date("2026-11-13T12:00:00.000Z");
const WEEK = 7 * 24 * 60 * 60 * 1000;
const DEVICE = "a".repeat(64);
const keys = fixtureKeys();
const verifier = fixtureVerifier(keys.publicKey);

function auth(uid: string): CallerAuth {
  return {uid};
}

async function enablePurchases(): Promise<void> {
  await db.doc(SURGE_PURCHASES_DOC).set({enabled: true});
}

async function enableSpend(): Promise<void> {
  await db.doc("config/flags").set({plannerSummaries: true});
  await db.doc("config/plannerSummaries").set({enabled: true, creditSpendEnabled: true});
}

async function purchase(id: string, uid: string, productId: string, payload: Record<string, unknown>): Promise<void> {
  const ref = db.collection("surgePurchaseRequests").doc(id);
  await ref.set({
    uid,
    productId,
    signedTransaction: keys.sign(payload),
    status: "pending",
    createdAt: Timestamp.fromDate(NOW),
  });
  await handleSurgePurchaseRequest(db, ref, verifier, NOW);
}

async function unlock(id: string, uid: string, summaryId: string, hotspotId: string, now = NOW): Promise<void> {
  await db.collection("plannerSummaryKeys").doc(summaryId).set({
    hotspotId,
    windowStart: Timestamp.fromMillis(now.getTime() - 60_000),
    windowEnd: Timestamp.fromMillis(now.getTime() + 3_600_000),
    expireAt: Timestamp.fromMillis(now.getTime() + 86_400_000),
  });
  const ref = db.collection("hotspotUnlockRequests").doc(id);
  await ref.set({
    uid,
    summaryId,
    status: "pending",
    createdAt: Timestamp.fromDate(now),
    deviceId: DEVICE,
  });
  await handleHotspotUnlockRequest(db, ref, auth(uid), now);
}

describe("apple sandbox purchase verification", () => {
  before(async () => {
    await clearDb(db);
    await enablePurchases();
  });

  it("verifies a sandbox subscription and sets the paid week from the payment", async () => {
    const uid = "buyer_premium";
    const purchaseMs = NOW.getTime() - 86_400_000;
    const expiresMs = purchaseMs + WEEK;
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Premium"});
    await purchase("tx_premium", uid, SURGE_PRODUCT_PREMIUM, sandboxPayload({
      transactionId: "tx_premium",
      productId: SURGE_PRODUCT_PREMIUM,
      appAccountToken: surgeAccountToken(uid),
      purchaseDateMs: purchaseMs,
      expiresDateMs: expiresMs,
    }));
    const saved = await db.collection("surgePurchaseRequests").doc("tx_premium").get();
    const user = await db.collection("users").doc(uid).get();
    const status = await db.collection(SURGE_STATUS).doc(uid).get();
    assert.equal(saved.get("status"), "verified");
    assert.equal(saved.get("reason"), undefined);
    assert.equal(user.get("surgePlan"), "premium");
    assert.equal(user.get("subscriptionExpiresAt").toMillis(), expiresMs);
    assert.equal(user.get("subscriptionPeriodStart").toMillis(), purchaseMs);
    assert.equal(user.get("surgeUnlimitedUntil"), undefined);
    assert.equal(status.get("tier"), "premium");
    assert.equal(status.get("periodEndsAt").toMillis(), purchaseMs + WEEK);
    assert.equal(status.get("allowance"), 10);
  });

  it("verifies stardust and sets surgeUnlimitedUntil to the expiry", async () => {
    const uid = "buyer_star";
    const purchaseMs = NOW.getTime();
    const expiresMs = purchaseMs + WEEK;
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Star"});
    await purchase("tx_star", uid, SURGE_PRODUCT_STARDUST, sandboxPayload({
      transactionId: "tx_star",
      productId: SURGE_PRODUCT_STARDUST,
      appAccountToken: surgeAccountToken(uid),
      purchaseDateMs: purchaseMs,
      expiresDateMs: expiresMs,
    }));
    const user = await db.collection("users").doc(uid).get();
    assert.equal((await db.collection("surgePurchaseRequests").doc("tx_star").get()).get("status"), "verified");
    assert.equal(user.get("surgePlan"), "stardust");
    assert.equal(user.get("surgeUnlimitedUntil").toMillis(), expiresMs);
  });

  it("adds one purchased credit and shows purchasedLeft before any unlock", async () => {
    const uid = "buyer_single";
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Single"});
    await purchase("tx_single", uid, SURGE_PRODUCT_SINGLE, sandboxPayload({
      transactionId: "tx_single",
      productId: SURGE_PRODUCT_SINGLE,
      appAccountToken: surgeAccountToken(uid),
      purchaseDateMs: NOW.getTime(),
    }));
    const credit = await db.collection("users").doc(uid).collection(SURGE_LEDGER).doc(purchaseCreditId("tx_single")).get();
    const status = await db.collection(SURGE_STATUS).doc(uid).get();
    assert.equal((await db.collection("surgePurchaseRequests").doc("tx_single").get()).get("status"), "verified");
    assert.equal(credit.get("kind"), "purchase");
    assert.equal(credit.get("source"), "purchased");
    assert.equal(status.get("purchasedLeft"), 1);
    assert.equal((await db.collection("users").doc(uid).get()).get("surgePlan"), undefined);
  });

  it("rejects a bad signature, the wrong bundle, Production, and the wrong account token", async () => {
    const uid = "buyer_bad";
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Bad"});
    const good = sandboxPayload({
      transactionId: "tx_bad_sig",
      productId: SURGE_PRODUCT_PREMIUM,
      appAccountToken: surgeAccountToken(uid),
      purchaseDateMs: NOW.getTime(),
      expiresDateMs: NOW.getTime() + WEEK,
    });
    const signed = keys.sign(good);
    const broken = `${signed.slice(0, -4)}AAAA`;
    const ref = db.collection("surgePurchaseRequests").doc("tx_bad_sig");
    await ref.set({
      uid,
      productId: SURGE_PRODUCT_PREMIUM,
      signedTransaction: broken,
      status: "pending",
      createdAt: Timestamp.fromDate(NOW),
    });
    await handleSurgePurchaseRequest(db, ref, verifier, NOW);
    assert.equal((await ref.get()).get("reason"), "bad_signature");

    await purchase("tx_bundle", uid, SURGE_PRODUCT_PREMIUM, sandboxPayload({
      ...good,
      transactionId: "tx_bundle",
      bundleId: "com.example.Other",
    }));
    assert.equal((await db.collection("surgePurchaseRequests").doc("tx_bundle").get()).get("reason"), "wrong_bundle");

    await purchase("tx_prod", uid, SURGE_PRODUCT_PREMIUM, sandboxPayload({
      ...good,
      transactionId: "tx_prod",
      environment: "Production",
    }));
    assert.equal((await db.collection("surgePurchaseRequests").doc("tx_prod").get()).get("reason"), "production_environment");

    await purchase("tx_token", uid, SURGE_PRODUCT_PREMIUM, sandboxPayload({
      ...good,
      transactionId: "tx_token",
      appAccountToken: surgeAccountToken("someone-else"),
    }));
    assert.equal(
      (await db.collection("surgePurchaseRequests").doc("tx_token").get()).get("reason"),
      "app_account_token_mismatch",
    );
    assert.equal((await db.collection("users").doc(uid).get()).get("surgePlan"), undefined);
  });

  it("does not grant a second credit when the same transaction is replayed", async () => {
    const uid = "buyer_replay";
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Replay"});
    await purchase("tx_replay", uid, SURGE_PRODUCT_SINGLE, sandboxPayload({
      transactionId: "tx_replay",
      productId: SURGE_PRODUCT_SINGLE,
      appAccountToken: surgeAccountToken(uid),
      purchaseDateMs: NOW.getTime(),
    }));
    const ref = db.collection("surgePurchaseRequests").doc("tx_replay");
    await ref.update({status: "pending"});
    await handleSurgePurchaseRequest(db, ref, verifier, NOW);
    const ledger = await db.collection("users").doc(uid).collection(SURGE_LEDGER).get();
    assert.equal((await ref.get()).get("status"), "verified");
    assert.equal(ledger.docs.filter((entry) => entry.get("kind") === "purchase").length, 1);
  });

  it("fails when another uid replays a transaction that was already claimed", async () => {
    const ref = db.collection("surgePurchaseRequests").doc("tx_replay");
    await ref.update({
      uid: "buyer_other",
      status: "pending",
      signedTransaction: keys.sign(sandboxPayload({
        transactionId: "tx_replay",
        productId: SURGE_PRODUCT_SINGLE,
        appAccountToken: surgeAccountToken("buyer_other"),
        purchaseDateMs: NOW.getTime(),
      })),
    });
    await handleSurgePurchaseRequest(db, ref, verifier, NOW);
    const saved = await ref.get();
    const other = await db.collection("users").doc("buyer_other").collection(SURGE_LEDGER).get();
    assert.equal(saved.get("status"), "failed");
    assert.equal(saved.get("reason"), "already_claimed");
    assert.equal(other.size, 0);
    assert.equal((await db.collection(SURGE_PURCHASE_CLAIMS).doc("tx_replay").get()).get("uid"), "buyer_replay");
  });

  it("spends the period allowance before the purchased credit", async () => {
    await enableSpend();
    const uid = "buyer_order";
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Order"});
    await purchase("tx_order", uid, SURGE_PRODUCT_SINGLE, sandboxPayload({
      transactionId: "tx_order",
      productId: SURGE_PRODUCT_SINGLE,
      appAccountToken: surgeAccountToken(uid),
      purchaseDateMs: NOW.getTime(),
    }));
    assert.equal((await db.collection(SURGE_STATUS).doc(uid).get()).get("purchasedLeft"), 1);
    for (let index = 1; index <= 3; index++) {
      await unlock(`req_order_${index}`, uid, `sum_order_${index}`, `sheet_order_${index}`);
      assert.equal(
        (await db.collection("hotspotUnlockRequests").doc(`req_order_${index}`).get()).get("status"),
        "done",
      );
    }
    const afterAllowance = await db.collection("users").doc(uid).collection(SURGE_LEDGER).get();
    const allowanceSpends = afterAllowance.docs.filter((entry) => entry.get("source") === "allowance");
    assert.equal(allowanceSpends.length, 3);
    assert.equal((await db.collection(SURGE_STATUS).doc(uid).get()).get("purchasedLeft"), 1);
    await unlock("req_order_single", uid, "sum_order_single", "sheet_order_single");
    const spent = await db.collection("users").doc(uid).collection(SURGE_LEDGER).doc("spend_req_order_single").get();
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_order_single").get()).get("status"), "done");
    assert.equal(spent.get("source"), "purchased");
    assert.equal((await db.collection(SURGE_STATUS).doc(uid).get()).get("purchasedLeft"), 0);
    await unlock("req_order_stop", uid, "sum_order_stop", "sheet_order_stop");
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_order_stop").get()).get("reason"), "no_credit");
  });

  it("keeps a purchased credit across a free month rollover", async () => {
    const uid = "buyer_roll";
    const october = new Date("2026-10-31T23:59:00.000Z");
    const november = new Date("2026-11-01T00:00:00.000Z");
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Roll"});
    const ref = db.collection("surgePurchaseRequests").doc("tx_roll");
    await ref.set({
      uid,
      productId: SURGE_PRODUCT_SINGLE,
      signedTransaction: keys.sign(sandboxPayload({
        transactionId: "tx_roll",
        productId: SURGE_PRODUCT_SINGLE,
        appAccountToken: surgeAccountToken(uid),
        purchaseDateMs: october.getTime(),
      })),
      status: "pending",
      createdAt: Timestamp.fromDate(october),
    });
    await handleSurgePurchaseRequest(db, ref, verifier, october);
    assert.equal((await db.collection(SURGE_STATUS).doc(uid).get()).get("purchasedLeft"), 1);
    await unlock("req_roll_nov", uid, "sum_roll_nov", "sheet_roll_nov", november);
    const credit = await db.collection("users").doc(uid).collection(SURGE_LEDGER).doc(purchaseCreditId("tx_roll")).get();
    const spend = await db.collection("users").doc(uid).collection(SURGE_LEDGER).doc("spend_req_roll_nov").get();
    const status = await db.collection(SURGE_STATUS).doc(uid).get();
    assert.equal(credit.exists, true);
    assert.equal(spend.get("source"), "allowance");
    assert.equal(spend.get("period"), "2026-11");
    assert.equal(status.get("purchasedLeft"), 1);
    assert.equal(status.get("periodKey"), "2026-11");
  });

  it("stays off and grants nothing when the purchase switch is missing", async () => {
    await db.doc(SURGE_PURCHASES_DOC).delete();
    const uid = "buyer_off";
    await db.collection("users").doc(uid).set({activeDeviceId: DEVICE, name: "Off"});
    await purchase("tx_off", uid, SURGE_PRODUCT_SINGLE, sandboxPayload({
      transactionId: "tx_off",
      productId: SURGE_PRODUCT_SINGLE,
      appAccountToken: surgeAccountToken(uid),
      purchaseDateMs: NOW.getTime(),
    }));
    const saved = await db.collection("surgePurchaseRequests").doc("tx_off").get();
    const ledger = await db.collection("users").doc(uid).collection(SURGE_LEDGER).get();
    assert.equal(saved.get("status"), "failed");
    assert.equal(saved.get("reason"), "flag_off");
    assert.equal(ledger.size, 0);
  });
});
