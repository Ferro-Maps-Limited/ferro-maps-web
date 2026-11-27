import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {after, before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  FLAT_STAY_GUARD_MINUTES,
  mergeStatus,
  paymentIntentIdempotencyKey,
  ParkingPaymentError,
  resolveStatus,
  retryIdempotencyKey,
  serviceFeePence,
  stripeChargePence,
} from "../src/parking/contract";
import {
  acknowledgeOperatorForward,
  runParkingPaymentRequest,
  type ParkingStripe,
  type PaymentIntentShape,
} from "../src/parking/payments";
import {handleParkingPaymentRequest} from "../src/parking/onParkingPaymentRequest";
import {
  assertPublishableKey,
  assertStripeTestKey,
  createStripeClient,
  EXPECTED_STRIPE_ACCOUNT_ID,
  stripeKeyLog,
  stripeLiveEnabled,
} from "../src/parking/stripeClient";
import {clearDb, testDb} from "./support";
import {pricingClock} from "../src/parking/sheetPricing";
import {formatStay, jobOpenedNotice, paidNotice, refundedNotice} from "../src/parking/notices";

const PROJECT = "demo-ferromaps-parking-pay";
const PUBLISHABLE = "pk_test_example";

const PLATE = "AB12CDE";

// What the driver pays on top of a charge (the Stripe charge plus the Ferro fee), and the charge plus that.
const fee = serviceFeePence;
const total = (pence: number): number => pence + serviceFeePence(pence);

function shape(over: Partial<PaymentIntentShape> = {}): PaymentIntentShape {
  return {
    id: "pi_test1",
    client_secret: "pi_test1_secret_value",
    status: "requires_payment_method",
    amount: total(450),
    currency: "gbp",
    customer: "cus_test",
    ...over,
  };
}

interface CreatedCharge {
  params: {
    amount?: number;
    currency?: string;
    metadata?: object;
    transfer_data?: object;
  };
  options: {idempotencyKey: string};
}

function mockStripe(payment: PaymentIntentShape, next?: PaymentIntentShape) {
  const creates: CreatedCharge[] = [];
  const cancels: string[] = [];
  let retrieves = 0;
  let created = 0;
  const stripe: ParkingStripe = {
    customers: {
      create: async () => ({id: "cus_test"}),
    },
    paymentIntents: {
      create: async (params, options) => {
        creates.push({params, options});
        created += 1;
        return created === 1 || !next ? payment : next;
      },
      retrieve: async (id) => {
        retrieves += 1;
        return {...payment, id};
      },
      cancel: async (id) => {
        cancels.push(id);
        return {...payment, id, status: "canceled"};
      },
    },
    ephemeralKeys: {
      create: async (_params, options) => {
        assert.equal(options.apiVersion.length > 0, true);
        return {secret: "ek_test_secret"};
      },
    },
  };
  return {stripe, creates, cancels, retrieveCount: () => retrieves};
}

async function seedDriver(uid = "alice"): Promise<void> {
  const db = testDb(PROJECT);
  await db.collection("users").doc(uid).set({
    subscriptionExpiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
  });
  await db.collection("places").doc("place-1").set({
    payMode: "inapp",
    operator: "RingGo",
    locationCode: "12345",
    name: "Yard",
    parkingPence: 450,
    feePence: 50,
    connectedAccountId: "acct_dest123",
  });
  await db.doc("config/parkingPayments").set({
    enabled: true,
    testMode: true,
    stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
  });
}

// One row for each stay the phone's picker offers. Prices are the server's, in pence.
const PHONE_TARIFFS = [
  {maxMinutes: 15, pence: 100},
  {maxMinutes: 30, pence: 200},
  {maxMinutes: 60, pence: 350},
  {maxMinutes: 120, pence: 500},
  {maxMinutes: 180, pence: 700},
  {maxMinutes: 240, pence: 900},
  {maxMinutes: 480, pence: 1200},
  {maxMinutes: 1440, pence: 1800},
];

function echoingStripe() {
  const creates: CreatedCharge[] = [];
  const cancels: string[] = [];
  const canceled = new Set<string>();
  const stripe: ParkingStripe = {
    customers: {create: async () => ({id: "cus_test"})},
    paymentIntents: {
      create: async (params, options) => {
        creates.push({params, options});
        const n = creates.length;
        return shape({
          id: `pi_price${n}`,
          client_secret: `secret_${n}`,
          amount: params.amount ?? 0,
        });
      },
      retrieve: async (id) => shape({
        id,
        client_secret: "reused_secret",
        status: canceled.has(id) ? "canceled" : "requires_payment_method",
      }),
      cancel: async (id) => {
        cancels.push(id);
        canceled.add(id);
        return shape({id, status: "canceled"});
      },
    },
    ephemeralKeys: {create: async () => ({secret: "ek_test_secret"})},
  };
  return {stripe, creates, cancels};
}

async function putCreate(
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const db = testDb(PROJECT);
  await db.collection("parkingPaymentRequests").doc(id).set({
    uid: "alice",
    v: 1,
    action: "create",
    placeId: "place-1",
    visitId: extra.visitId ?? id,
    operator: "RingGo",
    plate: "AB12CDE",
    platform: "ios",
    appVersion: "1.4.0",
    status: "pending",
    createdAt: Timestamp.now(),
    ...extra,
  });
}

