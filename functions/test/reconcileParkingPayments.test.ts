import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";
import {DocumentReference, Firestore, Timestamp, Transaction} from "firebase-admin/firestore";
import {reconcileParkingPaymentsOnce, type ReconcileEvent, type ReconcileStripe} from "../src/parking/reconcile";
import {commitPaymentStatus, type PaymentIntentShape} from "../src/parking/payments";
import {
  deliverParkingPaymentPush,
  type ParkingPushClaim,
  type ParkingPushMessage,
} from "../src/parking/paymentPush";
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

function pushRecorder(db: Firestore): {
  messages: ParkingPushMessage[];
  send: (claim: ParkingPushClaim) => Promise<void>;
} {
  const messages: ParkingPushMessage[] = [];
  return {
    messages,
    async send(claim: ParkingPushClaim): Promise<void> {
      await deliverParkingPaymentPush(db, claim, {
        async send(message: ParkingPushMessage): Promise<void> {
          messages.push(message);
        },
      });
    },
  };
}

async function seedCreated(db: Firestore, id: string, updatedAt: number): Promise<void> {
  await db.collection("parkingPayments").doc(id).set({
    v: 1,
    status: "created",
    amount: 610,
    currency: "gbp",
    placeId: "place-1",
    visitId: id,
    operator: "RingGo",
    uid: "alice",
    requestId: `req${id}`,
    paymentIntentId: id,
    createdAt: Timestamp.fromMillis(updatedAt),
    updatedAt: Timestamp.fromMillis(updatedAt),
  });
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
    const first = await db.collection("parkingPayments").doc("pi_s0").get();
    assert.equal(first.get("status"), "canceled");
    assert.equal(first.get("cancelReason"), "abandoned");
    assert.equal(first.get("notifiedStatus"), "canceled");
    assert.ok(first.get("notifiedAt"));
    assert.equal(first.get("notifiedTitle"), undefined);
    assert.equal(first.get("notifiedBody"), undefined);

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

  it("writes refundedPence from Stripe and leaves it when the status returns to paid", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    const created = Math.floor(now / 1000) - 40;
    async function pay(id: string, status = "paid", extra: Record<string, unknown> = {}): Promise<void> {
      await db.collection("parkingPayments").doc(id).set({
        v: 1, status, amount: 610, currency: "gbp", placeId: "place-1", visitId: id,
        operator: "RingGo", uid: "alice", requestId: `req-${id}`, paymentIntentId: id,
        createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
        ...extra,
      });
    }
    await pay("pi_partial");
    await pay("pi_full");
    await pay("pi_unknown");
    await pay("pi_raise", "partially_refunded", {refundedPence: 100});
    await pay("pi_back", "refund_pending", {refundedPence: 100});
    await pay("pi_onerefund");
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id}),
        cancel: async (id) => payment({id, status: "canceled"}),
      },
      events: {
        list: async () => ({
          data: [
            event({
              id: "evt_partial_pence",
              type: "charge.refunded",
              created,
              data: {object: {payment_intent: "pi_partial", refunded: false, amount_refunded: 100}},
            }),
            event({
              id: "evt_full_pence",
              type: "charge.refunded",
              created: created + 1,
              data: {object: {payment_intent: "pi_full", refunded: true, amount_refunded: 610}},
            }),
            event({
              id: "evt_no_pence",
              type: "charge.refunded",
              created: created + 2,
              data: {object: {payment_intent: "pi_unknown", refunded: true}},
            }),
            event({
              id: "evt_raise",
              type: "charge.refunded",
              created: created + 3,
              data: {object: {payment_intent: "pi_raise", refunded: false, amount_refunded: 250}},
            }),
            event({
              id: "evt_back_paid",
              type: "charge.dispute.closed",
              created: created + 4,
              data: {object: {payment_intent: "pi_back", status: "won"}},
            }),
            event({
              id: "evt_lower",
              type: "charge.refunded",
              created: created + 5,
              data: {object: {payment_intent: "pi_raise", refunded: false, amount_refunded: 50}},
            }),
            event({
              id: "evt_refund_updated",
              type: "refund.updated",
              created: created + 6,
              data: {object: {payment_intent: "pi_onerefund", status: "succeeded", amount: 200}},
            }),
          ],
          has_more: false,
        }),
      },
    };
    await reconcileParkingPaymentsOnce(db, stripe, now);
    const partial = await db.collection("parkingPayments").doc("pi_partial").get();
    assert.equal(partial.get("status"), "partially_refunded");
    assert.equal(partial.get("refundedPence"), 100);
    const full = await db.collection("parkingPayments").doc("pi_full").get();
    assert.equal(full.get("status"), "refunded");
    assert.equal(full.get("refundedPence"), 610);
    const unknown = await db.collection("parkingPayments").doc("pi_unknown").get();
    assert.equal(unknown.get("status"), "refunded");
    assert.equal(unknown.get("refundedPence"), undefined);
    const raised = await db.collection("parkingPayments").doc("pi_raise").get();
    assert.equal(raised.get("status"), "partially_refunded");
    assert.equal(raised.get("refundedPence"), 250);
    const one = await db.collection("parkingPayments").doc("pi_onerefund").get();
    assert.equal(one.get("status"), "partially_refunded");
    assert.equal(one.get("refundedPence"), 200);
    const back = await db.collection("parkingPayments").doc("pi_back").get();
    assert.equal(back.get("status"), "paid");
    assert.equal(back.get("refundedPence"), 100);
  });

  it("abandons a created payment with no push, the claim, and cancelReason", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    const stale = now - 3 * 60 * 60 * 1000;
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await db.collection("places").doc("place-1").set({name: "Acton Yard"});
    await seedCreated(db, "pi_abandon", stale);
    await seedCreated(db, "pi_already", stale + 1);
    const sent = pushRecorder(db);
    let retrieves = 0;
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => {
          retrieves += 1;
          return payment({id, status: "canceled"});
        },
        cancel: async (id) => {
          if (id === "pi_already") throw new Error("already canceled");
          return payment({id, status: "canceled"});
        },
      },
      events: {list: async () => ({data: [], has_more: false})},
    };
    await reconcileParkingPaymentsOnce(db, stripe, now, sent.send);
    assert.equal(sent.messages.length, 0);
    assert.equal(retrieves, 1);
    for (const id of ["pi_abandon", "pi_already"]) {
      const stored = await db.collection("parkingPayments").doc(id).get();
      assert.equal(stored.get("status"), "canceled", id);
      assert.equal(stored.get("cancelReason"), "abandoned", id);
      assert.equal(stored.get("notifiedStatus"), "canceled", id);
      assert.ok(stored.get("notifiedAt"), id);
      assert.equal(stored.get("notifiedTitle"), undefined, id);
      assert.equal(stored.get("notifiedBody"), undefined, id);
    }
    await commitPaymentStatus(db, "pi_abandon", "canceled", sent.send);
    assert.equal(sent.messages.length, 0);
  });

  it("still pushes when an abandon cancel finds the PaymentIntent succeeded", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    const stale = now - 3 * 60 * 60 * 1000;
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await db.collection("places").doc("place-1").set({name: "Acton Yard"});
    await seedCreated(db, "pi_paidlate", stale);
    await db.collection("parkingPaymentRequests").doc("reqpi_paidlate").set({
      uid: "alice",
      plate: "AB12CDE",
      status: "done",
    });
    const sent = pushRecorder(db);
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id, status: "succeeded"}),
        cancel: async () => {
          throw new Error("cancel refused");
        },
      },
      events: {list: async () => ({data: [], has_more: false})},
    };
    await reconcileParkingPaymentsOnce(db, stripe, now, sent.send);
    assert.equal(sent.messages.length, 1);
    assert.equal(sent.messages[0].data.status, "paid");
    assert.equal(sent.messages[0].notification.title, "Parking paid");
    assert.equal(sent.messages[0].notification.body, "Acton Yard. You're all set.");
    const stored = await db.collection("parkingPayments").doc("pi_paidlate").get();
    assert.equal(stored.get("status"), "paid");
    assert.equal(stored.get("notifiedStatus"), "paid");
    assert.equal(stored.get("cancelReason"), undefined);
    assert.equal(stored.get("notifiedTitle"), sent.messages[0].notification.title);
    assert.equal(stored.get("notifiedBody"), sent.messages[0].notification.body);
  });

  it("pushes when a normal retrieve finds a Stripe-side cancel", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await db.collection("places").doc("place-1").set({name: "Acton Yard"});
    await seedCreated(db, "pi_sidecancel", now - 5 * 60 * 1000);
    const sent = pushRecorder(db);
    let cancels = 0;
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({id, status: "canceled"}),
        cancel: async (id) => {
          cancels += 1;
          return payment({id, status: "canceled"});
        },
      },
      events: {list: async () => ({data: [], has_more: false})},
    };
    await reconcileParkingPaymentsOnce(db, stripe, now, sent.send);
    assert.equal(cancels, 0);
    assert.equal(sent.messages.length, 1);
    assert.equal(sent.messages[0].notification.title, "Payment cancelled");
    assert.equal(sent.messages[0].notification.body, "You haven't been charged.");
    assert.deepEqual(sent.messages[0].data, {
      type: "parking_payment",
      paymentId: "pi_sidecancel",
      placeId: "place-1",
      status: "canceled",
    });
    const stored = await db.collection("parkingPayments").doc("pi_sidecancel").get();
    assert.equal(stored.get("status"), "canceled");
    assert.equal(stored.get("notifiedStatus"), "canceled");
    assert.equal(stored.get("cancelReason"), undefined);
    assert.equal(stored.get("notifiedTitle"), sent.messages[0].notification.title);
    assert.equal(stored.get("notifiedBody"), sent.messages[0].notification.body);
  });

  it("pushes failed when a normal retrieve finds a real failed attempt", async () => {
    const db = testDb(PROJECT);
    const now = Date.now();
    await db.collection("users").doc("alice").set({fcmToken: "tok-alice"});
    await db.collection("places").doc("place-1").set({name: "Acton Yard"});
    await seedCreated(db, "pi_realfail", now - 5 * 60 * 1000);
    const sent = pushRecorder(db);
    let cancels = 0;
    const stripe: ReconcileStripe = {
      paymentIntents: {
        retrieve: async (id) => payment({
          id,
          status: "requires_payment_method",
          last_payment_error: {message: "card declined"},
        }),
        cancel: async (id) => {
          cancels += 1;
          return payment({id, status: "canceled"});
        },
      },
      events: {list: async () => ({data: [], has_more: false})},
    };
    await reconcileParkingPaymentsOnce(db, stripe, now, sent.send);
    assert.equal(cancels, 1);
    assert.equal(sent.messages.length, 1);
    assert.equal(sent.messages[0].notification.title, "Payment didn't go through");
    assert.equal(sent.messages[0].notification.body, "You haven't been charged.");
    assert.equal(sent.messages[0].data.status, "failed");
    const stored = await db.collection("parkingPayments").doc("pi_realfail").get();
    assert.equal(stored.get("status"), "failed");
    assert.equal(stored.get("notifiedStatus"), "failed");
    assert.equal(stored.get("cancelReason"), undefined);
    assert.equal(stored.get("notifiedTitle"), sent.messages[0].notification.title);
    assert.equal(stored.get("notifiedBody"), sent.messages[0].notification.body);
  });
});
