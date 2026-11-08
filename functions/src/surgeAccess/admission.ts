import {type Firestore, type Transaction} from "firebase-admin/firestore";
import {REQUEST_ADMISSION, SurgeAccessError} from "./contract.js";

export const ADMISSION = "surgeAdmission";

/*
 * The number of stored requests is the floor. A missing or deleted counter
 * does not drop below that. A counter that is higher than the documents
 * fails closed. Deleting the request documents themselves is a privileged
 * Admin change and is not prevented here.
 */
export async function admissionFloor(
  tx: Transaction,
  db: Firestore,
  collectionName: string,
  uid: string,
  exceptId: string,
  field: "openAccount" | "openIap",
): Promise<number> {
  const admission = await tx.get(db.collection(ADMISSION).doc(uid));
  const data = admission.data() as Record<string, unknown> | undefined;
  let counter = 0;
  if (data != null && data[field] != null) {
    const value = data[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new SurgeAccessError("admission-corrupt");
    }
    counter = value;
  }
  const found = await tx.get(
    db.collection(collectionName).where("uid", "==", uid).limit(REQUEST_ADMISSION.maxOpenPerUid + 1),
  );
  let docs = 0;
  for (const row of found.docs) {
    if (row.id !== exceptId) docs += 1;
  }
  return Math.max(counter, docs);
}