describe("parking payment requests", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    await clearDb(testDb(PROJECT));
  });

  it("rejects a live Stripe key without echoing it", () => {
    const leaked = "sk_live_do_not_print";
    assert.throws(() => assertStripeTestKey(leaked), (err: unknown) => {
      assert.ok(err instanceof ParkingPaymentError);
      assert.equal(err.errorCode, "failed-precondition");
      assert.equal(JSON.stringify(err).includes(leaked), false);
      assert.equal(err.message.includes("sk_live"), false);
      return true;
    });
    assert.doesNotThrow(() => assertStripeTestKey("rk_test_example"));
  });

  it("prices the authority amount plus the Ferro fee on Ferro's own account", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.collection("parkingPaymentRequests").doc("req-1").set({
      uid: "alice",
      v: 1,
      action: "create",
      placeId: "place-1",
      visitId: "visit-1",
      operator: "ringgo",
      plate: "ab12 cde",
      platform: "android",
      appVersion: "1.4.0",
      status: "pending",
      amount: 1,
      createdAt: Timestamp.now(),
    });
    const payment = shape();
    const stripe = mockStripe(payment);
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"), PUBLISHABLE);

    const request = (await db.collection("parkingPaymentRequests").doc("req-1").get()).data();
    assert.equal(request?.status, "done");
    assert.equal(request?.paymentIntentClientSecret, "pi_test1_secret_value");
    assert.equal(request?.customerId, "cus_test");
    assert.equal(request?.ephemeralKey, "ek_test_secret");
    assert.equal(request?.paymentId, "pi_test1");
    assert.equal(request?.paymentIntentId, "pi_test1");
    assert.equal(request?.parkingPence, 450);
    assert.equal(request?.feePence, fee(450));
    assert.equal(request?.feePence, 167);
    assert.equal(request?.stripeChargePence, 7);
    assert.equal(request?.amount, total(450));
    assert.equal(request?.currency, "gbp");
    assert.equal(request?.plate, "ab12 cde");
    assert.equal("connectedAccountId" in (request ?? {}), false);

    const stored = (await db.collection("parkingPayments").doc("pi_test1").get()).data();
    assert.equal(stored?.status, "created");
    assert.equal(stored?.uid, "alice");
    assert.equal(stored?.visitId, "visit-1");
    assert.equal(stored?.amount, total(450));
    assert.equal(stored?.paymentIntentId, "pi_test1");
    assert.equal(stored?.chargeType, "parking");
    assert.equal(stored?.authorityPence, 450);
    assert.equal(stored?.feePence, fee(450));
    assert.equal(stored?.stripeChargePence, 7);
    assert.ok(stored?.updatedAt);
    assert.equal(JSON.stringify(stored).includes(PLATE), false);
    assert.equal(JSON.stringify(stored).includes("secret"), false);

    const created = stripe.creates[0];
    assert.equal(
      created.options.idempotencyKey,
      paymentIntentIdempotencyKey("alice", "place-1", "visit-1", null, total(450)),
    );
    assert.equal(created.options.idempotencyKey, `alice:place-1:visit-1:-:${total(450)}`);
    assert.equal(created.params.amount, total(450));
    assert.equal(created.params.currency, "gbp");
    assert.deepEqual(created.params.metadata, {
      uid: "alice",
      placeId: "place-1",
      visitId: "visit-1",
      chargeType: "parking",
      ferroAccount: EXPECTED_STRIPE_ACCOUNT_ID,
    });
    assert.equal(created.params.transfer_data, undefined);
    assert.equal("on_behalf_of" in created.params, false);
    assert.equal("application_fee_amount" in created.params, false);
    assert.equal("payment_method_types" in created.params, false);
    assert.equal("connectedAccountId" in created.params, false);
    assert.equal((await db.collection("operatorForwards").doc("pi_test1").get()).exists, false);
  });

  it("stores the PaymentIntent livemode and keeps it when the payment is paid", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const payment = shape({
      id: "pi_livepay",
      client_secret: "pi_livepay_secret_value",
      livemode: true,
    });
    const stripe = mockStripe(payment);
    await putCreate("req-livepay", {visitId: "visit-live"});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-livepay"), PUBLISHABLE,
    );
    assert.equal((await db.collection("parkingPayments").doc("pi_livepay").get()).get("livemode"), true);

    payment.status = "succeeded";
    const confirmRef = db.collection("parkingPaymentRequests").doc("pi_livepay_confirm");
    await confirmRef.set({
      v: 1,
      action: "confirm",
      status: "pending",
      createdAt: Timestamp.now(),
      uid: "alice",
      paymentId: "pi_livepay",
      paymentIntentId: "pi_livepay",
      originalRequestId: "req-livepay",
    });
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef, "");
    const paid = await db.collection("parkingPayments").doc("pi_livepay").get();
    assert.equal(paid.get("status"), "paid");
    assert.equal(paid.get("livemode"), true);
  });

  it("stores livemode false for a test PaymentIntent", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const payment = shape({id: "pi_testmode", livemode: false});
    const stripe = mockStripe(payment);
    await putCreate("req-testmode", {visitId: "visit-testmode"});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-testmode"), PUBLISHABLE,
    );
    const stored = await db.collection("parkingPayments").doc("pi_testmode").get();
    assert.equal(stored.get("status"), "created");
    assert.equal(stored.get("livemode"), false);
  });

  it("reuses the PaymentIntent for the same visit", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const payment = shape();
    const stripe = mockStripe(payment);
    await db.collection("parkingPaymentRequests").doc("req-1").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"), PUBLISHABLE);
    await db.collection("parkingPaymentRequests").doc("req-2").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-2"), PUBLISHABLE);
    assert.equal(stripe.creates.length, 1);
    assert.equal(stripe.retrieveCount(), 1);
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-2").get()).get("paymentId"), "pi_test1");
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-2").get()).get("plate"), undefined);
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-1").get()).get("plate"), "AB12CDE");
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-2").get()).get("paymentIntentClientSecret"),
      "pi_test1_secret_value");
  });

  it("confirms on a new document and registers the plate once", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const payment = shape();
    const stripe = mockStripe(payment);
    await db.collection("parkingPaymentRequests").doc("req-1").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "ab12 cde", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"), PUBLISHABLE);
    assert.equal((await db.collection("operatorForwards").doc("pi_test1").get()).exists, false);
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-1").get()).get("plate"), "ab12 cde");
    payment.status = "succeeded";

    const confirmRef = db.collection("parkingPaymentRequests").doc("pi_test1_confirm");
    await confirmRef.set({
      v: 1,
      action: "confirm",
      status: "pending",
      createdAt: Timestamp.now(),
      uid: "alice",
      paymentId: "pi_test1",
      paymentIntentId: "pi_test1",
      originalRequestId: "req-1",
    });
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef, PUBLISHABLE);
    await confirmRef.update({status: "pending"});
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef, PUBLISHABLE);

    const paid = (await db.collection("parkingPayments").doc("pi_test1").get()).data();
    assert.equal(paid?.status, "paid");
    assert.ok(paid?.plateRegisteredAt);
    assert.equal(JSON.stringify(paid).includes(PLATE), false);
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-1").get()).get("plate"), undefined);
    const forward = (await db.collection("operatorForwards").doc("pi_test1").get()).data();
    assert.equal(forward?.plate, PLATE);
    assert.ok(forward?.expireAt);
    assert.equal((await db.collection("operatorForwards").get()).size, 1);
    await acknowledgeOperatorForward(db, "pi_test1");
    assert.equal((await db.collection("operatorForwards").doc("pi_test1").get()).exists, false);
    const confirm = (await confirmRef.get()).data();
    assert.equal(confirm?.status, "done");
    assert.equal(confirm?.paymentStatus, "paid");
    assert.equal(confirm?.paymentIntentClientSecret, undefined);
    assert.equal(stripe.retrieveCount() > 0, true);
  });

  it("does not move a paid payment backwards", async () => {
    assert.equal(mergeStatus("paid", "created"), "paid");
    assert.equal(mergeStatus("paid", "processing"), "paid");
    assert.equal(mergeStatus("created", "paid"), "created");
    assert.equal(resolveStatus("created", "paid"), "paid");
    assert.equal(mergeStatus("refunded", "paid"), "refunded");
    assert.equal(mergeStatus("paid", "refunded"), "refunded");
    assert.equal(mergeStatus("failed", "paid"), "failed");
    assert.equal(mergeStatus("paid", "partially_refunded"), "partially_refunded");
    assert.equal(mergeStatus("partially_refunded", "refunded"), "refunded");
    assert.equal(mergeStatus("refund_pending", "paid"), "paid");
  });

  it("rejects a place that is not in-app, and lets a driver pay without Gold", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.collection("places").doc("place-1").update({payMode: "handoff"});
    await db.collection("parkingPaymentRequests").doc("req-1").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    const stripe = mockStripe(shape());
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"), PUBLISHABLE);
    const failed = (await db.collection("parkingPaymentRequests").doc("req-1").get()).data();
    assert.equal(failed?.errorCode, "failed-precondition");
    assert.equal(failed?.plate, undefined);
    assert.equal(stripe.creates.length, 0);

    await db.collection("places").doc("place-1").update({payMode: "inapp"});
    await db.collection("users").doc("bob").set({
      subscriptionExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });
    await db.collection("parkingPaymentRequests").doc("req-bob").set({
      uid: "bob", v: 1, action: "create", placeId: "place-1", visitId: "visit-2", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-bob"), PUBLISHABLE);
    const bobRequest = (await db.collection("parkingPaymentRequests").doc("req-bob").get()).data();
    assert.equal(bobRequest?.status, "done");
    assert.equal(bobRequest?.feePence, fee(450));
    assert.equal(bobRequest?.errorCode, undefined);

    await db.doc("config/parkingPayments").set({
      enabled: false,
      testMode: true,
      stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
    });
    await db.collection("parkingPaymentRequests").doc("req-off").set({
      uid: "bob", v: 1, action: "create", placeId: "place-1", visitId: "visit-3", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-off"), PUBLISHABLE);
    const off = (await db.collection("parkingPaymentRequests").doc("req-off").get()).data();
    assert.equal(off?.errorCode, "failed-precondition");
    assert.equal(off?.plate, undefined);
  });

  it("retries after a failed payment without handing back that client secret", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const failed = shape({
      id: "pi_fail",
      client_secret: "pi_fail_secret",
      last_payment_error: {code: "card_declined"},
    });
    const retry = shape({
      id: "pi_retry",
      client_secret: "pi_retry_secret",
      status: "requires_payment_method",
    });
    const stripe = mockStripe(failed, retry);
    await db.collection("parkingPaymentRequests").doc("req-fail").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-fail"), PUBLISHABLE);
    const first = (await db.collection("parkingPaymentRequests").doc("req-fail").get()).data();
    assert.equal(first?.status, "error");
    assert.equal(first?.plate, undefined);
    assert.equal(first?.paymentIntentClientSecret, undefined);
    assert.equal((await db.collection("parkingPayments").doc("pi_fail").get()).get("status"), "failed");
    assert.deepEqual(stripe.cancels, ["pi_fail"]);

    await db.collection("parkingPaymentRequests").doc("req-retry").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-retry"), PUBLISHABLE);
    const second = (await db.collection("parkingPaymentRequests").doc("req-retry").get()).data();
    assert.equal(second?.status, "done");
    assert.equal(second?.paymentIntentClientSecret, "pi_retry_secret");
    assert.equal(second?.paymentId, "pi_retry");
    assert.notEqual(stripe.creates[1]?.options.idempotencyKey, stripe.creates[0]?.options.idempotencyKey);
    assert.equal((await db.collection("parkingPayments").doc("pi_retry").get()).get("status"), "created");
  });

  it("a second retry after another failure opens a third PaymentIntent", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const attempts = [
      shape({id: "pi_fail1", client_secret: "secret_fail1", last_payment_error: {code: "card_declined"}}),
      shape({id: "pi_fail2", client_secret: "secret_fail2", last_payment_error: {code: "card_declined"}}),
      shape({id: "pi_new3", client_secret: "secret_new3", status: "requires_payment_method"}),
    ];
    const creates: {options: {idempotencyKey: string}}[] = [];
    const stripe: ParkingStripe = {
      customers: {create: async () => ({id: "cus_test"})},
      paymentIntents: {
        create: async (_params, options) => {
          creates.push({options});
          return attempts[creates.length - 1];
        },
        retrieve: async (id) => attempts.find((item) => item.id === id) ?? attempts[0],
        cancel: async (id) => ({...(attempts.find((item) => item.id === id) ?? attempts[0]), id, status: "canceled"}),
      },
      ephemeralKeys: {create: async () => ({secret: "ek_test_secret"})},
    };
    for (const requestId of ["req-a", "req-b", "req-c"]) {
      await db.collection("parkingPaymentRequests").doc(requestId).set({
        uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-retry", operator: "RingGo",
        plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
        createdAt: Timestamp.now(),
      });
      await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc(requestId), PUBLISHABLE);
    }
    assert.equal(creates.length, 3);
    assert.equal(
      creates[0].options.idempotencyKey,
      paymentIntentIdempotencyKey("alice", "place-1", "visit-retry", null, total(450)),
    );
    assert.equal(
      creates[1].options.idempotencyKey,
      retryIdempotencyKey("alice", "place-1", "visit-retry", "pi_fail1", null, total(450)),
    );
    assert.equal(
      creates[2].options.idempotencyKey,
      retryIdempotencyKey("alice", "place-1", "visit-retry", "pi_fail2", null, total(450)),
    );
    assert.equal((await db.collection("parkingPayments").doc("pi_fail1").get()).get("status"), "failed");
    assert.equal((await db.collection("parkingPayments").doc("pi_fail2").get()).get("status"), "failed");
    assert.equal((await db.collection("parkingPayments").doc("pi_new3").get()).get("status"), "created");
    const third = (await db.collection("parkingPaymentRequests").doc("req-c").get()).data();
    assert.equal(third?.paymentId, "pi_new3");
    assert.equal(third?.paymentIntentClientSecret, "secret_new3");
    const open = (await db.collection("parkingPayments").where("visitId", "==", "visit-retry").get()).docs
      .filter((doc) => doc.get("status") !== "failed" && doc.get("status") !== "canceled");
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, "pi_new3");
  });

  it("replaces a declined open PaymentIntent in the same create", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.collection("parkingPayments").doc("pi_old").set({
      v: 1,
      status: "created",
      amount: total(450),
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-decline",
      operator: "RingGo",
      uid: "alice",
      requestId: "req-old",
      paymentIntentId: "pi_old",
      parkingPence: 450,
      feePence: fee(450),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    const declined = shape({
      id: "pi_old",
      client_secret: "old_secret",
      status: "requires_payment_method",
      last_payment_error: {code: "card_declined"},
    });
    const fresh = shape({
      id: "pi_new",
      client_secret: "new_secret",
      status: "requires_payment_method",
    });
    const creates: {options: {idempotencyKey: string}}[] = [];
    const cancels: string[] = [];
    const stripe: ParkingStripe = {
      customers: {create: async () => ({id: "cus_test"})},
      paymentIntents: {
        create: async (_params, options) => {
          const old = await db.collection("parkingPayments").doc("pi_old").get();
          assert.equal(old.get("status"), "failed");
          assert.equal(cancels.includes("pi_old"), true);
          creates.push({options});
          return fresh;
        },
        retrieve: async (id) => ({...declined, id}),
        cancel: async (id) => {
          cancels.push(id);
          return {...declined, id, status: "canceled"};
        },
      },
      ephemeralKeys: {create: async () => ({secret: "ek_test_secret"})},
    };
    const ref = db.collection("parkingPaymentRequests").doc("req-new");
    await ref.set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-decline", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe, ref, PUBLISHABLE);
    assert.equal((await db.collection("parkingPayments").doc("pi_old").get()).get("status"), "failed");
    assert.equal(cancels[0], "pi_old");
    assert.equal(creates.length, 1);
    assert.equal(
      creates[0]?.options.idempotencyKey,
      retryIdempotencyKey("alice", "place-1", "visit-decline", "pi_old", null, total(450)),
    );
    const done = (await ref.get()).data();
    assert.equal(done?.status, "done");
    assert.equal(done?.paymentIntentClientSecret, "new_secret");
    assert.equal(done?.customerId, "cus_test");
    assert.equal(done?.ephemeralKey, "ek_test_secret");
    assert.equal(done?.paymentId, "pi_new");
    const open = (await db.collection("parkingPayments").where("visitId", "==", "visit-decline").get()).docs
      .filter((doc) => doc.get("status") !== "failed" && doc.get("status") !== "canceled");
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, "pi_new");
  });

  it("reuses a PaymentIntent when the sheet closed without a card attempt", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.collection("parkingPayments").doc("pi_sheet").set({
      v: 1,
      status: "created",
      amount: total(450),
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-sheet",
      operator: "RingGo",
      uid: "alice",
      requestId: "req-sheet-old",
      paymentIntentId: "pi_sheet",
      parkingPence: 450,
      feePence: fee(450),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    let creates = 0;
    const stripe: ParkingStripe = {
      customers: {create: async () => ({id: "cus_test"})},
      paymentIntents: {
        create: async () => {
          creates += 1;
          return shape({id: "pi_other"});
        },
        retrieve: async (id) => shape({
          id,
          client_secret: "sheet_secret",
          status: "requires_payment_method",
        }),
        cancel: async (id) => shape({id, status: "canceled"}),
      },
      ephemeralKeys: {create: async () => ({secret: "ek_test_secret"})},
    };
    const ref = db.collection("parkingPaymentRequests").doc("req-sheet");
    await ref.set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-sheet", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe, ref, PUBLISHABLE);
    assert.equal(creates, 0);
    assert.equal((await db.collection("parkingPayments").doc("pi_sheet").get()).get("status"), "created");
    const done = (await ref.get()).data();
    assert.equal(done?.status, "done");
    assert.equal(done?.paymentId, "pi_sheet");
    assert.equal(done?.paymentIntentClientSecret, "sheet_secret");
    assert.equal(done?.customerId, "cus_test");
    assert.equal(done?.ephemeralKey, "ek_test_secret");
  });

  it("records plateMissing when a payment is paid without a plate", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const payment = shape();
    const stripe = mockStripe(payment);
    await db.collection("parkingPaymentRequests").doc("req-1").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"), PUBLISHABLE);
    await db.collection("parkingPaymentRequests").doc("req-1").update({plate: null});
    payment.status = "succeeded";
    const confirmRef = db.collection("parkingPaymentRequests").doc("pi_test1_confirm");
    await confirmRef.set({
      v: 1, action: "confirm", status: "pending", createdAt: Timestamp.now(), uid: "alice",
      paymentId: "pi_test1", paymentIntentId: "pi_test1", originalRequestId: "req-1",
    });
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef, PUBLISHABLE);
    const paid = (await db.collection("parkingPayments").doc("pi_test1").get()).data();
    assert.equal(paid?.status, "paid");
    assert.equal(paid?.plateMissing, true);
    assert.equal(paid?.plateRegisteredAt, undefined);
    assert.equal((await db.collection("operatorForwards").doc("pi_test1").get()).exists, false);
  });

  it("a live key leaves the request in error and deletes the plate", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const leaked = "sk_live_do_not_print";
    const ref = db.collection("parkingPaymentRequests").doc("req-live");
    await ref.set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await handleParkingPaymentRequest(db, leaked, ref, PUBLISHABLE);
    const stored = (await ref.get()).data();
    assert.equal(stored?.status, "error");
    assert.equal(stored?.errorCode, "failed-precondition");
    assert.equal(stored?.plate, undefined);
    assert.equal(JSON.stringify(stored).includes(leaked), false);
    assert.ok(stored?.expireAt);
  });

  it("prices each phone picker length on its own row and rounds up in between", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/flags").set({parkingDurationPricing: true});
    await db.collection("places").doc("place-1").update({parkingTariffs: PHONE_TARIFFS});
    const stripe = echoingStripe();
    const between: Array<[number, number]> = [
      [16, 200],
      [31, 350],
      [61, 500],
      [121, 700],
      [181, 900],
      [241, 1200],
      [481, 1800],
    ];
    const cases = [
      ...PHONE_TARIFFS.map((row) => [row.maxMinutes, row.pence] as [number, number]),
      ...between,
    ];
    for (const [minutes, pence] of cases) {
      const id = `stay-${minutes}`;
      await putCreate(id, {durationMinutes: minutes, amount: 1, parkingPence: 1});
      await runParkingPaymentRequest(
        db,
        stripe.stripe,
        db.collection("parkingPaymentRequests").doc(id),
        PUBLISHABLE,
      );
      const done = (await db.collection("parkingPaymentRequests").doc(id).get()).data();
      assert.equal(done?.status, "done", `status for ${minutes}`);
      assert.equal(done?.publishableKey, PUBLISHABLE);
      assert.equal(done?.parkingPence, pence, `price for ${minutes}`);
      assert.equal(done?.feePence, fee(pence));
      assert.equal(done?.amount, total(pence));
      assert.equal(done?.currency, "gbp");
    }
    assert.equal(stripe.creates.length, cases.length);
    for (const created of stripe.creates) {
      assert.equal(created.params.transfer_data, undefined);
      assert.equal("on_behalf_of" in created.params, false);
      assert.equal("application_fee_amount" in created.params, false);
    }
    const sixty = stripe.creates.find((item) => item.params.amount === total(350));
    assert.equal(
      sixty?.options.idempotencyKey,
      paymentIntentIdempotencyKey("alice", "place-1", "stay-60", 60, total(350)),
    );
    assert.equal(sixty?.options.idempotencyKey, `alice:place-1:stay-60:60:${total(350)}`);
  });

  it("cancels an open payment when the next request for that visit has a different length", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/flags").set({parkingDurationPricing: true});
    await db.collection("places").doc("place-1").update({parkingTariffs: PHONE_TARIFFS});
    const stripe = echoingStripe();
    await putCreate("req-first", {visitId: "visit-same", durationMinutes: 60});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-first"), PUBLISHABLE,
    );
    await putCreate("req-second", {visitId: "visit-same", durationMinutes: 15});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-second"), PUBLISHABLE,
    );
    assert.deepEqual(stripe.cancels, ["pi_price1"]);
    assert.equal((await db.collection("parkingPayments").doc("pi_price1").get()).get("status"), "canceled");
    assert.equal(stripe.creates.length, 2);
    assert.equal(
      stripe.creates[1]?.options.idempotencyKey,
      retryIdempotencyKey("alice", "place-1", "visit-same", "pi_price1", 15, total(100)),
    );
    const second = (await db.collection("parkingPaymentRequests").doc("req-second").get()).data();
    assert.equal(second?.status, "done");
    assert.equal(second?.paymentId, "pi_price2");
    assert.equal(second?.parkingPence, 100);
    assert.equal(second?.feePence, fee(100));
    assert.equal(second?.amount, total(100));
    assert.equal(second?.publishableKey, PUBLISHABLE);
    const stored = (await db.collection("parkingPayments").doc("pi_price2").get()).data();
    assert.equal(stored?.status, "created");
    assert.equal(stored?.durationMinutes, 15);
    assert.equal(stored?.amount, total(100));
  });

  it("reuses the PaymentIntent when the same visit is asked for again at the same length", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/flags").set({parkingDurationPricing: true});
    await db.collection("places").doc("place-1").update({parkingTariffs: PHONE_TARIFFS});
    const stripe = echoingStripe();
    await putCreate("req-first", {visitId: "visit-same", durationMinutes: 60});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-first"), PUBLISHABLE,
    );
    await putCreate("req-second", {visitId: "visit-same", durationMinutes: 60});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-second"), PUBLISHABLE,
    );
    assert.equal(stripe.creates.length, 1);
    assert.deepEqual(stripe.cancels, []);
    assert.equal(stripe.creates[0]?.options.idempotencyKey, `alice:place-1:visit-same:60:${total(350)}`);
    const second = (await db.collection("parkingPaymentRequests").doc("req-second").get()).data();
    assert.equal(second?.status, "done");
    assert.equal(second?.paymentId, "pi_price1");
    assert.equal(second?.parkingPence, 350);
    assert.equal(second?.amount, total(350));
    assert.equal((await db.collection("parkingPayments").doc("pi_price1").get()).get("status"), "created");
  });

  it("returns open-payment-in-progress when Stripe will not cancel the open payment", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/flags").set({parkingDurationPricing: true});
    await db.collection("places").doc("place-1").update({parkingTariffs: PHONE_TARIFFS});
    await db.collection("parkingPayments").doc("pi_open1").set({
      v: 1,
      status: "created",
      amount: total(350),
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-open",
      operator: "RingGo",
      uid: "alice",
      requestId: "req-old",
      paymentIntentId: "pi_open1",
      parkingPence: 350,
      feePence: fee(350),
      durationMinutes: 60,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    const cancels: string[] = [];
    let creates = 0;
    const stripe: ParkingStripe = {
      customers: {create: async () => ({id: "cus_test"})},
      paymentIntents: {
        create: async () => {
          creates += 1;
          return shape({id: "pi_should_not"});
        },
        retrieve: async (id) => shape({id, status: "processing", client_secret: "open_secret"}),
        cancel: async (id) => {
          cancels.push(id);
          return shape({id, status: "canceled"});
        },
      },
      ephemeralKeys: {create: async () => ({secret: "ek_test_secret"})},
    };
    await putCreate("req-change", {visitId: "visit-open", durationMinutes: 15});
    await runParkingPaymentRequest(
      db, stripe, db.collection("parkingPaymentRequests").doc("req-change"), PUBLISHABLE,
    );
    const stored = (await db.collection("parkingPaymentRequests").doc("req-change").get()).data();
    assert.equal(stored?.status, "error");
    assert.equal(stored?.errorCode, "open-payment-in-progress");
    assert.equal(stored?.error, "Finish the open payment before changing this stay.");
    assert.equal(stored?.plate, undefined);
    assert.deepEqual(cancels, []);
    assert.equal(creates, 0);
    assert.equal((await db.collection("parkingPayments").doc("pi_open1").get()).get("status"), "created");
  });

  it("returns the paid receipt before repricing or opening another PaymentIntent", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/flags").set({parkingDurationPricing: true});
    await db.collection("places").doc("place-1").update({
      parkingPence: 999,
      parkingTariffs: PHONE_TARIFFS,
    });
    await db.collection("parkingPayments").doc("pi_paid1").set({
      v: 1,
      status: "paid",
      amount: total(450),
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-paid",
      operator: "RingGo",
      uid: "alice",
      requestId: "req-paid-old",
      paymentIntentId: "pi_paid1",
      parkingPence: 450,
      feePence: fee(450),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    const cancels: string[] = [];
    let creates = 0;
    const stripe: ParkingStripe = {
      customers: {create: async () => ({id: "cus_should_not"})},
      paymentIntents: {
        create: async () => {
          creates += 1;
          return shape({id: "pi_should_not", amount: total(100)});
        },
        retrieve: async (id) => shape({
          id,
          status: "succeeded",
          client_secret: "paid_secret",
          amount: total(450),
          customer: "cus_paid",
        }),
        cancel: async (id) => {
          cancels.push(id);
          return shape({id, status: "canceled"});
        },
      },
      ephemeralKeys: {create: async () => ({secret: "ek_paid"})},
    };
    await putCreate("req-again", {visitId: "visit-paid", durationMinutes: 15, amount: 1});
    await runParkingPaymentRequest(
      db, stripe, db.collection("parkingPaymentRequests").doc("req-again"), PUBLISHABLE,
    );
    const done = (await db.collection("parkingPaymentRequests").doc("req-again").get()).data();
    assert.equal(done?.status, "done");
    assert.equal(done?.paymentId, "pi_paid1");
    assert.equal(done?.paymentIntentClientSecret, "paid_secret");
    assert.equal(done?.customerId, "cus_paid");
    assert.equal(done?.ephemeralKey, "ek_paid");
    assert.equal(done?.publishableKey, PUBLISHABLE);
    assert.equal(done?.parkingPence, 450);
    assert.equal(done?.feePence, fee(450));
    assert.equal(done?.amount, total(450));
    assert.equal(done?.currency, "gbp");
    assert.equal(done?.plate, undefined);
    assert.equal(creates, 0);
    assert.deepEqual(cancels, []);
    assert.equal((await db.collection("parkingPayments").doc("pi_paid1").get()).get("status"), "paid");
    assert.equal((await db.collection("places").doc("place-1").get()).get("parkingPence"), 999);
  });

  it("rejects a missing, non-integer, or out-of-range duration and a stay past the table", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/flags").set({parkingDurationPricing: true});
    await db.collection("places").doc("place-1").update({parkingTariffs: PHONE_TARIFFS});
    const stripe = echoingStripe();
    const cases: Array<{id: string; duration?: unknown; code: string}> = [
      {id: "missing", code: "duration-required"},
      {id: "fraction", duration: 30.5, code: "duration-invalid"},
      {id: "text", duration: "30", code: "duration-invalid"},
      {id: "too-short", duration: 14, code: "duration-invalid"},
      {id: "fifteen", duration: 15, code: "done"},
      {id: "all-day", duration: 1440, code: "done"},
      {id: "too-long", duration: 1441, code: "duration-invalid"},
    ];
    for (const item of cases) {
      const extra: Record<string, unknown> = {visitId: item.id};
      if (item.duration !== undefined) extra.durationMinutes = item.duration;
      await putCreate(item.id, extra);
      await runParkingPaymentRequest(
        db, stripe.stripe, db.collection("parkingPaymentRequests").doc(item.id), PUBLISHABLE,
      );
      const stored = (await db.collection("parkingPaymentRequests").doc(item.id).get()).data();
      if (item.code === "done") {
        assert.equal(stored?.status, "done", item.id);
        assert.equal(stored?.publishableKey, PUBLISHABLE);
      } else {
        assert.equal(stored?.status, "error", item.id);
        assert.equal(stored?.errorCode, item.code, item.id);
        assert.equal(stored?.plate, undefined);
      }
    }
    assert.equal(stripe.creates.length, 2);
    const fifteen = (await db.collection("parkingPaymentRequests").doc("fifteen").get()).data();
    const allDay = (await db.collection("parkingPaymentRequests").doc("all-day").get()).data();
    assert.equal(fifteen?.parkingPence, 100);
    assert.equal(fifteen?.amount, total(100));
    assert.equal(allDay?.parkingPence, 1800);
    assert.equal(allDay?.amount, total(1800));

    await db.collection("places").doc("place-1").update({
      parkingTariffs: PHONE_TARIFFS.filter((row) => row.maxMinutes <= 120),
    });
    await putCreate("past-table", {durationMinutes: 180});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("past-table"), PUBLISHABLE,
    );
    const past = (await db.collection("parkingPaymentRequests").doc("past-table").get()).data();
    assert.equal(past?.errorCode, "duration-invalid");
    assert.equal(stripe.creates.length, 2);
  });

  it("ignores duration on a flat-priced place, including an invalid one", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.collection("places").doc("place-1").update({parkingTariffs: PHONE_TARIFFS});
    await db.doc("config/flags").set({parkingDurationPricing: "true"});
    const stripe = mockStripe(shape());
    await putCreate("flat-14", {durationMinutes: 14, amount: 1});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("flat-14"), PUBLISHABLE,
    );
    const first = (await db.collection("parkingPaymentRequests").doc("flat-14").get()).data();
    assert.equal(first?.status, "done");
    assert.equal(first?.parkingPence, 450);
    assert.equal(first?.feePence, fee(450));
    assert.equal(first?.amount, total(450));
    assert.equal(first?.publishableKey, PUBLISHABLE);
    await putCreate("flat-text", {visitId: "flat-text", durationMinutes: "nope"});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("flat-text"), PUBLISHABLE,
    );
    const second = (await db.collection("parkingPaymentRequests").doc("flat-text").get()).data();
    assert.equal(second?.status, "done");
    assert.equal(second?.parkingPence, 450);
    assert.equal(second?.amount, total(450));
    assert.equal(stripe.creates.length, 2);
    assert.equal(stripe.creates[0]?.params.amount, total(450));
  });

  it("refuses a payment over the cap before creating a PaymentIntent", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/flags").set({parkingDurationPricing: true});
    await db.collection("places").doc("place-1").update({
      parkingTariffs: [{maxMinutes: 60, pence: 4950}], // 4950 plus its fee is over the 5000 cap
    });
    const stripe = echoingStripe();
    await putCreate("over-cap", {durationMinutes: 60});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("over-cap"), PUBLISHABLE,
    );
    const refused = (await db.collection("parkingPaymentRequests").doc("over-cap").get()).data();
    assert.equal(refused?.status, "error");
    assert.equal(refused?.errorCode, "failed-precondition");
    assert.equal(refused?.error, "This payment is above the limit we can take.");
    assert.equal(stripe.creates.length, 0);
    assert.equal((await db.collection("parkingPayments").get()).empty, true);
    assert.equal((await db.collection("stripeCustomers").get()).empty, true);

    await db.doc("config/payments").set({maxPaymentPence: 6000});
    await putCreate("under-cap", {visitId: "under-cap", durationMinutes: 60});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("under-cap"), PUBLISHABLE,
    );
    const allowed = (await db.collection("parkingPaymentRequests").doc("under-cap").get()).data();
    assert.equal(allowed?.status, "done");
    assert.equal(allowed?.amount, total(4950));
    assert.equal(stripe.creates.length, 1);
    assert.equal(stripe.creates[0]?.params.amount, total(4950));
  });

  it("refuses a live secret unless the live switch is exactly true, and never logs the key", async () => {
    const db = testDb(PROJECT);
    const live = "sk_live_do_not_print";
    const testKey = "sk_test_do_not_print";
    const logged: string[] = [];
    const original = stripeKeyLog.write.bind(stripeKeyLog);
    stripeKeyLog.write = (mode) => logged.push(mode);
    try {
      assert.equal(await stripeLiveEnabled(db), false);
      assert.throws(() => createStripeClient(live, false), (err: unknown) => {
        assert.ok(err instanceof ParkingPaymentError);
        assert.equal(err.errorCode, "failed-precondition");
        assert.equal(err.message.includes(live), false);
        assert.equal(err.message.includes("sk_"), false);
        return true;
      });
      assert.doesNotThrow(() => createStripeClient(testKey, false));
      await db.doc("config/payments").set({stripeLiveEnabled: "true"});
      assert.equal(await stripeLiveEnabled(db), false);
      await db.doc("config/payments").delete();
      assert.equal(await stripeLiveEnabled(db), false);
      await db.doc("config/payments").set({stripeLiveEnabled: true});
      assert.equal(await stripeLiveEnabled(db), true);
      assert.doesNotThrow(() => createStripeClient(live, true));
      assert.equal(logged.every((mode) => mode === "test" || mode === "live"), true);
      assert.equal(logged.includes("test"), true);
      assert.equal(logged.includes("live"), true);
      const dumped = logged.join(" ");
      assert.equal(dumped.includes(live), false);
      assert.equal(dumped.includes(testKey), false);
      assert.equal(dumped.includes("do_not_print"), false);
      assert.equal(dumped.includes("sk_"), false);
    } finally {
      stripeKeyLog.write = original;
    }
  });

  it("returns the test publishable key and refuses a live one while the switch is off", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const stripe = mockStripe(shape());
    await putCreate("req-pk");
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-pk"), PUBLISHABLE,
    );
    const done = (await db.collection("parkingPaymentRequests").doc("req-pk").get()).data();
    assert.equal(done?.status, "done");
    assert.equal(done?.publishableKey, PUBLISHABLE);
    assert.equal(done?.parkingPence, 450);
    const liveKey = "pk_live_do_not_print";
    await putCreate("req-pk-live", {visitId: "visit-pk-live"});
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-pk-live"), liveKey,
    );
    const failed = (await db.collection("parkingPaymentRequests").doc("req-pk-live").get()).data();
    assert.equal(failed?.status, "error");
    assert.equal(failed?.errorCode, "failed-precondition");
    assert.equal(JSON.stringify(failed).includes(liveKey), false);
    assert.equal(JSON.stringify(failed).includes("pk_live"), false);
    assert.equal(stripe.creates.length, 1);
  });

  it("refuses a publishable key whose mode does not match the secret", async () => {
    assert.throws(() => assertPublishableKey("pk_live_example", "test"), (err: unknown) => {
      assert.ok(err instanceof ParkingPaymentError);
      assert.equal(err.errorCode, "failed-precondition");
      assert.equal(err.message.includes("pk_live"), false);
      return true;
    });
    assert.throws(() => assertPublishableKey("pk_test_example", "live"), (err: unknown) => {
      assert.ok(err instanceof ParkingPaymentError);
      assert.equal(err.message.includes("pk_test"), false);
      return true;
    });
    assert.doesNotThrow(() => assertPublishableKey("pk_test_example", "test"));
    assert.doesNotThrow(() => assertPublishableKey("pk_live_example", "live"));

    const db = testDb(PROJECT);
    await seedDriver();
    const stripe = mockStripe(shape());
    await putCreate("req-mismatch");
    await runParkingPaymentRequest(
      db,
      stripe.stripe,
      db.collection("parkingPaymentRequests").doc("req-mismatch"),
      "pk_live_example",
      "test",
    );
    const failed = (await db.collection("parkingPaymentRequests").doc("req-mismatch").get()).data();
    assert.equal(failed?.status, "error");
    assert.equal(failed?.errorCode, "failed-precondition");
    assert.equal(JSON.stringify(failed).includes("pk_live"), false);
    assert.equal(stripe.creates.length, 0);
  });

  it("checks the publishable key on create only, so a confirm works before the key is set", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const payment = shape();
    const stripe = mockStripe(payment);
    await putCreate("req-sheet");
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-sheet"), "",
    );
    const missing = (await db.collection("parkingPaymentRequests").doc("req-sheet").get()).data();
    assert.equal(missing?.status, "error");
    assert.equal(missing?.errorCode, "failed-precondition");
    assert.equal(stripe.creates.length, 0);

    await putCreate("req-pay");
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-pay"), PUBLISHABLE,
    );
    payment.status = "succeeded";
    const confirmRef = db.collection("parkingPaymentRequests").doc("pi_test1_confirm");
    await confirmRef.set({
      v: 1,
      action: "confirm",
      status: "pending",
      createdAt: Timestamp.now(),
      uid: "alice",
      paymentId: "pi_test1",
      paymentIntentId: "pi_test1",
      originalRequestId: "req-pay",
    });
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef, "");
    const confirm = (await confirmRef.get()).data();
    assert.equal(confirm?.status, "done");
    assert.equal(confirm?.paymentStatus, "paid");
    assert.equal(confirm?.publishableKey, undefined);
    assert.equal((await db.collection("parkingPayments").doc("pi_test1").get()).get("status"), "paid");
  });

  it("takes a test-key payment when testMode is not true", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.doc("config/parkingPayments").set({
      enabled: true,
      testMode: false,
      stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
    });
    const stripe = mockStripe(shape());
    await putCreate("req-live-config");
    await runParkingPaymentRequest(
      db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-live-config"), PUBLISHABLE,
    );
    const done = (await db.collection("parkingPaymentRequests").doc("req-live-config").get()).data();
    assert.equal(done?.status, "done");
    assert.equal(done?.publishableKey, PUBLISHABLE);
    assert.equal(done?.amount, total(450));
    assert.equal(stripe.creates.length, 1);
  });

  it("rejects a client authorityPence and does not charge", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    const stripe = mockStripe(shape());
    const charges = [
      ["congestion", "London congestion"],
      ["ulez", "London ULEZ"],
      ["tunnel", "Dartford"],
      ["pcn", "Westminster fine"],
    ] as const;
    for (const [chargeType, zone] of charges) {
      const id = `road-${chargeType}`;
      await db.collection("parkingPaymentRequests").doc(id).set({
        uid: "alice",
        v: 1,
        action: "create",
        chargeType,
        plate: "AB12CDE",
        platform: "ios",
        appVersion: "1.4.0",
        status: "pending",
        createdAt: Timestamp.now(),
        authorityPence: 1250,
        zone,
        occurredOn: "2026-11-15",
        paymentUrl: "https://tfl.gov.uk/modes/driving/pay-to-drive-in-london",
      });
      await runParkingPaymentRequest(
        db, stripe.stripe, db.collection("parkingPaymentRequests").doc(id), PUBLISHABLE,
      );
      const stored = (await db.collection("parkingPaymentRequests").doc(id).get()).data();
      assert.equal(stored?.status, "error", chargeType);
      assert.equal(stored?.errorCode, "failed-precondition", chargeType);
      assert.equal(stored?.error, "Road charges aren't available right now.");
      assert.equal(stored?.plate, undefined);
    }
    assert.equal(stripe.creates.length, 0);
    assert.equal((await db.collection("parkingPayments").get()).empty, true);
  });

  it("keeps live keys and webhook secret values out of the parking source", () => {
    const root = join(__dirname, "..", "src", "parking");
    const files = readdirSync(root).filter((name) => name.endsWith(".ts"));
    for (const name of files) {
      const text = readFileSync(join(root, name), "utf8");
      assert.equal(/sk_live_[A-Za-z0-9]{8,}/.test(text), false, name);
      assert.equal(/pk_(test|live)_[A-Za-z0-9]{8,}/.test(text), false, name);
      assert.equal(text.includes("whsec_"), false, name);
    }
    const webhook = readFileSync(join(root, "stripeWebhook.ts"), "utf8");
    assert.equal(webhook.includes("defineSecret(\"STRIPE_WEBHOOK_SECRET\")"), true);
    assert.equal(webhook.includes("constructEvent"), true);
    assert.equal(/invoker\s*:/.test(webhook), false);
  });
});

