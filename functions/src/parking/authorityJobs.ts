import * as logger from "firebase-functions/logger";
import {FieldValue, Firestore, Timestamp, Transaction} from "firebase-admin/firestore";
import {londonDayKey} from "../admin/london";
import {assertNoCardData, redactCardNumbers} from "./cardGuard";
import {
  AUTHORITY_PAYMENTS,
  FUNDING_LEDGER,
  FUNDING_STATE,
  OPERATOR_FORWARDS,
  PAYMENTS,
  ParkingPaymentError,
  SERVICE_FEE_PENCE,
  httpsUrl,
  normalizePlate,
  shortText,
  type ParkingStatus,
} from "./contract";
import {
  applyLedger,
  availablePence,
  fundingAlerts,
  fundingStateFromData,
  fundingStateToData,
  withLowWater,
  withPaused,
  type FundingAlert,
  type FundingState,
  type LedgerEntry,
} from "./fundingMath";
import {mergeJobStatus, refundAfterMillis, type JobStatus} from "./jobPlan";
import {
  failureSlack,
  fulfilledNotice,
  fundingNotice,
  jobOpenedNotice,
  paidNotice,
  paymentPushNotice,
  readNotices,
  refundedNotice,
  writeMissingNotices,
  type JobNoticeInput,
  type Notice,
} from "./notices";
import type {PaymentPushEvent} from "./paymentPush";

export interface JobOutcome {
  jobOutcome: "fulfilled" | "failed" | "already_paid" | "expired";
  authorityReference?: string;
  authorityChargedPence?: number;
}

const OPERATOR_HOME: Record<string, string> = {
  RingGo: "https://www.myringgo.com/",
  PayByPhone: "https://www.paybyphone.co.uk/",
  JustPark: "https://www.justpark.com/",
};

