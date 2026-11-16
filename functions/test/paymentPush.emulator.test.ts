import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";
import type {Message} from "firebase-admin/messaging";
import {applyJobOutcome, ensureAuthorityJob, followPaymentStatus} from "../src/parking/authorityJobs";
import {deliverNotification, type NoticeDelivery} from "../src/parking/notices";
import {clearFcmToken, readFcmToken} from "../src/parking/paymentPush";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-payment-push";
const db = testDb(PROJECT);

function fcmError(code: string): Error {
  const err = new Error(code);
  err.name = "FirebaseMessagingError";
  return Object.assign(err, {code, errorInfo: {code}});
}

async function seedFunding(reservedPence = 0): Promise<void> {
  await db.doc("funding/state").set({
    balancePence: 100_000,
    reservedPence,
    spentTodayPence: 0,
    spentDay: "2026-11-16",
    dailyCapPence: 200_000,
    lowWaterPence: 10_000,
    paused: false,
    lowWaterAlerted: false,
    lowWaterGeneration: 0,
    pauseGeneration: 0,
  });
}

async function seedPayment(id: string, data: Record<string, unknown>): Promise<void> {
  await db.collection("parkingPayments").doc(id).set({
    status: "paid",
    uid: "alice",
    paymentIntentId: id,
    currency: "gbp",
    paymentUrl: "https://tfl.gov.uk/modes/driving/pay-to-drive-in-london",
    zone: "London",
    occurredOn: "2026-11-16",
    ...data,
  });
}

function capture(): {sent: Message[]; deps: NoticeDelivery} {
  const sent: Message[] = [];
  const deps: NoticeDelivery = {
    sendEmail: async () => {
      throw new Error("email");
    },
    postSlack: async () => {
      throw new Error("slack");
    },
    emailForUid: async () => {
      throw new Error("lookup");
    },
    tokenForUid: (uid) => readFcmToken(db, uid),
    clearToken: (uid) => clearFcmToken(db, uid),
    sendPush: async (message) => {
      sent.push(message);
    },
  };
  return {sent, deps};
}