describe("one payment per running stay", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    await clearDb(testDb(PROJECT));
  });

  const MINUTE = 60_000;

  async function seedPaid(
    id: string,
    over: Record<string, unknown> & {startedMinutesAgo: number},
  ): Promise<void> {
    const {startedMinutesAgo, ...fields} = over;
    await testDb(PROJECT).collection("parkingPayments").doc(id).set({
      v: 1,
      status: "paid",
      amount: total(450),
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-paid",
      operator: "RingGo",
      uid: "alice",
      requestId: "req-paid",
      paymentIntentId: id,
      chargeType: "parking",
      parkingPence: 450,
      feePence: fee(450),
      durationMinutes: 60,
      createdAt: Timestamp.fromMillis(Date.now() - startedMinutesAgo * MINUTE),
      updatedAt: Timestamp.now(),
      ...fields,
    });
  }

  async function createFor(visitId: string, extra: Record<string, unknown> = {}) {
    const db = testDb(PROJECT);
    const {stripe, creates} = mockStripe(shape({id: "pi_new1"}));
    const id = `req-${visitId}`;
    await putCreate(id, {visitId, ...extra});
    await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc(id), PUBLISHABLE);
    const stored = (await db.collection("parkingPaymentRequests").doc(id).get()).data();
    return {stored, creates};
  }

  it("refuses a new visit while the same driver's paid stay at that place is running", async () => {
    await seedDriver();
    await seedPaid("pi_paid1", {startedMinutesAgo: 10});
    const {stored, creates} = await createFor("visit-after-relaunch");
    assert.equal(stored?.status, "error");
    assert.equal(stored?.errorCode, "already-paid");
    assert.equal(stored?.error, "You've already paid for a stay here. You can pay again after it ends.");
    assert.equal(stored?.plate, undefined);
    assert.equal(creates.length, 0);
  });

  it("refuses while a payment from another visit is still processing", async () => {
    await seedDriver();
    await seedPaid("pi_proc1", {startedMinutesAgo: 2, status: "processing"});
    const {stored, creates} = await createFor("visit-second");
    assert.equal(stored?.errorCode, "already-paid");
    assert.equal(creates.length, 0);
  });

  it("gives a flat-priced stay with no length the guard window", async () => {
    await seedDriver();
    await seedPaid("pi_flat1", {startedMinutesAgo: 30, durationMinutes: null});
    const refused = await createFor("visit-flat-2");
    assert.equal(refused.stored?.errorCode, "already-paid");
    assert.equal(refused.creates.length, 0);

    await clearDb(testDb(PROJECT));
    await seedDriver();
    await seedPaid("pi_flat2", {startedMinutesAgo: FLAT_STAY_GUARD_MINUTES + 1, durationMinutes: null});
    const allowed = await createFor("visit-flat-3");
    assert.equal(allowed.stored?.status, "done");
    assert.equal(allowed.creates.length, 1);
  });

  it("allows a new stay once the paid one has ended", async () => {
    await seedDriver();
    await seedPaid("pi_ended1", {startedMinutesAgo: 61, durationMinutes: 60});
    const {stored, creates} = await createFor("visit-next");
    assert.equal(stored?.status, "done");
    assert.equal(creates.length, 1);
  });

  it("does not count a refunded, failed or canceled stay, or another driver's", async () => {
    await seedDriver();
    await seedPaid("pi_refunded", {startedMinutesAgo: 5, status: "refunded"});
    await seedPaid("pi_failed", {startedMinutesAgo: 5, status: "failed", visitId: "visit-f"});
    await seedPaid("pi_canceled", {startedMinutesAgo: 5, status: "canceled", visitId: "visit-c"});
    await seedPaid("pi_bob", {startedMinutesAgo: 5, uid: "bob", visitId: "visit-bob"});
    const {stored, creates} = await createFor("visit-mine");
    assert.equal(stored?.status, "done");
    assert.equal(creates.length, 1);
  });

  it("does not count a running stay at another place", async () => {
    await seedDriver();
    await seedPaid("pi_elsewhere", {startedMinutesAgo: 5, placeId: "place-2"});
    const {stored, creates} = await createFor("visit-here");
    assert.equal(stored?.status, "done");
    assert.equal(creates.length, 1);
  });

  it("still returns the receipt when the same visit asks again", async () => {
    await seedDriver();
    await seedPaid("pi_same1", {startedMinutesAgo: 10, visitId: "visit-same"});
    const {stored, creates} = await createFor("visit-same");
    assert.equal(stored?.status, "done");
    assert.equal(stored?.paymentIntentId, "pi_same1");
    assert.equal(creates.length, 0);
  });
});

