import * as logger from "firebase-functions/logger";
import {defineSecret} from "firebase-functions/params";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {DocumentData, FieldValue, Firestore, getFirestore} from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import {redactCardNumbers} from "./cardGuard";
import {
  isPaymentIntentId,
  isSafeId,
  normalizePlate,
  OPERATOR_FORWARDS,
  PAYMENT_NOTIFICATIONS,
  PLACES,
  REQUESTS,
} from "./contract";

// One trigger for every writer that changes parkingPayments status: the Stripe
// webhook, the five-minute reconcile, the confirm request, and the refund
// script. Each of those writes the status on this document. This function
// does not call Stripe and does not depend on which writer ran.
//
// Slack and email failures are logged and swallowed. The marker records which
// channel succeeded. A retry sends a channel again only when that channel
// failed or was not tried. A channel already marked successful is not sent again.

export const slackPaymentsWebhookUrl = defineSecret("SLACK_PAYMENTS_WEBHOOK_URL");
export const paymentsSmtpUrl = defineSecret("PAYMENTS_SMTP_URL");

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

export interface OperatorAlertDetails {
  carParkName?: string;
  address?: string;
  operator?: string;
  siteCode?: string;
  plate?: string;
  durationMinutes?: number;
  start?: Date;
  driverPaid?: string;
  phone?: string;
}

export function buildPaymentStatusMessage(input: {
  status: NotifyStatus;
  amount: unknown;
  currency: unknown;
  place: string;
  paymentIntentId: string;
  livemode: unknown;
  when: Date;
  details?: OperatorAlertDetails | null;
}): {subject: string; text: string} {
  const lines = [
    `Status: ${input.status}`,
    `Amount: ${formatPaymentAmount(input.amount, input.currency)}`,
    `Place: ${input.place}`,
    `Payment: ${input.paymentIntentId}`,
    `Stripe: ${stripeDashboardPaymentUrl(input.paymentIntentId, input.livemode)}`,
    `Time: ${londonTime(input.when)}`,
  ];
  const extra = input.details ? operatorDetailLines(input.details) : [];
  return {
    subject: `Parking payment ${input.status}`,
    text: [...lines, ...extra].join("\n"),
  };
}

function operatorDetailLines(details: OperatorAlertDetails): string[] {
  const lines: string[] = [];
  if (details.carParkName) lines.push(`Car park: ${details.carParkName}`);
  if (details.address) lines.push(`Address: ${details.address}`);
  if (details.operator) lines.push(`Operator: ${details.operator}`);
  if (details.siteCode) lines.push(`Site code: ${details.siteCode}`);
  if (details.plate) lines.push(`Plate: ${details.plate}`);
  if (typeof details.durationMinutes === "number") {
    lines.push(`Stay: ${details.durationMinutes} minutes`);
  }
  if (details.start) lines.push(`Paid at: ${londonTime(details.start)}`);
  if (details.driverPaid) lines.push(`Driver paid: ${details.driverPaid}`);
  if (details.phone) lines.push(`Phone: ${details.phone}`);
  return lines;
}

function publicText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = redactCardNumbers(value).replace(/\s+/g, " ").trim();
  if (cleaned.length < 1 || cleaned.length > max) return null;
  if (cleaned.includes("@")) return null;
  return cleaned;
}

function publicPlaceName(value: unknown): string | null {
  return publicText(value, 80);
}

function publicPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < 6 || cleaned.length > 32) return null;
  if (cleaned.includes("@") || /[A-Za-z]/.test(cleaned)) return null;
  if (!/^\+?[0-9][0-9 \-()]{5,30}$/.test(cleaned)) return null;
  return cleaned;
}

function siteCodeOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return publicText(value, 40);
}

function stayMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < 1 || value > 1440) return null;
  return value;
}

