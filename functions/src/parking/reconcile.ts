import * as logger from "firebase-functions/logger";
import {FieldValue, Firestore, Timestamp} from "firebase-admin/firestore";
import {
  PAYMENTS,
  PENDING_AFTER_MS,
  RECONCILE_LOOKBACK_SEC,
  STRIPE_SYNC_PATH,
  isPaymentIntentId,
  type ParkingStatus,
} from "./contract";
import {commitPaymentStatus, observedStatus, type PaymentIntentShape} from "./payments";

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

const EVENT_TYPES = [
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
];

const PENDING = ["created", "processing", "refund_pending"];

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
    if (object.refunded === true) return "refunded";
    const refunded = object.amount_refunded;
    if (typeof refunded === "number" && refunded > 0 && refunded < paymentAmount) return "refund_pending";
    return null;
  }
  if (event.type === "charge.refund.updated") {
    if (object.status === "pending") return "refund_pending";
    if (object.status === "failed" || object.status === "canceled") return "paid";
    if (object.status === "succeeded") {
      const amount = object.amount;
      if (typeof amount === "number" && amount >= paymentAmount) return "refunded";
      return "refund_pending";
    }
    return null;
  }
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.updated") {
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
  const cutoff = nowMs - PENDING_AFTER_MS;
  for (const status of PENDING) {
    const snap = await db.collection(PAYMENTS).where("status", "==", status).limit(50).get();
    for (const doc of snap.docs) {
      const updated = millisOf(doc.get("updatedAt")) ?? millisOf(doc.get("createdAt"));
      if (updated === null || updated > cutoff) continue;
      const paymentIntentId = doc.get("paymentIntentId");
      if (!isPaymentIntentId(paymentIntentId)) continue;
      try {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        await commitPaymentStatus(db, paymentIntentId, observedStatus(pi));
      } catch (err) {
        logger.error("reconcile retrieve failed", {
          paymentIntentId,
          name: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }
}

async function applyEvents(db: Firestore, stripe: ReconcileStripe, nowMs: number): Promise<void> {
  const cursorRef = db.doc(STRIPE_SYNC_PATH);
  const cursor = await cursorRef.get();
  const storedCreated = cursor.get("lastCreated");
  const storedId = cursor.get("lastEventId");
  const floor = typeof storedCreated === "number" ?
    storedCreated :
    Math.floor(nowMs / 1000) - RECONCILE_LOOKBACK_SEC;

  const collected: ReconcileEvent[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 5; page++) {
    const listed = await stripe.events.list({
      types: EVENT_TYPES,
      created: {gte: floor},
      limit: 100,
      ...(startingAfter ? {starting_after: startingAfter} : {}),
    });
    collected.push(...listed.data);
    if (!listed.has_more || listed.data.length === 0) break;
    startingAfter = listed.data[listed.data.length - 1].id;
  }

  const fresh = collected.filter((event) => {
    if (event.livemode) return false;
    if (typeof storedCreated !== "number") return true;
    if (event.created > storedCreated) return true;
    return event.created === storedCreated && event.id !== storedId;
  });
  fresh.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));

  for (const event of fresh) {
    const paymentIntentId = paymentIntentIdFrom(event.data.object);
    if (!paymentIntentId) continue;
    const payRef = db.collection(PAYMENTS).doc(paymentIntentId);
    const paySnap = await payRef.get();
    if (!paySnap.exists) continue;
    const amount = paySnap.get("amount");
    const incoming = statusFromEvent(event, typeof amount === "number" ? amount : 0);
    if (!incoming) continue;
    try {
      await commitPaymentStatus(db, paymentIntentId, incoming);
    } catch (err) {
      logger.error("reconcile event failed", {
        eventId: event.id,
        paymentIntentId,
        name: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  const newest = fresh.length > 0 ? fresh[fresh.length - 1] : null;
  if (newest && (newest.created > floor || newest.id !== storedId)) {
    await cursorRef.set({
      lastCreated: newest.created,
      lastEventId: newest.id,
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