describe("Ferro takes the payment at every payable car park", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    await clearDb(testDb(PROJECT));
  });

  const SHEET_ID = "f".repeat(64);

  function defined(o: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  }

  function sheetPlace(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: SHEET_ID, n: "Tesco Extra", p: [51.5, -0.12], s: 1, q: "known", aud: "c", auto: true,
      fee: 250, feeUnit: "hour", max: 180, operator: "Barnet Council", locationProvider: "PayByPhone",
      locationCode: "54321",
      ...over,
    };
  }

  function stored(place: Record<string, unknown>): Record<string, unknown> {
    return defined(place);
  }

  async function seed(place: Record<string, unknown>, opts: {on?: boolean; shard?: boolean} = {}): Promise<void> {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({subscriptionExpiresAt: Timestamp.fromMillis(Date.now() + 86_400_000)});
    await db.doc("config/parkingPayments").set({enabled: true, testMode: true, stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID});
    await db.doc("config/payments").set({ferroCollectsAll: opts.on ?? true});
    const other = {id: "other", n: "Other", p: [51.5, -0.12], s: 1};
    if (opts.shard) {
      await db.collection("privateParkingCells").doc("gcpvj0").set({v: 1, cell: "gcpvj0", shards: 2, places: [other]});
      await db.collection("privateParkingCells").doc("gcpvj0_1").set({v: 1, cell: "gcpvj0", places: [other]});
      await db.collection("privateParkingCells").doc("gcpvj0_2").set({v: 1, cell: "gcpvj0", places: [stored(place)]});
    } else {
      await db.collection("privateParkingCells").doc("gcpvj0").set({v: 1, cell: "gcpvj0", places: [other, stored(place)]});
    }
  }

  async function pay(extra: Record<string, unknown> = {}) {
    const db = testDb(PROJECT);
    const {stripe, creates} = echoingStripe();
    const id = `req-${Math.random().toString(36).slice(2)}`;
    await putCreate(id, defined({placeId: SHEET_ID, operator: "PayByPhone", cellId: "gcpvj0", ...extra}));
    await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc(id), PUBLISHABLE);
    const request = (await db.collection("parkingPaymentRequests").doc(id).get()).data();
    const paymentId = request?.paymentIntentId as string | undefined;
    const payment = paymentId ? (await db.collection("parkingPayments").doc(paymentId).get()).data() : undefined;
    return {request, payment, creates};
  }

  it("prices each started hour after the free time from the sheet and keeps the stay length", async () => {
    await seed(sheetPlace({free: 30}));
    const {request, payment, creates} = await pay({durationMinutes: 120});
    assert.equal(request?.status, "done", JSON.stringify(request));
    assert.equal(creates[0].params.amount, total(2 * 250)); // 90 chargeable minutes -> 2 hours
    assert.equal(payment?.parkingPence, 500);
    assert.equal(payment?.feePence, fee(2 * 250));
    assert.equal(payment?.durationMinutes, 120);
    assert.equal(payment?.locationCode, "54321");
    assert.equal(payment?.operator, "PayByPhone");
    assert.equal(payment?.zone, "Tesco Extra");
  });

  it("charges the flat fee per visit or per day and stores no stay length", async () => {
    for (const feeUnit of ["visit", "day", undefined]) {
      await clearDb(testDb(PROJECT));
      await seed(sheetPlace({feeUnit, fee: 300}));
      const {request, payment, creates} = await pay({durationMinutes: 60});
      assert.equal(request?.status, "done", String(feeUnit));
      assert.equal(creates[0].params.amount, total(300));
      assert.equal(payment?.durationMinutes, null);
    }
  });

  it("needs a stay length for an hourly car park, within its maximum and past its free time", async () => {
    await seed(sheetPlace({free: 60}));
    assert.equal((await pay()).request?.errorCode, "duration-required");
    assert.equal((await pay({durationMinutes: 240})).request?.errorCode, "duration-invalid"); // max 180
    assert.equal((await pay({durationMinutes: 60})).request?.errorCode, "duration-invalid"); // all free
    assert.equal((await pay({durationMinutes: 75})).request?.status, "done");
  });

  it("finds the place in a shard of its cell", async () => {
    await seed(sheetPlace({feeUnit: "visit"}), {shard: true});
    assert.equal((await pay()).request?.status, "done");
  });

  it("refuses places the apps wouldn't offer Pay at, and a different operator", async () => {
    for (const over of [{s: 2}, {auto: false}, {aud: "p"}, {q: undefined}, {conf: 0.3}, {fee: 0}]) {
      await clearDb(testDb(PROJECT));
      await seed(sheetPlace(over));
      const {request, creates} = await pay({durationMinutes: 60});
      assert.equal(request?.errorCode, "failed-precondition", JSON.stringify(over));
      assert.equal(creates.length, 0);
    }
    await clearDb(testDb(PROJECT));
    await seed(sheetPlace());
    assert.equal((await pay({durationMinutes: 60, operator: "RingGo"})).request?.errorCode, "failed-precondition");
  });

  it("asks an app that doesn't send the cell to update, and can't find a missing place", async () => {
    await seed(sheetPlace());
    const noCell = await pay({durationMinutes: 60, cellId: undefined});
    assert.equal(noCell.request?.errorCode, "failed-precondition");
    assert.match(String(noCell.request?.error), /Update the app/);
    assert.equal((await pay({durationMinutes: 60, cellId: "gcpvj1"})).request?.errorCode, "not-found");
  });

  it("stays off until config/payments.ferroCollectsAll is exactly true", async () => {
    await seed(sheetPlace(), {on: false});
    const {request, creates} = await pay({durationMinutes: 60});
    assert.equal(request?.errorCode, "not-found");
    assert.equal(creates.length, 0);
  });

  it("keeps an in-app place's own price when the switch is on", async () => {
    await seedDriver();
    await testDb(PROJECT).doc("config/payments").set({ferroCollectsAll: true});
    const {stripe, creates} = echoingStripe();
    const db = testDb(PROJECT);
    await putCreate("req-inapp", {cellId: "gcpvj0"});
    await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc("req-inapp"), PUBLISHABLE);
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-inapp").get()).get("status"), "done");
    assert.equal(creates[0].params.amount, total(450));
  });
});

