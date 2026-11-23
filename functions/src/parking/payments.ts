import {createHash} from "crypto";
import * as logger from "firebase-functions/logger";
import {FieldValue, Firestore, Timestamp, DocumentReference, DocumentSnapshot} from "firebase-admin/firestore";
import Stripe from "stripe";
import {londonDayKey} from "../admin/london";
import {followPaymentStatus, operatorPaymentUrl, type JobOutcome} from "./authorityJobs";
import {assertNoCardData} from "./cardGuard";
import {
  OPERATOR_FORWARDS,
  PAYMENTS,
  PAYMENTS_CONFIG,
  PLACES,
  ParkingPaymentError,
  REQUESTS,
  SERVICE_FEE_PENCE,
  STRIPE_CUSTOMERS,
  canonicalOperator,
  chargeIdempotencyKey,
  chargeRetryIdempotencyKey,
  chargeTypeFrom,
  failureReasonFor,
  httpsUrl,
  isParkingStatus,
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
  FLAT_STAY_GUARD_MINUTES,
  FORWARD_TTL_MS,
  FUNDING_STATE,
  MAX_TOTAL_PENCE,
  MIN_TOTAL_PENCE,
  REQUEST_TTL_MS,
  STAY_HOLDING_STATUSES,
  type ChargeType,
  type ParkingStatus,
} from "./contract";
import {
  EXPECTED_STRIPE_ACCOUNT_ID,
  EPHEMERAL_KEY_API_VERSION,
  assertPublishableKey,
  maxPaymentPence,
  type StripeKeyMode,
} from "./stripeClient";

export interface PaymentIntentShape {
  id: string;
  client_secret: string | null;
  status: string;
  amount: number;
  currency: string;
  customer: string | {id: string} | null;
  last_payment_error?: unknown;
  livemode?: boolean;
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
  durationMinutes: number | null;
  operator: string;
  locationCode: string | null;
  zone: string;
  paymentUrl: string;
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
  publishableKey: string;
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

async function assertPaymentsConfig(db: Firestore): Promise<void> {
  const snap = await db.doc(PAYMENTS_CONFIG).get();
  const enabled = snap.get("enabled") === true;
  const account = snap.get("stripeAccountId");
  if (!enabled || account !== EXPECTED_STRIPE_ACCOUNT_ID) {
    logger.error("parking payments config refused", {
      enabled,
      account: typeof account === "string" ? account : null,
    });
    throw new ParkingPaymentError("failed-precondition", "In-app payment isn't available right now.");
  }
}

async function fundingPaused(db: Firestore): Promise<boolean> {
  const snap = await db.doc(FUNDING_STATE).get();
  return snap.get("paused") === true;
}

// Direct charge on Ferro's account. No Connect account, no destination charge.
function merchantCharge(params: Stripe.PaymentIntentCreateParams): Stripe.PaymentIntentCreateParams {
  if (params.transfer_data || params.on_behalf_of || params.application_fee_amount != null) {
    throw new ParkingPaymentError("internal", "We couldn't start the payment. Please try again.");
  }
  return params;
}

const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 1440;

interface TariffRow {
  maxMinutes: number;
  pence: number;
}

// Smallest maxMinutes that still covers the stay. Rows are sorted ascending.
function priceForDuration(rows: TariffRow[], minutes: number): number | null {
  for (const row of rows) {
    if (row.maxMinutes >= minutes) return row.pence;
  }
  return null;
}

function tariffRows(value: unknown): TariffRow[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows: TariffRow[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const maxMinutes = (item as {maxMinutes?: unknown}).maxMinutes;
    const pence = wholePence((item as {pence?: unknown}).pence, 1);
    if (
      typeof maxMinutes !== "number" ||
      !Number.isSafeInteger(maxMinutes) ||
      maxMinutes < 1 ||
      pence === null
    ) {
      return null;
    }
    rows.push({maxMinutes, pence});
  }
  rows.sort((a, b) => a.maxMinutes - b.maxMinutes);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].maxMinutes === rows[i - 1].maxMinutes) return null;
  }
  return rows;
}

