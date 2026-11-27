import * as logger from "firebase-functions/logger";
import {DocumentReference, FieldValue, Firestore, Transaction} from "firebase-admin/firestore";
import type {Message} from "firebase-admin/messaging";
import {isPaymentIntentId, isSafeId, PAYMENTS, PAYMENT_NOTIFICATIONS} from "./contract";
import {redactCardNumbers} from "./cardGuard";
import {formatPence} from "./fundingMath";
import {
  isDeadFcmTokenError,
  classifyFcmToken,
  parkingPaymentPushMessage,
  payloadStatusFor,
  paymentPushCopy,
  planParkingPush,
  type PaymentPushEvent,
} from "./paymentPush";

export const PAYMENTS_EMAIL = "pay@ferromaps.com";
export const PAYMENTS_FROM = "admin@ferromaps.com";
const ADMIN_PAYMENTS_URL = "https://admin.ferromaps.com/payments";

export interface Notice {
  id: string;
  channel: "email" | "slack" | "push";
  event: string;
  text: string;
  subject?: string;
  paymentIntentId?: string;
  uid?: string;
  placeId?: string;
  payloadStatus?: string;
}

export interface JobNoticeInput {
  paymentIntentId: string;
  uid: string;
  plate: string | null;
  occurredOn: string;
  zone: string;
  chargeType: string;
  authorityPence: number;
  driverAmountPence: number;
  /* Everything on top of the authority amount: the Stripe charge plus the Ferro fee. */
  feePence: number;
  /* The Stripe part of feePence. 0 for payments made before the Stripe charge. */
  stripeChargePence?: number;
  paymentUrl: string;
  authorityReference?: string | null;
  refundedPence?: number;
  /* Set only when the price depended on the stay (an hourly tariff). */
  durationMinutes?: number | null;
  locationCode?: string | null;
  /* Added time: the payment for the stay this time is added to. */
  extendsPaymentId?: string | null;
  /* A stepped price list's band, which staff buy at the operator. */
  tariffBand?: string | null;
  /* The authority's payment deadline (a road charge): pay before it, or the driver gets a penalty. */
  deadlineAtMs?: number | null;
  /* When the paid time ends (hourly stays and added time). */
  stayEndsAtMs?: number | null;
}

/* 24 Nov, 15:30 in London time. */
export function formatLondonTime(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms)).replace(" at ", ", ");
}

/* 30 -> "30 min", 120 -> "2 h", 90 -> "1 h 30 min". */
export function formatStay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function clean(value: string): string {
  return redactCardNumbers(value).replace(/\s+/g, " ").trim();
}

function plateLine(plate: string | null): string {
  return plate ? plate : "plate missing";
}

function jobLines(input: JobNoticeInput): string[] {
  return [
    `Type: ${input.chargeType}`,
    `Plate: ${plateLine(input.plate)}`,
    `Date: ${clean(input.occurredOn)}`,
    `Zone: ${clean(input.zone)}`,
    ...(input.locationCode ? [`Location code: ${clean(input.locationCode)}`] : []),
    // Only when the operator payment needs it: an hourly price was worked out from it.
    ...(input.durationMinutes ? [`Parking time: ${formatStay(input.durationMinutes)}`] : []),
    ...(input.tariffBand ? [`Band to buy: ${clean(input.tariffBand)}`] : []),
    ...(input.extendsPaymentId ? [`Adds time to: ${input.extendsPaymentId}`] : []),
    ...(input.stayEndsAtMs ? [`Paid until: ${formatLondonTime(input.stayEndsAtMs)}`] : []),
    // The deadline is midnight at the end of the last day; 23:59 reads as that day.
    ...(input.deadlineAtMs ? [`Pay by: ${formatLondonTime(input.deadlineAtMs - 60_000)}`] : []),
    `Authority amount: ${formatPence(input.authorityPence)}`,
    `Driver paid: ${formatPence(input.driverAmountPence)} (includes ${feeParts(input)})`,
    `Pay: ${input.paymentUrl}`,
    `Payment: ${input.paymentIntentId}`,
  ];
}

function email(id: string, event: string, input: JobNoticeInput, subject: string, text: string): Notice {
  return {
    id,
    channel: "email",
    event,
    subject,
    text: redactCardNumbers(text),
    paymentIntentId: input.paymentIntentId,
    uid: input.uid,
  };
}

