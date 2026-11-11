import {FieldValue, Timestamp, type Firestore} from "firebase-admin/firestore";
import {
  CACHE_TTL_MS,
  DVLA_MAX_WAIT_MS,
  DVLA_MIN_INTERVAL_MS,
  LIMITS,
  LOOKUPS,
  THROTTLE,
  THROTTLE_DOC,
  USER_LIMIT,
  USER_WINDOW_MS,
  vehicleFromStored,
  type VehicleLookup,
} from "./contract";

export async function readFreshLookup(
  db: Firestore,
  registration: string,
  now: Date,
): Promise<VehicleLookup | null> {
  const snap = await db.collection(LOOKUPS).doc(registration).get();
  if (!snap.exists) return null;
  const expireAt = snap.get("expireAt");
  if (!(expireAt instanceof Timestamp)) return null;
  if (expireAt.toMillis() <= now.getTime()) return null;
  const data = snap.data();
  if (!data) return null;
  return vehicleFromStored(registration, data);
}

export async function writeLookup(db: Firestore, vehicle: VehicleLookup, now: Date): Promise<void> {
  await db.collection(LOOKUPS).doc(vehicle.registration).set({
    ...vehicle,
    expireAt: Timestamp.fromMillis(now.getTime() + CACHE_TTL_MS),
  });
}

function userLimitDocId(uid: string, now: Date): string {
  const window = Math.floor(now.getTime() / USER_WINDOW_MS);
  return `${uid}_${window}`;
}

// Returns false when this user is already at the minute cap.
// Throws nothing: a throw would retry the transaction.
export async function takeUserSlot(db: Firestore, uid: string, now: Date): Promise<boolean> {
  const window = Math.floor(now.getTime() / USER_WINDOW_MS);
  const ref = db.collection(LIMITS).doc(userLimitDocId(uid, now));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        uid,
        window,
        count: 1,
        updatedAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis((window + 2) * USER_WINDOW_MS),
      });
      return true;
    }
    const current = snap.get("count");
    if (typeof current !== "number" || !Number.isFinite(current) || current >= USER_LIMIT) return false;
    tx.set(ref, {
      uid,
      window,
      count: current + 1,
      updatedAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis((window + 2) * USER_WINDOW_MS),
    });
    return true;
  });
}

export interface ThrottleSlot {
  waitMs: number;
}

// Spaces DVLA calls at least 500ms apart (2 per second). Cache hits do not
// call this. A slot that would wait longer than DVLA_MAX_WAIT_MS is refused
// and does not move the next slot, so a burst cannot lock the queue.
export async function reserveDvlaSlot(db: Firestore, now: Date): Promise<ThrottleSlot | null> {
  const ref = db.collection(THROTTLE).doc(THROTTLE_DOC);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const nowMs = now.getTime();
    const stored = snap.exists ? snap.get("nextSlotAt") : 0;
    const nextSlotAt = typeof stored === "number" && Number.isFinite(stored) ? stored : 0;
    const slot = Math.max(nowMs, nextSlotAt);
    const waitMs = slot - nowMs;
    if (waitMs > DVLA_MAX_WAIT_MS) return null;
    tx.set(ref, {
      nextSlotAt: slot + DVLA_MIN_INTERVAL_MS,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {waitMs};
  });
}
