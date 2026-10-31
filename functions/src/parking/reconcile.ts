import * as logger from "firebase-functions/logger";
import {FieldValue, Firestore, Timestamp} from "firebase-admin/firestore";
import {
  ABANDON_AFTER_MS,
  PAYMENTS,
  PENDING_AFTER_MS,
  RECONCILE_LOOKBACK_SEC,
  RECONCILE_PAGE_SIZE,
  STRIPE_SYNC_PATH,
  isPaymentIntentId,
  type ParkingStatus,
} from "./contract";
import {commitPaymentStatus, observedStatus, settlePaymentStatus, type PaymentIntentShape} from "./payments";

export interface ReconcileEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: {object: Record<string, unknown>};
}

export interface ReconcileStripe {
  paymentIntents: {
    retrieve(id: string): Promise<PaymentIntentShape>;
    cancel(id: string): Promise<PaymentIntentShape>;
  };
  events: {
    list(params: {
      types: string[];
      created: {gte: number};
      limit: number;
      starting_after?: string;
    }): Promise<{data: ReconcileEvent[]; has_more: boolean}>;
  };
}

const EVENT_PAGE_CAP = 20;

const EVENT_TYPES = [
  "charge.refunded",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
];

const PENDING = ["created", "processing"];

function millisOf(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  return null;
}

function paymentIntentIdFrom(object: Record<string, unknown>): string | null {
  const id = object.payment_intent;
  return isPaymentIntentId(id) ? id : null;
}

function statusFromEvent(event: ReconcileEvent, paymentAmount: number): ParkingStatus | null {
  const object = event.data.object;
  if (event.type === "charge.refunded") {
    const refunded = object.amount_refunded;
    if (object.refunded === true) return "refunded";
    if (typeof refunded === "number" && refunded >= paymentAmount && paymentAmount > 0) return "refunded";
    if (typeof refunded === "number" && refunded > 0) return "partially_refunded";
    return null;
  }
  if (event.type === "refund.updated") {
    if (object.status === "pending") return "refund_pending";
    if (object.status === "failed" || object.status === "canceled") return "paid";
    if (object.status === "succeeded") {
      const amount = object.amount;
      if (typeof amount === "number" && amount > 0 && amount < paymentAmount) return "partially_refunded";
      if (typeof amount === "number" && amount > 0) return "refunded";
    }
    return null;
  }
  if (event.type === "charge.dispute.created") {
    return "refund_pending";
  }
  if (event.type === "charge.dispute.closed") {
    if (object.status === "won" || object.status === "warning_closed") return "paid";
    if (object.status === "lost" || object.status === "charge_refunded") return "refunded";
    return "refund_pending";
  }
  return null;
}

async function retrievePending(db: Firestore, stripe: ReconcileStripe, nowMs: number): Promise<void> {
  const cutoff = Timestamp.fromMillis(nowMs - PENDING_AFTER_MS);
  const abandonBefore = nowMs - ABANDON_AFTER_MS;
  for (const status of PENDING) {
    const snap = await db.collection(PAYMENTS)
      .where("status", "==", status)
      .where("updatedAt", "<", cutoff)
      .orderBy("updatedAt")
      .limit(RECONCILE_PAGE_SIZE)
      .get();
    for (const doc of snap.docs) {
      const paymentIntentId = doc.get("paymentIntentId");
      if (!isPaymentIntentId(paymentIntentId)) continue;
      const updated = millisOf(doc.get("updatedAt"));
      try {
        if (status === "created" && updated !== null && updated <= abandonBefore) {
          try {
            await stripe.paymentIntents.cancel(paymentIntentId);
            await commitPaymentStatus(db, paymentIntentId, "canceled");
          } catch (err) {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
            const observed = observedStatus(pi);
            await commitPaymentStatus(db, paymentIntentId, observed === "failed" ? "canceled" : observed);
            logger.error("reconcile abandon cancel failed", {
              paymentIntentId,
              name: err instanceof Error ? err.name : "unknown",
            });
          }
          continue;
        }
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        await settlePaymentStatus(db, stripe, paymentIntentId, observedStatus(pi));
      } catch (err) {
        logger.error("reconcile retrieve failed", {
          paymentIntentId,
          name: err instanceof Error ? err.name : "unknown",
        });
        await doc.ref.set({updatedAt: FieldValue.serverTimestamp()}, {merge: true});
      }
    }
  }
}

async function applyEvents(db: Firestore, stripe: ReconcileStripe, nowMs: number): Promise<void> {
  const cursorRef = db.doc(STRIPE_SYNC_PATH);
  const cursor = await cursorRef.get();
  const storedCreated = cursor.get("lastEventCreated");
  const storedId = cursor.get("lastEventId");
  const floor = typeof storedCreated === "number" ?
    storedCreated :
    Math.floor(nowMs / 1000) - RECONCILE_LOOKBACK_SEC;

  const collected: ReconcileEvent[] = [];
  let startingAfter: string | undefined;
  let capped = false;
  for (let page = 0; page < EVENT_PAGE_CAP; page++) {
    const listed = await stripe.events.list({
      types: EVENT_TYPES,
      created: {gte: floor},
      limit: 100,
      ...(startingAfter ? {starting_after: startingAfter} : {}),
    });
    collected.push(...listed.data);
    if (!listed.has_more || listed.data.length === 0) break;
    const next = listed.data[listed.data.length - 1]?.id;
    if (!next || next === startingAfter) break;
    startingAfter = next;
    if (page === EVENT_PAGE_CAP - 1) capped = true;
  }
  if (capped) {
    logger.error("reconcile event page cap reached", {pages: EVENT_PAGE_CAP});
  }

  const fresh = collected.filter((event) => {
    if (event.livemode) return false;
    if (typeof storedCreated !== "number") return true;
    if (event.created > storedCreated) return true;
    return event.created === storedCreated && event.id !== storedId;
  });
  fresh.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));

  let cursorCreated = typeof storedCreated === "number" ? storedCreated : null;
  let cursorId = typeof storedId === "string" ? storedId : null;
  let advanced = false;
  for (const event of fresh) {
    const paymentIntentId = paymentIntentIdFrom(event.data.object);
    if (paymentIntentId) {
      const paySnap = await db.collection(PAYMENTS).doc(paymentIntentId).get();
      if (paySnap.exists) {
        const amount = paySnap.get("amount");
        const incoming = statusFromEvent(event, typeof amount === "number" ? amount : 0);
        if (incoming) {
          try {
            await commitPaymentStatus(db, paymentIntentId, incoming);
          } catch (err) {
            logger.error("reconcile event failed", {
              eventId: event.id,
              paymentIntentId,
              name: err instanceof Error ? err.name : "unknown",
            });
            break;
          }
        }
      }
    }
    cursorCreated = event.created;
    cursorId = event.id;
    advanced = true;
  }

  if (advanced && cursorCreated !== null && cursorId !== null) {
    await cursorRef.set({
      lastEventCreated: cursorCreated,
      lastEventId: cursorId,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
  }
}

// Retrieves stale PaymentIntents and applies refund and dispute events.
export async function reconcileParkingPaymentsOnce(
  db: Firestore,
  stripe: ReconcileStripe,
  nowMs: number,
): Promise<void> {
  await retrievePending(db, stripe, nowMs);
  await applyEvents(db, stripe, nowMs);
}
