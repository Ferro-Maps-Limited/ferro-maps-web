import {FieldValue, Timestamp, type Firestore} from "firebase-admin/firestore";
import {
  REQUEST_ADMISSION,
  SIGNED_TRANSACTION_MAX,
  SIGNED_TRANSACTION_MIN,
  SurgeAccessError,
  assertUid,
  isUuid,
} from "./contract.js";

export const IAP_REQUESTS = "iapRequests";
export const ADMISSION = "surgeAdmission";

export interface HeldIapResult {
  status: "held";
  outcome: "verifier-not-implemented";
  delivered: false;
  granted: false;
}

const HELD: HeldIapResult = {
  status: "held",
  outcome: "verifier-not-implemented",
  delivered: false,
  granted: false,
};

const STORED_KEYS = new Set([
  "v",
  "uid",
  "platform",
  "signedTransaction",
  "createdAt",
  "status",
  "outcome",
]);

function payloadOk(payload: unknown): payload is string {
  return typeof payload === "string" &&
    payload.length >= SIGNED_TRANSACTION_MIN &&
    payload.length <= SIGNED_TRANSACTION_MAX;
}

/* Authority comes from the stored document, never from a caller's copy of the blob. */
function storedIap(body: Record<string, unknown>, authUid: string): void {
  for (const key of Object.keys(body)) {
    if (!STORED_KEYS.has(key)) throw new SurgeAccessError("stored-shape");
  }
  if (body.v !== 1) throw new SurgeAccessError("bad-version");
  if (body.uid !== authUid) throw new SurgeAccessError("owner-mismatch");
  if (body.platform !== "apple") throw new SurgeAccessError("bad-platform");
  if (!payloadOk(body.signedTransaction)) throw new SurgeAccessError("bad-payload");
  if (!(body.createdAt instanceof Timestamp)) throw new SurgeAccessError("stored-shape");
  if (body.status != null && body.status !== "held") throw new SurgeAccessError("unexpected-status");
  if (body.outcome != null && body.outcome !== "verifier-not-implemented") {
    throw new SurgeAccessError("unexpected-status");
  }
}

function openCount(data: Record<string, unknown> | undefined, field: "openIap" | "openAccount"): number {
  if (data == null) return 0;
  const value = data[field];
  if (value == null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SurgeAccessError("admission-corrupt");
  }
  return value;
}

/*
 * Holds one Apple submission. A missing document is created only under the
 * per-account cap, in the same transaction as the counter. An existing
 * document is judged from its stored fields. The optional initialPayload is
 * ignored once a document exists, and it is never granted or finished.
 */
export async function holdSurgeIapRequest(
  db: Firestore,
  requestId: string,
  authUid: string,
  initialPayload?: string,
): Promise<HeldIapResult> {
  if (!isUuid(requestId)) throw new SurgeAccessError("bad-request-id");
  assertUid(authUid);
  await db.runTransaction(async (tx) => {
    const ref = db.collection(IAP_REQUESTS).doc(requestId);
    const admissionRef = db.collection(ADMISSION).doc(authUid);
    const snap = await tx.get(ref);
    const admission = await tx.get(admissionRef);
    const count = openCount(admission.data() as Record<string, unknown> | undefined, "openIap");
    if (snap.exists) {
      const body = snap.data() as Record<string, unknown>;
      storedIap(body, authUid);
      if (body.status !== "held") {
        tx.set(ref, {status: "held", outcome: "verifier-not-implemented"}, {merge: true});
      }
      return;
    }
    if (!payloadOk(initialPayload)) throw new SurgeAccessError("bad-payload");
    if (count >= REQUEST_ADMISSION.maxOpenPerUid) throw new SurgeAccessError("admission-full");
    tx.set(ref, {
      v: 1,
      uid: authUid,
      platform: "apple",
      signedTransaction: initialPayload,
      createdAt: FieldValue.serverTimestamp(),
      status: "held",
      outcome: "verifier-not-implemented",
    });
    tx.set(admissionRef, {uid: authUid, openIap: count + 1}, {merge: true});
  });
  return HELD;
}
