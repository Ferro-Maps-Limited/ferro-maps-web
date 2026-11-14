import {FieldValue, Timestamp, type Firestore} from "firebase-admin/firestore";
import {
  SURGE_LEDGER,
  isUnlimitedSurge,
  monthlyAllowance,
  spendsInPeriod,
  surgeSpendTier,
  type SurgeGrantTier,
} from "./surgeLedger";
import {londonMonthStartMs, londonYearMonth, nextLondonMonthStartMs} from "./time";

export const SURGE_STATUS = "surge_status";

/* Paid status window, measured from 00:00 Europe/London on the 1st. One week. */
export const PAID_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

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

/* Free ends at the next London 1st. Paid ends one PAID_PERIOD_MS after this month's 1st. */
export function surgePeriodEndsAt(tier: SurgeStatusTier, nowMs: number): Timestamp | null {
  if (tier === "premium" || tier === "ultimate") {
    const start = londonMonthStartMs(nowMs);
    if (start == null) return null;
    return Timestamp.fromMillis(start + PAID_PERIOD_MS);
  }
  const end = nextLondonMonthStartMs(nowMs);
  if (end == null) return null;
  return Timestamp.fromMillis(end);
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
  const periodKey = londonYearMonth(nowMs);
  if (!periodKey) return;
  const userSnap = await db.collection("users").doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : undefined;
  const tier = statusTierForUser(user, nowMs);
  const periodEndsAt = surgePeriodEndsAt(tier, nowMs);
  if (!periodEndsAt) return;
  let spentThisPeriod = 0;
  let allowance = 0;
  if (tier !== "stardust") {
    const ledger = await db.collection("users").doc(uid).collection(SURGE_LEDGER).get();
    spentThisPeriod = spendsInPeriod(ledger.docs.map((entry) => entry.data()), periodKey);
    allowance = monthlyAllowance({
      user,
      nowMs,
      premiumMonthlyCredits,
      ultimateMonthlyCredits,
    });
  }
  await db.collection(SURGE_STATUS).doc(uid).set(surgeStatusFields({
    tier,
    periodKey,
    periodEndsAt,
    allowance,
    spentThisPeriod,
  }));
}
