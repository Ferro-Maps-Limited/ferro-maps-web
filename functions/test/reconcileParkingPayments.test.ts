import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";
import {DocumentReference, Firestore, Timestamp, Transaction} from "firebase-admin/firestore";
import {reconcileParkingPaymentsOnce, type ReconcileEvent, type ReconcileStripe} from "../src/parking/reconcile";
import {type PaymentIntentShape} from "../src/parking/payments";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-parking-reconcile";

function failCommit(db: Firestore, paymentId: string): Firestore {
  const runTransaction = db.runTransaction.bind(db);
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "runTransaction") {
        return (fn: (tx: Transaction) => Promise<unknown>) => runTransaction(async (tx) => {
          const get = tx.get.bind(tx);
          tx.get = ((ref: DocumentReference) => {
            if (ref.path === `parkingPayments/${paymentId}`) {
              throw new Error("injected commit failure");
            }
            return get(ref);
          }) as Transaction["get"];
          return fn(tx);
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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
        cancel: async (id) => payment({id, status: "canceled"}),
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
    const stored = (await db.collection("parkingPayments").doc("pi_old").get()).data();
    assert.equal(JSON.stringify(stored).includes("AB12CDE"), false);
    assert.ok(stored?.plateRegisteredAt);
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-old").get()).get("plate"), undefined);

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
      paymentIntents: {
        retrieve: async () => payment(),
        cancel: async (id) => payment({id, status: "canceled"}),
      },
      events: {
        list: async (params) => {
          queries += 1;
          assert.ok(params.types.includes("charge.refunded"));
          assert.ok(params.types.includes("refund.updated"));
          assert.ok(params.types.includes("charge.dispute.created"));
          assert.equal(params.types.includes("charge.dispute.updated"), false);
          const floor = params.created.gte;
          return {data: events.filter((item) => item.created >= floor), has_more: false};
        },
      },
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal((await db.collection("parkingPayments").doc("pi_paid").get()).get("status"), "refunded");
    const cursor = (await db.doc("stripeSync/cursor").get()).data();
    assert.equal(cursor?.lastEventId, "evt_refund");
    assert.equal(cursor?.lastEventCreated, refundAt);

    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal((await db.collection("parkingPayments").doc("pi_paid").get()).get("status"), "refunded");
    assert.equal(queries, 2);
  });

  it("cancels abandoned created payments a page at a time", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    const stale = now - 3 * 60 * 60 * 1000;
    for (let i = 0; i < 51; i++) {
      await db.collection("parkingPayments").doc(`pi_s${i}`).set({
        v: 1,
        status: "created",
        amount: 610,
        currency: "gbp",
        placeId: "place-1",
        visitId: `visit-${i}`,
        operator: "RingGo",
        uid: "alice",
        requestId: `req-${i}`,
        paymentIntentId: `pi_s${i}`,
        createdAt: Timestamp.fromMillis(stale + i),
        updatedAt: Timestamp.fromMillis(stale + i),
      });
      await db.collection("parkingPaymentRequests").doc(`req-${i}`).set({
        uid: "alice",
        plate: "AB12CDE",
        status: "done",
      });
    }
    await db.collection("parkingPayments").doc("pi_fresh").set({
      v: 1,
      status: "created",
      amount: 610,
      currency: "gbp",
      placeId: "place-1",
      visitId: "visit-fresh",
      operator: "RingGo",
      uid: "alice",
      paymentIntentId: "pi_fresh",
      createdAt: Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now),
    });
    const canceled: string[] = [];
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id, status: "requires_payment_method"}),
        cancel: async (id) => {
          canceled.push(id);
          return payment({id, status: "canceled"});
        },
      },
      events: {list: async () => ({data: [], has_more: false})},
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal(canceled.length, 50);
    const stillCreated = (await db.collection("parkingPayments").where("status", "==", "created").get()).docs
      .map((doc) => doc.id)
      .sort();
    assert.deepEqual(stillCreated, ["pi_fresh", "pi_s50"]);
    assert.equal((await db.collection("parkingPaymentRequests").doc("req-0").get()).get("plate"), undefined);
    assert.equal((await db.collection("parkingPayments").doc("pi_s0").get()).get("status"), "canceled");

    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal((await db.collection("parkingPayments").doc("pi_s50").get()).get("status"), "canceled");
    assert.equal((await db.collection("parkingPayments").doc("pi_fresh").get()).get("status"), "created");
  });

  it("pages events in time order and stops the cursor at the first failed commit", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    const t1 = Math.floor(now / 1000) - 30;
    const t2 = Math.floor(now / 1000) - 20;
    const t3 = Math.floor(now / 1000) - 10;
    await db.collection("parkingPayments").doc("pi_partial").set({
      v: 1, status: "paid", amount: 610, currency: "gbp", placeId: "place-1", visitId: "v1",
      operator: "RingGo", uid: "alice", requestId: "req-partial", paymentIntentId: "pi_partial",
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
    });
    await db.collection("parkingPayments").doc("pi_block").set({
      v: 1, status: "paid", amount: 610, currency: "gbp", placeId: "place-1", visitId: "v2",
      operator: "RingGo", uid: "alice", requestId: "req-block", paymentIntentId: "pi_block",
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
    });
    await db.collection("parkingPayments").doc("pi_later").set({
      v: 1, status: "paid", amount: 610, currency: "gbp", placeId: "place-1", visitId: "v3",
      operator: "RingGo", uid: "alice", requestId: "req-later", paymentIntentId: "pi_later",
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
    });
    const oldest = event({
      id: "evt_partial",
      type: "charge.refunded",
      created: t1,
      data: {object: {payment_intent: "pi_partial", refunded: false, amount_refunded: 100}},
    });
    const middle = event({
      id: "evt_block",
      type: "charge.dispute.created",
      created: t2,
      data: {object: {payment_intent: "pi_block"}},
    });
    const newest = event({
      id: "evt_full",
      type: "charge.refunded",
      created: t3,
      data: {object: {payment_intent: "pi_later", refunded: true, amount_refunded: 610}},
    });
    const pages = [
      {data: [newest, middle], has_more: true},
      {data: [oldest], has_more: false},
    ];
    let page = 0;
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id}),
        cancel: async (id) => payment({id, status: "canceled"}),
      },
      events: {
        list: async (params) => {
          assert.equal(params.starting_after, page === 0 ? undefined : "evt_block");
          const result = pages[page];
          page += 1;
          return result;
        },
      },
    };
    await reconcileParkingPaymentsOnce(failCommit(db, "pi_block"), stripe, now);
    assert.equal(page, 2);
    assert.equal((await db.collection("parkingPayments").doc("pi_partial").get()).get("status"), "partially_refunded");
    assert.equal((await db.collection("parkingPayments").doc("pi_block").get()).get("status"), "paid");
    assert.equal((await db.collection("parkingPayments").doc("pi_later").get()).get("status"), "paid");
    const cursor = (await db.doc("stripeSync/cursor").get()).data();
    assert.equal(cursor?.lastEventId, "evt_partial");
    assert.equal(cursor?.lastEventCreated, t1);
  });

  it("returns a dispute won after refund_pending to paid", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    await db.collection("parkingPayments").doc("pi_dispute").set({
      v: 1, status: "refund_pending", amount: 610, currency: "gbp", placeId: "place-1", visitId: "vd",
      operator: "RingGo", uid: "alice", requestId: "req-d", paymentIntentId: "pi_dispute",
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
    });
    const closedAt = Math.floor(now / 1000) - 5;
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id}),
        cancel: async (id) => payment({id, status: "canceled"}),
      },
      events: {
        list: async () => ({
          has_more: false,
          data: [event({
            id: "evt_won",
            type: "charge.dispute.closed",
            created: closedAt,
            data: {object: {payment_intent: "pi_dispute", status: "won"}},
          })],
        }),
      },
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal((await db.collection("parkingPayments").doc("pi_dispute").get()).get("status"), "paid");
  });

  it("applies nothing and leaves the cursor unchanged when event paging is capped", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    const cursorCreated = Math.floor(now / 1000) - 500;
    await db.doc("stripeSync/cursor").set({
      lastEventCreated: cursorCreated,
      lastEventId: "evt_cursor",
      updatedAt: Timestamp.fromMillis(now - 60_000),
    });
    await db.collection("parkingPayments").doc("pi_cap").set({
      v: 1, status: "paid", amount: 610, currency: "gbp", placeId: "place-1", visitId: "vcap",
      operator: "RingGo", uid: "alice", requestId: "req-cap", paymentIntentId: "pi_cap",
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
    });
    let calls = 0;
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id}),
        cancel: async (id) => payment({id, status: "canceled"}),
      },
      events: {
        list: async () => {
          calls += 1;
          return {
            has_more: true,
            data: [event({
              id: `evt_new_${calls}`,
              type: "charge.refunded",
              created: cursorCreated + calls,
              data: {object: {payment_intent: "pi_cap", refunded: true, amount_refunded: 610}},
            })],
          };
        },
      },
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal(calls, 20);
    assert.equal((await db.collection("parkingPayments").doc("pi_cap").get()).get("status"), "paid");
    const cursor = (await db.doc("stripeSync/cursor").get()).data();
    assert.equal(cursor?.lastEventId, "evt_cursor");
    assert.equal(cursor?.lastEventCreated, cursorCreated);
  });

  it("applies every event oldest first when paging reaches the cursor within the cap", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    const cursorCreated = Math.floor(now / 1000) - 100;
    const openedAt = cursorCreated + 10;
    const wonAt = cursorCreated + 20;
    await db.doc("stripeSync/cursor").set({
      lastEventCreated: cursorCreated,
      lastEventId: "evt_cursor",
      updatedAt: Timestamp.fromMillis(now - 60_000),
    });
    await db.collection("parkingPayments").doc("pi_order").set({
      v: 1, status: "paid", amount: 610, currency: "gbp", placeId: "place-1", visitId: "vorder",
      operator: "RingGo", uid: "alice", requestId: "req-order", paymentIntentId: "pi_order",
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
    });
    const opened = event({
      id: "evt_opened",
      type: "charge.dispute.created",
      created: openedAt,
      data: {object: {payment_intent: "pi_order"}},
    });
    const won = event({
      id: "evt_won_order",
      type: "charge.dispute.closed",
      created: wonAt,
      data: {object: {payment_intent: "pi_order", status: "won"}},
    });
    const pages = [
      {data: [won], has_more: true},
      {data: [opened], has_more: false},
    ];
    let calls = 0;
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id}),
        cancel: async (id) => payment({id, status: "canceled"}),
      },
      events: {
        list: async (params) => {
          assert.equal(params.created.gte, cursorCreated);
          assert.equal(params.starting_after, calls === 0 ? undefined : "evt_won_order");
          const result = pages[calls];
          calls += 1;
          return result;
        },
      },
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);
    assert.equal(calls, 2);
    assert.equal((await db.collection("parkingPayments").doc("pi_order").get()).get("status"), "paid");
    const cursor = (await db.doc("stripeSync/cursor").get()).data();
    assert.equal(cursor?.lastEventId, "evt_won_order");
    assert.equal(cursor?.lastEventCreated, wonAt);
  });
});
