import {FieldValue, type Firestore} from "firebase-admin/firestore";
import {SurgeAccessError, isUuid} from "./contract.js";
import {isLibraryVerified} from "./verifiedMark.js";

export const PURCHASE_EVIDENCE = "surgePurchaseEvidence";

export interface EvidenceDraft {
  provenance: "apple-library" | "synthetic-test";
  transactionId: string;
  originalTransactionId: string;
  uid: string;
  appAccountToken: string;
  bundleId: string;
  environment: string;
  productId: string;
  requestId: string;
  snapshotSha256: string;
}

/*
 * One row per verified Apple transaction id. Not an allowance, a credit, or
 * a delivered purchase. Synthetic rows are refused outside the Firestore
 * emulator. The raw signed transaction is not stored.
 */
export async function putPurchaseEvidence(
  db: Firestore,
  draft: EvidenceDraft,
  proof?: object,
): Promise<{created: boolean}> {
  if (draft.provenance === "apple-library" && (proof == null || !isLibraryVerified(proof))) {
    throw new SurgeAccessError("evidence-untrusted");
  }
  if (draft.provenance !== "apple-library" && draft.provenance !== "synthetic-test") {
    throw new SurgeAccessError("evidence-untrusted");
  }
  if (draft.provenance === "synthetic-test" && !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new SurgeAccessError("synthetic-evidence-emulator-only");
  }
  if (!isUuid(draft.requestId) || !isUuid(draft.appAccountToken)) throw new SurgeAccessError("evidence-untrusted");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(draft.transactionId)) throw new SurgeAccessError("evidence-untrusted");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(draft.originalTransactionId)) {
    throw new SurgeAccessError("evidence-untrusted");
  }
  if (!/^[a-f0-9]{64}$/.test(draft.snapshotSha256)) throw new SurgeAccessError("evidence-untrusted");
  const ref = db.collection(PURCHASE_EVIDENCE).doc(`apple_${draft.transactionId}`);
  let created = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const body = snap.data() as Record<string, unknown>;
      const same = body.uid === draft.uid &&
        body.appAccountToken === draft.appAccountToken &&
        body.bundleId === draft.bundleId &&
        body.environment === draft.environment &&
        body.productId === draft.productId &&
        body.requestId === draft.requestId &&
        body.snapshotSha256 === draft.snapshotSha256 &&
        body.originalTransactionId === draft.originalTransactionId;
      if (!same) throw new SurgeAccessError("evidence-conflict");
      return;
    }
    created = true;
    tx.set(ref, {
      store: "apple",
      provenance: draft.provenance,
      transactionId: draft.transactionId,
      originalTransactionId: draft.originalTransactionId,
      uid: draft.uid,
      appAccountToken: draft.appAccountToken,
      bundleId: draft.bundleId,
      environment: draft.environment,
      productId: draft.productId,
      requestId: draft.requestId,
      snapshotSha256: draft.snapshotSha256,
      result: "evidence-recorded",
      recordedAt: FieldValue.serverTimestamp(),
    });
  });
  return {created};
}
