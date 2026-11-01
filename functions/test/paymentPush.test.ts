import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  buildParkingPaymentMessage,
  deliverParkingPaymentPush,
  paidBody,
  type ParkingPushClaim,
  type ParkingPushMessage,
} from "../src/parking/paymentPush.js";
import {commitPaymentStatus} from "../src/parking/payments.js";
import {clearDb, testDb} from "./support.js";

const PROJECT = "demo-ferromaps-payment-push";

function claim(status: ParkingPushClaim["status"], placeId = "place-1"): ParkingPushClaim {
  return {paymentId: "pi_push1", uid: "alice", placeId, status};
}

function assertNoAmount(message: ParkingPushMessage): void {
  const encoded = JSON.stringify(message);
  for (const banned of ["450", "160", "610", "£", "pence", "amount", "fee"]) {
    assert.equal(encoded.includes(banned), false, banned);
  }
  assert.deepEqual(Object.keys(message.data).sort(), ["paymentId", "placeId", "status", "type"]);
}

async function seedPayment(status = "created", id = "pi_push1"): Promise<void> {
  const db = testDb(PROJECT);
  await db.collection("parkingPayments").doc(id).set({
    v: 1,
    status,
    amount: 610,
    currency: "gbp",
    placeId: "place-1",
    visitId: "visit-1",
    operator: "RingGo",
    uid: "alice",
    requestId: "req-1",
    paymentIntentId: id,
    parkingPence: 450,
    feePence: 160,
    plateRegisteredAt: Timestamp.fromMillis(1),
    failureReason: null,
    createdAt: Timestamp.fromMillis(1),
    updatedAt: Timestamp.fromMillis(1),
  });
}

describe("parking payment push copy", () => {
  it("uses the place name when the server has one, and omits it otherwise", () => {
    const named = buildParkingPaymentMessage({
      token: "tok",
      claim: claim("paid"),
      placeName: "Acton Yard",
    });
    assert.equal(named.notification.title, "Parking paid");
    assert.equal(named.notification.body, "Acton Yard. You're all set.");
    assert.equal(named.apns.payload.aps.alert.body, named.notification.body);
    assert.equal(paidBody(null), "You're all set.");
    const unnamed = buildParkingPaymentMessage({
      token: "tok",
      claim: claim("paid"),
      placeName: null,
    });
    assert.equal(unnamed.notification.body, "You're all set.");
    const failed = buildParkingPaymentMessage({
      token: "tok",
      claim: claim("failed"),
      placeName: "Acton Yard",
    });
    const canceled = buildParkingPaymentMessage({
      token: "tok",
      claim: claim("canceled"),
      placeName: "Acton Yard",
    });
    assert.equal(failed.notification.title, "Payment didn't go through");
    assert.equal(failed.notification.body, "You haven't been charged. Tap to try again.");
    assert.equal(canceled.notification.title, "Payment cancelled");
    assert.equal(canceled.notification.body, "You haven't been charged.");
    assert.equal(canceled.data.status, "canceled");
    assert.equal(failed.data.status, "failed");
    for (const message of [named, unnamed, failed, canceled]) assertNoAmount(message);
  });
});

