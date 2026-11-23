import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";
import {Timestamp, type Transaction} from "firebase-admin/firestore";
import type {Message} from "firebase-admin/messaging";
import Stripe from "stripe";
import {deliverNotification, type NoticeDelivery} from "../src/parking/notices";
import {clearFcmToken, readFcmToken} from "../src/parking/paymentPush";
import {runParkingPaymentRequest, type ParkingStripe, type PaymentIntentShape} from "../src/parking/payments";
import {reconcileParkingPaymentsOnce, type ReconcileStripe} from "../src/parking/reconcile";
import {EXPECTED_STRIPE_ACCOUNT_ID} from "../src/parking/stripeClient";
import {
  STRIPE_WEBHOOK_EVENTS,
  handleStripeWebhook,
  type StripeWebhookDeps,
} from "../src/parking/stripeWebhook";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-stripe-webhook";
const PAYMENT_ID = "pi_hook1";
const TEST_KEY = "sk_test_fixture_not_used";
const WEBHOOK_SECRET = "test_only_webhook_signing_secret";

const signer = new Stripe(TEST_KEY, {apiVersion: Stripe.API_VERSION});

function shape(over: Partial<PaymentIntentShape> = {}): PaymentIntentShape {
  return {
    id: PAYMENT_ID,
    client_secret: null,
    status: "succeeded",
    amount: 610,
    currency: "gbp",
    customer: "cus_test",
    ...over,
  };
}

const PARKING_METADATA = {
  uid: "alice",
  placeId: "place-1",
  visitId: "visit-1",
  chargeType: "parking",
  ferroAccount: EXPECTED_STRIPE_ACCOUNT_ID,
};

function payload(over: {
  id?: string;
  type?: string;
  livemode?: boolean;
  status?: string;
  metadata?: Record<string, string> | null;
  lastPaymentError?: boolean;
  intentLivemode?: boolean;
  amount?: number;
  currency?: string;
} = {}): string {
  const metadata = over.metadata === null ? undefined : (over.metadata ?? PARKING_METADATA);
  return JSON.stringify({
    id: over.id ?? "evt_succeeded1",
    object: "event",
    api_version: Stripe.API_VERSION,
    created: 1_700_000_000,
    type: over.type ?? "payment_intent.succeeded",
    livemode: over.livemode ?? false,
    data: {
      object: {
        id: PAYMENT_ID,
        object: "payment_intent",
        status: over.status ?? "succeeded",
        amount: over.amount ?? 610,
        currency: over.currency ?? "gbp",
        livemode: over.intentLivemode ?? over.livemode ?? false,
        client_secret: null,
        customer: "cus_test",
        ...(metadata ? {metadata} : {}),
        ...(over.lastPaymentError ? {last_payment_error: {type: "card_error", code: "card_declined"}} : {}),
      },
    },
  });
}

function refundPayload(over: {
  id?: string;
  metadata?: Record<string, string> | null;
  amountRefunded?: number;
} = {}): string {
  const metadata = over.metadata === null ? undefined : (over.metadata ?? PARKING_METADATA);
  return JSON.stringify({
    id: over.id ?? "evt_refund1",
    object: "event",
    api_version: Stripe.API_VERSION,
    created: 1_700_000_000,
    type: "charge.refunded",
    livemode: false,
    data: {
      object: {
        id: "ch_refund1",
        object: "charge",
        payment_intent: PAYMENT_ID,
        amount: 610,
        amount_refunded: over.amountRefunded ?? 610,
        currency: "gbp",
        refunded: (over.amountRefunded ?? 610) >= 610,
        livemode: false,
        ...(metadata ? {metadata} : {}),
      },
    },
  });
}

function signed(body: string, secret = WEBHOOK_SECRET): string {
  return signer.webhooks.generateTestHeaderString({payload: body, secret});
}

function deps(over: Partial<StripeWebhookDeps> = {}): StripeWebhookDeps & {cancels: string[]} {
  const cancels: string[] = [];
  return {
    secretKey: TEST_KEY,
    webhookSecret: WEBHOOK_SECRET,
    constructEvent: (raw, signature, secret) => signer.webhooks.constructEvent(raw, signature, secret),
    stripe: {
      paymentIntents: {
        retrieve: async (id) => shape({id, status: "requires_payment_method", last_payment_error: {code: "card_declined"}}),
        cancel: async (id) => {
          cancels.push(id);
          return shape({id, status: "canceled"});
        },
      },
    },
    cancels,
    ...over,
  };
}

