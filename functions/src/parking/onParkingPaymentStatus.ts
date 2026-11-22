import * as logger from "firebase-functions/logger";
import {defineSecret} from "firebase-functions/params";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {DocumentData, FieldValue, Firestore, getFirestore} from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import {redactCardNumbers} from "./cardGuard";
import {isPaymentIntentId, isSafeId, PLACES} from "./contract";

// One trigger for every writer that changes parkingPayments status: the Stripe
// webhook, the five-minute reconcile, the confirm request, and the refund
// script. Each of those writes the status on this document. This function
// does not call Stripe and does not depend on which writer ran.
//
// Slack and email failures are logged and swallowed. A thrown error here
// would retry the trigger; the marker below is what stops a second send.

export const slackPaymentsWebhookUrl = defineSecret("SLACK_PAYMENTS_WEBHOOK_URL");
export const paymentsSmtpUrl = defineSecret("PAYMENTS_SMTP_URL");

export const STATUS_NOTIFICATIONS = "notifications";
export const DEFAULT_PAYMENTS_EMAIL = "pay@ferromaps.com";
export const NOTIFY_STATUSES = ["paid", "failed", "canceled", "refunded"] as const;
export type NotifyStatus = typeof NOTIFY_STATUSES[number];

export const SLACK_TIMEOUT_MS = 5000;
export const SMTP_TIMEOUT_MS = 5000;

const FLAGS = "config/flags";
const NOTIFICATIONS_CONFIG = "config/notifications";

export interface PaymentEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface PaymentNotifyIo {
  postSlack(url: string, text: string): Promise<void>;
  sendEmail(smtpUrl: string, message: PaymentEmail): Promise<void>;
}

export interface SecretReaders {
  slackWebhook(): string;
  smtpUrl(): string;
}

interface MailTransport {
  sendMail(message: PaymentEmail): Promise<unknown>;
  close(): void;
}

type CreateMailTransport = (settings: SMTPTransport.Options) => MailTransport;

export function changedNotifyStatus(beforeStatus: unknown, afterStatus: unknown): NotifyStatus | null {
  if (typeof afterStatus !== "string") return null;
  if (beforeStatus === afterStatus) return null;
  if (!(NOTIFY_STATUSES as readonly string[]).includes(afterStatus)) return null;
  return afterStatus as NotifyStatus;
}

export function statusNotificationId(paymentIntentId: string, status: string): string {
  return `${paymentIntentId}_${status}`;
}

export function readSecret(read: () => string): string | null {
  try {
    const value = read();
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function formatPaymentAmount(amount: unknown, currency: unknown): string {
  const code = typeof currency === "string" && /^[a-z]{3}$/i.test(currency) ?
    currency.toUpperCase() :
    "UNKNOWN";
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    return `unknown ${code}`;
  }
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${major}.${minor} ${code}`;
}

// Test-mode dashboard unless the payment document says livemode is exactly true.
export function stripeDashboardPaymentUrl(paymentIntentId: string, livemode: unknown): string {
  const prefix = livemode === true ? "" : "test/";
  return `https://dashboard.stripe.com/${prefix}payments/${paymentIntentId}`;
}

export function londonTime(when: Date): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(when);
  return `${formatted} (Europe/London)`;
}

export function buildPaymentStatusMessage(input: {
  status: NotifyStatus;
  amount: unknown;
  currency: unknown;
  place: string;
  paymentIntentId: string;
  livemode: unknown;
  when: Date;
}): {subject: string; text: string} {
  const text = [
    `Status: ${input.status}`,
    `Amount: ${formatPaymentAmount(input.amount, input.currency)}`,
    `Place: ${input.place}`,
    `Payment: ${input.paymentIntentId}`,
    `Stripe: ${stripeDashboardPaymentUrl(input.paymentIntentId, input.livemode)}`,
    `Time: ${londonTime(input.when)}`,
  ].join("\n");
  return {
    subject: `Parking payment ${input.status}`,
    text,
  };
}

function publicPlaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = redactCardNumbers(value).replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > 80) return null;
  if (cleaned.includes("@")) return null;
  return cleaned;
}

async function placeLabel(db: Firestore, placeId: unknown): Promise<string> {
  if (!isSafeId(placeId)) return "unknown place";
  try {
    const snap = await db.collection(PLACES).doc(placeId).get();
    const name = publicPlaceName(snap.get("name"));
    if (name) return name;
  } catch (err) {
    logger.warn("place name lookup failed", {
      placeId,
      name: err instanceof Error ? err.name : "unknown",
    });
  }
  return placeId;
}

function inboxAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

async function paymentsInbox(db: Firestore): Promise<string> {
  try {
    const snap = await db.doc(NOTIFICATIONS_CONFIG).get();
    const parsed = inboxAddress(snap.get("paymentsEmail"));
    if (parsed) return parsed;
  } catch (err) {
    logger.warn("payments email config unreadable", {
      name: err instanceof Error ? err.name : "unknown",
    });
  }
  return DEFAULT_PAYMENTS_EMAIL;
}

async function notifyFlags(db: Firestore): Promise<{slack: boolean; email: boolean}> {
  const snap = await db.doc(FLAGS).get();
  return {
    slack: snap.get("paymentSlackNotify") === true,
    email: snap.get("paymentEmailNotify") === true,
  };
}

