import {createHash} from "crypto";
import * as logger from "firebase-functions/logger";
import {FieldValue, Firestore, Timestamp, DocumentReference} from "firebase-admin/firestore";
import Stripe from "stripe";
import {
  OPERATOR_FORWARDS,
  PAYMENTS,
  PLACES,
  ParkingPaymentError,
  REQUESTS,
  STRIPE_CUSTOMERS,
  canonicalOperator,
  failureReasonFor,
  isPaymentIntentId,
  isSafeId,
  paymentIntentIdempotencyKey,
  normalizePlate,
  resolveStatus,
  shortText,
  statusFromStripe,
  wholePence,
  MAX_TOTAL_PENCE,
  MIN_TOTAL_PENCE,
  type ParkingStatus,
} from "./contract";
import {EPHEMERAL_KEY_API_VERSION} from "./stripeClient";

export interface PaymentIntentShape {
  id: string;
  client_secret: string | null;
  status: string;
  amount: number;
  currency: string;
  customer: string | {id: string} | null;
  last_payment_error?: unknown;
}

export interface ParkingStripe {
  customers: {
    create(
      params: {metadata: {uid: string}},
      options: {idempotencyKey: string},
    ): Promise<{id: string}>;
  };
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options: {idempotencyKey: string},
    ): Promise<PaymentIntentShape>;
    retrieve(id: string): Promise<PaymentIntentShape>;
  };
  ephemeralKeys: {
    create(
      params: {customer: string},
      options: {apiVersion: string},
    ): Promise<{secret?: string | null}>;
  };
}

interface PricedPlace {
  parkingPence: number;
  feePence: number;
  amount: number;
  operator: string;
  destination: string;
  locationCode: string | null;
}

interface CreateResult {
  paymentIntentClientSecret: string;
  customerId: string;
  ephemeralKey: string;
  paymentId: string;
  paymentIntentId: string;
  parkingPence: number;
  feePence: number;
  amount: number;
  currency: "gbp";
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }
  return value as Record<string, unknown>;
}

function wrapStripe(err: unknown): ParkingPaymentError {
  if (err instanceof ParkingPaymentError) return err;
  const stripeErr = err instanceof Stripe.errors.StripeError ? err : null;
  logger.error("parking stripe call failed", {
    type: stripeErr?.type,
    code: stripeErr?.code,
  });
  if (err instanceof Stripe.errors.StripeIdempotencyError) {
    return new ParkingPaymentError(
      "failed-precondition",
      "This visit's price changed. Start again with a new visit.",
    );
  }
  if (
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeConnectionError
  ) {
    return new ParkingPaymentError("unavailable", "We couldn't start the payment. Please try again.");
  }
  return new ParkingPaymentError("internal", "We couldn't start the payment. Please try again.");
}

async function stripeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw wrapStripe(err);
  }
}

async function isGold(db: Firestore, uid: string): Promise<boolean> {
  const snap = await db.collection("users").doc(uid).get();
  const expires = snap.get("subscriptionExpiresAt");
  return expires instanceof Timestamp && expires.toMillis() > Date.now();
}

async function requireGold(db: Firestore, uid: string): Promise<void> {
  if (!await isGold(db, uid)) {
    throw new ParkingPaymentError(
      "permission-denied",
      "In-app parking payment is part of FerroMaps Gold.",
    );
  }
}

function customerIdOf(pi: PaymentIntentShape): string {
  if (typeof pi.customer === "string" && pi.customer.startsWith("cus_")) return pi.customer;
  if (pi.customer && typeof pi.customer === "object" && pi.customer.id.startsWith("cus_")) {
    return pi.customer.id;
  }
  throw new ParkingPaymentError("internal", "We couldn't start the payment. Please try again.");
}

async function ephemeralKey(stripe: ParkingStripe, customerId: string): Promise<string> {
  const key = await stripeCall(() => stripe.ephemeralKeys.create(
    {customer: customerId},
    {apiVersion: EPHEMERAL_KEY_API_VERSION},
  ));
  if (!key.secret) {
    throw new ParkingPaymentError("internal", "We couldn't start the payment. Please try again.");
  }
  return key.secret;
}