describe("payment emails and the desk alert", () => {
  const input = {
    paymentIntentId: "pi_mail1", uid: "alice", plate: "AB12CDE", occurredOn: "2026-11-24", zone: "Tesco Extra",
    chargeType: "parking", authorityPence: 500, driverAmountPence: total(500), feePence: fee(500),
    paymentUrl: "https://www.paybyphone.co.uk/",
  };

  it("lists the parking time only when the price depended on it, and the location code", () => {
    const hourly = paidNotice({...input, durationMinutes: 90, locationCode: "54321"}).text;
    assert.match(hourly, /Parking time: 1 h 30 min/);
    assert.match(hourly, /Location code: 54321/);
    assert.match(jobOpenedNotice({...input, durationMinutes: 120}).text, /Parking time: 2 h/);
    const flat = paidNotice({...input, durationMinutes: null, locationCode: null}).text;
    assert.doesNotMatch(flat, /Parking time/);
    assert.doesNotMatch(flat, /Location code/);
    assert.doesNotMatch(paidNotice(input).text, /Parking time/);
    assert.equal(formatStay(30), "30 min");
    assert.equal(formatStay(120), "2 h");
    assert.equal(formatStay(90), "1 h 30 min");
  });
});

describe("adding time to a paid stay", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    await clearDb(testDb(PROJECT));
  });

  const PLACE = "e".repeat(64);
  const MIN = 60_000;

  async function seed(over: Record<string, unknown> = {}, root: Record<string, unknown> = {}): Promise<void> {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({subscriptionExpiresAt: Timestamp.fromMillis(Date.now() + 86_400_000)});
    await db.doc("config/parkingPayments").set({enabled: true, testMode: true, stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID});
    await db.doc("config/payments").set({ferroCollectsAll: true});
    await db.collection("privateParkingCells").doc("gcpvj0").set({v: 1, cell: "gcpvj0", places: [{
      id: PLACE, n: "Tesco Extra", p: [51.5, -0.12], s: 1, q: "known", aud: "c", auto: true,
      fee: 250, feeUnit: "hour", free: 30, max: 240, operator: "PayByPhone", locationCode: "54321", ...over,
    }]});
    await db.collection("parkingPayments").doc("pi_root1").set({
      v: 1, status: "paid", amount: 410, currency: "gbp", placeId: PLACE, visitId: "visit-root", operator: "PayByPhone",
      uid: "alice", chargeType: "parking", parkingPence: 250, feePence: 160, durationMinutes: 90,
      createdAt: Timestamp.fromMillis(Date.now() - 60 * MIN), stayEndsAt: Timestamp.fromMillis(Date.now() + 30 * MIN),
      ...root,
    });
  }

  async function add(extra: Record<string, unknown> = {}) {
    const db = testDb(PROJECT);
    const {stripe, creates} = echoingStripe();
    const id = `req-${Math.random().toString(36).slice(2)}`;
    const fields = {placeId: PLACE, operator: "PayByPhone", cellId: "gcpvj0", visitId: `visit-root-ext-${id}`,
      extendsPaymentId: "pi_root1", durationMinutes: 60, ...extra};
    await putCreate(id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc(id), PUBLISHABLE);
    const request = (await db.collection("parkingPaymentRequests").doc(id).get()).data();
    const pid = request?.paymentIntentId as string | undefined;
    const payment = pid ? (await db.collection("parkingPayments").doc(pid).get()).data() : undefined;
    return {request, payment, creates};
  }

  it("charges each added hour without the free time and moves the paid-until time on", async () => {
    await seed();
    const before = Date.now();
    const {request, payment, creates} = await add();
    assert.equal(request?.status, "done", JSON.stringify(request));
    assert.equal(creates[0].params.amount, total(250));
    assert.equal(payment?.extendsPaymentId, "pi_root1");
    assert.equal(payment?.durationMinutes, 60);
    const ends = (payment?.stayEndsAt as Timestamp).toMillis();
    assert.ok(ends >= before + 89 * MIN && ends <= Date.now() + 91 * MIN, String(ends - before));
  });

  it("refuses once the paid time has ended", async () => {
    await seed({}, {stayEndsAt: Timestamp.fromMillis(Date.now() - MIN)});
    const {request, creates} = await add();
    assert.equal(request?.errorCode, "stay-ended");
    assert.equal(creates.length, 0);
  });

  it("refuses another driver's stay, a stay at another place, and a flat-priced car park", async () => {
    await seed({}, {uid: "bob"});
    assert.equal((await add()).request?.errorCode, "stay-ended"); // bob's stay doesn't count for alice
    await clearDb(testDb(PROJECT));
    await seed({}, {placeId: "other"});
    assert.equal((await add()).request?.errorCode, "stay-ended");
    await clearDb(testDb(PROJECT));
    await seed({feeUnit: "visit"});
    assert.equal((await add()).request?.errorCode, "failed-precondition");
  });

  it("won't add time past the car park's maximum stay", async () => {
    await seed({max: 120});
    assert.equal((await add({durationMinutes: 60})).request?.errorCode, "duration-invalid"); // 60 + 30 left + 60 > 120
    assert.equal((await add({durationMinutes: 30})).request?.status, "done");
  });

  it("still refuses a new stay until the added time has run out", async () => {
    await seed();
    await add();
    const {request} = await add({extendsPaymentId: undefined, visitId: "visit-new"});
    assert.equal(request?.errorCode, "already-paid");
  });

  it("tells the desk and the driver which stay the time is added to and when it now ends", () => {
    const text = paidNotice({
      paymentIntentId: "pi_ext1", uid: "alice", plate: "AB12CDE", occurredOn: "2026-11-24", zone: "Tesco Extra",
      chargeType: "parking", authorityPence: 250, driverAmountPence: total(250), feePence: fee(250),
      paymentUrl: "https://www.paybyphone.co.uk/", durationMinutes: 60, extendsPaymentId: "pi_root1",
      stayEndsAtMs: Date.UTC(2026, 10, 24, 15, 30),
    }).text;
    assert.match(text, /Parking time: 1 h/);
    assert.match(text, /Adds time to: pi_root1/);
    assert.match(text, /Paid until: 24 Nov, 15:30/);
  });
});