describe("parking payment push delivery", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    await clearDb(testDb(PROJECT));
  });

  function recorder(): {messages: ParkingPushMessage[]; send: (claim: ParkingPushClaim) => Promise<void>} {
    const messages: ParkingPushMessage[] = [];
    return {
      messages,
      async send(claimToSend: ParkingPushClaim): Promise<void> {
        await deliverParkingPaymentPush(testDb(PROJECT), claimToSend, {
          async send(message: ParkingPushMessage): Promise<void> {
            messages.push(message);
          },
        });
      },
    };
  }

  it("sends one push when status first becomes paid, failed, or canceled", async () => {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await db.collection("places").doc("place-1").set({name: "Acton Yard", payMode: "inapp", parkingPence: 450});
    await seedPayment();
    const paid = recorder();
    assert.equal(await commitPaymentStatus(db, "pi_push1", "paid", paid.send), "paid");
    assert.equal(await commitPaymentStatus(db, "pi_push1", "paid", paid.send), "paid");
    assert.equal(paid.messages.length, 1);
    assert.equal(paid.messages[0].data.status, "paid");
    assert.equal(paid.messages[0].notification.body, "Acton Yard. You're all set.");
    assert.equal(paid.messages[0].token, "tok-alice");
    assertNoAmount(paid.messages[0]);
    assert.equal((await db.collection("parkingPayments").doc("pi_push1").get()).get("notifiedStatus"), "paid");

    await seedPayment("created", "pi_fail");
    const failed = recorder();
    assert.equal(await commitPaymentStatus(db, "pi_fail", "failed", failed.send), "failed");
    assert.equal(failed.messages.length, 1);
    assert.equal(failed.messages[0].data.status, "failed");
    assert.equal(failed.messages[0].notification.body, "You haven't been charged. Tap to try again.");
    assertNoAmount(failed.messages[0]);

    await seedPayment("created", "pi_cancel");
    const canceled = recorder();
    assert.equal(await commitPaymentStatus(db, "pi_cancel", "canceled", canceled.send), "canceled");
    assert.equal(canceled.messages.length, 1);
    assert.equal(canceled.messages[0].data.status, "canceled");
    assert.equal(canceled.messages[0].notification.title, "Payment cancelled");
    assert.equal(canceled.messages[0].notification.body, "You haven't been charged.");
    assert.deepEqual(canceled.messages[0].data, {
      type: "parking_payment",
      paymentId: "pi_cancel",
      placeId: "place-1",
      status: "canceled",
    });
    assertNoAmount(canceled.messages[0]);
  });

  it("uses n when name is absent, and sends You're all set when neither is set", async () => {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await db.collection("places").doc("place-1").set({n: "Named Yard"});
    await seedPayment("created", "pi_n");
    const named = recorder();
    await commitPaymentStatus(db, "pi_n", "paid", named.send);
    assert.equal(named.messages[0].notification.body, "Named Yard. You're all set.");

    await db.collection("places").doc("place-1").set({payMode: "inapp", parkingPence: 450});
    await seedPayment("created", "pi_noname");
    const bare = recorder();
    await commitPaymentStatus(db, "pi_noname", "paid", bare.send);
    assert.equal(bare.messages[0].notification.body, "You're all set.");
    assertNoAmount(bare.messages[0]);
  });

  it("does not push for processing, refunds, or a repeat of a status that was not a first entry", async () => {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await seedPayment();
    const sent = recorder();
    assert.equal(await commitPaymentStatus(db, "pi_push1", "processing", sent.send), "processing");
    assert.equal(await commitPaymentStatus(db, "pi_push1", "refund_pending", sent.send), "refund_pending");
    assert.equal(sent.messages.length, 0);
    assert.equal((await db.collection("parkingPayments").doc("pi_push1").get()).get("notifiedAt"), undefined);
  });

  it("sends one push when confirm and the reconciler race into paid", async () => {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await db.collection("places").doc("place-1").set({name: "Acton Yard"});
    await seedPayment();
    const sent = recorder();
    const results = await Promise.all([
      commitPaymentStatus(db, "pi_push1", "paid", sent.send),
      commitPaymentStatus(db, "pi_push1", "paid", sent.send),
    ]);
    assert.deepEqual(results.sort(), ["paid", "paid"]);
    assert.equal(sent.messages.length, 1);
    assert.equal((await db.collection("parkingPayments").doc("pi_push1").get()).get("status"), "paid");
  });

  it("keeps the paid status when the push throws, and removes an unregistered token", async () => {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({fcmToken: "tok-stale"});
    await db.collection("places").doc("place-1").set({name: "Acton Yard"});
    await seedPayment();
    const status = await commitPaymentStatus(db, "pi_push1", "paid", async (claim) => {
      await deliverParkingPaymentPush(db, claim, {
        async send(): Promise<void> {
          const err = new Error("unregistered");
          Object.assign(err, {code: "messaging/registration-token-not-registered"});
          throw err;
        },
      });
    });
    assert.equal(status, "paid");
    assert.equal((await db.collection("parkingPayments").doc("pi_push1").get()).get("status"), "paid");
    assert.equal((await db.collection("parkingPayments").doc("pi_push1").get()).get("notifiedStatus"), "paid");
    assert.equal((await db.collection("users").doc("alice").get()).get("fcmToken"), undefined);
  });
});
