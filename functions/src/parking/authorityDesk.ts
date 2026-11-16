import {DocumentReference, FieldValue, Firestore, Timestamp} from "firebase-admin/firestore";
import {
  AUTHORITY_PAYMENTS,
  PAYMENTS,
  PAYMENT_NOTIFICATIONS,
  ParkingPaymentError,
  isPaymentIntentId,
  shortText,
} from "./contract";
import {assertNoCardData} from "./cardGuard";
import {TOPUP_MAX_PENCE} from "./fundingMath";
import {drainAuthorityQueue, ensureAuthorityJob, recordTopUp} from "./authorityJobs";
import {commitPaymentStatus} from "./payments";
import {refundDriverCharge, type RefundClient} from "./refunds";

async function failRequest(
  requestRef: DocumentReference,
  error: string,
): Promise<void> {
  await requestRef.update({
    status: "error",
    error,
    completedAt: FieldValue.serverTimestamp(),
  });
}

export async function handleAuthorityAction(
  db: Firestore,
  refunds: RefundClient,
  requestRef: DocumentReference,
): Promise<void> {
  const snap = await requestRef.get();
  if (!snap.exists || snap.get("status") !== "pending") return;
  const data = snap.data() ?? {};
  try {
    assertNoCardData(data);
  } catch {
    await failRequest(requestRef, "This request isn't valid.");
    return;
  }
  const action = data.action;
  const paymentIntentId = data.paymentIntentId;
  if ((action !== "fulfill" && action !== "fail" && action !== "already_paid") ||
      !isPaymentIntentId(paymentIntentId)) {
    await failRequest(requestRef, "This request isn't valid.");
    return;
  }
  const jobRef = db.collection(AUTHORITY_PAYMENTS).doc(paymentIntentId);
  const job = await jobRef.get();
  if (!job.exists) {
    await failRequest(requestRef, "We couldn't find this authority payment.");
    return;
  }
  const wanted = action === "fulfill" ? "fulfilled" : action;
  if (job.get("status") === wanted) {
    await requestRef.update({status: "done", completedAt: FieldValue.serverTimestamp()});
    return;
  }
  const payment = await db.collection(PAYMENTS).doc(paymentIntentId).get();
  const driverAmount = payment.get("amount");
  const authority = job.get("authorityPence");
  if (typeof driverAmount !== "number" || typeof authority !== "number") {
    await failRequest(requestRef, "This payment has no amount.");
    return;
  }
  try {
    if (action === "fulfill") {
      if (job.get("status") !== "open") {
        await failRequest(requestRef, "Only an open job can be marked fulfilled.");
        return;
      }
      const reference = shortText(data.authorityReference, 64);
      if (!reference) {
        await failRequest(requestRef, "Enter the authority reference.");
        return;
      }
      const charged = data.authorityChargedPence === undefined ? authority : data.authorityChargedPence;
      if (typeof charged !== "number" || !Number.isSafeInteger(charged) || charged < 1 || charged > authority) {
        await failRequest(requestRef, "The authority charge is outside the amount the driver paid.");
        return;
      }
      const diff = authority - charged;
      if (diff > 0) await refundDriverCharge(refunds, paymentIntentId, diff);
      await commitPaymentStatus(db, paymentIntentId, diff > 0 ? "partially_refunded" : "paid", {
        jobOutcome: "fulfilled",
        authorityReference: reference,
        authorityChargedPence: charged,
      });
    } else {
      if (job.get("status") !== "open" && job.get("status") !== "queued") {
        await failRequest(requestRef, "This authority payment is already closed.");
        return;
      }
      await refundDriverCharge(refunds, paymentIntentId, driverAmount);
      await commitPaymentStatus(db, paymentIntentId, "refunded", {jobOutcome: action});
    }
    await requestRef.update({status: "done", completedAt: FieldValue.serverTimestamp()});
  } catch (err) {
    const again = await jobRef.get();
    if (again.get("status") === wanted) {
      await requestRef.update({status: "done", completedAt: FieldValue.serverTimestamp()});
      return;
    }
    const message = err instanceof ParkingPaymentError ?
      err.message :
      "We couldn't update this authority payment.";
    await failRequest(requestRef, message);
  }
}

export async function handleFundingTopUp(
  db: Firestore,
  requestRef: DocumentReference,
  nowMs = Date.now(),
): Promise<void> {
  const snap = await requestRef.get();
  if (!snap.exists || snap.get("status") !== "pending") return;
  const data = snap.data() ?? {};
  try {
    assertNoCardData(data);
  } catch {
    await failRequest(requestRef, "This top-up isn't valid.");
    return;
  }
  const amount = data.amountPence;
  const note = data.note;
  if (note !== undefined && (typeof note !== "string" || note.length > 200)) {
    await failRequest(requestRef, "The top-up note is too long.");
    return;
  }
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > TOPUP_MAX_PENCE) {
    await failRequest(requestRef, "Enter a top-up between 1p and £20,000.");
    return;
  }
  await recordTopUp(db, requestRef.id, amount, nowMs);
  await drainAuthorityQueue(db, nowMs);
  await requestRef.update({status: "done", completedAt: FieldValue.serverTimestamp()});
}

export async function expireDueAuthorityJobs(
  db: Firestore,
  refunds: RefundClient,
  nowMs = Date.now(),
): Promise<void> {
  const snap = await db.collection(AUTHORITY_PAYMENTS).where("status", "==", "queued").limit(20).get();
  for (const doc of snap.docs) {
    const refundAfter = doc.get("refundAfter");
    if (!(refundAfter instanceof Timestamp) || refundAfter.toMillis() > nowMs) continue;
    const payment = await db.collection(PAYMENTS).doc(doc.id).get();
    const amount = payment.get("amount");
    if (typeof amount !== "number" || !isPaymentIntentId(doc.id)) continue;
    await refundDriverCharge(refunds, doc.id, amount);
    await commitPaymentStatus(db, doc.id, "refunded", {jobOutcome: "expired"}, nowMs);
  }
}

export async function retryPendingJobs(db: Firestore, nowMs = Date.now()): Promise<void> {
  const snap = await db.collection(PAYMENTS).where("jobPending", "==", true).limit(20).get();
  for (const doc of snap.docs) {
    if (!isPaymentIntentId(doc.id)) continue;
    await ensureAuthorityJob(db, doc.id, nowMs);
  }
}

export async function requeueStuckNotices(db: Firestore, nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - 2 * 60 * 1000;
  const snap = await db.collection(PAYMENT_NOTIFICATIONS).where("status", "==", "sending").limit(20).get();
  for (const doc of snap.docs) {
    const sendingAt = doc.get("sendingAt");
    if (sendingAt instanceof Timestamp && sendingAt.toMillis() > cutoff) continue;
    await doc.ref.update({status: "pending"});
  }
}
