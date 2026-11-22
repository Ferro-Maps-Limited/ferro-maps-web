/**
 * Lists trial parking payments and, only with --execute, refunds them.
 *
 * Dry-run is the default. A refund needs --execute, --project, and either
 * --payment-intent (repeatable) or both --from and --to (UTC dates, inclusive).
 * Already-refunded payments are skipped. The log file records the previous
 * status so the Firestore write can be undone by hand. The Stripe refund cannot.
 *
 * This file does not run on import. Tests call the exported functions with a
 * mocked Stripe client. Do not point it at a live project from CI.
 */
import {writeFile} from "node:fs/promises";
import {FieldValue, Firestore, Timestamp} from "firebase-admin/firestore";
import {isPaymentIntentId, refundIdempotencyKey} from "../src/parking/contract";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REFUNDED = new Set(["refunded", "partially_refunded", "refund_pending"]);

export interface RefundArgs {
  execute: boolean;
  project: string;
  paymentIntentIds: string[];
  from: string | null;
  to: string | null;
  logPath: string;
}

export interface TrialIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  amountRefunded: number;
}

export interface TrialStripe {
  retrievePaymentIntent(id: string): Promise<TrialIntent>;
  refundPaymentIntent(id: string, idempotencyKey: string): Promise<{id: string}>;
}

export interface RefundLogItem {
  paymentIntentId: string;
  previousStatus: string | null;
  stripeStatus: string | null;
  amount: number | null;
  amountRefunded: number | null;
  action: "would-refund" | "refunded" | "skipped";
  reason: string | null;
  refundId: string | null;
}

export interface RefundLog {
  project: string;
  execute: boolean;
  at: string;
  note: string;
  items: RefundLogItem[];
}

interface PaymentRow {
  id: string;
  status: string | null;
}

export function parseRefundArgs(argv: string[]): RefundArgs {
  let execute = false;
  let project = "";
  const paymentIntentIds: string[] = [];
  let from: string | null = null;
  let to: string | null = null;
  let logPath = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      i += 1;
      return value;
    };
    if (arg === "--execute") execute = true;
    else if (arg === "--project") project = next();
    else if (arg === "--payment-intent") paymentIntentIds.push(next());
    else if (arg === "--from") from = next();
    else if (arg === "--to") to = next();
    else if (arg === "--log") logPath = next();
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (!project) {
    throw new Error("Pass --project. This script will not guess a Firebase project.");
  }
  const hasIds = paymentIntentIds.length > 0;
  const hasRange = from !== null || to !== null;
  if (hasIds && hasRange) {
    throw new Error("Pass payment intent ids or a date range, not both.");
  }
  if (!hasIds && (!from || !to)) {
    throw new Error("Pass --payment-intent, or both --from and --to.");
  }
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) {
    throw new Error("Dates must be YYYY-MM-DD.");
  }
  for (const id of paymentIntentIds) {
    if (!isPaymentIntentId(id)) throw new Error(`Not a PaymentIntent id: ${id}.`);
  }
  return {
    execute,
    project,
    paymentIntentIds,
    from,
    to,
    logPath: logPath || `refund-trial-${project}.json`,
  };
}

function alreadyRefunded(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return (err as {code?: unknown}).code === "charge_already_refunded";
}

