import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {EXPECTED_STRIPE_ACCOUNT_ID} from "../src/parking/stripeClient";
import {refundIdempotencyKey} from "../src/parking/contract";
import {runParkingPaymentRequest, type ParkingStripe, type PaymentIntentShape} from "../src/parking/payments";
import {handleAuthorityAction, handleFundingTopUp, expireDueAuthorityJobs} from "../src/parking/authorityDesk";
import {ensureAuthorityJob} from "../src/parking/authorityJobs";
import {deliverNotification} from "../src/parking/notices";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-authority";
const PUBLISHABLE = "pk_test_example";

function shape(over: Partial<PaymentIntentShape> = {}): PaymentIntentShape {
  return {
    id: "pi_job1",
    client_secret: "pi_job1_secret",
    status: "requires_payment_method",
    amount: 610,
    currency: "gbp",
    customer: "cus_test",
    ...over,
  };
}

function mockStripe(payment: PaymentIntentShape) {
  const creates: {params: {transfer_data?: unknown; amount?: number}; options: {idempotencyKey: string}}[] = [];
  const refunds: {amount: number; key: string}[] = [];
  const stripe: ParkingStripe = {
    customers: {create: async () => ({id: "cus_test"})},
    paymentIntents: {
      create: async (params, options) => {
        creates.push({params, options});
        return {...payment, amount: params.amount ?? payment.amount};
      },
      retrieve: async (id) => ({...payment, id}),
      cancel: async (id) => ({...payment, id, status: "canceled"}),
    },
    ephemeralKeys: {create: async () => ({secret: "ek_test"})},
  };
  return {
    stripe,
    creates,
    refunds,
    refundClient: {
      refunds: {
        create: async (params: {amount: number}, options: {idempotencyKey: string}) => {
          refunds.push({amount: params.amount, key: options.idempotencyKey});
          return {id: "re_test"};
        },
      },
    },
  };
}

async function seed(balancePence: number, paused = false): Promise<void> {
  const db = testDb(PROJECT);
  await db.collection("places").doc("place-1").set({
    payMode: "inapp",
    operator: "RingGo",
    locationCode: "12345",
    name: "Yard",
    parkingPence: 450,
    paymentUrl: "https://www.myringgo.com/location/12345",
  });
  await db.doc("config/parkingPayments").set({
    enabled: true,
    testMode: true,
    stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
  });
  await db.doc("funding/state").set({
    balancePence,
    reservedPence: 0,
    spentTodayPence: 0,
    spentDay: "2026-11-15",
    dailyCapPence: 200_000,
    lowWaterPence: 10_000,
    paused,
    lowWaterAlerted: false,
    lowWaterGeneration: 0,
    pauseGeneration: 0,
  });
}

async function createParking(stripe: ParkingStripe, visitId = "visit-1"): Promise<void> {
  const db = testDb(PROJECT);
  const ref = db.collection("parkingPaymentRequests").doc(`req-${visitId}`);
  await ref.set({
    uid: "alice", v: 1, action: "create", placeId: "place-1", visitId, operator: "RingGo",
    plate: "AB12 CDE", platform: "ios", appVersion: "1.4.0", status: "pending",
    createdAt: Timestamp.now(),
  });
  await runParkingPaymentRequest(db, stripe, ref, PUBLISHABLE);
}