describe("Ferro pays any operator that takes payment online", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    await clearDb(testDb(PROJECT));
  });

  const ID = "d".repeat(64);

  async function seed(place: Record<string, unknown>): Promise<void> {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({subscriptionExpiresAt: Timestamp.fromMillis(Date.now() + 86_400_000)});
    await db.doc("config/parkingPayments").set({enabled: true, testMode: true, stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID});
    await db.doc("config/payments").set({ferroCollectsAll: true});
    const full = {id: ID, n: "London St Pancras International Station - Saba Car Park", p: [51.53, -0.12], s: 1, q: "known",
      aud: "a", auto: true, fee: 1000, feeUnit: "day", operator: "Saba", src: "https://www.sabaparking.co.uk/car-park/st-pancras", ...place};
    await db.collection("privateParkingCells").doc("gcpvj0").set({v: 1, cell: "gcpvj0",
      places: [Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined))]});
  }

  async function pay(operator: string) {
    const db = testDb(PROJECT);
    const {stripe, creates} = echoingStripe();
    const id = `req-${Math.random().toString(36).slice(2)}`;
    await putCreate(id, {placeId: ID, operator, cellId: "gcpvj0"});
    await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc(id), PUBLISHABLE);
    const request = (await db.collection("parkingPaymentRequests").doc(id).get()).data();
    const pid = request?.paymentIntentId as string | undefined;
    const payment = pid ? (await db.collection("parkingPayments").doc(pid).get()).data() : undefined;
    return {request, payment, creates};
  }

  it("takes the payment for a named operator and points staff at the car park's own site", async () => {
    await seed({});
    const {request, payment, creates} = await pay("Saba");
    assert.equal(request?.status, "done", JSON.stringify(request));
    assert.equal(creates[0].params.amount, total(1000));
    assert.equal(payment?.operator, "Saba");
    assert.equal(payment?.paymentUrl, "https://www.sabaparking.co.uk/car-park/st-pancras");
    assert.equal((await pay("SABA ")).request?.status, "done"); // case and spacing don't matter
  });

  it("refuses a different operator, a car park marked off, and one with no operator", async () => {
    await seed({});
    assert.equal((await pay("NCP")).request?.errorCode, "failed-precondition");
    await clearDb(testDb(PROJECT));
    await seed({payMode: "off"});
    assert.equal((await pay("Saba")).request?.errorCode, "failed-precondition");
    await clearDb(testDb(PROJECT));
    await seed({operator: undefined});
    assert.equal((await pay("Saba")).request?.errorCode, "failed-precondition");
  });

  it("matches a long operator name cut to 40 characters, and searches when there's no source page", async () => {
    await seed({operator: "St Pancras International   Car Parking (NCP) Limited", src: undefined});
    const {request, payment} = await pay("St Pancras International Car Parking (NC");
    assert.equal(request?.status, "done", JSON.stringify(request));
    assert.match(String(payment?.paymentUrl), /^https:\/\/www\.google\.com\/search\?q=/);
  });
});