async function loadPlace(db: Firestore, placeId: string, operator: string): Promise<PricedPlace> {
  const snap = await db.collection(PLACES).doc(placeId).get();
  if (!snap.exists) {
    throw new ParkingPaymentError("not-found", "We couldn't find this place.");
  }
  if (snap.get("payMode") !== "inapp") {
    throw new ParkingPaymentError("failed-precondition", "In-app payment isn't available at this place.");
  }
  const placeOperator = canonicalOperator(snap.get("operator"));
  if (!placeOperator || placeOperator !== operator) {
    throw new ParkingPaymentError("failed-precondition", "In-app payment isn't available at this place.");
  }
  const parkingPence = wholePence(snap.get("parkingPence"), 1);
  const feePence = wholePence(snap.get("feePence"), 0);
  if (parkingPence === null || feePence === null) {
    throw new ParkingPaymentError("failed-precondition", "In-app payment isn't available at this place.");
  }
  const amount = parkingPence + feePence;
  if (amount < MIN_TOTAL_PENCE || amount > MAX_TOTAL_PENCE) {
    throw new ParkingPaymentError("failed-precondition", "In-app payment isn't available at this place.");
  }
  const destination = snap.get("connectedAccountId");
  if (typeof destination !== "string" || !/^acct_[A-Za-z0-9]+$/.test(destination)) {
    throw new ParkingPaymentError("failed-precondition", "In-app payment isn't available at this place.");
  }
  const locationCode = snap.get("locationCode");
  return {
    parkingPence,
    feePence,
    amount,
    operator: placeOperator,
    destination,
    locationCode: typeof locationCode === "string" ? locationCode : null,
  };
}

async function getOrCreateCustomer(db: Firestore, stripe: ParkingStripe, uid: string): Promise<string> {
  const ref = db.collection(STRIPE_CUSTOMERS).doc(uid);
  const snap = await ref.get();
  const existing = snap.get("stripeCustomerId");
  if (typeof existing === "string" && existing.startsWith("cus_")) return existing;
  const digest = createHash("sha256").update(uid).digest("hex");
  const customer = await stripeCall(() => stripe.customers.create(
    {metadata: {uid}},
    {idempotencyKey: `parking_cus_${digest}`},
  ));
  await ref.set({
    stripeCustomerId: customer.id,
    createdAt: FieldValue.serverTimestamp(),
  }, {merge: true});
  return customer.id;
}

async function findPaymentByVisit(
  db: Firestore,
  uid: string,
  placeId: string,
  visitId: string,
): Promise<{id: string; parkingPence: number; feePence: number} | null> {
  const snap = await db.collection(PAYMENTS).where("visitId", "==", visitId).limit(10).get();
  const own = snap.docs.find((doc) => doc.get("uid") === uid && doc.get("placeId") === placeId);
  if (own) {
    return {
      id: own.id,
      parkingPence: own.get("parkingPence") as number,
      feePence: own.get("feePence") as number,
    };
  }
  if (!snap.empty) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }
  return null;
}

