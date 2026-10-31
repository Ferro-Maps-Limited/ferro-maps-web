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
  plateClearedOn,
  normalizePlate,
  resolveStatus,
  retryIdempotencyKey,
  shortText,
  statusFromStripe,
  wholePence,
  FORWARD_TTL_MS,
  MAX_TOTAL_PENCE,
  MIN_TOTAL_PENCE,
  REQUEST_TTL_MS,
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

export interface PaymentIntentClient {
  paymentIntents: {
    retrieve(id: string): Promise<PaymentIntentShape>;
    cancel(id: string): Promise<PaymentIntentShape>;
  };
}

export interface ParkingStripe extends PaymentIntentClient {
  customers: {
    create(
      params: {metadata: {uid: string}},
      options: {idempotencyKey: string},
    ): Promise<{id: string}>;
  };
  paymentIntents: PaymentIntentClient["paymentIntents"] & {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options: {idempotencyKey: string},
    ): Promise<PaymentIntentShape>;
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
    throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

function requestExpiry(nowMs = Date.now()): Timestamp {
  return Timestamp.fromMillis(nowMs + REQUEST_TTL_MS);
}

function forwardExpiry(nowMs = Date.now()): Timestamp {
  return Timestamp.fromMillis(nowMs + FORWARD_TTL_MS);
}

function wrapStripe(err: unknown): ParkingPaymentError {
  if (err instanceof ParkingPaymentError) return err;
  const stripeErr = err instanceof Stripe.errors.StripeError ? err : null;
  logger.error("parking stripe call failed", {
    type: stripeErr?.type,
    code: stripeErr?.code,
    statusCode: stripeErr?.statusCode,
  });
  if (err instanceof Stripe.errors.StripeIdempotencyError) {
    return new ParkingPaymentError(
      "failed-precondition",
      "This visit's price changed. Start again with a new visit.",
    );
  }
  if (stripeErr && (stripeErr.statusCode === 408 || stripeErr.statusCode === 504 ||
      stripeErr.code === "lock_timeout")) {
    return new ParkingPaymentError(
      "deadline-exceeded",
      "The payment service took too long. Please try again.",
    );
  }
  if (
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeConnectionError
  ) {
    return new ParkingPaymentError("unavailable", "The payment service is busy. Please try again.");
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
  throw new ParkingPaymentError("internal", "We couldn't open a payment account for this driver.");
}

async function ephemeralKey(stripe: ParkingStripe, customerId: string): Promise<string> {
  const key = await stripeCall(() => stripe.ephemeralKeys.create(
    {customer: customerId},
    {apiVersion: EPHEMERAL_KEY_API_VERSION},
  ));
  if (!key.secret) {
    throw new ParkingPaymentError("internal", "We couldn't open a payment session. Please try again.");
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
    throw new ParkingPaymentError("failed-precondition", "This place uses a different operator.");
  }
  const parkingPence = wholePence(snap.get("parkingPence"), 1);
  const feePence = wholePence(snap.get("feePence"), 0);
  if (parkingPence === null || feePence === null) {
    throw new ParkingPaymentError("failed-precondition", "This place doesn't have a price set.");
  }
  const amount = parkingPence + feePence;
  if (amount < MIN_TOTAL_PENCE || amount > MAX_TOTAL_PENCE) {
    throw new ParkingPaymentError("failed-precondition", "This stay's price is outside the range we can charge.");
  }
  const destination = snap.get("connectedAccountId");
  if (typeof destination !== "string" || !/^acct_[A-Za-z0-9]+$/.test(destination)) {
    throw new ParkingPaymentError("failed-precondition", "This place isn't set up to take in-app payment.");
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

interface VisitPayment {
  id: string;
  parkingPence: number;
  feePence: number;
  status: string;
}

function closedPayment(status: string): boolean {
  return status === "failed" || status === "canceled";
}

function createdAtMillis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

async function findPaymentByVisit(
  db: Firestore,
  uid: string,
  placeId: string,
  visitId: string,
): Promise<VisitPayment | null> {
  const snap = await db.collection(PAYMENTS)
    .where("visitId", "==", visitId)
    .orderBy("createdAt", "desc")
    .limit(10)
    .get();
  const own = snap.docs.filter((doc) => doc.get("uid") === uid && doc.get("placeId") === placeId);
  if (own.length === 0) {
    if (!snap.empty) {
      throw new ParkingPaymentError("invalid-argument", "This visit is already tied to another driver.");
    }
    return null;
  }
  const ranked = [...own].sort((a, b) => {
    const delta = createdAtMillis(b.get("createdAt")) - createdAtMillis(a.get("createdAt"));
    if (delta !== 0) return delta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const open = ranked.find((doc) => !closedPayment(textField(doc.get("status"))));
  const chosen = open ?? ranked[0];
  const parkingPence = integerField(chosen.get("parkingPence"));
  const feePence = integerField(chosen.get("feePence"));
  if (parkingPence === null || feePence === null) {
    throw new ParkingPaymentError("internal", "This payment's price is missing.");
  }
  return {
    id: chosen.id,
    parkingPence,
    feePence,
    status: textField(chosen.get("status")),
  };
}

// Moves status forward inside one transaction. Entering `processing` (including
// the created → processing → paid step for a succeeded PaymentIntent) registers
// the plate once, then deletes it from the create request. plateRegisteredAt is
// set only when that forward is written. A terminal status also deletes the plate.
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
    const currentValue = paySnap.get("status");
    const current = typeof currentValue === "string" ? currentValue : undefined;
    const next = resolveStatus(current, incoming);
    const forwardSnap = await tx.get(forwardRef);
    const alreadyRegistered = paySnap.get("plateRegisteredAt") != null || forwardSnap.exists;
    const fromOpen = current === "created" || current === "processing" || current === undefined;
    const enteringProcessing = !alreadyRegistered && fromOpen &&
      (next === "processing" || next === "paid");
    const requestId = textField(paySnap.get("requestId"));
    const reqRef = requestId ? db.collection(REQUESTS).doc(requestId) : null;
    const clearPlate = enteringProcessing || plateClearedOn(next);
    const reqSnap = reqRef && clearPlate ? await tx.get(reqRef) : null;
    const plate = enteringProcessing && reqSnap?.exists ? normalizePlate(reqSnap.get("plate")) : null;
    const operator = enteringProcessing ? textField(paySnap.get("operator")) : "";
    const placeId = enteringProcessing ? textField(paySnap.get("placeId")) : "";
    const visitId = enteringProcessing ? textField(paySnap.get("visitId")) : "";
    const uid = enteringProcessing ? textField(paySnap.get("uid")) : "";
    const placeSnap = placeId ? await tx.get(db.collection(PLACES).doc(placeId)) : null;
    const locationValue = placeSnap?.get("locationCode");
    const locationCode = typeof locationValue === "string" ? locationValue : null;
    const wroteForward = Boolean(enteringProcessing && plate && requestId);

    if (next !== current || enteringProcessing) {
      tx.set(payRef, {
        status: next,
        failureReason: failureReasonFor(next, null),
        ...(wroteForward ? {
          plateRegisteredAt: FieldValue.serverTimestamp(),
          plateMissing: FieldValue.delete(),
        } : {}),
        ...(enteringProcessing && !wroteForward ? {plateMissing: true} : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
    }
    if (wroteForward && reqRef && plate) {
      tx.set(forwardRef, {
        plate,
        operator,
        locationCode,
        placeId,
        visitId,
        uid,
        paymentIntentId,
        createdAt: FieldValue.serverTimestamp(),
        expireAt: forwardExpiry(),
      });
      tx.update(reqRef, {plate: FieldValue.delete()});
    } else if (clearPlate && reqSnap?.exists && reqSnap.get("plate") != null && reqRef) {
      tx.update(reqRef, {plate: FieldValue.delete()});
    }
    if (enteringProcessing && !wroteForward) {
      logger.error("plate missing for operator forward", {paymentIntentId, requestId});
    }
    return next;
  });
}

// failed is recorded only after Stripe has canceled the PaymentIntent, so a
// later success of that same PaymentIntent cannot arrive.
export async function settlePaymentStatus(
  db: Firestore,
  stripe: PaymentIntentClient,
  paymentIntentId: string,
  incoming: ParkingStatus,
): Promise<ParkingStatus> {
  if (incoming !== "failed") {
    return commitPaymentStatus(db, paymentIntentId, incoming);
  }
  try {
    await stripeCall(() => stripe.paymentIntents.cancel(paymentIntentId));
  } catch (err) {
    const fresh = await stripeCall(() => stripe.paymentIntents.retrieve(paymentIntentId));
    const again = observedStatus(fresh);
    if (again !== "failed") {
      return commitPaymentStatus(db, paymentIntentId, again);
    }
    throw err instanceof ParkingPaymentError ? err : wrapStripe(err);
  }
  return commitPaymentStatus(db, paymentIntentId, "failed");
}

export async function acknowledgeOperatorForward(
  db: Firestore,
  paymentIntentId: string,
): Promise<void> {
  if (!isPaymentIntentId(paymentIntentId)) {
    throw new ParkingPaymentError("invalid-argument", "This operator forward isn't valid.");
  }
  await db.collection(OPERATOR_FORWARDS).doc(paymentIntentId).delete();
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
    throw new ParkingPaymentError("internal", "Stripe didn't return a client secret for this payment.");
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
    expireAt: requestExpiry(),
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
  if (requestRef.id.endsWith("_confirm")) {
    throw new ParkingPaymentError(
      "invalid-argument",
      "Choose a different id for this payment request.",
    );
  }
  if (data.action !== "create" || data.v !== 1) {
    throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
  }
  if (!isSafeId(placeId) || !isSafeId(visitId)) {
    throw new ParkingPaymentError("invalid-argument", "The place or visit id isn't valid.");
  }
  if (!platform || !appVersion) {
    throw new ParkingPaymentError("invalid-argument", "The app version isn't valid.");
  }
  if (!operator) {
    throw new ParkingPaymentError("invalid-argument", "That operator isn't supported.");
  }
  if (!plate) {
    throw new ParkingPaymentError("invalid-argument", "Enter the vehicle registration as letters and numbers.");
  }

  const existing = await findPaymentByVisit(db, uid, placeId, visitId);
  if (existing && !closedPayment(existing.status)) {
    const pi = await stripeCall(() => stripe.paymentIntents.retrieve(existing.id));
    const next = await settlePaymentStatus(db, stripe, pi.id, observedStatus(pi));
    if (next === "failed" || next === "canceled") {
      throw new ParkingPaymentError("failed-precondition", "The payment didn't go through.");
    }
    await requestRef.update({plate: FieldValue.delete()});
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
  const idempotencyKey = existing ?
    retryIdempotencyKey(uid, placeId, visitId, existing.id) :
    paymentIntentIdempotencyKey(uid, placeId, visitId);
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
  }, {idempotencyKey}));
  if (!isPaymentIntentId(pi.id) || pi.currency !== "gbp" || pi.amount !== place.amount) {
    throw new ParkingPaymentError("internal", "Stripe returned an unexpected payment.");
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
  const observed = observedStatus(pi);
  if (observed !== "created") {
    const next = await settlePaymentStatus(db, stripe, pi.id, observed);
    if (next === "failed" || next === "canceled") {
      throw new ParkingPaymentError("failed-precondition", "The payment didn't go through.");
    }
  }
  const storedRequestId = textField((await payRef.get()).get("requestId"));
  if (storedRequestId && storedRequestId !== requestRef.id) {
    await requestRef.update({plate: FieldValue.delete()});
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
    throw new ParkingPaymentError("invalid-argument", "This confirmation isn't valid.");
  }
  if (!isPaymentIntentId(paymentId) || typeof paymentIntentId !== "string" ||
      paymentIntentId.length < 1 || paymentIntentId.length > 255 ||
      !isSafeId(originalRequestId)) {
    throw new ParkingPaymentError("invalid-argument", "This confirmation doesn't match the payment.");
  }
  if (requestRef.id !== `${paymentId}_confirm`) {
    throw new ParkingPaymentError("invalid-argument", "This confirmation id doesn't match the payment.");
  }

  const original = await db.collection(REQUESTS).doc(originalRequestId).get();
  if (!original.exists) {
    throw new ParkingPaymentError("not-found", "We couldn't find this payment.");
  }
  if (original.get("uid") !== uid) {
    throw new ParkingPaymentError("permission-denied", "This confirmation belongs to another driver.");
  }
  if (original.get("action") !== "create" || original.get("status") !== "done") {
    throw new ParkingPaymentError("failed-precondition", "The original payment request isn't ready to confirm.");
  }

  const payRef = db.collection(PAYMENTS).doc(paymentId);
  const paySnap = await payRef.get();
  if (!paySnap.exists) {
    throw new ParkingPaymentError("not-found", "We couldn't find this payment.");
  }
  if (paySnap.get("uid") !== uid) {
    throw new ParkingPaymentError("permission-denied", "This payment belongs to another driver.");
  }
  if (paySnap.get("paymentIntentId") !== paymentIntentId) {
    throw new ParkingPaymentError("invalid-argument", "This confirmation doesn't match the payment.");
  }

  const pi = await stripeCall(() => stripe.paymentIntents.retrieve(paymentIntentId));
  if (pi.id !== paymentIntentId) {
    throw new ParkingPaymentError("internal", "Stripe returned a different payment.");
  }
  const next = await settlePaymentStatus(db, stripe, paymentIntentId, observedStatus(pi));
  await requestRef.update({
    status: "done",
    paymentId,
    paymentStatus: next,
    expireAt: requestExpiry(),
    completedAt: FieldValue.serverTimestamp(),
  });
}

export async function failPendingRequest(
  requestRef: DocumentReference,
  err: unknown,
): Promise<void> {
  const failure = err instanceof ParkingPaymentError ? err : wrapStripe(err);
  logger.error("onParkingPaymentRequest failed", {
    requestId: requestRef.id,
    errorCode: failure.errorCode,
  });
  await requestRef.firestore.runTransaction(async (tx) => {
    const fresh = await tx.get(requestRef);
    if (fresh.get("status") !== "pending") return;
    tx.update(requestRef, {
      status: "error",
      error: failure.message,
      errorCode: failure.errorCode,
      plate: FieldValue.delete(),
      expireAt: requestExpiry(),
      completedAt: FieldValue.serverTimestamp(),
    });
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
      throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
    }
    await requestRef.set({expireAt: requestExpiry()}, {merge: true});
    await requireGold(db, uid);
    if (data.action === "confirm") {
      await confirmPayment(db, stripe, requestRef, uid, data);
    } else if (data.action === "create") {
      await createPayment(db, stripe, requestRef, uid, data);
    } else {
      throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
    }
  } catch (err) {
    await failPendingRequest(requestRef, err);
  }
}