describe("authority payments", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  it("refuses a new parking payment while funding is paused and refuses a road charge", async () => {
    const db = testDb(PROJECT);
    await seed(100_000, true);
    const mocked = mockStripe(shape());
    await createParking(mocked.stripe);
    const refused = (await db.collection("parkingPaymentRequests").doc("req-visit-1").get()).data();
    assert.equal(refused?.status, "error");
    assert.equal(refused?.errorCode, "failed-precondition");
    assert.equal(mocked.creates.length, 0);

    const ref = db.collection("parkingPaymentRequests").doc("req-ulez");
    await ref.set({
      uid: "alice", v: 1, action: "create", chargeType: "ulez", plate: "AB12CDE",
      platform: "ios", appVersion: "1.4.0", status: "pending", createdAt: Timestamp.now(),
      authorityPence: 1250, zone: "London ULEZ", occurredOn: "2026-11-15",
      paymentUrl: "https://tfl.gov.uk/modes/driving/pay-to-drive-in-london",
      deadlineAt: Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000),
      reference: "ULEZ-1",
    });
    await runParkingPaymentRequest(db, mocked.stripe, ref, PUBLISHABLE);
    const held = (await ref.get()).data();
    assert.equal(held?.status, "error");
    assert.equal(held?.errorCode, "failed-precondition");
    assert.equal(held?.plate, undefined);
    assert.equal(mocked.creates.length, 0);
    assert.equal((await db.collection("parkingPayments").get()).size, 0);
  });

  it("reserves once when the job fits, and a second success does not reserve again", async () => {
    const db = testDb(PROJECT);
    await seed(100_000, false);
    const payment = shape();
    const mocked = mockStripe(payment);
    await createParking(mocked.stripe);
    payment.status = "succeeded";
    const confirm = db.collection("parkingPaymentRequests").doc("pi_job1_confirm");
    await confirm.set({
      v: 1, action: "confirm", status: "pending", createdAt: Timestamp.now(), uid: "alice",
      paymentId: "pi_job1", paymentIntentId: "pi_job1", originalRequestId: "req-visit-1",
    });
    await runParkingPaymentRequest(db, mocked.stripe, confirm, PUBLISHABLE);
    await ensureAuthorityJob(db, "pi_job1");

    const job = (await db.collection("authorityPayments").doc("pi_job1").get()).data();
    assert.equal(job?.status, "open");
    assert.equal(job?.plate, "AB12CDE");
    assert.equal(job?.authorityPence, 450);
    assert.equal(job?.feePence, 167);
    assert.equal(job?.stripeChargePence, 7);
    assert.equal(job?.zone, "Yard");
    assert.equal(job?.paymentUrl, "https://www.myringgo.com/location/12345");
    assert.equal(JSON.stringify(job).includes("4111"), false);
    const paymentDoc = (await db.collection("parkingPayments").doc("pi_job1").get()).data();
    assert.equal(paymentDoc?.status, "paid");
    assert.equal(paymentDoc?.authorityStatus, "open");
    assert.equal(JSON.stringify(paymentDoc).includes("AB12CDE"), false);
    const state = (await db.doc("funding/state").get()).data();
    assert.equal(state?.reservedPence, 450);
    assert.equal(state?.balancePence, 100_000);
    const ledger = await db.collection("fundingLedger").get();
    assert.deepEqual(ledger.docs.map((doc) => doc.id), ["reserve:pi_job1"]);
    const slack = await db.collection("paymentNotifications").doc("pi_job1:job").get();
    assert.equal(slack.get("channel"), "slack");
    assert.equal(String(slack.get("text")).includes("AB12CDE"), true);
    assert.equal(String(slack.get("text")).includes("https://www.myringgo.com/location/12345"), true);
    assert.match(String(slack.get("text")), /includes £1\.60 Ferro fee and £0\.07 Stripe charge/);
  });

  it("queues a job that does not fit, pauses, then opens it after a top-up", async () => {
    const db = testDb(PROJECT);
    await seed(100, false);
    const payment = shape();
    const mocked = mockStripe(payment);
    await createParking(mocked.stripe);
    payment.status = "succeeded";
    const confirm = db.collection("parkingPaymentRequests").doc("pi_job1_confirm");
    await confirm.set({
      v: 1, action: "confirm", status: "pending", createdAt: Timestamp.now(), uid: "alice",
      paymentId: "pi_job1", paymentIntentId: "pi_job1", originalRequestId: "req-visit-1",
    });
    await runParkingPaymentRequest(db, mocked.stripe, confirm, PUBLISHABLE);
    assert.equal((await db.collection("authorityPayments").doc("pi_job1").get()).get("status"), "queued");
    assert.equal((await db.doc("funding/state").get()).get("paused"), true);
    assert.equal((await db.collection("paymentNotifications").doc("funding:paused:1").get()).exists, true);

    const topup = db.collection("fundingTopUpRequests").doc("top-1");
    await topup.set({
      requestedBy: "admin",
      amountPence: 50_000,
      note: "funding card top-up",
      status: "pending",
      createdAt: Timestamp.now(),
    });
    await handleFundingTopUp(db, topup);
    await handleFundingTopUp(db, topup);
    assert.equal((await topup.get()).get("status"), "done");
    assert.equal((await db.collection("authorityPayments").doc("pi_job1").get()).get("status"), "open");
    assert.equal((await db.doc("funding/state").get()).get("balancePence"), 50_100);
    assert.equal((await db.doc("funding/state").get()).get("reservedPence"), 450);
    assert.equal((await db.doc("funding/state").get()).get("paused"), false);
    const topups = await db.collection("fundingLedger").where("kind", "==", "topup").get();
    assert.equal(topups.size, 1);
  });

  it("refunds the difference on a cheaper authority charge and the whole payment on failure", async () => {
    const db = testDb(PROJECT);
    await seed(100_000, false);
    const payment = shape();
    const mocked = mockStripe(payment);
    await createParking(mocked.stripe);
    payment.status = "succeeded";
    const confirm = db.collection("parkingPaymentRequests").doc("pi_job1_confirm");
    await confirm.set({
      v: 1, action: "confirm", status: "pending", createdAt: Timestamp.now(), uid: "alice",
      paymentId: "pi_job1", paymentIntentId: "pi_job1", originalRequestId: "req-visit-1",
    });
    await runParkingPaymentRequest(db, mocked.stripe, confirm, PUBLISHABLE);

    const fulfill = db.collection("authorityPaymentActionRequests").doc("act-1");
    await fulfill.set({
      requestedBy: "admin",
      paymentIntentId: "pi_job1",
      action: "fulfill",
      authorityReference: "RG-100",
      authorityChargedPence: 400,
      status: "pending",
    });
    await handleAuthorityAction(db, mocked.refundClient, fulfill);
    await handleAuthorityAction(db, mocked.refundClient, fulfill);
    assert.equal((await fulfill.get()).get("status"), "done");
    assert.equal((await db.collection("authorityPayments").doc("pi_job1").get()).get("status"), "fulfilled");
    assert.equal((await db.collection("parkingPayments").doc("pi_job1").get()).get("status"), "partially_refunded");
    assert.deepEqual(mocked.refunds, [{amount: 50, key: refundIdempotencyKey("pi_job1")}]);
    const state = (await db.doc("funding/state").get()).data();
    assert.equal(state?.balancePence, 99_600);
    assert.equal(state?.reservedPence, 0);
    assert.equal(state?.spentTodayPence, 400);

    await db.collection("authorityPayments").doc("pi_job2").set({
      v: 1, paymentIntentId: "pi_job2", uid: "alice", status: "open", authorityPence: 200,
      feePence: 160, driverAmountPence: 360, chargeType: "pcn", plate: "AB12CDE",
      occurredOn: "2026-11-15", zone: "Camden", paymentUrl: "https://example.com/pay",
      createdAt: Timestamp.now(),
    });
    await db.collection("parkingPayments").doc("pi_job2").set({
      status: "paid", amount: 360, uid: "alice", paymentIntentId: "pi_job2", currency: "gbp",
    });
    await db.collection("fundingLedger").doc("reserve:pi_job2").set({
      kind: "reserve", amountPence: 200, paymentIntentId: "pi_job2",
    });
    await db.doc("funding/state").update({reservedPence: 200, balancePence: 99_600});
    const fail = db.collection("authorityPaymentActionRequests").doc("act-2");
    await fail.set({
      requestedBy: "admin", paymentIntentId: "pi_job2", action: "already_paid", status: "pending",
    });
    await handleAuthorityAction(db, mocked.refundClient, fail);
    assert.equal((await db.collection("authorityPayments").doc("pi_job2").get()).get("status"), "already_paid");
    assert.equal((await db.collection("parkingPayments").doc("pi_job2").get()).get("status"), "refunded");
    assert.equal(mocked.refunds[1]?.amount, 360);
    assert.equal(mocked.refunds[1]?.key, "refund:pi_job2");
    assert.equal((await db.doc("funding/state").get()).get("reservedPence"), 0);
  });

  it("refunds a queued job at the earlier deadline and does not reserve it", async () => {
    const db = testDb(PROJECT);
    const now = Date.parse("2026-11-15T12:00:00Z");
    await db.collection("authorityPayments").doc("pi_due").set({
      v: 1,
      paymentIntentId: "pi_due",
      uid: "alice",
      status: "queued",
      authorityPence: 700,
      feePence: 160,
      driverAmountPence: 860,
      chargeType: "congestion",
      plate: "AB12CDE",
      occurredOn: "2026-11-15",
      zone: "Congestion",
      paymentUrl: "https://tfl.gov.uk/modes/driving/congestion-charge",
      createdAt: Timestamp.fromMillis(now - 60 * 60 * 1000),
      refundAfter: Timestamp.fromMillis(now - 1000),
    });
    await db.collection("parkingPayments").doc("pi_due").set({
      status: "paid", amount: 860, uid: "alice", paymentIntentId: "pi_due", currency: "gbp",
      authorityPence: 700, feePence: 160,
    });
    await db.doc("funding/state").set({
      balancePence: 0, reservedPence: 0, spentTodayPence: 0, spentDay: "2026-11-15",
      dailyCapPence: 200_000, lowWaterPence: 10_000, paused: true,
      lowWaterAlerted: false, lowWaterGeneration: 0, pauseGeneration: 1,
    });
    const mocked = mockStripe(shape({id: "pi_due", amount: 860}));
    await expireDueAuthorityJobs(db, mocked.refundClient, now);
    assert.equal((await db.collection("authorityPayments").doc("pi_due").get()).get("status"), "expired");
    assert.equal((await db.collection("parkingPayments").doc("pi_due").get()).get("status"), "refunded");
    assert.equal(mocked.refunds[0]?.amount, 860);
    assert.equal(mocked.refunds[0]?.key, "refund:pi_due");
    assert.equal((await db.collection("fundingLedger").doc("reserve:pi_due").get()).exists, false);
    await expireDueAuthorityJobs(db, mocked.refundClient, now);
    assert.equal(mocked.refunds.length, 1);
  });

  it("sends an outbox notice once", async () => {
    const db = testDb(PROJECT);
    await db.collection("paymentNotifications").doc("pi_job1:paid").set({
      channel: "email",
      event: "paid",
      subject: "Your Ferro Maps payment",
      text: "Plate: AB12CDE",
      uid: "alice",
      status: "pending",
    });
    const sent: string[] = [];
    const deps = {
      sendEmail: async (input: {to: string[]}) => {
        sent.push(input.to.join(","));
      },
      postSlack: async () => undefined,
      emailForUid: async () => "ada@example.com",
    };
    await deliverNotification(db, "pi_job1:paid", deps);
    await deliverNotification(db, "pi_job1:paid", deps);
    assert.deepEqual(sent, ["ada@example.com,pay@ferromaps.com"]);
    assert.equal((await db.collection("paymentNotifications").doc("pi_job1:paid").get()).get("status"), "sent");
  });
});