// Moves status forward inside one transaction. Entering `processing` (including
// the created → processing → paid step for a succeeded PaymentIntent) registers
// the plate once, then deletes it from the create request.
export async function commitPaymentStatus(
  db: Firestore,
  paymentIntentId: string,
  incoming: ParkingStatus,
): Promise<ParkingStatus> {
  return db.runTransaction(async (tx) => {
    const payRef = db.collection(PAYMENTS).doc(paymentIntentId);
    const forwardRef = db.collection(OPERATOR_FORWARDS).doc(paymentIntentId);
    const paySnap = await tx.get(payRef);
    if (!paySnap.exists) {
      throw new ParkingPaymentError("not-found", "We couldn't find this payment.");
    }
    const current = paySnap.get("status") as string | undefined;
    const next = resolveStatus(current, incoming);
    const forwardSnap = await tx.get(forwardRef);
    const alreadyRegistered = paySnap.get("plateRegisteredAt") != null || forwardSnap.exists;
    const enteringProcessing = !alreadyRegistered && (next === "processing" || next === "paid");
    let plate: string | null = null;
    let requestId = "";
    let operator = "";
    let locationCode: string | null = null;
    let placeId = "";
    let visitId = "";
    let uid = "";
    if (enteringProcessing) {
      const storedRequestId = paySnap.get("requestId");
      if (typeof storedRequestId === "string") {
        requestId = storedRequestId;
        const reqSnap = await tx.get(db.collection(REQUESTS).doc(requestId));
        plate = normalizePlate(reqSnap.get("plate"));
      }
      operator = typeof paySnap.get("operator") === "string" ? paySnap.get("operator") as string : "";
      placeId = typeof paySnap.get("placeId") === "string" ? paySnap.get("placeId") as string : "";
      visitId = typeof paySnap.get("visitId") === "string" ? paySnap.get("visitId") as string : "";
      uid = typeof paySnap.get("uid") === "string" ? paySnap.get("uid") as string : "";
      const placeSnap = placeId ? await tx.get(db.collection(PLACES).doc(placeId)) : null;
      const code = placeSnap?.get("locationCode");
      locationCode = typeof code === "string" ? code : null;
    }
    if (next !== current || enteringProcessing) {
      tx.set(payRef, {
        status: next,
        failureReason: failureReasonFor(next, null),
        ...(enteringProcessing ? {plateRegisteredAt: FieldValue.serverTimestamp()} : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
    }
    if (enteringProcessing && plate && requestId) {
      tx.set(forwardRef, {
        plate,
        operator,
        locationCode,
        placeId,
        visitId,
        uid,
        paymentIntentId,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(db.collection(REQUESTS).doc(requestId), {plate: FieldValue.delete()});
    }
    return next;
  });
}

export function observedStatus(pi: PaymentIntentShape): ParkingStatus {
  return statusFromStripe(pi.status, pi.last_payment_error != null);
}

function resultFrom(
  pi: PaymentIntentShape,
  customerId: string,
  ephemeral: string,
  parkingPence: number,
  feePence: number,
): CreateResult {
  if (!pi.client_secret) {
    throw new ParkingPaymentError("internal", "We couldn't start the payment. Please try again.");
  }
  return {
    paymentIntentClientSecret: pi.client_secret,
    customerId,
    ephemeralKey: ephemeral,
    paymentId: pi.id,
    paymentIntentId: pi.id,
    parkingPence,
    feePence,
    amount: parkingPence + feePence,
    currency: "gbp",
  };
}

async function finishCreate(
  requestRef: DocumentReference,
  result: CreateResult,
): Promise<void> {
  await requestRef.update({
    status: "done",
    paymentIntentClientSecret: result.paymentIntentClientSecret,
    customerId: result.customerId,
    ephemeralKey: result.ephemeralKey,
    paymentId: result.paymentId,
    paymentIntentId: result.paymentIntentId,
    parkingPence: result.parkingPence,
    feePence: result.feePence,
    amount: result.amount,
    currency: result.currency,
    completedAt: FieldValue.serverTimestamp(),
  });
}

async function createPayment(
  db: Firestore,
  stripe: ParkingStripe,
  requestRef: DocumentReference,
  uid: string,
  data: Record<string, unknown>,
): Promise<void> {
  const placeId = data.placeId;
  const visitId = data.visitId;
  const operator = canonicalOperator(data.operator);
  const plate = normalizePlate(data.plate);
  const platform = shortText(data.platform, 32);
  const appVersion = shortText(data.appVersion, 32);
  if (data.action !== "create" || data.v !== 1) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }
  if (!isSafeId(placeId) || !isSafeId(visitId) || !platform || !appVersion) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }
  if (!operator) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }
  if (!plate) {
    throw new ParkingPaymentError("invalid-argument", "Enter the vehicle registration as letters and numbers.");
  }

  const existing = await findPaymentByVisit(db, uid, placeId, visitId);
  if (existing) {
    const pi = await stripeCall(() => stripe.paymentIntents.retrieve(existing.id));
    await commitPaymentStatus(db, pi.id, observedStatus(pi));
    const customerId = customerIdOf(pi);
    const ephemeral = await ephemeralKey(stripe, customerId);
    await finishCreate(
      requestRef,
      resultFrom(pi, customerId, ephemeral, existing.parkingPence, existing.feePence),
    );
    return;
  }

  const place = await loadPlace(db, placeId, operator);
  const customerId = await getOrCreateCustomer(db, stripe, uid);
  const pi = await stripeCall(() => stripe.paymentIntents.create({
    amount: place.amount,
    currency: "gbp",
    customer: customerId,
    description: "FerroMaps parking",
    metadata: {uid, placeId, visitId},
    transfer_data: {
      destination: place.destination,
      amount: place.parkingPence,
    },
  }, {idempotencyKey: paymentIntentIdempotencyKey(uid, placeId, visitId)}));
  if (!isPaymentIntentId(pi.id) || pi.currency !== "gbp" || pi.amount !== place.amount) {
    throw new ParkingPaymentError("internal", "We couldn't start the payment. Please try again.");
  }

  const payRef = db.collection(PAYMENTS).doc(pi.id);
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(payRef);
    if (!fresh.exists) {
      tx.set(payRef, {
        v: 1,
        status: "created",
        amount: place.amount,
        currency: "gbp",
        placeId,
        visitId,
        operator: place.operator,
        uid,
        requestId: requestRef.id,
        paymentIntentId: pi.id,
        parkingPence: place.parkingPence,
        feePence: place.feePence,
        failureReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
  if (observedStatus(pi) !== "created") {
    await commitPaymentStatus(db, pi.id, observedStatus(pi));
  }
  const ephemeral = await ephemeralKey(stripe, customerId);
  await finishCreate(
    requestRef,
    resultFrom(pi, customerId, ephemeral, place.parkingPence, place.feePence),
  );
}

async function confirmPayment(
  db: Firestore,
  stripe: ParkingStripe,
  requestRef: DocumentReference,
  uid: string,
  data: Record<string, unknown>,
): Promise<void> {
  const paymentId = data.paymentId;
  const paymentIntentId = data.paymentIntentId;
  const originalRequestId = data.originalRequestId;
  if (data.action !== "confirm" || data.v !== 1) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }
  if (!isPaymentIntentId(paymentId) || typeof paymentIntentId !== "string" ||
      paymentIntentId.length < 1 || paymentIntentId.length > 255 ||
      !isSafeId(originalRequestId)) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }
  if (requestRef.id !== `${paymentId}_confirm`) {
    throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
  }

  const original = await db.collection(REQUESTS).doc(originalRequestId).get();
  if (!original.exists) {
    throw new ParkingPaymentError("not-found", "We couldn't find this payment.");
  }
  if (original.get("uid") !== uid) {
    throw new ParkingPaymentError("permission-denied", "In-app payment isn't available at this place.");
  }
  if (original.get("action") !== "create" || original.get("status") !== "done") {
    throw new ParkingPaymentError("failed-precondition", "In-app payment isn't available at this place.");
  }

  const payRef = db.collection(PAYMENTS).doc(paymentId);
  const paySnap = await payRef.get();
  if (!paySnap.exists) {
    throw new ParkingPaymentError("not-found", "We couldn't find this payment.");
  }
  if (paySnap.get("uid") !== uid) {
    throw new ParkingPaymentError("permission-denied", "In-app payment isn't available at this place.");
  }
  if (paySnap.get("paymentIntentId") !== paymentIntentId) {
    throw new ParkingPaymentError("invalid-argument", "This confirmation doesn't match the payment.");
  }

  const pi = await stripeCall(() => stripe.paymentIntents.retrieve(paymentIntentId));
  if (pi.id !== paymentIntentId) {
    throw new ParkingPaymentError("internal", "We couldn't start the payment. Please try again.");
  }
  const next = await commitPaymentStatus(db, paymentIntentId, observedStatus(pi));
  await requestRef.update({
    status: "done",
    paymentId,
    paymentStatus: next,
    completedAt: FieldValue.serverTimestamp(),
  });
}

export async function runParkingPaymentRequest(
  db: Firestore,
  stripe: ParkingStripe,
  requestRef: DocumentReference,
): Promise<void> {
  const snap = await requestRef.get();
  if (!snap.exists || snap.get("status") !== "pending") return;
  const data = record(snap.data());
  const uid = data.uid;
  try {
    if (!isSafeId(uid)) {
      throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
    }
    await requireGold(db, uid);
    if (data.action === "confirm") {
      await confirmPayment(db, stripe, requestRef, uid, data);
    } else if (data.action === "create") {
      await createPayment(db, stripe, requestRef, uid, data);
    } else {
      throw new ParkingPaymentError("invalid-argument", "Check the place and try again.");
    }
  } catch (err) {
    const failure = err instanceof ParkingPaymentError ? err : wrapStripe(err);
    logger.error("onParkingPaymentRequest failed", {
      requestId: requestRef.id,
      errorCode: failure.errorCode,
    });
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(requestRef);
      if (fresh.get("status") !== "pending") return;
      tx.update(requestRef, {
        status: "error",
        error: failure.message,
        errorCode: failure.errorCode,
        plate: FieldValue.delete(),
        completedAt: FieldValue.serverTimestamp(),
      });
    });
  }
}