async function enable(db = testDb(PROJECT)): Promise<void> {
  await db.doc("config/flags").set({stripeWebhookEnabled: true});
}

async function seedPayment(id = PAYMENT_ID): Promise<void> {
  const db = testDb(PROJECT);
  const stale = Timestamp.fromMillis(Date.now() - 10 * 60_000);
  await db.doc("funding/state").set({
    balancePence: 100_000,
    reservedPence: 0,
    spentTodayPence: 0,
    spentDay: "2026-11-22",
    dailyCapPence: 200_000,
    lowWaterPence: 10_000,
    paused: false,
    lowWaterAlerted: false,
    lowWaterGeneration: 0,
    pauseGeneration: 0,
  });
  await db.collection("parkingPayments").doc(id).set({
    v: 1,
    status: "created",
    amount: 610,
    currency: "gbp",
    placeId: "place-1",
    visitId: "visit-1",
    operator: "RingGo",
    uid: "alice",
    requestId: "req-1",
    paymentIntentId: id,
    chargeType: "parking",
    authorityPence: 450,
    parkingPence: 450,
    feePence: 160,
    zone: "Yard",
    paymentUrl: "https://www.myringgo.com/",
    occurredOn: "2026-11-22",
    failureReason: null,
    createdAt: stale,
    updatedAt: stale,
  });
  await db.collection("parkingPaymentRequests").doc("req-1").set({
    uid: "alice",
    v: 1,
    action: "create",
    status: "done",
    placeId: "place-1",
    visitId: "visit-1",
    plate: "AB12CDE",
  });
}

async function post(
  body: string,
  header: string | undefined,
  input: StripeWebhookDeps = deps(),
): Promise<number> {
  return handleStripeWebhook(testDb(PROJECT), input, {
    method: "POST",
    rawBody: body,
    signature: header,
  });
}

async function pushCount(): Promise<number> {
  const snap = await testDb(PROJECT).collection("paymentNotifications").where("channel", "==", "push").get();
  return snap.size;
}

