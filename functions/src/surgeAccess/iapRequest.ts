import {type Firestore} from "firebase-admin/firestore";
import {
  FORBIDDEN_CLIENT_IAP_KEYS,
  SIGNED_TRANSACTION_MAX,
  SIGNED_TRANSACTION_MIN,
  SurgeAccessError,
  assertUid,
  exactKeys,
  isUuid,
} from "./contract.js";

export const IAP_REQUESTS = "iapRequests";

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

/*
 * Accepts a signed transaction blob and holds it. This does not verify the
 * signature, does not read a product, and does not grant access. The client
 * must not finish the Apple transaction while the result is held.
 */
export async function holdSurgeIapRequest(
  db: Firestore,
  requestId: string,
  authUid: string,
  data: Record<string, unknown>,
): Promise<HeldIapResult> {
  if (!isUuid(requestId)) throw new SurgeAccessError("bad-request-id");
  assertUid(authUid);
  for (const key of FORBIDDEN_CLIENT_IAP_KEYS) {
    if (key in data) throw new SurgeAccessError("forbidden-field");
  }
  exactKeys(data, ["v", "uid", "platform", "signedTransaction", "createdAt"]);
  if (data.v !== 1) throw new SurgeAccessError("bad-version");
  if (data.uid !== authUid) throw new SurgeAccessError("owner-mismatch");
  if (data.platform !== "apple") throw new SurgeAccessError("bad-platform");
  const payload = data.signedTransaction;
  if (typeof payload !== "string") throw new SurgeAccessError("bad-payload");
  if (payload.length < SIGNED_TRANSACTION_MIN || payload.length > SIGNED_TRANSACTION_MAX) {
    throw new SurgeAccessError("bad-payload");
  }
  const ref = db.collection(IAP_REQUESTS).doc(requestId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new SurgeAccessError("request-missing");
    const body = snap.data() ?? {};
    if (body.uid !== authUid) throw new SurgeAccessError("owner-mismatch");
    if (body.status === "held") return;
    if (body.status != null) throw new SurgeAccessError("unexpected-status");
    tx.set(ref, {status: "held", outcome: "verifier-not-implemented"}, {merge: true});
  });
  return HELD;
}
