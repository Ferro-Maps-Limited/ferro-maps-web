import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {after, before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  mergeStatus,
  paymentIntentIdempotencyKey,
  ParkingPaymentError,
  resolveStatus,
  retryIdempotencyKey,
} from "../src/parking/contract";
import {
  acknowledgeOperatorForward,
  runParkingPaymentRequest,
  type ParkingStripe,
  type PaymentIntentShape,
} from "../src/parking/payments";
import {handleParkingPaymentRequest} from "../src/parking/onParkingPaymentRequest";
import {assertStripeTestKey} from "../src/parking/stripeClient";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-parking-pay";

const PLATE = "AB12CDE";

function shape(over: Partial<PaymentIntentShape> = {}): PaymentIntentShape {
  return {
    id: "pi_test1",
    client_secret: "pi_test1_secret_value",
    status: "requires_payment_method",
    amount: 610,
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
    parkingPence: 450,
    feePence: 160,
    connectedAccountId: "acct_dest123",
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

  it("prices from the place and opens a destination charge", async () => {
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
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"));

    const request = (await db.collection("parkingPaymentRequests").doc("req-1").get()).data();
    assert.equal(request?.status, "done");
    assert.equal(request?.paymentIntentClientSecret, "pi_test1_secret_value");
    assert.equal(request?.customerId, "cus_test");
    assert.equal(request?.ephemeralKey, "ek_test_secret");
    assert.equal(request?.paymentId, "pi_test1");
    assert.equal(request?.paymentIntentId, "pi_test1");
    assert.equal(request?.parkingPence, 450);
    assert.equal(request?.feePence, 160);
    assert.equal(request?.amount, 610);
    assert.equal(request?.currency, "gbp");
    assert.equal(request?.plate, "ab12 cde");
    assert.equal("connectedAccountId" in (request ?? {}), false);

    const stored = (await db.collection("parkingPayments").doc("pi_test1").get()).data();
    assert.equal(stored?.status, "created");
    assert.equal(stored?.uid, "alice");
    assert.equal(stored?.visitId, "visit-1");
    assert.equal(stored?.amount, 610);
    assert.equal(stored?.paymentIntentId, "pi_test1");
    assert.ok(stored?.updatedAt);
    assert.equal(JSON.stringify(stored).includes(PLATE), false);
    assert.equal(JSON.stringify(stored).includes("secret"), false);

    const created = stripe.creates[0];
    assert.equal(created.options.idempotencyKey, paymentIntentIdempotencyKey("alice", "place-1", "visit-1"));
    assert.equal(created.options.idempotencyKey, "alice:place-1:visit-1");
    assert.equal(created.params.amount, 610);
    assert.equal(created.params.currency, "gbp");
    assert.deepEqual(created.params.metadata, {uid: "alice", placeId: "place-1", visitId: "visit-1"});
    assert.deepEqual(created.params.transfer_data, {destination: "acct_dest123", amount: 450});
    assert.equal("application_fee_amount" in created.params, false);
    assert.equal("payment_method_types" in created.params, false);
    assert.equal("connectedAccountId" in created.params, false);
    assert.equal((await db.collection("operatorForwards").doc("pi_test1").get()).exists, false);
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
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"));
    await db.collection("parkingPaymentRequests").doc("req-2").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-2"));
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
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"));
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
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef);
    await confirmRef.update({status: "pending"});
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef);

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

  it("rejects a place that is not in-app and a driver who is not Gold", async () => {
    const db = testDb(PROJECT);
    await seedDriver();
    await db.collection("places").doc("place-1").update({payMode: "handoff"});
    await db.collection("parkingPaymentRequests").doc("req-1").set({
      uid: "alice", v: 1, action: "create", placeId: "place-1", visitId: "visit-1", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    const stripe = mockStripe(shape());
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"));
    const failed = (await db.collection("parkingPaymentRequests").doc("req-1").get()).data();
    assert.equal(failed?.errorCode, "failed-precondition");
    assert.equal(failed?.plate, undefined);
    assert.equal(stripe.creates.length, 0);

    await db.collection("users").doc("bob").set({
      subscriptionExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });
    await db.collection("parkingPaymentRequests").doc("req-bob").set({
      uid: "bob", v: 1, action: "create", placeId: "place-1", visitId: "visit-2", operator: "RingGo",
      plate: "AB12CDE", platform: "android", appVersion: "1.4.0", status: "pending",
      createdAt: Timestamp.now(),
    });
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-bob"));
    const bobRequest = (await db.collection("parkingPaymentRequests").doc("req-bob").get()).data();
    assert.equal(bobRequest?.errorCode, "permission-denied");
    assert.equal(bobRequest?.plate, undefined);
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
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-fail"));
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
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-retry"));
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
      await runParkingPaymentRequest(db, stripe, db.collection("parkingPaymentRequests").doc(requestId));
    }
    assert.equal(creates.length, 3);
    assert.equal(creates[0].options.idempotencyKey, paymentIntentIdempotencyKey("alice", "place-1", "visit-retry"));
    assert.equal(creates[1].options.idempotencyKey, retryIdempotencyKey("alice", "place-1", "visit-retry", "pi_fail1"));
    assert.equal(creates[2].options.idempotencyKey, retryIdempotencyKey("alice", "place-1", "visit-retry", "pi_fail2"));
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
    await runParkingPaymentRequest(db, stripe.stripe, db.collection("parkingPaymentRequests").doc("req-1"));
    await db.collection("parkingPaymentRequests").doc("req-1").update({plate: null});
    payment.status = "succeeded";
    const confirmRef = db.collection("parkingPaymentRequests").doc("pi_test1_confirm");
    await confirmRef.set({
      v: 1, action: "confirm", status: "pending", createdAt: Timestamp.now(), uid: "alice",
      paymentId: "pi_test1", paymentIntentId: "pi_test1", originalRequestId: "req-1",
    });
    await runParkingPaymentRequest(db, stripe.stripe, confirmRef);
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
    await handleParkingPaymentRequest(db, leaked, ref);
    const stored = (await ref.get()).data();
    assert.equal(stored?.status, "error");
    assert.equal(stored?.errorCode, "failed-precondition");
    assert.equal(stored?.plate, undefined);
    assert.equal(JSON.stringify(stored).includes(leaked), false);
    assert.ok(stored?.expireAt);
  });

  it("has no webhook secret in the parking functions", () => {
    const root = join(__dirname, "..", "src", "parking");
    const files = readdirSync(root).filter((name) => name.endsWith(".ts"));
    for (const name of files) {
      const text = readFileSync(join(root, name), "utf8");
      assert.equal(text.includes("STRIPE_WEBHOOK_SECRET"), false);
      assert.equal(text.includes("stripeWebhook"), false);
      assert.equal(text.includes("sk_live_"), false);
      assert.equal(text.includes("whsec_"), false);
    }
  });
});
