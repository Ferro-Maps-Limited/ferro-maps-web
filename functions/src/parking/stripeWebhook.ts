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
} from "./contract";
import {observedStatus, settlePaymentStatus, type PaymentIntentClient} from "./payments";
import {paymentShape} from "./stripeAdapter";
import {
  EXPECTED_STRIPE_ACCOUNT_ID,
  assertStripeTestKey,
  createStripeClient,
  stripeSecretKey,
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
  const meta = pi.metadata;
  if (!meta || meta.ferroAccount !== EXPECTED_STRIPE_ACCOUNT_ID) return false;
  if (!isSafeId(meta.uid) || !isSafeId(meta.placeId) || !isSafeId(meta.visitId)) return false;
  if (typeof meta.chargeType !== "string" || chargeTypeFrom(meta.chargeType) === null) return false;
  return isPaymentIntentId(pi.id);
}

function paymentIntentOf(event: Stripe.Event): Stripe.PaymentIntent | null {
  const object = event.data.object;
  if (object.object !== "payment_intent") return null;
  return object;
}

async function rememberEvent(
  db: Firestore,
  eventId: string,
  type: string,
  paymentIntentId: string,
): Promise<void> {
  const ref = db.collection(STRIPE_WEBHOOK_EVENTS).doc(eventId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return;
    tx.set(ref, {
      type,
      paymentIntentId,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
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

  // assertStripeTestKey refuses a live API key. While that guard is in place,
  // a livemode event is refused as well. Neither path writes the payment.
  try {
    assertStripeTestKey(deps.secretKey);
  } catch (err) {
    logger.error("stripe webhook refused a live key", {
      name: err instanceof Error ? err.name : "unknown",
    });
    return 400;
  }
  if (event.livemode !== false) return 400;
  if (!isEventId(event.id)) return 400;
  if (!HANDLED_TYPES.has(event.type)) return 200;

  const pi = paymentIntentOf(event);
  if (!pi || !alreadyOurPayment(pi)) return 200;
  if (pi.livemode === true) return 400;

  const eventRef = db.collection(STRIPE_WEBHOOK_EVENTS).doc(event.id);
  if ((await eventRef.get()).exists) return 200;

  const paySnap = await db.collection(PAYMENTS).doc(pi.id).get();
  if (!paySnap.exists) {
    logger.warn("stripe webhook payment is not stored yet", {paymentIntentId: pi.id});
    return 500;
  }
  const storedIntent = paySnap.get("paymentIntentId");
  const storedUid = paySnap.get("uid");
  if ((typeof storedIntent === "string" && storedIntent !== pi.id) || storedUid !== pi.metadata.uid) {
    await rememberEvent(db, event.id, event.type, pi.id);
    return 200;
  }

  let next: string;
  try {
    next = await settlePaymentStatus(db, deps.stripe, pi.id, observedStatus(paymentShape(pi)));
  } catch (err) {
    if (err instanceof ParkingPaymentError && err.errorCode === "not-found") {
      return 500;
    }
    logger.error("stripe webhook apply failed", {
      eventId: event.id,
      paymentIntentId: pi.id,
      name: err instanceof Error ? err.name : "unknown",
    });
    return 500;
  }

  await rememberEvent(db, event.id, event.type, pi.id);
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
        stripe = createStripeClient(stripeSecretKey.value());
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
