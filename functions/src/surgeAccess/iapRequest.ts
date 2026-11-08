import {FieldValue, Timestamp, type Firestore} from "firebase-admin/firestore";
import {ADMISSION, admissionFloor} from "./admission.js";
import {
  REQUEST_ADMISSION,
  SIGNED_TRANSACTION_MAX,
  SIGNED_TRANSACTION_MIN,
  SurgeAccessError,
  assertUid,
  isUuid,
} from "./contract.js";

export const IAP_REQUESTS = "iapRequests";
export {ADMISSION};

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
  "admitted",
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
  if (body.admitted !== true) throw new SurgeAccessError("unadmitted");
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

/*
 * Holds one Apple submission. Not a Cloud Function. A missing document is
 * created only when the stored-document count is under the cap. An existing
 * document is judged from its stored fields. A caller blob is ignored once
 * a document exists. Nothing here is delivered or granted.
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
    const floor = await admissionFloor(tx, db, IAP_REQUESTS, authUid, requestId, "openIap");
    if (snap.exists) {
      const body = snap.data() as Record<string, unknown>;
      storedIap(body, authUid);
      return;
    }
    if (!payloadOk(initialPayload)) throw new SurgeAccessError("bad-payload");
    if (floor >= REQUEST_ADMISSION.maxOpenPerUid) throw new SurgeAccessError("admission-full");
    tx.set(ref, {
      admitted: true,
      v: 1,
      uid: authUid,
      platform: "apple",
      signedTransaction: initialPayload,
      createdAt: FieldValue.serverTimestamp(),
      status: "held",
      outcome: "verifier-not-implemented",
    });
    tx.set(admissionRef, {uid: authUid, openIap: floor + 1}, {merge: true});
  });
  return HELD;
}