describe("stripeWebhook", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  it("accepts a valid signature and writes status paid", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const body = payload();
    const code = await post(body, signed(body));
    assert.equal(code, 200);
    const stored = (await db.collection("parkingPayments").doc(PAYMENT_ID).get()).data();
    assert.equal(stored?.status, "paid");
    assert.equal(stored?.paymentIntentId, PAYMENT_ID);
    assert.equal(stored?.failureReason, null);
    assert.equal(JSON.stringify(stored).includes("succeeded"), false);
    const event = await db.collection(STRIPE_WEBHOOK_EVENTS).doc("evt_succeeded1").get();
    assert.equal(event.exists, true);
    assert.equal(await pushCount(), 1);
    const push = await db.collection("paymentNotifications").doc(`${PAYMENT_ID}:paid:push`).get();
    assert.equal(push.get("channel"), "push");
    assert.equal(push.get("payloadStatus"), "paid");
  });

  it("rejects a missing or bad signature", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const body = payload();
    assert.equal(await post(body, undefined), 400);
    assert.equal(await post(body, signed(body, "wrong_webhook_signing_secret")), 400);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");
    assert.equal((await db.collection(STRIPE_WEBHOOK_EVENTS).get()).size, 0);
    assert.equal(await pushCount(), 0);
  });

  it("ignores a duplicate event", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const body = payload();
    const header = signed(body);
    assert.equal(await post(body, header), 200);
    assert.equal(await post(body, header), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "paid");
    assert.equal((await db.collection(STRIPE_WEBHOOK_EVENTS).get()).size, 1);
    assert.equal(await pushCount(), 1);
    assert.equal((await db.collection("operatorForwards").get()).size, 1);
  });

  it("keeps one paid status and one push when the webhook runs before reconcile", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const confirm = {
      v: 1,
      action: "confirm",
      status: "pending",
      createdAt: Timestamp.now(),
      uid: "alice",
      paymentId: PAYMENT_ID,
      paymentIntentId: PAYMENT_ID,
      originalRequestId: "req-1",
    };
    await db.collection("parkingPaymentRequests").doc(`${PAYMENT_ID}_confirm`).set(confirm);
    const body = payload();
    assert.equal(await post(body, signed(body)), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "paid");
    const untouched = (await db.collection("parkingPaymentRequests").doc(`${PAYMENT_ID}_confirm`).get()).data();
    assert.equal(untouched?.status, "pending");
    assert.equal(untouched?.paymentStatus, undefined);
    assert.equal(untouched?.paymentIntentId, PAYMENT_ID);

    const retrieved: string[] = [];
    const reconcileStripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => {
          retrieved.push(id);
          return shape({id, status: "succeeded"});
        },
        cancel: async () => {
          throw new Error("cancel");
        },
      },
      events: {list: async () => ({data: [], has_more: false})},
    };
    await reconcileParkingPaymentsOnce(db, reconcileStripe, Date.now());
    assert.deepEqual(retrieved, []);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "paid");
    assert.equal(await pushCount(), 1);

    const payment: PaymentIntentShape = shape();
    const parking: ParkingStripe = {
      customers: {create: async () => ({id: "cus_test"})},
      paymentIntents: {
        create: async () => payment,
        retrieve: async (id) => ({...payment, id}),
        cancel: async (id) => ({...payment, id, status: "canceled"}),
      },
      ephemeralKeys: {create: async () => ({secret: "ek_test"})},
    };
    await runParkingPaymentRequest(
      db,
      parking,
      db.collection("parkingPaymentRequests").doc(`${PAYMENT_ID}_confirm`),
      "pk_test_publishable",
    );
    const confirmed = await db.collection("parkingPaymentRequests").doc(`${PAYMENT_ID}_confirm`).get();
    assert.equal(confirmed.get("status"), "done");
    assert.equal(confirmed.get("paymentStatus"), "paid");
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "paid");
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("paymentIntentId"), PAYMENT_ID);
    assert.equal(await pushCount(), 1);
  });

  it("sends the paid push once across a duplicate event and a later reconcile", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    await db.collection("users").doc("alice").set({fcmToken: "device-token"});
    const body = payload({id: "evt_once1"});
    const header = signed(body);
    assert.equal(await post(body, header), 200);
    assert.equal(await post(body, header), 200);
    const reconcileStripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => shape({id}),
        cancel: async (id) => shape({id, status: "canceled"}),
      },
      events: {list: async () => ({data: [], has_more: false})},
    };
    await reconcileParkingPaymentsOnce(db, reconcileStripe, Date.now());
    assert.equal(await pushCount(), 1);
    const sent: Message[] = [];
    const notice: NoticeDelivery = {
      sendEmail: async () => undefined,
      postSlack: async () => undefined,
      emailForUid: async () => null,
      tokenForUid: (uid) => readFcmToken(db, uid),
      clearToken: (uid) => clearFcmToken(db, uid),
      sendPush: async (message) => {
        sent.push(message);
      },
    };
    await deliverNotification(db, `${PAYMENT_ID}:paid:push`, notice);
    await deliverNotification(db, `${PAYMENT_ID}:paid:push`, notice);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.data?.type, "parking_payment");
    assert.equal(sent[0]?.data?.paymentId, PAYMENT_ID);
    assert.equal(sent[0]?.data?.status, "paid");
    assert.equal(sent[0]?.notification?.title, "Payment taken");
    const payment = await db.collection("parkingPayments").doc(PAYMENT_ID).get();
    assert.equal(payment.get("status"), "paid");
    assert.equal(payment.get("notifiedTitle"), "Payment taken");
  });

  it("does nothing when the flag is off", async () => {
    const db = testDb(PROJECT);
    await seedPayment();
    const body = payload();
    let constructed = 0;
    const input = deps({
      constructEvent: (raw, signature, secret) => {
        constructed += 1;
        return signer.webhooks.constructEvent(raw, signature, secret);
      },
    });
    assert.equal(await post(body, signed(body), input), 200);
    await db.doc("config/flags").set({stripeWebhookEnabled: false});
    assert.equal(await post(body, "not-a-signature", input), 200);
    assert.equal(constructed, 0);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");
    assert.equal((await db.collection(STRIPE_WEBHOOK_EVENTS).get()).size, 0);
    assert.equal(await pushCount(), 0);
  });

  it("accepts a live event only when stripeLiveEnabled is true and the key mode matches", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const liveEvent = payload({id: "evt_liveoff", livemode: true});
    assert.equal(await post(liveEvent, signed(liveEvent)), 400);
    const liveKey = "sk_live_do_not_print";
    const testEvent = payload({id: "evt_livekey"});
    assert.equal(await post(testEvent, signed(testEvent), deps({secretKey: liveKey})), 400);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");

    await db.doc("config/payments").set({stripeLiveEnabled: true});
    const mismatched = payload({id: "evt_livemismatch", livemode: true});
    assert.equal(await post(mismatched, signed(mismatched)), 400);
    const liveOnTestKey = payload({id: "evt_testmismatch"});
    assert.equal(await post(liveOnTestKey, signed(liveOnTestKey), deps({secretKey: liveKey})), 400);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");

    const accepted = payload({id: "evt_liveok", livemode: true});
    assert.equal(await post(accepted, signed(accepted), deps({secretKey: liveKey})), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "paid");
    assert.equal(await pushCount(), 1);
  });

  it("writes partially_refunded when amount_refunded is below the payment", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    await db.collection("parkingPayments").doc(PAYMENT_ID).update({status: "paid"});
    const body = refundPayload({id: "evt_partial1", amountRefunded: 100});
    assert.equal(await post(body, signed(body)), 200);
    const stored = await db.collection("parkingPayments").doc(PAYMENT_ID).get();
    assert.equal(stored.get("status"), "partially_refunded");
    assert.equal(stored.get("failureReason"), "Part of the payment was refunded.");
    assert.equal((await db.collection("paymentNotifications").doc(`${PAYMENT_ID}:refunded:push`).get()).exists, false);
  });

  it("completes a partial refund into refunded and writes the refund push then", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    await db.collection("parkingPayments").doc(PAYMENT_ID).update({status: "paid"});
    await db.collection("authorityPayments").doc(PAYMENT_ID).set({
      status: "fulfilled",
      uid: "alice",
      chargeType: "parking",
      authorityPence: 450,
      driverAmountPence: 610,
      feePence: 160,
      occurredOn: "2026-11-22",
      zone: "Yard",
      paymentUrl: "https://www.myringgo.com/",
    });
    const first = refundPayload({id: "evt_partialthen", amountRefunded: 200});
    assert.equal(await post(first, signed(first)), 200);
    const partial = await db.collection("parkingPayments").doc(PAYMENT_ID).get();
    assert.equal(partial.get("status"), "partially_refunded");
    assert.equal((await db.collection("paymentNotifications").doc(`${PAYMENT_ID}:refunded:push`).get()).exists, false);

    const second = refundPayload({id: "evt_partialdone", amountRefunded: 610});
    assert.equal(await post(second, signed(second)), 200);
    const done = await db.collection("parkingPayments").doc(PAYMENT_ID).get();
    assert.equal(done.get("status"), "refunded");
    assert.equal(done.get("failureReason"), "The payment was refunded.");
    const push = await db.collection("paymentNotifications").doc(`${PAYMENT_ID}:refunded:push`).get();
    assert.equal(push.exists, true);
    assert.equal(push.get("channel"), "push");
    assert.equal(push.get("event"), "refunded");
    assert.equal(push.get("payloadStatus"), "refunded");
    assert.equal(await pushCount(), 1);
  });

  it("rejects a refund while the payment is still created or failed", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const created = refundPayload({id: "evt_refundcreated"});
    assert.equal(await post(created, signed(created)), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");
    assert.equal(await pushCount(), 0);

    await db.collection("parkingPayments").doc(PAYMENT_ID).update({status: "failed"});
    const failed = refundPayload({id: "evt_refundfailed"});
    assert.equal(await post(failed, signed(failed)), 200);
    const stored = await db.collection("parkingPayments").doc(PAYMENT_ID).get();
    assert.equal(stored.get("status"), "failed");
    assert.equal(stored.get("failureReason"), null);
    assert.equal(await pushCount(), 0);
  });

  it("writes the refund push when a paid payment is refunded in full", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    await db.collection("parkingPayments").doc(PAYMENT_ID).update({status: "paid"});
    await db.collection("authorityPayments").doc(PAYMENT_ID).set({
      status: "fulfilled",
      uid: "alice",
      chargeType: "parking",
      authorityPence: 450,
      driverAmountPence: 610,
      feePence: 160,
      occurredOn: "2026-11-22",
      zone: "Yard",
      paymentUrl: "https://www.myringgo.com/",
    });
    const body = refundPayload({id: "evt_refundfull"});
    assert.equal(await post(body, signed(body)), 200);
    const stored = await db.collection("parkingPayments").doc(PAYMENT_ID).get();
    assert.equal(stored.get("status"), "refunded");
    assert.equal(stored.get("failureReason"), "The payment was refunded.");
    const push = await db.collection("paymentNotifications").doc(`${PAYMENT_ID}:refunded:push`).get();
    assert.equal(push.exists, true);
    assert.equal(push.get("channel"), "push");
    assert.equal(push.get("event"), "refunded");
    assert.equal(push.get("payloadStatus"), "refunded");
    assert.equal(await pushCount(), 1);
    assert.equal(await post(body, signed(body)), 200);
    assert.equal(await pushCount(), 1);
  });

  it("does not mark a payment paid when the amount or currency does not match", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const amount = payload({id: "evt_amount", amount: 999});
    assert.equal(await post(amount, signed(amount)), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");
    assert.equal(await pushCount(), 0);

    const currency = payload({id: "evt_currency", currency: "usd"});
    assert.equal(await post(currency, signed(currency)), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");
    const matched = payload({id: "evt_match"});
    assert.equal(await post(matched, signed(matched)), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "paid");
  });

  it("writes the event id and the status in one transaction", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const original = db.runTransaction.bind(db);
    let sawBoth = false;
    db.runTransaction = (async (fn: (tx: Transaction) => Promise<unknown>) => {
      return original(async (tx) => {
        const writes: string[] = [];
        const proxy = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === "set") {
              return (ref: {path: string}, data: unknown, opts?: unknown) => {
                writes.push(ref.path);
                return target.set(ref as never, data as never, opts as never);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        try {
          return await fn(proxy);
        } finally {
          const payment = writes.includes(`parkingPayments/${PAYMENT_ID}`);
          const event = writes.includes(`${STRIPE_WEBHOOK_EVENTS}/evt_atomic1`);
          if (payment && event) sawBoth = true;
        }
      });
    }) as typeof db.runTransaction;
    try {
      const body = payload({id: "evt_atomic1"});
      assert.equal(await post(body, signed(body)), 200);
    } finally {
      db.runTransaction = original as typeof db.runTransaction;
    }
    assert.equal(sawBoth, true);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "paid");
    assert.equal((await db.collection(STRIPE_WEBHOOK_EVENTS).doc("evt_atomic1").get()).exists, true);
  });

  it("writes failed only after cancel, and canceled with one L", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const failed = payload({
      id: "evt_failed1",
      type: "payment_intent.payment_failed",
      status: "requires_payment_method",
      lastPaymentError: true,
    });
    const failedDeps = deps();
    assert.equal(await post(failed, signed(failed), failedDeps), 200);
    assert.deepEqual(failedDeps.cancels, [PAYMENT_ID]);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "failed");
    assert.equal(
      (await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("failureReason"),
      "The payment didn't go through.",
    );

    await db.collection("parkingPayments").doc(PAYMENT_ID).update({status: "created", failureReason: null});
    const canceled = payload({
      id: "evt_canceled1",
      type: "payment_intent.canceled",
      status: "canceled",
    });
    const canceledDeps = deps();
    assert.equal(await post(canceled, signed(canceled), canceledDeps), 200);
    assert.deepEqual(canceledDeps.cancels, []);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "canceled");
    assert.equal(JSON.stringify(
      (await db.collection("parkingPayments").doc(PAYMENT_ID).get()).data(),
    ).includes("cancelled"), false);
  });

  it("ignores an unknown event and a PaymentIntent this function did not create", async () => {
    const db = testDb(PROJECT);
    await enable(db);
    await seedPayment();
    const unknown = payload({id: "evt_unknown1", type: "customer.created"});
    assert.equal(await post(unknown, signed(unknown)), 200);
    const foreign = payload({
      id: "evt_foreign1",
      metadata: {
        uid: "alice",
        placeId: "place-1",
        visitId: "visit-1",
        chargeType: "parking",
        ferroAccount: "acct_someone_else",
      },
    });
    assert.equal(await post(foreign, signed(foreign)), 200);
    assert.equal((await db.collection("parkingPayments").doc(PAYMENT_ID).get()).get("status"), "created");
    assert.equal(await pushCount(), 0);
  });
});
