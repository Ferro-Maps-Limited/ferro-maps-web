import * as logger from "firebase-functions/logger";
import {onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import {FieldValue, Firestore, getFirestore} from "firebase-admin/firestore";
import Stripe from "stripe";
import {
  PAYMENTS,
  ParkingPaymentError,
  chargeTypeFrom,
  isPaymentIntentId,
  isSafeId,
  type ParkingStatus,
} from "./contract";
import {
  commitPaymentStatus,
  observedStatus,
  settlePaymentStatus,
  type PaymentIntentClient,
  type StatusClaim,
} from "./payments";
import {paymentShape} from "./stripeAdapter";
import {
  EXPECTED_STRIPE_ACCOUNT_ID,
  assertStripeKey,
  createStripeClient,
  stripeLiveEnabled,
  stripeSecretKey,
  type StripeKeyMode,
} from "./stripeClient";

// Signing secret for Stripe's webhook. Declared here so a named deploy can
// bind it. This code does not create the secret in Secret Manager.
export const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

// One document per accepted Stripe event id. A repeat delivery finds it and
// does not write the payment again. Status comparison in commitPaymentStatus
// is the other guard, so a reconcile pass and this webhook can land in either
// order. Clients cannot read this collection: the rules catch-all denies it.
export const STRIPE_WEBHOOK_EVENTS = "stripeWebhookEvents";

const HANDLED_TYPES = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
]);

export interface StripeWebhookHttpRequest {
  method: string;
  rawBody?: Buffer | string;
  signature?: string | string[];
}

export interface StripeWebhookDeps {
  secretKey: string;
  webhookSecret: string;
  constructEvent: (
    payload: Buffer | string,
    signature: string,
    secret: string,
  ) => Stripe.Event;
  stripe: PaymentIntentClient;
}

// Missing, false, or any other value is off. Only the boolean true turns it on.
export async function stripeWebhookEnabled(db: Firestore): Promise<boolean> {
  const snap = await db.doc("config/flags").get();
  return snap.get("stripeWebhookEnabled") === true;
}

function rawPayload(value: Buffer | string | undefined): Buffer | string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (Buffer.isBuffer(value) && value.length > 0) return value;
  return null;
}

function signatureHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isEventId(value: string): boolean {
  return /^evt_[A-Za-z0-9]+$/.test(value) && value.length <= 128;
}

function alreadyOurPayment(pi: Stripe.PaymentIntent): boolean {
  return isPaymentIntentId(pi.id) && alreadyOurMetadata(pi.metadata ?? {});
}

function paymentIntentOf(event: Stripe.Event): Stripe.PaymentIntent | null {
  const object = event.data.object;
  if (object.object !== "payment_intent") return null;
  return object;
}