describe("payment push outbox", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(db);
  });

  it("writes one paid push from the payment document, and a retry does not write another", async () => {
    await seedFunding();
    await seedPayment("pi_paid1", {
      amount: 610,
      authorityPence: 450,
      feePence: 160,
      chargeType: "parking",
      placeId: "place-1",
    });
    await ensureAuthorityJob(db, "pi_paid1");
    await ensureAuthorityJob(db, "pi_paid1");

    const email = await db.collection("paymentNotifications").doc("pi_paid1:paid").get();
    const push = await db.collection("paymentNotifications").doc("pi_paid1:paid:push").get();
    assert.equal(email.get("channel"), "email");
    assert.match(String(email.get("text")), /^We've taken your Ferro Maps payment\./);
    assert.equal(push.get("channel"), "push");
    assert.equal(push.get("payloadStatus"), "paid");
    assert.equal(push.get("placeId"), "place-1");
    assert.equal(push.get("text"), "We've taken £6.10 for your parking charge.");
    const pushes = await db.collection("paymentNotifications").where("channel", "==", "push").get();
    assert.equal(pushes.size, 1);
  });

  it("does not invent a charge type when the payment document has none", async () => {
    await seedFunding();
    await seedPayment("pi_notype", {amount: 500, authorityPence: 340});
    await ensureAuthorityJob(db, "pi_notype");
    assert.equal((await db.collection("paymentNotifications").doc("pi_notype:paid").get()).exists, true);
    assert.equal((await db.collection("paymentNotifications").doc("pi_notype:paid:push").get()).exists, false);
  });

  it("sends fulfilled and refunded pushes with the recorded amounts", async () => {
    await seedFunding();
    await seedPayment("pi_ful1", {
      amount: 1410,
      authorityPence: 1250,
      feePence: 160,
      chargeType: "congestion",
      placeId: "london-cc",
    });
    await ensureAuthorityJob(db, "pi_ful1");
    await applyJobOutcome(db, "pi_ful1", {
      jobOutcome: "fulfilled",
      authorityReference: "TFL-100",
      authorityChargedPence: 1000,
    });
    await applyJobOutcome(db, "pi_ful1", {
      jobOutcome: "fulfilled",
      authorityReference: "TFL-100",
      authorityChargedPence: 1000,
    });

    const fulfilled = await db.collection("paymentNotifications").doc("pi_ful1:fulfilled:push").get();
    const partial = await db.collection("paymentNotifications").doc("pi_ful1:partial_refund:push").get();
    assert.equal(fulfilled.get("payloadStatus"), "fulfilled");
    assert.equal(fulfilled.get("text"), "We've paid the £10.00 congestion charge to the authority.");
    assert.equal(fulfilled.get("placeId"), "london-cc");
    assert.equal(partial.get("payloadStatus"), "partially_refunded");
    assert.equal(partial.get("text"), "We've refunded £2.50 of your congestion charge.");
    assert.equal((await db.collection("paymentNotifications").doc("pi_ful1:fulfilled").get()).get("channel"), "email");

    await seedPayment("pi_ref1", {
      amount: 999,
      authorityPence: 200,
      feePence: 160,
      chargeType: "ulez",
      placeId: "ulez-1",
    });
    await ensureAuthorityJob(db, "pi_ref1");
    await applyJobOutcome(db, "pi_ref1", {jobOutcome: "failed"});
    await applyJobOutcome(db, "pi_ref1", {jobOutcome: "failed"});
    const refunded = await db.collection("paymentNotifications").doc("pi_ref1:refunded:push").get();
    assert.equal(refunded.get("payloadStatus"), "refunded");
    assert.equal(refunded.get("text"), "We've refunded £9.99 for your ULEZ charge.");
    assert.equal(String(refunded.get("text")).includes("£3.60"), false);
  });

  it("writes one refund push when a closed job is refunded from Stripe", async () => {
    await seedFunding();
    await seedPayment("pi_ext1", {
      amount: 860,
      authorityPence: 700,
      chargeType: "tunnel",
      placeId: "blackwall",
    });
    await db.collection("authorityPayments").doc("pi_ext1").set({
      status: "fulfilled",
      uid: "alice",
      chargeType: "tunnel",
      authorityPence: 700,
      driverAmountPence: 860,
      feePence: 160,
      zone: "Blackwall",
      occurredOn: "2026-11-16",
      paymentUrl: "https://tfl.gov.uk/modes/driving/pay-to-drive-in-london",
    });
    await followPaymentStatus(db, "pi_ext1", "paid", "refunded");
    await followPaymentStatus(db, "pi_ext1", "paid", "refunded");
    const push = await db.collection("paymentNotifications").doc("pi_ext1:refunded:push").get();
    assert.equal(push.get("text"), "We've refunded £8.60 for your tunnel charge.");
    assert.equal(push.get("placeId"), "blackwall");
    const pushes = (await db.collection("paymentNotifications").get()).docs
      .filter((doc) => doc.get("channel") === "push" && doc.get("paymentIntentId") === "pi_ext1");
    assert.equal(pushes.length, 1);
    assert.equal((await db.collection("paymentNotifications").doc("pi_ext1:refunded").get()).get("channel"), "email");
  });

  it("sends one push per notice and skips a missing or invalid token", async () => {
    await db.collection("users").doc("alice").set({fcmToken: "device-token", email: "ada@example.com"});
    await db.collection("parkingPayments").doc("pi_send1").set({
      status: "paid", uid: "alice", amount: 610, chargeType: "parking",
    });
    await db.collection("paymentNotifications").doc("pi_send1:paid:push").set({
      channel: "push",
      event: "paid",
      subject: "Payment taken",
      text: "We've taken £6.10 for your parking charge.",
      payloadStatus: "paid",
      paymentIntentId: "pi_send1",
      placeId: "place-1",
      uid: "alice",
      status: "pending",
    });
    const {sent, deps} = capture();
    await deliverNotification(db, "pi_send1:paid:push", deps);
    await deliverNotification(db, "pi_send1:paid:push", deps);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.data?.type, "parking_payment");
    assert.equal(sent[0]?.data?.paymentId, "pi_send1");
    assert.equal(sent[0]?.data?.status, "paid");
    assert.equal(sent[0]?.data?.placeId, "place-1");
    assert.equal(sent[0]?.notification?.title, "Payment taken");
    assert.equal((await db.collection("paymentNotifications").doc("pi_send1:paid:push").get()).get("status"), "sent");
    const payment = await db.collection("parkingPayments").doc("pi_send1").get();
    assert.equal(payment.get("notifiedTitle"), "Payment taken");
    assert.equal(payment.get("notifiedBody"), "We've taken £6.10 for your parking charge.");

    await db.collection("paymentNotifications").doc("pi_send1:refunded:push").set({
      channel: "push",
      event: "refunded",
      subject: "Payment refunded",
      text: "We've refunded £6.10 for your parking charge.",
      payloadStatus: "refunded",
      paymentIntentId: "pi_send1",
      uid: "alice",
      status: "pending",
    });
    await db.collection("users").doc("alice").set({email: "ada@example.com"});
    const missing = capture();
    await deliverNotification(db, "pi_send1:refunded:push", missing.deps);
    assert.equal(missing.sent.length, 0);
    assert.equal(
      (await db.collection("paymentNotifications").doc("pi_send1:refunded:push").get()).get("pushSkipped"),
      "missing-token",
    );
    assert.equal((await db.collection("parkingPayments").doc("pi_send1").get()).get("notifiedTitle"), "Payment taken");

    await db.collection("users").doc("alice").update({fcmToken: "bad token"});
    await db.collection("paymentNotifications").doc("pi_send1:fulfilled:push").set({
      channel: "push",
      event: "fulfilled",
      subject: "Authority payment done",
      text: "We've paid the £4.50 parking charge to the authority.",
      payloadStatus: "fulfilled",
      paymentIntentId: "pi_send1",
      uid: "alice",
      status: "pending",
    });
    const invalid = capture();
    await deliverNotification(db, "pi_send1:fulfilled:push", invalid.deps);
    assert.equal(invalid.sent.length, 0);
    assert.equal((await db.collection("users").doc("alice").get()).get("fcmToken"), "bad token");
    assert.equal(
      (await db.collection("paymentNotifications").doc("pi_send1:fulfilled:push").get()).get("pushSkipped"),
      "invalid-token",
    );
  });

  it("clears a dead token the way the mobile sender does, and retries a transient failure once", async () => {
    await db.collection("users").doc("alice").set({fcmToken: "stale-token"});
    await db.collection("parkingPayments").doc("pi_dead1").set({
      status: "paid", uid: "alice", amount: 610, chargeType: "parking",
    });
    await db.collection("paymentNotifications").doc("pi_dead1:paid:push").set({
      channel: "push",
      event: "paid",
      subject: "Payment taken",
      text: "We've taken £6.10 for your parking charge.",
      payloadStatus: "paid",
      paymentIntentId: "pi_dead1",
      uid: "alice",
      status: "pending",
    });
    let sent = 0;
    const deps: NoticeDelivery = {
      sendEmail: async () => undefined,
      postSlack: async () => undefined,
      emailForUid: async () => null,
      tokenForUid: (uid) => readFcmToken(db, uid),
      clearToken: (uid) => clearFcmToken(db, uid),
      sendPush: async () => {
        sent += 1;
        throw fcmError("messaging/registration-token-not-registered");
      },
    };
    await deliverNotification(db, "pi_dead1:paid:push", deps);
    await deliverNotification(db, "pi_dead1:paid:push", deps);
    assert.equal(sent, 1);
    assert.equal((await db.collection("users").doc("alice").get()).get("fcmToken"), undefined);
    assert.equal((await db.collection("parkingPayments").doc("pi_dead1").get()).get("notifiedTitle"), undefined);
    assert.equal(
      (await db.collection("paymentNotifications").doc("pi_dead1:paid:push").get()).get("pushSkipped"),
      "unregistered",
    );

    await db.collection("users").doc("bob").set({fcmToken: "bob-token"});
    await db.collection("paymentNotifications").doc("pi_dead2:refunded:push").set({
      channel: "push",
      event: "refunded",
      subject: "Payment refunded",
      text: "We've refunded £6.10 for your parking charge.",
      payloadStatus: "refunded",
      paymentIntentId: "pi_dead2",
      uid: "bob",
      status: "pending",
    });
    const invalidToken = capture();
    invalidToken.deps.sendPush = async () => {
      throw fcmError("messaging/invalid-registration-token");
    };
    await deliverNotification(db, "pi_dead2:refunded:push", invalidToken.deps);
    assert.equal((await db.collection("users").doc("bob").get()).get("fcmToken"), undefined);

    await db.collection("users").doc("cara").set({fcmToken: "cara-token"});
    await db.collection("parkingPayments").doc("pi_retry1").set({
      status: "refunded", uid: "cara", amount: 610, chargeType: "parking",
    });
    await db.collection("paymentNotifications").doc("pi_retry1:refunded:push").set({
      channel: "push",
      event: "refunded",
      subject: "Payment refunded",
      text: "We've refunded £6.10 for your parking charge.",
      payloadStatus: "refunded",
      paymentIntentId: "pi_retry1",
      uid: "cara",
      status: "pending",
    });
    let attempts = 0;
    const retry = capture();
    retry.deps.tokenForUid = (uid) => readFcmToken(db, uid);
    retry.deps.sendPush = async (message) => {
      attempts += 1;
      if (attempts === 1) throw fcmError("messaging/internal");
      retry.sent.push(message);
    };
    await assert.rejects(() => deliverNotification(db, "pi_retry1:refunded:push", retry.deps));
    assert.equal((await db.collection("paymentNotifications").doc("pi_retry1:refunded:push").get()).get("status"), "pending");
    assert.equal((await db.collection("users").doc("cara").get()).get("fcmToken"), "cara-token");
    await deliverNotification(db, "pi_retry1:refunded:push", retry.deps);
    assert.equal(attempts, 2);
    assert.equal(retry.sent.length, 1);
    assert.equal((await db.collection("paymentNotifications").doc("pi_retry1:refunded:push").get()).get("status"), "sent");
    assert.equal((await db.collection("parkingPayments").doc("pi_retry1").get()).get("notifiedTitle"), "Payment refunded");
  });

  it("does not send again when a previous attempt already reached FCM", async () => {
    await db.collection("users").doc("alice").set({fcmToken: "device-token"});
    await db.collection("parkingPayments").doc("pi_once").set({
      status: "paid", uid: "alice", amount: 610, chargeType: "parking",
    });
    await db.collection("paymentNotifications").doc("pi_once:paid:push").set({
      channel: "push",
      event: "paid",
      subject: "Payment taken",
      text: "We've taken £6.10 for your parking charge.",
      payloadStatus: "paid",
      paymentIntentId: "pi_once",
      uid: "alice",
      status: "sending",
      pushSent: true,
    });
    const {sent, deps} = capture();
    await deliverNotification(db, "pi_once:paid:push", deps);
    assert.equal(sent.length, 0);
    assert.equal((await db.collection("paymentNotifications").doc("pi_once:paid:push").get()).get("status"), "sent");
    assert.equal((await db.collection("parkingPayments").doc("pi_once").get()).get("notifiedBody"),
      "We've taken £6.10 for your parking charge.");
  });
});