describe("stepped prices by day and time (price lists)", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    pricingClock.nowMs = () => Date.now();
    await clearDb(testDb(PROJECT));
  });

  const ID = "c".repeat(64);
  const MIN = 60_000;
  const CITY = {v: 1, s: [
    {d: 63, f: 480, t: 1080, b: [60, 190, 120, 310, 180, 450, 240, 600]},
    {d: 0, bh: 1, f: 0, t: 1440, b: [1440, 0]},
  ], h: ["2026-12-25", "2026-12-28"], ht: "2027-12-31"};
  // Every day, all day, no bank holidays: the real clock can't fall outside it.
  const ALWAYS = {v: 1, s: [{d: 127, f: 0, t: 1440, b: [120, 510, 240, 770, 1440, 2300]}], h: [], ht: "2099-12-31"};

  async function seed(rates: Record<string, unknown>, opts: {stepped?: unknown} = {}): Promise<void> {
    const db = testDb(PROJECT);
    await db.collection("users").doc("alice").set({subscriptionExpiresAt: Timestamp.fromMillis(Date.now() + 86_400_000)});
    await db.doc("config/parkingPayments").set({enabled: true, testMode: true, stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID});
    // Leaving the field out is one of the "off" cases.
    const stepped = "stepped" in opts ? opts.stepped : true;
    await db.doc("config/payments").set({ferroCollectsAll: true, ...(stepped === undefined ? {} : {steppedTariffs: stepped})});
    await db.collection("privateParkingCells").doc("gcpvj0").set({v: 1, cell: "gcpvj0", places: [{
      id: ID, n: "Gun Quarter CPZ", p: [52.49, -1.9], s: 1, q: "known", aud: "a", auto: true, payMode: "inapp",
      max: 240, operator: "RingGo", locationProvider: "ringgo", locationCode: "684268", rates,
    }]});
  }

  async function pay(extra: Record<string, unknown> = {}) {
    const db = testDb(PROJECT);
    const {stripe, creates} = echoingStripe();
    const id = `req-${Math.random().toString(36).slice(2)}`;
    const fields = {placeId: ID, operator: "RingGo", cellId: "gcpvj0", ...extra};
    await putCreate(id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc(id), PUBLISHABLE);
    const request = (await db.collection("parkingPaymentRequests").doc(id).get()).data();
    const pid = request?.paymentIntentId as string | undefined;
    const payment = pid ? (await db.collection("parkingPayments").doc(pid).get()).data() : undefined;
    return {request, payment, creates};
  }

  function at(iso: string): void {
    pricingClock.nowMs = () => Date.parse(iso);
  }

  it("stays off until config/payments.steppedTariffs is exactly true", async () => {
    at("2026-11-27T09:00:00Z");
    for (const stepped of [undefined, "true", 1]) {
      await clearDb(testDb(PROJECT));
      await seed(CITY, {stepped});
      const {request, creates} = await pay({durationMinutes: 60});
      assert.equal(request?.errorCode, "failed-precondition", JSON.stringify(request));
      assert.equal(creates.length, 0);
    }
  });

  it("charges the band for the stay and tells the desk which band to buy", async () => {
    at("2026-11-27T09:00:00Z");
    await seed(CITY);
    const {request, payment, creates} = await pay({durationMinutes: 120});
    assert.equal(request?.status, "done", JSON.stringify(request));
    assert.equal(creates[0].params.amount, total(310));
    assert.equal(payment?.parkingPence, 310);
    assert.equal(payment?.durationMinutes, 120);
    assert.equal(payment?.tariffBand, "Up to 2 hours, Mon–Sat 8am–6pm");
    assert.equal(payment?.locationCode, "684268");
    const text = paidNotice({
      paymentIntentId: "pi_band1", uid: "alice", plate: "AB12CDE", occurredOn: "2026-11-27", zone: "Gun Quarter CPZ",
      chargeType: "parking", authorityPence: 310, driverAmountPence: total(310), feePence: fee(310),
      paymentUrl: "https://www.ringgo.co.uk/", durationMinutes: 120, tariffBand: payment?.tariffBand as string,
    }).text;
    assert.match(text, /Band to buy: Up to 2 hours, Mon–Sat 8am–6pm/);
  });

  it("cuts a stay at the end of charging time and prices what's left", async () => {
    at("2026-11-27T17:30:00Z");
    await seed(CITY);
    const {request, payment, creates} = await pay({durationMinutes: 120});
    assert.equal(request?.status, "done", JSON.stringify(request));
    assert.equal(creates[0].params.amount, total(190));
    assert.equal(payment?.durationMinutes, 30);
    assert.equal(payment?.tariffBand, "Up to 1 hour, Mon–Sat 8am–6pm");
  });

  it("takes nothing outside charging times, on a free bank holiday, or for a stay too long", async () => {
    await seed(CITY);
    at("2026-11-27T21:00:00Z");
    assert.equal((await pay({durationMinutes: 60})).request?.errorCode, "no-charge-now");
    at("2026-12-25T12:00:00Z");
    assert.equal((await pay({durationMinutes: 60})).request?.errorCode, "no-charge-now");
    at("2026-11-27T09:00:00Z");
    assert.equal((await pay({durationMinutes: 300})).request?.errorCode, "duration-invalid");
    assert.equal((await pay({durationMinutes: undefined})).request?.errorCode, "duration-required");
  });

  it("refuses a broken price list instead of guessing", async () => {
    at("2026-11-27T09:00:00Z");
    await seed({...CITY, s: [{d: 63, f: 480, t: 1080, b: [60, 300, 120, 200]}]});
    assert.equal((await pay({durationMinutes: 60})).request?.errorCode, "failed-precondition");
  });

  it("charges added time as the band for the whole stay less what the stay has paid", async () => {
    pricingClock.nowMs = () => Date.now();
    await seed(ALWAYS);
    const db = testDb(PROJECT);
    await db.collection("parkingPayments").doc("pi_root1").set({
      v: 1, status: "paid", amount: 670, currency: "gbp", placeId: ID, visitId: "visit-root", operator: "RingGo",
      uid: "alice", chargeType: "parking", parkingPence: 510, feePence: 160, durationMinutes: 120,
      createdAt: Timestamp.fromMillis(Date.now() - 60 * MIN), stayEndsAt: Timestamp.fromMillis(Date.now() + 60 * MIN),
    });
    const {request, payment, creates} = await pay({extendsPaymentId: "pi_root1", visitId: "visit-root-ext", durationMinutes: 60});
    assert.equal(request?.status, "done", JSON.stringify(request));
    // 1 h paid and 1 h left, plus 1 h: a 3-hour stay is the 4-hour band, 770, less the 510 paid.
    assert.equal(creates[0].params.amount, total(260));
    assert.equal(payment?.extendsPaymentId, "pi_root1");
    assert.equal(payment?.durationMinutes, 60);
    assert.equal(payment?.tariffBand, "Up to 4 hours, every day");
  });
});