// The phone's stay picker is 15, 30, 60, 120, 180, 240, 480 and 1440 minutes.
// A place priced by length of stay stores one row for each of those, as
// places/{id}.parkingTariffs = [{maxMinutes, pence}, ...]. pence is the stay
// in GBP pence. The fee is added here. The client never sends a price.
async function stayPence(
  db: Firestore,
  snap: DocumentSnapshot,
  durationMinutes: unknown,
): Promise<{parkingPence: number; durationMinutes: number | null}> {
  const flagOn = (await db.doc("config/flags").get()).get("parkingDurationPricing") === true;
  const tariffs = snap.get("parkingTariffs");
  const durationPriced = flagOn && Array.isArray(tariffs) && tariffs.length > 0;
  if (!durationPriced) {
    const parkingPence = wholePence(snap.get("parkingPence"), 1);
    if (parkingPence === null) {
      throw new ParkingPaymentError("failed-precondition", "This place doesn't have a price set.");
    }
    return {parkingPence, durationMinutes: null};
  }
  if (durationMinutes === undefined) {
    throw new ParkingPaymentError("duration-required", "Say how many minutes you are staying.");
  }
  if (
    typeof durationMinutes !== "number" ||
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes < MIN_DURATION_MINUTES ||
    durationMinutes > MAX_DURATION_MINUTES
  ) {
    throw new ParkingPaymentError("duration-invalid", "That stay length isn't one we can price.");
  }
  const rows = tariffRows(tariffs);
  if (rows === null) {
    throw new ParkingPaymentError("failed-precondition", "This place doesn't have a price set.");
  }
  const pence = priceForDuration(rows, durationMinutes);
  if (pence === null) {
    throw new ParkingPaymentError("duration-invalid", "That stay length isn't one we can price.");
  }
  return {parkingPence: pence, durationMinutes};
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

async function loadPlace(
  db: Firestore,
  placeId: string,
  operator: string,
  durationMinutes: unknown,
  maxPence: number,
): Promise<PricedPlace> {
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
  const stay = await stayPence(db, snap, durationMinutes);
  const parkingPence = stay.parkingPence;
  const feePence = SERVICE_FEE_PENCE;
  const amount = parkingPence + feePence;
  if (amount < MIN_TOTAL_PENCE || amount > MAX_TOTAL_PENCE) {
    throw new ParkingPaymentError("failed-precondition", "This stay's price is outside the range we can charge.");
  }
  if (amount > maxPence) {
    throw new ParkingPaymentError("failed-precondition", "This payment is above the limit we can take.");
  }
  const locationCode = snap.get("locationCode");
  const code = typeof locationCode === "string" ? locationCode : null;
  const name = shortText(snap.get("name"), 80);
  const zone = name ?? (code ? `${placeOperator} ${code}` : placeOperator);
  return {
    parkingPence,
    feePence,
    amount,
    durationMinutes: stay.durationMinutes,
    operator: placeOperator,
    locationCode: code,
    zone,
    paymentUrl: operatorPaymentUrl(placeOperator, snap.get("paymentUrl")),
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
  amount: number;
  durationMinutes: number | null;
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
  const paid = ranked.find((doc) => textField(doc.get("status")) === "paid");
  const open = ranked.find((doc) => !closedPayment(textField(doc.get("status"))));
  const chosen = paid ?? open ?? ranked[0];
  const parkingPence = integerField(chosen.get("parkingPence"));
  const feePence = integerField(chosen.get("feePence"));
  const amount = integerField(chosen.get("amount"));
  if (parkingPence === null || feePence === null || amount === null) {
    throw new ParkingPaymentError("internal", "This payment's price is missing.");
  }
  const durationValue = chosen.get("durationMinutes");
  const durationMinutes = typeof durationValue === "number" && Number.isSafeInteger(durationValue) ?
    durationValue :
    null;
  return {
    id: chosen.id,
    parkingPence,
    feePence,
    amount,
    durationMinutes,
    status: textField(chosen.get("status")),
  };
}

// A paid stay from another visit that has not ended yet. A relaunch mid-stay
// gives the phone a new visit id, so the visit lookup alone would let the same
// driver pay twice for one stay. Equality filters only, so no composite index.
export async function findRunningPaidStay(
  db: Firestore,
  uid: string,
  placeId: string,
  visitId: string,
  nowMs: number,
): Promise<{id: string; endsAtMs: number} | null> {
  const snap = await db.collection(PAYMENTS)
    .where("uid", "==", uid)
    .where("placeId", "==", placeId)
    .limit(100)
    .get();
  let running: {id: string; endsAtMs: number} | null = null;
  for (const doc of snap.docs) {
    if (doc.get("visitId") === visitId) continue;
    if (chargeTypeFrom(doc.get("chargeType")) !== "parking") continue;
    const status = textField(doc.get("status"));
    if (!isParkingStatus(status) || !STAY_HOLDING_STATUSES.includes(status)) continue;
    const startedMs = createdAtMillis(doc.get("createdAt"));
    if (startedMs === 0) continue;
    const minutes = integerField(doc.get("durationMinutes")) ?? FLAT_STAY_GUARD_MINUTES;
    const endsAtMs = startedMs + minutes * 60_000;
    if (endsAtMs <= nowMs) continue;
    if (!running || endsAtMs > running.endsAtMs) running = {id: doc.id, endsAtMs};
  }
  return running;
}

// Optional Stripe webhook claim. The event id and the payment status are
// written in this same transaction. A repeat event id does not write status.
export interface StatusClaim {
  eventRef: DocumentReference;
  record: Record<string, unknown>;
  expectedUid?: string;
  paidCheck?: {amount: number; currency: string};
  result?: "applied" | "duplicate" | "mismatch" | "ignored";
  storedAmount?: unknown;
  storedCurrency?: unknown;
}

// Moves status forward inside one transaction. Entering `processing` (including
// the created → processing → paid step for a succeeded PaymentIntent) registers
// the plate once, then deletes it from the create request. plateRegisteredAt is
// set only when that forward is written. A terminal status also deletes the plate.
// livemode, when the caller has it from the PaymentIntent, is stored on the
// same write so a status change carries the Stripe mode.
export async function commitPaymentStatus(
  db: Firestore,
  paymentIntentId: string,
  incoming: ParkingStatus,
  followUp?: JobOutcome,
  nowMs = Date.now(),
  claim?: StatusClaim,
  livemode?: boolean,
): Promise<ParkingStatus> {
  const outcome = await db.runTransaction(async (tx) => {
    const payRef = db.collection(PAYMENTS).doc(paymentIntentId);
    const forwardRef = db.collection(OPERATOR_FORWARDS).doc(paymentIntentId);
    if (claim) {
      const seen = await tx.get(claim.eventRef);
      if (seen.exists) return {kind: "duplicate" as const};
    }
    const paySnap = await tx.get(payRef);
    if (!paySnap.exists) {
      throw new ParkingPaymentError("not-found", "We couldn't find this payment.");
    }
    if (claim?.expectedUid !== undefined) {
      const storedIntent = paySnap.get("paymentIntentId");
      const storedUid = paySnap.get("uid");
      const intentMismatch = typeof storedIntent === "string" && storedIntent !== paymentIntentId;
      if (intentMismatch || storedUid !== claim.expectedUid) {
        tx.set(claim.eventRef, claim.record);
        return {kind: "ignored" as const};
      }
    }
    const currentValue = paySnap.get("status");
    const current = typeof currentValue === "string" ? currentValue : undefined;
    const next = resolveStatus(current, incoming);
    if (claim?.paidCheck && next === "paid" && current !== "paid") {
      const storedAmount = paySnap.get("amount");
      const storedCurrency = paySnap.get("currency");
      if (storedAmount !== claim.paidCheck.amount || storedCurrency !== claim.paidCheck.currency) {
        claim.storedAmount = storedAmount;
        claim.storedCurrency = storedCurrency;
        tx.set(claim.eventRef, claim.record);
        return {kind: "mismatch" as const};
      }
    }
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
        ...(next === "paid" && current !== "paid" ? {jobPending: true} : {}),
        ...(typeof livemode === "boolean" ? {livemode} : {}),
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
    if (claim) tx.set(claim.eventRef, claim.record);
    return {kind: "applied" as const, previous: current, next};
  });
  if (claim) claim.result = outcome.kind;
  if (outcome.kind !== "applied") {
    const snap = await db.collection(PAYMENTS).doc(paymentIntentId).get();
    const status = snap.get("status");
    return isParkingStatus(status) ? status : incoming;
  }
  const becamePaid = outcome.next === "paid" && outcome.previous !== "paid";
  const becameRefunded = outcome.next === "refunded" && outcome.previous !== "refunded";
  if (followUp || becamePaid || becameRefunded) {
    try {
      await followPaymentStatus(db, paymentIntentId, outcome.previous, outcome.next, followUp, nowMs);
    } catch (err) {
      logger.error("payment follow-up failed", {
        paymentIntentId,
        name: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return outcome.next;
}

const CANCELABLE_STRIPE_STATUS = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

// A declined sheet can leave the PaymentIntent cancelable after we have already
// recorded failed. Ignore a refusal; the retry must still open.
async function cancelIfStripeAllows(stripe: ParkingStripe, paymentIntentId: string): Promise<void> {
  let status = "";
  try {
    const fresh = await stripe.paymentIntents.retrieve(paymentIntentId);
    status = fresh.status;
  } catch (err) {
    logger.warn("could not read the previous PaymentIntent before retry", {
      paymentIntentId,
      name: err instanceof Error ? err.name : "unknown",
    });
    return;
  }
  if (!CANCELABLE_STRIPE_STATUS.has(status)) return;
  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (err) {
    logger.warn("could not cancel the previous PaymentIntent", {
      paymentIntentId,
      status,
      name: err instanceof Error ? err.name : "unknown",
    });
  }
}

// failed is recorded only after Stripe has canceled the PaymentIntent, so a
// later success of that same PaymentIntent cannot arrive.
function modeFrom(value: boolean | undefined, fallback: boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  return typeof fallback === "boolean" ? fallback : undefined;
}

export async function settlePaymentStatus(
  db: Firestore,
  stripe: PaymentIntentClient,
  paymentIntentId: string,
  incoming: ParkingStatus,
  claim?: StatusClaim,
  livemode?: boolean,
): Promise<ParkingStatus> {
  if (incoming !== "failed") {
    return commitPaymentStatus(db, paymentIntentId, incoming, undefined, Date.now(), claim, livemode);
  }
  try {
    const canceled = await stripeCall(() => stripe.paymentIntents.cancel(paymentIntentId));
    livemode = modeFrom(livemode, canceled.livemode);
  } catch (err) {
    const fresh = await stripeCall(() => stripe.paymentIntents.retrieve(paymentIntentId));
    const again = observedStatus(fresh);
    const mode = modeFrom(livemode, fresh.livemode);
    if (again !== "failed") {
      return commitPaymentStatus(db, paymentIntentId, again, undefined, Date.now(), claim, mode);
    }
    throw err instanceof ParkingPaymentError ? err : wrapStripe(err);
  }
  return commitPaymentStatus(db, paymentIntentId, "failed", undefined, Date.now(), claim, livemode);
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
  publishableKey: string,
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
    publishableKey,
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
    publishableKey: result.publishableKey,
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
  publishableKey: string,
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
  if (existing?.status === "paid") {
    const pi = await stripeCall(() => stripe.paymentIntents.retrieve(existing.id));
    await requestRef.update({plate: FieldValue.delete()});
    const customerId = customerIdOf(pi);
    const ephemeral = await ephemeralKey(stripe, customerId);
    await finishCreate(
      requestRef,
      resultFrom(pi, customerId, ephemeral, existing.parkingPence, existing.feePence, publishableKey),
    );
    return;
  }
  const running = await findRunningPaidStay(db, uid, placeId, visitId, Date.now());
  if (running) {
    logger.info("parking payment refused: stay already paid", {placeId, paymentIntentId: running.id});
    throw new ParkingPaymentError(
      "already-paid",
      "You've already paid for a stay here. You can pay again after it ends.",
    );
  }
  const place = await loadPlace(db, placeId, operator, data.durationMinutes, await maxPaymentPence(db));
  const sameStay = existing !== null &&
    existing.durationMinutes === place.durationMinutes &&
    existing.amount === place.amount;
  if (existing && !closedPayment(existing.status) && sameStay) {
    const pi = await stripeCall(() => stripe.paymentIntents.retrieve(existing.id));
    const next = await settlePaymentStatus(db, stripe, pi.id, observedStatus(pi), undefined, pi.livemode);
    if (next !== "failed" && next !== "canceled") {
      await requestRef.update({plate: FieldValue.delete()});
      const customerId = customerIdOf(pi);
      const ephemeral = await ephemeralKey(stripe, customerId);
      await finishCreate(
        requestRef,
        resultFrom(pi, customerId, ephemeral, existing.parkingPence, existing.feePence, publishableKey),
      );
      return;
    }
    await cancelIfStripeAllows(stripe, existing.id);
  }

  if (await fundingPaused(db)) {
    throw new ParkingPaymentError(
      "failed-precondition",
      "Parking payments are paused until Ferro's payment balance is topped up.",
    );
  }

  if (existing && !closedPayment(existing.status) && !sameStay) {
    await cancelIfStripeAllows(stripe, existing.id);
    const fresh = await stripeCall(() => stripe.paymentIntents.retrieve(existing.id));
    if (fresh.status !== "canceled") {
      throw new ParkingPaymentError(
        "open-payment-in-progress",
        "Finish the open payment before changing this stay.",
      );
    }
    await commitPaymentStatus(db, existing.id, "canceled");
  }

  const customerId = await getOrCreateCustomer(db, stripe, uid);
  const idempotencyKey = existing ?
    retryIdempotencyKey(uid, placeId, visitId, existing.id, place.durationMinutes, place.amount) :
    paymentIntentIdempotencyKey(uid, placeId, visitId, place.durationMinutes, place.amount);
  const pi = await stripeCall(() => stripe.paymentIntents.create(merchantCharge({
    amount: place.amount,
    currency: "gbp",
    customer: customerId,
    description: "FerroMaps parking",
    metadata: {
      uid,
      placeId,
      visitId,
      chargeType: "parking",
      ferroAccount: EXPECTED_STRIPE_ACCOUNT_ID,
    },
  }), {idempotencyKey}));
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
        chargeType: "parking",
        ...(typeof pi.livemode === "boolean" ? {livemode: pi.livemode} : {}),
        authorityPence: place.parkingPence,
        parkingPence: place.parkingPence,
        feePence: place.feePence,
        durationMinutes: place.durationMinutes,
        zone: place.zone,
        paymentUrl: place.paymentUrl,
        occurredOn: londonDayKey(new Date()),
        failureReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
  const observed = observedStatus(pi);
  if (observed !== "created") {
    const next = await settlePaymentStatus(db, stripe, pi.id, observed, undefined, pi.livemode);
    if (next === "failed" || next === "canceled") {
      throw new ParkingPaymentError("internal", "The payment didn't go through.");
    }
  }
  const storedRequestId = textField((await payRef.get()).get("requestId"));
  if (storedRequestId && storedRequestId !== requestRef.id) {
    await requestRef.update({plate: FieldValue.delete()});
  }
  const ephemeral = await ephemeralKey(stripe, customerId);
  await finishCreate(
    requestRef,
    resultFrom(pi, customerId, ephemeral, place.parkingPence, place.feePence, publishableKey),
  );
}

function zonePlaceId(zone: string): string {
  const slug = zone.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return isSafeId(slug) ? slug : "charge";
}

function referenceVisitId(chargeType: string, reference: string): string {
  const raw = `${chargeType}_${reference}`.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 120);
  if (isSafeId(raw)) return raw;
  return `c_${createHash("sha256").update(`${chargeType}:${reference}`).digest("hex").slice(0, 32)}`;
}

async function createCharge(
  db: Firestore,
  stripe: ParkingStripe,
  requestRef: DocumentReference,
  uid: string,
  data: Record<string, unknown>,
  chargeType: Exclude<ChargeType, "parking">,
  publishableKey: string,
): Promise<void> {
  if (requestRef.id.endsWith("_confirm") || data.action !== "create" || data.v !== 1) {
    throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
  }
  const plate = normalizePlate(data.plate);
  const platform = shortText(data.platform, 32);
  const appVersion = shortText(data.appVersion, 32);
  const zone = shortText(data.zone, 80);
  const occurredOn = shortText(data.occurredOn, 10);
  const paymentUrl = httpsUrl(data.paymentUrl);
  const authorityPence = wholePence(data.authorityPence, 1);
  const reference = shortText(data.reference, 64);
  const deadlineAt = data.deadlineAt instanceof Timestamp ? data.deadlineAt : null;
  if (data.deadlineAt != null && deadlineAt === null) {
    throw new ParkingPaymentError("invalid-argument", "The payment deadline isn't valid.");
  }
  if (!plate || !platform || !appVersion || !zone || !occurredOn || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
  }
  if (!paymentUrl || authorityPence === null) {
    throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
  }
  try {
    assertNoCardData({zone, reference, paymentUrl, plate}, "payment request");
  } catch {
    throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
  }
  const feePence = SERVICE_FEE_PENCE;
  const amount = authorityPence + feePence;
  if (amount < MIN_TOTAL_PENCE || amount > MAX_TOTAL_PENCE) {
    throw new ParkingPaymentError("failed-precondition", "This charge is outside the range we can take.");
  }
  if (amount > await maxPaymentPence(db)) {
    throw new ParkingPaymentError("failed-precondition", "This payment is above the limit we can take.");
  }
  const chargeReference = reference ?? `${zone}:${occurredOn}:${plate}`;
  const placeId = zonePlaceId(zone);
  const visitId = referenceVisitId(chargeType, chargeReference);
  const existing = await findPaymentByVisit(db, uid, placeId, visitId);
  if (existing && !closedPayment(existing.status)) {
    const pi = await stripeCall(() => stripe.paymentIntents.retrieve(existing.id));
    const next = await settlePaymentStatus(db, stripe, pi.id, observedStatus(pi), undefined, pi.livemode);
    if (next !== "failed" && next !== "canceled") {
      await requestRef.update({plate: FieldValue.delete()});
      const customerId = customerIdOf(pi);
      const ephemeral = await ephemeralKey(stripe, customerId);
      await finishCreate(
        requestRef,
        resultFrom(pi, customerId, ephemeral, existing.parkingPence, existing.feePence, publishableKey),
      );
      return;
    }
    await cancelIfStripeAllows(stripe, existing.id);
  }
  const customerId = await getOrCreateCustomer(db, stripe, uid);
  const idempotencyKey = existing ?
    chargeRetryIdempotencyKey(uid, chargeType, chargeReference, existing.id) :
    chargeIdempotencyKey(uid, chargeType, chargeReference);
  const pi = await stripeCall(() => stripe.paymentIntents.create(merchantCharge({
    amount,
    currency: "gbp",
    customer: customerId,
    description: `FerroMaps ${chargeType}`,
    metadata: {
      uid,
      placeId,
      visitId,
      chargeType,
      ferroAccount: EXPECTED_STRIPE_ACCOUNT_ID,
    },
  }), {idempotencyKey}));
  if (!isPaymentIntentId(pi.id) || pi.currency !== "gbp" || pi.amount !== amount) {
    throw new ParkingPaymentError("internal", "Stripe returned an unexpected payment.");
  }
  const payRef = db.collection(PAYMENTS).doc(pi.id);
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(payRef);
    if (!fresh.exists) {
      tx.set(payRef, {
        v: 1,
        status: "created",
        amount,
        currency: "gbp",
        placeId,
        visitId,
        operator: chargeType,
        uid,
        requestId: requestRef.id,
        paymentIntentId: pi.id,
        chargeType,
        ...(typeof pi.livemode === "boolean" ? {livemode: pi.livemode} : {}),
        authorityPence,
        parkingPence: authorityPence,
        feePence,
        zone,
        paymentUrl,
        occurredOn,
        ...(deadlineAt ? {deadlineAt} : {}),
        failureReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
  const observed = observedStatus(pi);
  if (observed !== "created") {
    const next = await settlePaymentStatus(db, stripe, pi.id, observed, undefined, pi.livemode);
    if (next === "failed" || next === "canceled") {
      throw new ParkingPaymentError("internal", "The payment didn't go through.");
    }
  }
  const ephemeral = await ephemeralKey(stripe, customerId);
  await finishCreate(requestRef, resultFrom(pi, customerId, ephemeral, authorityPence, feePence, publishableKey));
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
  const next = await settlePaymentStatus(db, stripe, paymentIntentId, observedStatus(pi), undefined, pi.livemode);
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
  publishableKey: string,
  secretMode: StripeKeyMode = "test",
): Promise<void> {
  const snap = await requestRef.get();
  if (!snap.exists || snap.get("status") !== "pending") return;
  const data = record(snap.data());
  const uid = data.uid;
  try {
    if (!isSafeId(uid)) {
      throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
    }
    if ("authorityPence" in data) {
      throw new ParkingPaymentError(
        "failed-precondition",
        "Road charges aren't available right now.",
      );
    }
    await requestRef.set({expireAt: requestExpiry()}, {merge: true});
    if (data.action === "confirm") {
      await confirmPayment(db, stripe, requestRef, uid, data);
    } else if (data.action === "create") {
      assertPublishableKey(publishableKey, secretMode);
      const chargeType = chargeTypeFrom(data.chargeType);
      if (!chargeType) {
        throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
      }
      await assertPaymentsConfig(db);
      if (chargeType === "parking") {
        await createPayment(db, stripe, requestRef, uid, data, publishableKey);
      } else {
        await createCharge(db, stripe, requestRef, uid, data, chargeType, publishableKey);
      }
    } else {
      throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
    }
  } catch (err) {
    await failPendingRequest(requestRef, err);
  }
}
