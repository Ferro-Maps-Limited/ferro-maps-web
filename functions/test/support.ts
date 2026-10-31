import {initializeApp, getApps} from "firebase-admin/app";
import {Firestore, getFirestore} from "firebase-admin/firestore";

export function testDb(projectId: string): Firestore {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set. Run via firebase emulators:exec.");
  }
  const existing = getApps().find((app) => app.name === projectId);
  const app = existing ?? initializeApp({projectId}, projectId);
  return getFirestore(app);
}

export async function clearDb(db: Firestore): Promise<void> {
  const names = [
    "parkingPaymentRequests",
    "parkingPayments",
    "places",
    "users",
    "operatorForwards",
    "stripeCustomers",
    "stripeSync",
  ];
  for (const name of names) {
    const snap = await db.collection(name).get();
    if (snap.empty) continue;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}
