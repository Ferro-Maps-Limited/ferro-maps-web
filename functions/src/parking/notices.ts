import {DocumentReference, FieldValue, Firestore, Transaction} from "firebase-admin/firestore";
import {PAYMENT_NOTIFICATIONS} from "./contract";
import {redactCardNumbers} from "./cardGuard";
import {formatPence} from "./fundingMath";

export const PAYMENTS_EMAIL = "pay@ferromaps.com";
export const PAYMENTS_FROM = "admin@ferromaps.com";
const ADMIN_PAYMENTS_URL = "https://admin.ferromaps.com/payments";

export interface Notice {
  id: string;
  channel: "email" | "slack";
  event: string;
  text: string;
  subject?: string;
  paymentIntentId?: string;
  uid?: string;
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
  feePence: number;
  paymentUrl: string;
  authorityReference?: string | null;
  refundedPence?: number;
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
    `Authority amount: ${formatPence(input.authorityPence)}`,
    `Driver paid: ${formatPence(input.driverAmountPence)} (includes ${formatPence(input.feePence)} Ferro fee)`,
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
        `We've refunded ${amount}. The Ferro fee stays on the amount the authority actually charged.` :
        `We've refunded ${amount}, including the Ferro fee.`,
      "",
      ...jobLines(input),
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
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });
  }
}

export interface NoticeDelivery {
  sendEmail: (input: {to: string[]; subject: string; text: string; html: string}) => Promise<void>;
  postSlack: (text: string) => Promise<void>;
  emailForUid: (uid: string) => Promise<string | null>;
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