export function operatorPaymentUrl(operator: string, explicit: unknown): string {
  const direct = httpsUrl(explicit);
  if (direct) return direct;
  return OPERATOR_HOME[operator] ?? "https://ferromaps.com/";
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function pence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function dayOf(nowMs: number): string {
  return londonDayKey(new Date(nowMs));
}

function deadlineMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function paymentPushFor(
  event: PaymentPushEvent,
  paymentIntentId: string,
  source: {get: (field: string) => unknown},
  amountPence: unknown,
): Notice | null {
  return paymentPushNotice({
    event,
    paymentIntentId,
    uid: source.get("uid"),
    chargeType: source.get("chargeType"),
    amountPence,
    placeId: source.get("placeId"),
  });
}

function noticeInput(id: string, data: Record<string, unknown>): JobNoticeInput {
  const authority = pence(data.authorityPence) ?? 0;
  const fee = pence(data.feePence) ?? SERVICE_FEE_PENCE;
  const driver = pence(data.driverAmountPence) ?? pence(data.amount) ?? authority + fee;
  return {
    paymentIntentId: id,
    uid: text(data.uid),
    plate: normalizePlate(data.plate),
    occurredOn: text(data.occurredOn, dayOf(Date.now())),
    zone: text(data.zone, "Unknown"),
    chargeType: text(data.chargeType, "parking"),
    authorityPence: authority,
    driverAmountPence: driver,
    feePence: fee,
    paymentUrl: httpsUrl(data.paymentUrl) ?? "https://ferromaps.com/",
    authorityReference: text(data.authorityReference) || null,
    durationMinutes: pence(data.durationMinutes),
    locationCode: text(data.locationCode) || null,
    extendsPaymentId: text(data.extendsPaymentId) || null,
    tariffBand: text(data.tariffBand) || null,
    stayEndsAtMs: data.stayEndsAt instanceof Timestamp ? data.stayEndsAt.toMillis() :
      (typeof data.stayEndsAtMs === "number" ? data.stayEndsAtMs : null),
  };
}

async function applyFunding(
  tx: Transaction,
  db: Firestore,
  day: string,
  before: FundingState,
  entries: LedgerEntry[],
  paused: boolean | null,
  notices: Notice[],
): Promise<void> {
  const ledgerSnaps = [];
  for (const entry of entries) {
    const ref = db.collection(FUNDING_LEDGER).doc(entry.id);
    ledgerSnaps.push({entry, ref, snap: await tx.get(ref)});
  }
  const noticeRows = await readNotices(tx, db, notices);
  let state = before;
  const applied: LedgerEntry[] = [];
  for (const row of ledgerSnaps) {
    if (row.snap.exists) continue;
    state = applyLedger(state, row.entry, day);
    applied.push(row.entry);
  }
  state = withLowWater(before, state, day);
  if (paused !== null) state = withPaused(state, paused);
  const alerts = fundingAlerts(before, state, day);
  const alertRows = await readNotices(tx, db, alerts.map((alert) => fundingNotice(alert.id, alert.kind, alert.text)));
  tx.set(db.doc(FUNDING_STATE), {
    ...fundingStateToData(state),
    updatedAt: FieldValue.serverTimestamp(),
  }, {merge: true});
  for (const row of ledgerSnaps) {
    if (row.snap.exists || !applied.includes(row.entry)) continue;
    tx.set(row.ref, {
      kind: row.entry.kind,
      amountPence: row.entry.amountPence,
      ...(row.entry.paymentIntentId ? {paymentIntentId: row.entry.paymentIntentId} : {}),
      ...(row.entry.requestId ? {requestId: row.entry.requestId} : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  writeMissingNotices(tx, noticeRows);
  writeMissingNotices(tx, alertRows);
}

function assertLedgerSafe(entries: LedgerEntry[]): void {
  assertNoCardData(entries, "ledger");
}

export async function ensureAuthorityJob(
  db: Firestore,
  paymentIntentId: string,
  nowMs = Date.now(),
): Promise<void> {
  const day = dayOf(nowMs);
  await db.runTransaction(async (tx) => {
    const payRef = db.collection(PAYMENTS).doc(paymentIntentId);
    const jobRef = db.collection(AUTHORITY_PAYMENTS).doc(paymentIntentId);
    const forwardRef = db.collection(OPERATOR_FORWARDS).doc(paymentIntentId);
    const stateRef = db.doc(FUNDING_STATE);
    const pay = await tx.get(payRef);
    const job = await tx.get(jobRef);
    const forward = await tx.get(forwardRef);
    const stateSnap = await tx.get(stateRef);
    if (!pay.exists) return;
    const status = text(pay.get("status"));
    if (job.exists) {
      tx.set(payRef, {jobPending: false, updatedAt: FieldValue.serverTimestamp()}, {merge: true});
      return;
    }
    if (status !== "paid") {
      if (status === "failed" || status === "canceled" || status === "refunded") {
        tx.set(payRef, {jobPending: false, updatedAt: FieldValue.serverTimestamp()}, {merge: true});
      }
      return;
    }
    const authorityPence = pence(pay.get("authorityPence")) ?? pence(pay.get("parkingPence"));
    const driverAmount = pence(pay.get("amount"));
    const uid = text(pay.get("uid"));
    if (authorityPence === null || driverAmount === null || !uid) {
      logger.warn("paid payment is missing an authority amount", {paymentIntentId});
      tx.set(payRef, {jobPending: false, updatedAt: FieldValue.serverTimestamp()}, {merge: true});
      return;
    }
    const feePence = pence(pay.get("feePence")) ?? SERVICE_FEE_PENCE;
    const plate = normalizePlate(forward.get("plate"));
    const chargeType = text(pay.get("chargeType"), "parking");
    const zone = redactCardNumbers(text(pay.get("zone"), text(pay.get("placeId"), "Unknown"))).slice(0, 80);
    const paymentUrl = httpsUrl(pay.get("paymentUrl")) ?? operatorPaymentUrl(text(pay.get("operator")), null);
    const occurredOn = text(pay.get("occurredOn"), day);
    const deadlineAt = pay.get("deadlineAt") instanceof Timestamp ? pay.get("deadlineAt") as Timestamp : null;
    const before = fundingStateFromData(stateSnap.data(), day);
    const canReserve = !before.paused && availablePence(before, day) >= authorityPence;
    const jobStatus: JobStatus = canReserve ? "open" : "queued";
    const refundAt = jobStatus === "queued" ?
      Timestamp.fromMillis(refundAfterMillis(nowMs, deadlineMillis(deadlineAt))) :
      null;
    const input = noticeInput(paymentIntentId, {
      uid,
      plate,
      occurredOn,
      zone,
      chargeType,
      authorityPence,
      driverAmountPence: driverAmount,
      feePence,
      paymentUrl,
      durationMinutes: pay.get("durationMinutes"),
      locationCode: pay.get("locationCode"),
      extendsPaymentId: pay.get("extendsPaymentId"),
      tariffBand: pay.get("tariffBand"),
      stayEndsAt: pay.get("stayEndsAt"),
    });
    const notices: Notice[] = [paidNotice(input)];
    const paidPush = paymentPushFor("paid", paymentIntentId, pay, pay.get("amount"));
    if (paidPush) notices.push(paidPush);
    if (jobStatus === "open") notices.push(jobOpenedNotice(input));
    const entries: LedgerEntry[] = canReserve ? [{
      id: `reserve:${paymentIntentId}`,
      kind: "reserve",
      amountPence: authorityPence,
      paymentIntentId,
    }] : [];
    assertLedgerSafe(entries);
    const jobData = {
      v: 1,
      paymentIntentId,
      uid,
      chargeType,
      plate: plate ?? null,
      plateMissing: plate === null,
      occurredOn,
      zone,
      placeId: text(pay.get("placeId")) || null,
      visitId: text(pay.get("visitId")) || null,
      operator: text(pay.get("operator")) || null,
      locationCode: text(pay.get("locationCode")) || null,
      durationMinutes: pence(pay.get("durationMinutes")),
      extendsPaymentId: text(pay.get("extendsPaymentId")) || null,
      tariffBand: text(pay.get("tariffBand")) || null,
      stayEndsAt: pay.get("stayEndsAt") instanceof Timestamp ? pay.get("stayEndsAt") : null,
      authorityPence,
      feePence,
      driverAmountPence: driverAmount,
      currency: "gbp",
      paymentUrl,
      deadlineAt,
      refundAfter: refundAt,
      status: jobStatus,
      authorityReference: null,
      authorityChargedPence: null,
      createdAt: Timestamp.fromMillis(nowMs),
      updatedAt: FieldValue.serverTimestamp(),
      ...(jobStatus === "queued" ? {queuedAt: Timestamp.fromMillis(nowMs)} : {}),
      ...(jobStatus === "open" ? {openedAt: Timestamp.fromMillis(nowMs)} : {}),
    };
    assertNoCardData(jobData, "authority job");
    await applyFunding(tx, db, day, before, entries, canReserve ? null : true, notices);
    tx.set(jobRef, jobData);
    tx.set(payRef, {
      authorityStatus: jobStatus,
      jobPending: false,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
  });
}

export async function applyJobOutcome(
  db: Firestore,
  paymentIntentId: string,
  outcome: JobOutcome,
  nowMs = Date.now(),
): Promise<void> {
  const day = dayOf(nowMs);
  await db.runTransaction(async (tx) => {
    const jobRef = db.collection(AUTHORITY_PAYMENTS).doc(paymentIntentId);
    const payRef = db.collection(PAYMENTS).doc(paymentIntentId);
    const stateRef = db.doc(FUNDING_STATE);
    const reserveRef = db.collection(FUNDING_LEDGER).doc(`reserve:${paymentIntentId}`);
    const commitRef = db.collection(FUNDING_LEDGER).doc(`commit:${paymentIntentId}`);
    const releaseRef = db.collection(FUNDING_LEDGER).doc(`release:${paymentIntentId}`);
    const job = await tx.get(jobRef);
    const pay = await tx.get(payRef);
    const stateSnap = await tx.get(stateRef);
    const reserveSnap = await tx.get(reserveRef);
    const commitSnap = await tx.get(commitRef);
    const releaseSnap = await tx.get(releaseRef);
    if (!job.exists) {
      throw new ParkingPaymentError("not-found", "We couldn't find this authority payment.");
    }
    const current = text(job.get("status"));
    if (current === outcome.jobOutcome) return;
    const next = mergeJobStatus(current, outcome.jobOutcome);
    if (next !== outcome.jobOutcome) {
      throw new ParkingPaymentError("failed-precondition", "This authority payment can't take that update.");
    }
    const authorityPence = pence(job.get("authorityPence"));
    if (authorityPence === null) {
      throw new ParkingPaymentError("internal", "This authority payment has no amount.");
    }
    const before = fundingStateFromData(stateSnap.data(), day);
    const entries: LedgerEntry[] = [];
    let charged = authorityPence;
    let refundedPence = pence(pay.get("amount")) ?? authorityPence + SERVICE_FEE_PENCE;
    let partial = false;
    if (outcome.jobOutcome === "fulfilled") {
      const reference = shortText(outcome.authorityReference, 64);
      if (!reference || assertCard(reference)) {
        throw new ParkingPaymentError("invalid-argument", "Enter the authority reference.");
      }
      charged = outcome.authorityChargedPence ?? authorityPence;
      if (!Number.isSafeInteger(charged) || charged < 1 || charged > authorityPence) {
        throw new ParkingPaymentError("invalid-argument", "The authority charge is outside the amount the driver paid.");
      }
      const reserved = reserveSnap.exists ? reserveSnap.get("amountPence") : null;
      if (typeof reserved !== "number" || reserved < charged) {
        throw new ParkingPaymentError("failed-precondition", "This job has no funding reserved.");
      }
      if (!commitSnap.exists) {
        entries.push({
          id: `commit:${paymentIntentId}`,
          kind: "commit",
          amountPence: charged,
          paymentIntentId,
        });
      }
      const diff = authorityPence - charged;
      if (diff > 0 && !releaseSnap.exists) {
        entries.push({
          id: `release:${paymentIntentId}`,
          kind: "release",
          amountPence: diff,
          paymentIntentId,
        });
        partial = true;
        refundedPence = diff;
      }
    } else if (reserveSnap.exists && !commitSnap.exists && !releaseSnap.exists) {
      const reserved = reserveSnap.get("amountPence");
      if (typeof reserved === "number" && reserved > 0) {
        entries.push({
          id: `release:${paymentIntentId}`,
          kind: "release",
          amountPence: reserved,
          paymentIntentId,
        });
      }
    }
    const data = job.data() ?? {};
    const input = noticeInput(paymentIntentId, {
      ...data,
      authorityReference: outcome.authorityReference ?? null,
      authorityChargedPence: charged,
    });
    input.refundedPence = refundedPence;
    const notices: Notice[] = [];
    if (outcome.jobOutcome === "fulfilled") {
      notices.push(fulfilledNotice({...input, authorityReference: outcome.authorityReference ?? null}));
      // `charged` is the authority amount for this job. When the desk omits one,
      // it is the payment document's authorityPence. It is not a made-up total.
      const fulfilledPush = paymentPushFor("fulfilled", paymentIntentId, pay, charged);
      if (fulfilledPush) notices.push(fulfilledPush);
      if (partial) {
        notices.push(refundedNotice(input, true));
        const partialPush = paymentPushFor("partial_refund", paymentIntentId, pay, authorityPence - charged);
        if (partialPush) notices.push(partialPush);
      }
    } else {
      notices.push(refundedNotice(input, false));
      notices.push(failureSlack(input, outcome.jobOutcome.replace(/_/g, " ")));
      const refundedPush = paymentPushFor("refunded", paymentIntentId, pay, pay.get("amount"));
      if (refundedPush) notices.push(refundedPush);
    }
    assertLedgerSafe(entries);
    await applyFunding(tx, db, day, before, entries, null, notices);
    tx.set(jobRef, {
      status: next,
      authorityReference: outcome.jobOutcome === "fulfilled" ? shortText(outcome.authorityReference, 64) : null,
      authorityChargedPence: outcome.jobOutcome === "fulfilled" ? charged : null,
      updatedAt: FieldValue.serverTimestamp(),
      closedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    tx.set(payRef, {
      authorityStatus: next,
      ...(outcome.jobOutcome === "fulfilled" ? {authorityReference: shortText(outcome.authorityReference, 64)} : {}),
      jobPending: false,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
  });
}

function assertCard(value: string): boolean {
  try {
    assertNoCardData(value, "reference");
    return false;
  } catch {
    return true;
  }
}

export async function followPaymentStatus(
  db: Firestore,
  paymentIntentId: string,
  previous: string | undefined,
  next: ParkingStatus,
  outcome?: JobOutcome,
  nowMs = Date.now(),
): Promise<void> {
  if (outcome?.jobOutcome) {
    await applyJobOutcome(db, paymentIntentId, outcome, nowMs);
    return;
  }
  if (next === "paid" && previous !== "paid") {
    await ensureAuthorityJob(db, paymentIntentId, nowMs);
    return;
  }
  if (next === "refunded" && previous !== "refunded") {
    await syncExternalRefund(db, paymentIntentId, nowMs);
  }
}

async function syncExternalRefund(db: Firestore, paymentIntentId: string, nowMs: number): Promise<void> {
  const job = await db.collection(AUTHORITY_PAYMENTS).doc(paymentIntentId).get();
  if (!job.exists) return;
  const status = text(job.get("status"));
  if (status === "queued" || status === "open") {
    await applyJobOutcome(db, paymentIntentId, {jobOutcome: "failed"}, nowMs);
    return;
  }
  const input = noticeInput(paymentIntentId, job.data() ?? {});
  const notice = refundedNotice(input, false);
  const pay = await db.collection(PAYMENTS).doc(paymentIntentId).get();
  const notices: Notice[] = [notice];
  if (pay.exists) {
    const push = paymentPushFor("refunded", paymentIntentId, pay, pay.get("amount"));
    if (push) notices.push(push);
  }
  await db.runTransaction(async (tx) => {
    const rows = await readNotices(tx, db, notices);
    writeMissingNotices(tx, rows);
  });
}

export async function tryOpenQueued(
  db: Firestore,
  paymentIntentId: string,
  nowMs = Date.now(),
): Promise<"opened" | "blocked" | "skipped"> {
  const day = dayOf(nowMs);
  let result: "opened" | "blocked" | "skipped" = "skipped";
  await db.runTransaction(async (tx) => {
    const jobRef = db.collection(AUTHORITY_PAYMENTS).doc(paymentIntentId);
    const payRef = db.collection(PAYMENTS).doc(paymentIntentId);
    const stateRef = db.doc(FUNDING_STATE);
    const job = await tx.get(jobRef);
    const stateSnap = await tx.get(stateRef);
    if (!job.exists || job.get("status") !== "queued") {
      result = "skipped";
      return;
    }
    const authorityPence = pence(job.get("authorityPence"));
    if (authorityPence === null) {
      result = "blocked";
      return;
    }
    const before = fundingStateFromData(stateSnap.data(), day);
    if (availablePence(before, day) < authorityPence) {
      result = "blocked";
      return;
    }
    const input = noticeInput(paymentIntentId, job.data() ?? {});
    const entries: LedgerEntry[] = [{
      id: `reserve:${paymentIntentId}`,
      kind: "reserve",
      amountPence: authorityPence,
      paymentIntentId,
    }];
    await applyFunding(tx, db, day, before, entries, null, [jobOpenedNotice(input)]);
    tx.set(jobRef, {
      status: "open",
      openedAt: Timestamp.fromMillis(nowMs),
      refundAfter: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    tx.set(payRef, {
      authorityStatus: "open",
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    result = "opened";
  });
  return result;
}

export async function drainAuthorityQueue(db: Firestore, nowMs = Date.now()): Promise<void> {
  const snap = await db.collection(AUTHORITY_PAYMENTS)
    .where("status", "==", "queued")
    .orderBy("createdAt", "asc")
    .limit(20)
    .get();
  for (const doc of snap.docs) {
    const result = await tryOpenQueued(db, doc.id, nowMs);
    if (result === "blocked") break;
  }
  await resumeIfIdle(db, nowMs);
}

export async function resumeIfIdle(db: Firestore, nowMs = Date.now()): Promise<void> {
  const day = dayOf(nowMs);
  await db.runTransaction(async (tx) => {
    const stateRef = db.doc(FUNDING_STATE);
    const stateSnap = await tx.get(stateRef);
    const waiting = await tx.get(
      db.collection(AUTHORITY_PAYMENTS).where("status", "==", "queued").limit(1),
    );
    if (!stateSnap.exists || !waiting.empty) return;
    const before = fundingStateFromData(stateSnap.data(), day);
    if (!before.paused) return;
    const after = withPaused(withLowWater(before, before, day), false);
    const alerts: FundingAlert[] = fundingAlerts(before, after, day);
    const rows = await readNotices(tx, db, alerts.map((alert) => fundingNotice(alert.id, alert.kind, alert.text)));
    tx.set(stateRef, {...fundingStateToData(after), updatedAt: FieldValue.serverTimestamp()}, {merge: true});
    writeMissingNotices(tx, rows);
  });
}

export async function recordTopUp(
  db: Firestore,
  requestId: string,
  amountPence: number,
  nowMs = Date.now(),
): Promise<void> {
  const day = dayOf(nowMs);
  await db.runTransaction(async (tx) => {
    const stateRef = db.doc(FUNDING_STATE);
    const stateSnap = await tx.get(stateRef);
    const before = fundingStateFromData(stateSnap.data(), day);
    const entry: LedgerEntry = {
      id: `topup:${requestId}`,
      kind: "topup",
      amountPence,
      requestId,
    };
    await applyFunding(tx, db, day, before, [entry], null, []);
  });
}