function slack(id: string, event: string, input: JobNoticeInput | undefined, text: string): Notice {
  return {
    id,
    channel: "slack",
    event,
    text: redactCardNumbers(text),
    ...(input ? {paymentIntentId: input.paymentIntentId, uid: input.uid} : {}),
  };
}

export function paidNotice(input: JobNoticeInput): Notice {
  return email(
    `${input.paymentIntentId}:paid`,
    "paid",
    input,
    "Your Ferro Maps payment",
    [
      "We've taken your Ferro Maps payment.",
      "",
      ...jobLines(input),
      "",
      "We'll email you again when the authority payment is done, or if we refund you.",
    ].join("\n"),
  );
}

export function jobOpenedNotice(input: JobNoticeInput): Notice {
  return slack(
    `${input.paymentIntentId}:job`,
    "job",
    input,
    ["New Ferro payment to make", "", ...jobLines(input), `Desk: ${ADMIN_PAYMENTS_URL}`].join("\n"),
  );
}

export function fulfilledNotice(input: JobNoticeInput): Notice {
  const reference = input.authorityReference ? clean(input.authorityReference) : "recorded";
  return email(
    `${input.paymentIntentId}:fulfilled`,
    "fulfilled",
    input,
    "Your Ferro Maps payment is complete",
    [
      "The authority payment is done.",
      "",
      ...jobLines(input),
      `Authority reference: ${reference}`,
    ].join("\n"),
  );
}

/* "1.60 GBP Ferro fee and 0.05 GBP Stripe charge", or the Ferro fee alone for an older payment. */
function feeParts(input: JobNoticeInput): string {
  const stripe = input.stripeChargePence ?? 0;
  if (!hasStripeCharge(input)) return `${formatPence(input.feePence)} Ferro fee`;
  return `${formatPence(input.feePence - stripe)} Ferro fee and ${formatPence(stripe)} Stripe charge`;
}

function hasStripeCharge(input: JobNoticeInput): boolean {
  return (input.stripeChargePence ?? 0) > 0;
}

/* "Ferro fee and Stripe charge", or "Ferro fee" for an older payment. */
function feeNames(input: JobNoticeInput): string {
  return hasStripeCharge(input) ? "Ferro fee and Stripe charge" : "Ferro fee";
}

export function refundedNotice(input: JobNoticeInput, partial: boolean): Notice {
  const event = partial ? "partial_refund" : "refunded";
  const amount = formatPence(input.refundedPence ?? input.driverAmountPence);
  return email(
    `${input.paymentIntentId}:${event}`,
    event,
    input,
    partial ? "Part of your Ferro Maps payment was refunded" : "Your Ferro Maps payment was refunded",
    [
      partial ?
        `We've refunded ${amount}. The ${feeNames(input)} ${hasStripeCharge(input) ? "stay" : "stays"} ` +
          "on the amount the authority actually charged." :
        `We've refunded ${amount}, including the ${feeNames(input)}.`,
      "",
      ...jobLines(input),
    ].join("\n"),
  );
}

/* One reminder for an open desk job close to the authority's deadline. */
export function deadlineSoonNotice(input: JobNoticeInput, missed: boolean): Notice {
  return slack(
    `${input.paymentIntentId}:deadline`,
    "deadline",
    input,
    [
      missed ?
        "This payment's deadline has passed and it isn't marked paid. Pay it now or mark it, and check for a penalty." :
        "This payment is due within 6 hours. Pay it before the deadline, or the driver gets a penalty.",
      "",
      ...jobLines(input),
      `Desk: ${ADMIN_PAYMENTS_URL}`,
    ].join("\n"),
  );
}

export function failureSlack(input: JobNoticeInput, reason: string): Notice {
  return slack(
    `${input.paymentIntentId}:failure`,
    "failure",
    input,
    [
      `Authority payment ${reason}. The driver is being refunded.`,
      "",
      ...jobLines(input),
      `Desk: ${ADMIN_PAYMENTS_URL}`,
    ].join("\n"),
  );
}

export function fundingNotice(id: string, event: string, text: string): Notice {
  return {id, channel: "slack", event, text: redactCardNumbers(text)};
}