function timeOf(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value && typeof value === "object" && "toDate" in value) {
    const toDate = (value as {toDate?: unknown}).toDate;
    if (typeof toDate === "function") {
      const date = toDate.call(value) as unknown;
      if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

async function placeLabel(db: Firestore, placeId: unknown): Promise<string> {
  if (!isSafeId(placeId)) return "unknown place";
  try {
    const snap = await db.collection(PLACES).doc(placeId).get();
    const name = publicPlaceName(snap.get("name")) ?? publicPlaceName(snap.get("n"));
    if (name) return name;
  } catch (err) {
    logger.warn("place name lookup failed", {
      placeId,
      name: err instanceof Error ? err.name : "unknown",
    });
  }
  return placeId;
}

async function loadOperatorAlertDetails(
  db: Firestore,
  paymentIntentId: string,
  after: DocumentData,
): Promise<OperatorAlertDetails> {
  const details: OperatorAlertDetails = {};
  const paid = formatPaymentAmount(after.amount, after.currency);
  if (typeof after.amount === "number" && Number.isSafeInteger(after.amount)) {
    details.driverPaid = paid;
  }
  const minutes = stayMinutes(after.durationMinutes);
  if (minutes !== null) details.durationMinutes = minutes;
  const start = timeOf(after.createdAt);
  if (start) details.start = start;
  const operator = publicText(after.operator, 40);
  if (operator) details.operator = operator;

  if (isSafeId(after.placeId)) {
    try {
      const place = await db.collection(PLACES).doc(after.placeId).get();
      const carPark = publicPlaceName(place.get("name")) ?? publicPlaceName(place.get("n"));
      if (carPark) details.carParkName = carPark;
      const address = publicText(place.get("addr"), 200) ?? publicText(place.get("address"), 200);
      if (address) details.address = address;
      if (!details.operator) {
        const placeOperator = publicText(place.get("operator"), 40);
        if (placeOperator) details.operator = placeOperator;
      }
      const code = siteCodeOf(place.get("locationCode"));
      if (code) details.siteCode = code;
    } catch (err) {
      logger.warn("place details lookup failed", {
        name: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  try {
    const forward = await db.collection(OPERATOR_FORWARDS).doc(paymentIntentId).get();
    const plate = normalizePlate(forward.get("plate"));
    if (plate) details.plate = plate;
    if (!details.siteCode) {
      const code = siteCodeOf(forward.get("locationCode"));
      if (code) details.siteCode = code;
    }
  } catch (err) {
    logger.warn("operator forward lookup failed", {
      name: err instanceof Error ? err.name : "unknown",
    });
  }
  if (!details.plate && isSafeId(after.requestId)) {
    try {
      const request = await db.collection(REQUESTS).doc(after.requestId).get();
      const plate = normalizePlate(request.get("plate"));
      if (plate) details.plate = plate;
    } catch (err) {
      logger.warn("payment request lookup failed", {
        name: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  if (isSafeId(after.uid)) {
    try {
      const user = await db.collection("users").doc(after.uid).get();
      const phone = publicPhone(user.get("phoneNumber"));
      if (phone) details.phone = phone;
    } catch (err) {
      logger.warn("driver phone lookup failed", {
        name: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return details;
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

async function notifyFlags(db: Firestore): Promise<{slack: boolean; email: boolean; operatorDetails: boolean}> {
  const snap = await db.doc(FLAGS).get();
  return {
    slack: snap.get("paymentSlackNotify") === true,
    email: snap.get("paymentEmailNotify") === true,
    operatorDetails: snap.get("paymentAlertOperatorDetails") === true,
  };
}

function markerRef(db: Firestore, paymentIntentId: string, status: NotifyStatus) {
  return db.collection(PAYMENT_NOTIFICATIONS).doc(statusNotificationId(paymentIntentId, status));
}

function channelSucceeded(value: unknown): boolean {
  return value === true;
}

// Reserves a channel that has not succeeded and is not already being sent.
// `true` on the marker means that channel was delivered. A later call leaves
// it alone and sends only a channel that failed or was never reserved.
export async function reserveNotificationChannels(
  db: Firestore,
  paymentIntentId: string,
  status: NotifyStatus,
  wanted: {slack: boolean; email: boolean},
): Promise<{slack: boolean; email: boolean}> {
  const ref = markerRef(db, paymentIntentId, status);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const sendSlack = wanted.slack && !channelSucceeded(snap.get("slack")) && snap.get("slack") !== "sending";
    const sendEmail = wanted.email && !channelSucceeded(snap.get("email")) && snap.get("email") !== "sending";
    if (!sendSlack && !sendEmail) return {slack: false, email: false};
    tx.set(ref, {
      paymentIntentId,
      status,
      ...(snap.exists ? {} : {createdAt: FieldValue.serverTimestamp()}),
      ...(sendSlack ? {slack: "sending"} : {}),
      ...(sendEmail ? {email: "sending"} : {}),
    }, {merge: true});
    return {slack: sendSlack, email: sendEmail};
  });
}

export async function finishNotificationChannels(
  db: Firestore,
  paymentIntentId: string,
  status: NotifyStatus,
  result: {slack?: boolean; email?: boolean},
): Promise<void> {
  const ref = markerRef(db, paymentIntentId, status);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const patch: Record<string, unknown> = {
      paymentIntentId,
      status,
    };
    if (!snap.exists) patch.createdAt = FieldValue.serverTimestamp();
    if (result.slack === true) patch.slack = true;
    else if (result.slack === false && snap.get("slack") === "sending") patch.slack = FieldValue.delete();
    if (result.email === true) patch.email = true;
    else if (result.email === false && snap.get("email") === "sending") patch.email = FieldValue.delete();
    tx.set(ref, patch, {merge: true});
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
  if (!slackUrl && !smtpUrl) return;

  const reserved = await reserveNotificationChannels(db, paymentIntentId, status, {
    slack: Boolean(slackUrl),
    email: Boolean(smtpUrl),
  });
  if (!reserved.slack && !reserved.email) return;

  const details = flags.operatorDetails ?
    await loadOperatorAlertDetails(db, paymentIntentId, after) :
    null;
  const built = buildPaymentStatusMessage({
    status,
    amount: after.amount,
    currency: after.currency,
    place: await placeLabel(db, after.placeId),
    paymentIntentId,
    livemode: after.livemode,
    when: now,
    details,
  });

  let slackOk = false;
  let emailOk = false;
  if (reserved.slack && slackUrl) {
    try {
      await io.postSlack(slackUrl, built.text);
      slackOk = true;
    } catch (err) {
      logger.error("parking payment slack notify failed", {
        paymentIntentId,
        paymentStatus: status,
        name: errorName(err),
      });
    }
  }
  if (reserved.email && smtpUrl) {
    try {
      const to = await paymentsInbox(db);
      await io.sendEmail(smtpUrl, {
        from: to,
        to,
        subject: built.subject,
        text: built.text,
      });
      emailOk = true;
    } catch (err) {
      logger.error("parking payment email notify failed", {
        paymentIntentId,
        paymentStatus: status,
        name: errorName(err),
      });
    }
  }
  await finishNotificationChannels(db, paymentIntentId, status, {
    ...(reserved.slack ? {slack: slackOk} : {}),
    ...(reserved.email ? {email: emailOk} : {}),
  });
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