// Returns true only for the invocation that created the marker. A retry or a
// second write of the same status finds the document and sends nothing.
export async function claimStatusNotification(
  db: Firestore,
  paymentIntentId: string,
  status: NotifyStatus,
): Promise<boolean> {
  const ref = db.collection(STATUS_NOTIFICATIONS).doc(statusNotificationId(paymentIntentId, status));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.create(ref, {
      paymentIntentId,
      status,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

export function smtpSettings(smtpUrl: string): SMTPTransport.Options {
  let url: URL;
  try {
    url = new URL(smtpUrl);
  } catch {
    throw new Error("smtp url is not usable");
  }
  const secure = url.protocol === "smtps:";
  if (!secure && url.protocol !== "smtp:") {
    throw new Error("smtp url is not usable");
  }
  if (!url.hostname) {
    throw new Error("smtp url is not usable");
  }
  let port = secure ? 465 : 587;
  if (url.port) {
    const parsed = Number(url.port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error("smtp url is not usable");
    }
    port = parsed;
  }
  let user = "";
  let pass = "";
  try {
    user = decodeURIComponent(url.username);
    pass = decodeURIComponent(url.password);
  } catch {
    throw new Error("smtp url is not usable");
  }
  return {
    host: url.hostname,
    port,
    secure,
    requireTLS: !secure,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    ...(user ? {auth: {user, pass}} : {}),
  };
}

function defaultCreateTransport(settings: SMTPTransport.Options): MailTransport {
  const transport = nodemailer.createTransport(settings);
  return {
    sendMail: (message) => transport.sendMail(message),
    close: () => transport.close(),
  };
}

export async function sendPaymentsEmail(
  smtpUrl: string,
  message: PaymentEmail,
  createTransport: CreateMailTransport = defaultCreateTransport,
): Promise<void> {
  const transport = createTransport(smtpSettings(smtpUrl));
  try {
    await transport.sendMail(message);
  } finally {
    transport.close();
  }
}

export async function postSlackWebhook(
  url: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = SLACK_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({text}),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("slack webhook failed");
    }
  } finally {
    clearTimeout(timer);
  }
}

export function defaultPaymentNotifyIo(): PaymentNotifyIo {
  return {
    postSlack: (url, text) => postSlackWebhook(url, text),
    sendEmail: (smtpUrl, message) => sendPaymentsEmail(smtpUrl, message),
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

export async function notifyParkingPaymentStatus(
  db: Firestore,
  paymentIntentId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  now: Date,
  secrets: SecretReaders,
  io: PaymentNotifyIo = defaultPaymentNotifyIo(),
): Promise<void> {
  const status = changedNotifyStatus(before?.status, after?.status);
  if (!status || !after) return;
  if (!isPaymentIntentId(paymentIntentId)) {
    logger.warn("parking payment status notify skipped");
    return;
  }
  const flags = await notifyFlags(db);
  if (!flags.slack && !flags.email) return;

  const slackUrl = flags.slack ? readSecret(secrets.slackWebhook) : null;
  const smtpUrl = flags.email ? readSecret(secrets.smtpUrl) : null;
  if (flags.slack && !slackUrl) {
    logger.info("SLACK_PAYMENTS_WEBHOOK_URL is missing; skipping Slack");
  }
  if (flags.email && !smtpUrl) {
    logger.info("PAYMENTS_SMTP_URL is missing; skipping email");
  }
  // A channel with no secret is skipped. Claim only when at least one channel
  // can send, and claim before that send, so a retry cannot deliver it twice.
  if (!slackUrl && !smtpUrl) return;

  const claimed = await claimStatusNotification(db, paymentIntentId, status);
  if (!claimed) return;

  const built = buildPaymentStatusMessage({
    status,
    amount: after.amount,
    currency: after.currency,
    place: await placeLabel(db, after.placeId),
    paymentIntentId,
    livemode: after.livemode,
    when: now,
  });

  if (slackUrl) {
    try {
      await io.postSlack(slackUrl, built.text);
    } catch (err) {
      logger.error("parking payment slack notify failed", {
        paymentIntentId,
        paymentStatus: status,
        name: errorName(err),
      });
    }
  }
  if (smtpUrl) {
    try {
      const to = await paymentsInbox(db);
      await io.sendEmail(smtpUrl, {
        from: to,
        to,
        subject: built.subject,
        text: built.text,
      });
    } catch (err) {
      logger.error("parking payment email notify failed", {
        paymentIntentId,
        paymentStatus: status,
        name: errorName(err),
      });
    }
  }
}

// europe-west2. Deploy this name only. Both secrets have to exist before that
// deploy; this file does not create them. A missing value skips that channel.
export const onParkingPaymentStatus = onDocumentWritten(
  {
    document: "parkingPayments/{pi}",
    region: "europe-west2",
    secrets: [slackPaymentsWebhookUrl, paymentsSmtpUrl],
    retry: true,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() : undefined;
    const after = event.data?.after.exists ? event.data.after.data() : undefined;
    const parsed = event.time ? new Date(event.time) : new Date();
    const when = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    await notifyParkingPaymentStatus(getFirestore(), event.params.pi, before, after, when, {
      slackWebhook: () => slackPaymentsWebhookUrl.value(),
      smtpUrl: () => paymentsSmtpUrl.value(),
    });
  },
);