// Sibling of the driver email. Null when the payment doc has no known charge
// type or no real amount: the email still goes out, and no push is invented.
export function paymentPushNotice(facts: {
  paymentIntentId: string;
  uid: unknown;
  chargeType: unknown;
  amountPence: unknown;
  placeId: unknown;
  event: PaymentPushEvent;
}): Notice | null {
  const copy = paymentPushCopy(facts.event, facts.chargeType, facts.amountPence);
  if (!copy || !isPaymentIntentId(facts.paymentIntentId)) return null;
  if (!isSafeId(facts.uid)) return null;
  const placeId = isSafeId(facts.placeId) ? facts.placeId : undefined;
  return {
    id: `${facts.paymentIntentId}:${facts.event}:push`,
    channel: "push",
    event: facts.event,
    subject: redactCardNumbers(copy.title),
    text: redactCardNumbers(copy.body),
    paymentIntentId: facts.paymentIntentId,
    uid: facts.uid,
    payloadStatus: payloadStatusFor(facts.event),
    ...(placeId ? {placeId} : {}),
  };
}

export interface StagedNotice {
  notice: Notice;
  ref: DocumentReference;
  exists: boolean;
}

export async function readNotices(
  tx: Transaction,
  db: Firestore,
  notices: Notice[],
): Promise<StagedNotice[]> {
  const rows: StagedNotice[] = [];
  for (const notice of notices) {
    const ref = db.collection(PAYMENT_NOTIFICATIONS).doc(notice.id);
    const snap = await tx.get(ref);
    rows.push({notice, ref, exists: snap.exists});
  }
  return rows;
}

export function writeMissingNotices(tx: Transaction, rows: StagedNotice[]): void {
  for (const row of rows) {
    if (row.exists) continue;
    tx.set(row.ref, {
      channel: row.notice.channel,
      event: row.notice.event,
      text: row.notice.text,
      ...(row.notice.subject ? {subject: row.notice.subject} : {}),
      ...(row.notice.paymentIntentId ? {paymentIntentId: row.notice.paymentIntentId} : {}),
      ...(row.notice.uid ? {uid: row.notice.uid} : {}),
      ...(row.notice.placeId ? {placeId: row.notice.placeId} : {}),
      ...(row.notice.payloadStatus ? {payloadStatus: row.notice.payloadStatus} : {}),
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });
  }
}

export interface NoticeDelivery {
  sendEmail: (input: {to: string[]; subject: string; text: string; html: string}) => Promise<void>;
  postSlack: (text: string) => Promise<void>;
  emailForUid: (uid: string) => Promise<string | null>;
  sendPush?: (message: Message) => Promise<void>;
  tokenForUid?: (uid: string) => Promise<unknown>;
  clearToken?: (uid: string) => Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function htmlFromText(text: string): string {
  const body = escapeHtml(text).replace(/\n/g, "<br>");
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">${body}</div>`;
}

// Sends once. A retry that finds `sent` or `sending` returns. A failed send
// puts the doc back to pending and throws so the trigger can retry.
export async function deliverNotification(
  db: Firestore,
  id: string,
  deps: NoticeDelivery,
): Promise<void> {
  const ref = db.collection(PAYMENT_NOTIFICATIONS).doc(id);
  const head = await ref.get();
  if (head.exists && head.get("channel") === "push") {
    await deliverPush(db, ref, deps);
    return;
  }
  const won = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const status = snap.get("status");
    if (status === "sent" || status === "sending") return false;
    tx.update(ref, {status: "sending", sendingAt: FieldValue.serverTimestamp()});
    return true;
  });
  if (!won) return;
  const snap = await ref.get();
  try {
    const channel = snap.get("channel");
    const text = typeof snap.get("text") === "string" ? snap.get("text") as string : "";
    if (channel === "slack") {
      await deps.postSlack(text);
    } else if (channel === "email") {
      const uid = snap.get("uid");
      const driver = typeof uid === "string" ? await deps.emailForUid(uid) : null;
      const to = [...new Set([driver, PAYMENTS_EMAIL].filter((item): item is string => !!item))];
      const subject = typeof snap.get("subject") === "string" ? snap.get("subject") as string : "Ferro Maps payment";
      await deps.sendEmail({to, subject, text, html: htmlFromText(text)});
      if (!driver) await ref.set({driverEmailMissing: true}, {merge: true});
    } else {
      throw new Error("unknown notification channel");
    }
    await ref.update({status: "sent", sentAt: FieldValue.serverTimestamp()});
  } catch (err) {
    await ref.set({
      status: "pending",
      lastError: err instanceof Error ? err.name : "unknown",
    }, {merge: true});
    throw err;
  }
}

type PushSkip = "missing-token" | "invalid-token" | "unregistered" | "invalid-notice";