function eventRecord(type: string, paymentIntentId: string): Record<string, unknown> {
  return {
    type,
    paymentIntentId,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function modeMatches(livemode: boolean, mode: StripeKeyMode): boolean {
  return livemode === (mode === "live");
}

function eventModeMatches(event: Stripe.Event, mode: StripeKeyMode): boolean {
  if (!modeMatches(event.livemode === true, mode)) return false;
  const object = event.data.object as {livemode?: unknown};
  if (typeof object.livemode === "boolean" && !modeMatches(object.livemode, mode)) return false;
  return true;
}

function paymentIntentIdFromCharge(value: unknown): string | null {
  if (isPaymentIntentId(value)) return value;
  if (value && typeof value === "object" && "id" in value && isPaymentIntentId(value.id)) return value.id;
  return null;
}

function metadataRecord(value: unknown): Stripe.Metadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Stripe.Metadata;
}

// Full when the refunded pence covers the stored payment. Anything smaller
// that is still above zero is a partial refund. Zero is not a status change.
export function refundStatusFromAmounts(
  amountRefunded: unknown,
  paymentAmount: unknown,
): Extract<ParkingStatus, "refunded" | "partially_refunded"> | null {
  if (typeof amountRefunded !== "number" || !Number.isSafeInteger(amountRefunded) || amountRefunded <= 0) {
    return null;
  }
  const amount = typeof paymentAmount === "number" && Number.isSafeInteger(paymentAmount) ? paymentAmount : 0;
  if (amount > 0 && amountRefunded >= amount) return "refunded";
  return "partially_refunded";
}

// Status moves only through commitPaymentStatus, so created and failed stay
// put, and a real refund runs followPaymentStatus.
async function applyChargeRefunded(db: Firestore, event: Stripe.Event): Promise<number> {
  if (event.data.object.object !== "charge") return 200;
  const charge = event.data.object;
  const paymentIntentId = paymentIntentIdFromCharge(charge.payment_intent);
  if (!paymentIntentId) return 200;
  const meta = metadataRecord(charge.metadata);
  if (meta?.ferroAccount && meta.ferroAccount !== EXPECTED_STRIPE_ACCOUNT_ID) return 200;
  const tagged = meta ? alreadyOurMetadata(meta) : false;
  const paySnap = await db.collection(PAYMENTS).doc(paymentIntentId).get();
  if (!paySnap.exists) return tagged ? 500 : 200;
  const incoming = refundStatusFromAmounts(charge.amount_refunded, paySnap.get("amount"));
  if (!incoming) return 200;
  const storedUid = paySnap.get("uid");
  const claim: StatusClaim = {
    eventRef: db.collection(STRIPE_WEBHOOK_EVENTS).doc(event.id),
    record: eventRecord(event.type, paymentIntentId),
    ...(typeof storedUid === "string" ? {expectedUid: storedUid} : {}),
  };
  let next: string;
  try {
    next = await commitPaymentStatus(db, paymentIntentId, incoming, undefined, Date.now(), claim);
  } catch (err) {
    if (err instanceof ParkingPaymentError && err.errorCode === "not-found") return tagged ? 500 : 200;
    logger.error("stripe webhook apply failed", {
      eventId: event.id,
      paymentIntentId,
      name: err instanceof Error ? err.name : "unknown",
    });
    return 500;
  }
  if (claim.result === "duplicate" || claim.result === "ignored") return 200;
  logger.info("stripe webhook applied", {
    eventId: event.id,
    type: event.type,
    paymentIntentId,
    status: next,
  });
  return 200;
}

function alreadyOurMetadata(meta: Stripe.Metadata): boolean {
  if (meta.ferroAccount !== EXPECTED_STRIPE_ACCOUNT_ID) return false;
  if (!isSafeId(meta.uid) || !isSafeId(meta.placeId) || !isSafeId(meta.visitId)) return false;
  if (typeof meta.chargeType !== "string" || chargeTypeFrom(meta.chargeType) === null) return false;
  return true;
}

// Verifies the signature, then moves parkingPayments/{paymentIntentId} with
// the same settle path the confirm request and the five-minute reconcile job
// use. Success is the string `paid`. This does not create or edit
// parkingPaymentRequests/{paymentIntentId}_confirm.
export async function handleStripeWebhook(
  db: Firestore,
  deps: StripeWebhookDeps,
  request: StripeWebhookHttpRequest,
): Promise<number> {
  if (!(await stripeWebhookEnabled(db))) return 200;
  if (request.method !== "POST") return 405;

  const payload = rawPayload(request.rawBody);
  const signature = signatureHeader(request.signature);
  if (!payload || !signature) return 400;

  let event: Stripe.Event;
  try {
    event = deps.constructEvent(payload, signature, deps.webhookSecret);
  } catch (err) {
    logger.warn("stripe webhook signature rejected", {
      name: err instanceof Error ? err.name : "unknown",
    });
    return 400;
  }

  // Live events are accepted only when config/payments.stripeLiveEnabled is
  // exactly true. The event livemode has to match the key: test with test,
  // live with live.
  const liveAllowed = await stripeLiveEnabled(db);
  let mode: StripeKeyMode;
  try {
    mode = assertStripeKey(deps.secretKey, liveAllowed);
  } catch (err) {
    logger.error("stripe webhook refused the key mode", {
      name: err instanceof Error ? err.name : "unknown",
    });
    return 400;
  }
  if (!eventModeMatches(event, mode)) return 400;
  if (!isEventId(event.id)) return 400;
  if (!HANDLED_TYPES.has(event.type)) return 200;
  if (event.type === "charge.refunded") return applyChargeRefunded(db, event);

  const pi = paymentIntentOf(event);
  if (!pi || !alreadyOurPayment(pi)) return 200;

  const eventRef = db.collection(STRIPE_WEBHOOK_EVENTS).doc(event.id);
  if ((await eventRef.get()).exists) return 200;

  const observed = observedStatus(paymentShape(pi));
  const claim: StatusClaim = {
    eventRef,
    record: eventRecord(event.type, pi.id),
    expectedUid: pi.metadata.uid,
    ...(observed === "paid" ? {
      paidCheck: {
        amount: typeof pi.amount === "number" ? pi.amount : Number.NaN,
        currency: typeof pi.currency === "string" ? pi.currency : "",
      },
    } : {}),
  };
  let next: string;
  try {
    next = await settlePaymentStatus(db, deps.stripe, pi.id, observed, claim);
  } catch (err) {
    if (err instanceof ParkingPaymentError && err.errorCode === "not-found") {
      logger.warn("stripe webhook payment is not stored yet", {paymentIntentId: pi.id});
      return 500;
    }
    logger.error("stripe webhook apply failed", {
      eventId: event.id,
      paymentIntentId: pi.id,
      name: err instanceof Error ? err.name : "unknown",
    });
    return 500;
  }
  if (claim.result === "mismatch") {
    logger.error("stripe webhook amount mismatch", {
      eventId: event.id,
      paymentIntentId: pi.id,
      eventAmount: pi.amount,
      eventCurrency: pi.currency,
      storedAmount: claim.storedAmount ?? null,
      storedCurrency: claim.storedCurrency ?? null,
    });
    return 200;
  }
  logger.info("stripe webhook applied", {
    eventId: event.id,
    type: event.type,
    paymentIntentId: pi.id,
    status: next,
  });
  return 200;
}

function intentClient(stripe: Stripe): PaymentIntentClient {
  return {
    paymentIntents: {
      retrieve: async (id) => paymentShape(await stripe.paymentIntents.retrieve(id)),
      cancel: async (id) => paymentShape(await stripe.paymentIntents.cancel(id)),
    },
  };
}

// HTTPS endpoint for Stripe. Region europe-west2. Not granted a public
// invoker here. Deploy this name only; do not deploy the whole codebase.
// The five-minute reconcileParkingPayments job stays the fallback.
export const stripeWebhook = onRequest(
  {
    region: "europe-west2",
    secrets: [stripeWebhookSecret, stripeSecretKey],
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (req, res) => {
    try {
      const db = getFirestore();
      if (!(await stripeWebhookEnabled(db))) {
        res.status(200).send();
        return;
      }
      let stripe: Stripe;
      try {
        stripe = createStripeClient(stripeSecretKey.value(), await stripeLiveEnabled(db));
      } catch (err) {
        if (err instanceof ParkingPaymentError) {
          res.status(400).send();
          return;
        }
        throw err;
      }
      const code = await handleStripeWebhook(db, {
        secretKey: stripeSecretKey.value(),
        webhookSecret: stripeWebhookSecret.value(),
        constructEvent: (payload, signature, secret) => stripe.webhooks.constructEvent(payload, signature, secret),
        stripe: intentClient(stripe),
      }, {
        method: req.method,
        rawBody: req.rawBody,
        signature: req.get("stripe-signature") ?? undefined,
      });
      res.status(code).send();
    } catch (err) {
      logger.error("stripeWebhook failed", {
        name: err instanceof Error ? err.name : "unknown",
      });
      res.status(500).send();
    }
  },
);
