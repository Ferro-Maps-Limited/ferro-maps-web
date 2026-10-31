import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {reconcileParkingPaymentsOnce, type ReconcileEvent, type ReconcileStripe} from "../src/parking/reconcile";
import {type PaymentIntentShape} from "../src/parking/payments";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-parking-reconcile";

function payment(over: Partial<PaymentIntentShape> = {}): PaymentIntentShape {
  return {
    id: "pi_old",
    client_secret: "secret",
    status: "succeeded",
    amount: 610,
    currency: "gbp",
    customer: "cus_test",
    ...over,
  };
}

function event(over: Partial<ReconcileEvent> & Pick<ReconcileEvent, "id" | "type">): ReconcileEvent {
  return {
    created: 1_700_000_000,
    livemode: false,
    data: {object: {}},
    ...over,
  };
}

describe("reconcileParkingPayments", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  it("retrieves a PaymentIntent still pending after two minutes and ignores a fresh one", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    await db.collection("parkingPayments").doc("pi_old").set({
      v: 1,
      status: "created",
      amount: 610,
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-old",
      operator: "RingGo",
      uid: "alice",
      requestId: "req-old",
      paymentIntentId: "pi_old",
      parkingPence: 450,
      feePence: 160,
      failureReason: null,
      createdAt: Timestamp.fromMillis(now - 5 * 60_000),
      updatedAt: Timestamp.fromMillis(now - 5 * 60_000),
    });
    await db.collection("parkingPaymentRequests").doc("req-old").set({
      uid: "alice",
      plate: "AB12 CDE",
      status: "done",
    });
    await db.collection("parkingPayments").doc("pi_new").set({
      v: 1,
      status: "created",
      amount: 610,
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-new",
      operator: "RingGo",
      uid: "alice",
      paymentIntentId: "pi_new",
      createdAt: Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now),
    });

    const retrieved: string[] = [];
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => {
          retrieved.push(id);
          return payment({id, status: "succeeded"});
        },
      },
      events: {
        list: async () => ({data: [], has_more: false}),
      },
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);

    assert.deepEqual(retrieved, ["pi_old"]);
    assert.equal((await db.collection("parkingPayments").doc("pi_old").get()).get("status"), "paid");
    assert.equal((await db.collection("parkingPayments").doc("pi_new").get()).get("status"), "created");
    const forward = (await db.collection("operatorForwards").doc("pi_old").get()).data();
    assert.equal(forward?.plate, "AB12CDE");
    assert.equal(JSON.stringify((await db.collection("parkingPayments").doc("pi_old").get()).data())
      .includes("AB12CDE"), false);

    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal((await db.collection("operatorForwards").get()).size, 1);
  });

  it("applies a refund and a dispute from events.list and stores the cursor", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    await db.collection("parkingPayments").doc("pi_paid").set({
      v: 1,
      status: "paid",
      amount: 610,
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-paid",
      operator: "RingGo",
      uid: "alice",
      requestId: "req-paid",
      paymentIntentId: "pi_paid",
      parkingPence: 450,
      feePence: 160,
      failureReason: null,
      createdAt: Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now),
    });
    const disputeAt = Math.floor(now / 1000) - 50;
    const refundAt = Math.floor(now / 1000) - 10;
    const events = [
      event({
        id: "evt_dispute",
        type: "charge.dispute.created",
        created: disputeAt,
        data: {object: {payment_intent: "pi_paid", status: "needs_response"}},
      }),
      event({
        id: "evt_refund",
        type: "charge.refunded",
        created: refundAt,
        data: {object: {payment_intent: "pi_paid", refunded: true, amount_refunded: 610}},
      }),
    ];
    let queries = 0;
    const stripe: ReconcileStripe = {
      paymentIntents: {retrieve: async () => payment()},
      events: {
        list: async (params) => {
          queries += 1;
          assert.ok(params.types.includes("charge.refunded"));
          assert.ok(params.types.includes("charge.dispute.created"));
          const floor = params.created.gte;
          return {data: events.filter((item) => item.created >= floor), has_more: false};
        },
      },
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal((await db.collection("parkingPayments").doc("pi_paid").get()).get("status"), "refunded");
    const cursor = (await db.doc("stripeSync/events").get()).data();
    assert.equal(cursor?.lastEventId, "evt_refund");
    assert.equal(cursor?.lastCreated, refundAt);

    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal((await db.collection("parkingPayments").doc("pi_paid").get()).get("status"), "refunded");
    assert.equal(queries, 2);
  });
});
