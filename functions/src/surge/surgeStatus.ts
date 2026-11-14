import {FieldValue, Timestamp, type Firestore} from "firebase-admin/firestore";
import {
  SURGE_LEDGER,
  allowanceWindow,
  isUnlimitedSurge,
  monthlyAllowance,
  spendsInPeriod,
  surgeSpendTier,
  type SurgeGrantTier,
} from "./surgeLedger";

export const SURGE_STATUS = "surge_status";
export {PAID_PERIOD_MS} from "./surgeLedger";

export type SurgeStatusTier = SurgeGrantTier | "stardust";

/*
 * Fields for surge_status/{uid}. The phone may read this. The unlock
 * decision does not. updatedAt is a server timestamp.
 * Stardust omits allowance and spentThisPeriod.
 */
export function surgeStatusFields(input: {
  tier: SurgeStatusTier;
  periodKey: string;
  periodEndsAt: Timestamp;
  allowance?: number;
  spentThisPeriod?: number;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    tier: input.tier,
    periodKey: input.periodKey,
    periodEndsAt: input.periodEndsAt,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (input.tier === "stardust") return data;
  data.allowance = input.allowance ?? 0;
  data.spentThisPeriod = input.spentThisPeriod ?? 0;
  return data;
}

/* Free ends at the next London 1st. Paid and stardust end seven days after the latest payment. */
export function surgePeriodEndsAt(
  user: Record<string, unknown> | undefined,
  nowMs: number,
): Timestamp | null {
  const window = allowanceWindow(user, nowMs);
  if (!window) return null;
  return Timestamp.fromMillis(window.endMs);
}

export function statusTierForUser(
  user: Record<string, unknown> | undefined,
  nowMs: number,
): SurgeStatusTier {
  if (isUnlimitedSurge(user, nowMs)) return "stardust";
  return surgeSpendTier(user, nowMs);
}

/*
 * For the purchase verifier, which is on hold. Not a Cloud Function and not
 * exported from the functions entrypoint. Nothing calls this yet.
 */
export async function refreshSurgeStatus(
  db: Firestore,
  uid: string,
  now: Date,
  premiumMonthlyCredits: number,
  ultimateMonthlyCredits: number,
): Promise<void> {
  const nowMs = now.getTime();
  const userSnap = await db.collection("users").doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : undefined;
  const window = allowanceWindow(user, nowMs);
  if (!window) return;
  const tier = statusTierForUser(user, nowMs);
  const periodEndsAt = Timestamp.fromMillis(window.endMs);
  let spentThisPeriod = 0;
  let allowance = 0;
  if (tier !== "stardust") {
    const ledger = await db.collection("users").doc(uid).collection(SURGE_LEDGER).get();
    spentThisPeriod = spendsInPeriod(ledger.docs.map((entry) => entry.data()), window);
    allowance = monthlyAllowance({
      user,
      nowMs,
      premiumMonthlyCredits,
      ultimateMonthlyCredits,
    });
  }
  await db.collection(SURGE_STATUS).doc(uid).set(surgeStatusFields({
    tier,
    periodKey: window.key,
    periodEndsAt,
    allowance,
    spentThisPeriod,
  }));
}