// One push per outbox doc. A retry that finds `sent`, `sending`, or `pushSent`
// does not send again. A missing or unusable token is a skip, not a failure.
// A token FCM rejects as dead is deleted and the push is not retried.
async function deliverPush(
  db: Firestore,
  ref: DocumentReference,
  deps: NoticeDelivery,
): Promise<void> {
  if (!deps.sendPush || !deps.tokenForUid || !deps.clearToken) {
    throw new Error("push delivery is not configured");
  }
  const sendPush = deps.sendPush;
  const tokenForUid = deps.tokenForUid;
  const clearToken = deps.clearToken;
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "stop" as const;
    if (snap.get("pushSent") === true) return "finish" as const;
    if (snap.get("status") === "sent" || snap.get("status") === "sending") return "stop" as const;
    tx.update(ref, {status: "sending", sendingAt: FieldValue.serverTimestamp()});
    return "claimed" as const;
  });
  if (claimed === "finish") {
    await finishSentPush(db, ref);
    return;
  }
  if (claimed === "stop") return;
  const snap = await ref.get();
  try {
    const plan = planParkingPush({
      subject: snap.get("subject"),
      text: snap.get("text"),
      payloadStatus: snap.get("payloadStatus"),
      paymentIntentId: snap.get("paymentIntentId"),
      placeId: snap.get("placeId"),
      uid: snap.get("uid"),
    });
    if (!plan) {
      await markPushSkipped(ref, "invalid-notice");
      return;
    }
    const token = classifyFcmToken(await tokenForUid(plan.uid));
    if (!token.ok) {
      logger.info("parking payment push skipped", {paymentIntentId: plan.paymentId, reason: token.reason});
      await markPushSkipped(ref, token.reason);
      return;
    }
    try {
      await sendPush(parkingPaymentPushMessage({
        token: token.token,
        title: plan.title,
        body: plan.body,
        paymentId: plan.paymentId,
        status: plan.status,
        placeId: plan.placeId,
      }));
    } catch (err) {
      if (!isDeadFcmTokenError(err)) throw err;
      try {
        await clearToken(plan.uid);
      } catch (clearErr) {
        logger.warn("could not clear dead fcm token", {
          paymentIntentId: plan.paymentId,
          name: clearErr instanceof Error ? clearErr.name : "unknown",
        });
      }
      logger.info("parking payment push skipped", {paymentIntentId: plan.paymentId, reason: "unregistered"});
      await markPushSkipped(ref, "unregistered");
      return;
    }
    await ref.update({pushSent: true});
    await finishSentPush(db, ref);
    logger.info("parking payment push sent", {paymentIntentId: plan.paymentId, status: plan.status});
  } catch (err) {
    const latest = await ref.get();
    if (latest.get("pushSent") === true) {
      await finishSentPush(db, ref);
      return;
    }
    await ref.set({
      status: "pending",
      lastError: err instanceof Error ? err.name : "unknown",
    }, {merge: true});
    throw err;
  }
}

async function finishSentPush(db: Firestore, ref: DocumentReference): Promise<void> {
  const snap = await ref.get();
  const plan = planParkingPush({
    subject: snap.get("subject"),
    text: snap.get("text"),
    payloadStatus: snap.get("payloadStatus"),
    paymentIntentId: snap.get("paymentIntentId"),
    placeId: snap.get("placeId"),
    uid: snap.get("uid"),
  });
  if (plan) {
    try {
      await recordNotifiedCopy(db, plan.paymentId, plan.title, plan.body);
    } catch (err) {
      logger.warn("could not store parking push copy", {
        paymentIntentId: plan.paymentId,
        name: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  if (snap.get("status") !== "sent") {
    await ref.update({status: "sent", sentAt: FieldValue.serverTimestamp()});
  }
}

async function markPushSkipped(ref: DocumentReference, reason: PushSkip): Promise<void> {
  await ref.update({
    status: "sent",
    sentAt: FieldValue.serverTimestamp(),
    pushSkipped: reason,
  });
}

async function recordNotifiedCopy(
  db: Firestore,
  paymentIntentId: string,
  title: string,
  body: string,
): Promise<void> {
  const payRef = db.collection(PAYMENTS).doc(paymentIntentId);
  const pay = await payRef.get();
  if (!pay.exists) return;
  await payRef.update({
    notifiedTitle: title,
    notifiedBody: body,
    updatedAt: FieldValue.serverTimestamp(),
  });
}