describe("what the driver pays on top of the charge", () => {
  it("is the Stripe charge, 1.5% to the nearest penny with half a penny rounding up, plus the 1.60 Ferro fee", () => {
    assert.equal(stripeChargePence(310), 5); // 4.65
    assert.equal(stripeChargePence(450), 7); // 6.75
    assert.equal(stripeChargePence(1800), 27);
    assert.equal(stripeChargePence(2100), 32); // 31.5 rounds up
    assert.equal(stripeChargePence(34), 1); // 0.51
    assert.equal(stripeChargePence(33), 0); // 0.495
    assert.equal(serviceFeePence(310), 165);
    assert.equal(serviceFeePence(1800), 187);
    assert.equal(serviceFeePence(2100), 192);
    assert.equal(serviceFeePence(0), 160);
  });

  it("names both parts for the desk and the driver, and the Ferro fee alone on an older payment", () => {
    const input = {
      paymentIntentId: "pi_fee1", uid: "alice", plate: "AB12CDE", occurredOn: "2026-11-27", zone: "Yard",
      chargeType: "parking", authorityPence: 450, driverAmountPence: 617, feePence: 167, stripeChargePence: 7,
      paymentUrl: "https://www.myringgo.com/",
    };
    assert.match(paidNotice(input).text, /Driver paid: £6\.17 \(includes £1\.60 Ferro fee and £0\.07 Stripe charge\)/);
    assert.match(refundedNotice(input, false).text,
      /We've refunded £6\.17, including the Ferro fee and Stripe charge\./);
    assert.match(refundedNotice({...input, refundedPence: 100}, true).text,
      /We've refunded £1\.00\. The Ferro fee and Stripe charge stay on the amount the authority actually charged\./);
    const older = {...input, driverAmountPence: 610, feePence: 160, stripeChargePence: 0};
    assert.match(paidNotice(older).text, /Driver paid: £6\.10 \(includes £1\.60 Ferro fee\)/);
    assert.match(refundedNotice(older, false).text, /including the Ferro fee\./);
  });
});
