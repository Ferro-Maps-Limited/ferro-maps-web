import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {after, before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {mergeStatus, paymentIntentIdempotencyKey, ParkingPaymentError, resolveStatus} from "../src/parking/contract";
import {runParkingPaymentRequest, type ParkingStripe, type PaymentIntentShape} from "../src/parking/payments";
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

function mockStripe(payment: PaymentIntentShape) {
  const creates: {params: Record<string, unknown>; options: {idempotencyKey: string}}[] = [];
  let retrieves = 0;
  const stripe: ParkingStripe = {
    customers: {
      create: async () => ({id: "cus_test"}),
    },
    paymentIntents: {
      create: async (params, options) => {
        creates.push({params: params as unknown as Record<string, unknown>, options});
        return payment;
      },
      retrieve: async (id) => {
        retrieves += 1;
        return {...payment, id};
      },
    },
    ephemeralKeys: {
      create: async (_params, options) => {
        assert.equal(options.apiVersion.length > 0, true);
        return {secret: "ek_test_secret"};
      },
    },
  };
  return {stripe, creates, retrieveCount: () => retrieves};
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
    assert.equal((await db.collection("operatorForwards").get()).size, 1);
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