async function selectedPayments(db: Firestore, args: RefundArgs): Promise<PaymentRow[]> {
  if (args.paymentIntentIds.length > 0) {
    const rows: PaymentRow[] = [];
    for (const id of args.paymentIntentIds) {
      const snap = await db.collection("parkingPayments").doc(id).get();
      rows.push({id, status: snap.exists ? text(snap.get("status")) : null});
    }
    return rows;
  }
  if (!args.from || !args.to) throw new Error("Pass --from and --to.");
  const start = Timestamp.fromDate(new Date(`${args.from}T00:00:00.000Z`));
  const until = Timestamp.fromDate(new Date(new Date(`${args.to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000));
  const snap = await db.collection("parkingPayments")
    .where("createdAt", ">=", start)
    .where("createdAt", "<", until)
    .get();
  return snap.docs.map((doc) => ({id: doc.id, status: text(doc.get("status"))}));
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function runRefundTrial(
  db: Firestore,
  stripe: TrialStripe,
  args: RefundArgs,
  now = new Date(),
): Promise<RefundLog> {
  const rows = await selectedPayments(db, args);
  const items: RefundLogItem[] = [];
  for (const row of rows) {
    items.push(await refundOne(db, stripe, args.execute, row));
  }
  return {
    project: args.project,
    execute: args.execute,
    at: now.toISOString(),
    note: "To undo the Firestore write, set parkingPayments/{id}.status back to previousStatus. A Stripe refund cannot be undone.",
    items,
  };
}

async function refundOne(
  db: Firestore,
  stripe: TrialStripe,
  execute: boolean,
  row: PaymentRow,
): Promise<RefundLogItem> {
  const item: RefundLogItem = {
    paymentIntentId: row.id,
    previousStatus: row.status,
    stripeStatus: null,
    amount: null,
    amountRefunded: null,
    action: "skipped",
    reason: null,
    refundId: null,
  };
  if (row.status === null) {
    item.reason = "No parkingPayments document.";
    try {
      const intent = await stripe.retrievePaymentIntent(row.id);
      item.stripeStatus = intent.status;
      item.amount = intent.amount;
      item.amountRefunded = intent.amountRefunded;
    } catch {
      return item;
    }
    return item;
  }
  let intent: TrialIntent;
  try {
    intent = await stripe.retrievePaymentIntent(row.id);
  } catch (err) {
    item.reason = err instanceof Error ? err.name : "Stripe retrieve failed.";
    return item;
  }
  item.stripeStatus = intent.status;
  item.amount = intent.amount;
  item.amountRefunded = intent.amountRefunded;
  const stripeRefunded = intent.amountRefunded > 0;
  const docRefunded = REFUNDED.has(row.status);
  if (docRefunded || stripeRefunded) {
    item.action = "skipped";
    item.reason = "Already refunded.";
    if (execute && !docRefunded) await markRefunded(db, row.id);
    return item;
  }
  if (row.status !== "paid") {
    item.reason = "Only a paid payment can be refunded.";
    return item;
  }
  if (!execute) {
    item.action = "would-refund";
    return item;
  }
  try {
    const refund = await stripe.refundPaymentIntent(row.id, refundIdempotencyKey(row.id));
    item.refundId = refund.id;
  } catch (err) {
    if (!alreadyRefunded(err)) throw err;
    item.reason = "Already refunded.";
    await markRefunded(db, row.id);
    return item;
  }
  await markRefunded(db, row.id);
  item.action = "refunded";
  return item;
}

async function markRefunded(db: Firestore, paymentIntentId: string): Promise<void> {
  await db.collection("parkingPayments").doc(paymentIntentId).set({
    status: "refunded",
    failureReason: "The payment was refunded.",
    updatedAt: FieldValue.serverTimestamp(),
  }, {merge: true});
}

export async function writeRefundLog(logPath: string, log: RefundLog): Promise<void> {
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}

function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("refundTrialPayments.ts") || entry.endsWith("refundTrialPayments.js");
}

export async function main(argv: string[]): Promise<void> {
  const args = parseRefundArgs(argv);
  const {initializeApp} = await import("firebase-admin/app");
  const {getFirestore} = await import("firebase-admin/firestore");
  const {default: Stripe} = await import("stripe");
  initializeApp({projectId: args.project});
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not set. Refusing to call Stripe.");
  const stripe = new Stripe(secret, {typescript: true});
  const adapter: TrialStripe = {
    async retrievePaymentIntent(id) {
      const pi = await stripe.paymentIntents.retrieve(id, {expand: ["latest_charge"]});
      const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : null;
      const amountRefunded = charge && "amount_refunded" in charge ? Number(charge.amount_refunded) : 0;
      return {
        id: pi.id,
        status: pi.status,
        amount: pi.amount,
        currency: pi.currency,
        amountRefunded,
      };
    },
    async refundPaymentIntent(id, idempotencyKey) {
      const refund = await stripe.refunds.create({payment_intent: id}, {idempotencyKey});
      return {id: refund.id};
    },
  };
  const log = await runRefundTrial(getFirestore(), adapter, args);
  await writeRefundLog(args.logPath, log);
  const refunded = log.items.filter((item) => item.action === "refunded").length;
  const preview = log.items.filter((item) => item.action === "would-refund").length;
  console.log(`${args.execute ? "Refunded" : "Would refund"} ${args.execute ? refunded : preview} of ${log.items.length}. Log: ${args.logPath}`);
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Refund script failed.";
    console.error(message);
    process.exitCode = 1;
  });
}
