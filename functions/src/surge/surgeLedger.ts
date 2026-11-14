import {Timestamp, type Firestore} from "firebase-admin/firestore";

export const SURGE_LEDGER = "surge_ledger";
export const SURGE_LEDGER_LOCK_ID = "lock";

/* Monthly credits. The month resets at 00:00 Europe/London on the 1st. */
export const SURGE_MONTHLY_ALLOWANCE = {
  free: 3,
  premium: 10,
  ultimate: 30,
} as const;

/* A config override outside this range is ignored and the constant is used. */
export const SURGE_ALLOWANCE_OVERRIDE_CAP = 60;

/*
 * Server-only surge credits. One grant document is one credit. One spend
 * document is one credit. Nothing on the user document stores a running
 * total, and these documents are not readable by the phone.
 *
 * The spend document id is spend_ plus the unlock request id. Replaying that
 * request finds the same document and does not write another.
 *
 * A lock document, id "lock", is written only when a spend is written. It
 * holds no credit. Concurrent spends read it inside the transaction so two
 * requests cannot both take the last credit. It is not a total.
 *
 * grantSurgeCreditEntry is not a Cloud Function and not a callable. Tests and
 * a future admin tool call it with the Admin SDK. It does not sell anything.
 *
 * Allowances live in SURGE_MONTHLY_ALLOWANCE. A free driver gets three.
 * A paid driver (subscriptionExpiresAt still ahead) gets premium unless
 * users/{uid}.surgePlan is exactly "ultimate". Missing or any other
 * surgePlan, including "stardust", is premium. Stardust spend is not read
 * from surgePlan. A future surgeUnlimitedUntil skips the spend.
 * config/plannerSummaries.premiumMonthlyCredits and ultimateMonthlyCredits
 * can replace those two constants. Missing, 0, or any other unusable value
 * keeps the constant. The same grant ids are not written again.
 */

export function surgeSpendDocId(requestId: string): string {
  return `spend_${requestId}`;
}

export function availableSurgeCredits(entries: readonly {kind?: unknown}[]): number {
  let grants = 0;
  let spends = 0;
  for (const entry of entries) {
    if (entry.kind === "grant") grants += 1;
    else if (entry.kind === "spend") spends += 1;
  }
  const left = grants - spends;
  return left > 0 ? left : 0;
}

export function surgeGrantFields(now: Date, source = "admin"): Record<string, unknown> {
  return {
    kind: "grant",
    source,
    createdAt: Timestamp.fromDate(now),
  };
}

function futureStamp(value: unknown, nowMs: number): boolean {
  return value instanceof Timestamp && value.toMillis() > nowMs;
}

/* Server-written clock only. A string or a number is not unlimited. */
export function isUnlimitedSurge(user: Record<string, unknown> | undefined, nowMs: number): boolean {
  return futureStamp(user?.surgeUnlimitedUntil, nowMs);
}

/* Paid means subscriptionExpiresAt is a timestamp still ahead. */
export function isPaidSurge(user: Record<string, unknown> | undefined, nowMs: number): boolean {
  return futureStamp(user?.subscriptionExpiresAt, nowMs);
}

/* A usable override is a whole number from 1 through the cap. Anything else keeps the constant. */
export function allowanceOverride(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < 1 || value > SURGE_ALLOWANCE_OVERRIDE_CAP) return fallback;
  return value;
}

export type SurgeGrantTier = "free" | "premium" | "ultimate";

export function periodGrantId(tier: SurgeGrantTier, month: string, index: number): string {
  return `grant_${tier}_${month}_${index}`;
}

export interface PeriodGrant {
  id: string;
  source: SurgeGrantTier;
}

function grantSet(tier: SurgeGrantTier, count: number, month: string): PeriodGrant[] {
  return Array.from({length: count}, (_, index) => ({
    id: periodGrantId(tier, month, index + 1),
    source: tier,
  }));
}

/* The month's grant set. Unlimited drivers get none. A paid plan replaces free. */
export function periodGrantPlan(input: {
  user: Record<string, unknown> | undefined;
  nowMs: number;
  month: string;
  premiumMonthlyCredits: unknown;
  ultimateMonthlyCredits: unknown;
}): PeriodGrant[] {
  if (!/^\d{4}-\d{2}$/.test(input.month)) return [];
  if (isUnlimitedSurge(input.user, input.nowMs)) return [];
  if (!isPaidSurge(input.user, input.nowMs)) {
    return grantSet("free", SURGE_MONTHLY_ALLOWANCE.free, input.month);
  }
  if (input.user?.surgePlan === "ultimate") {
    const count = allowanceOverride(input.ultimateMonthlyCredits, SURGE_MONTHLY_ALLOWANCE.ultimate);
    return grantSet("ultimate", count, input.month);
  }
  const count = allowanceOverride(input.premiumMonthlyCredits, SURGE_MONTHLY_ALLOWANCE.premium);
  return grantSet("premium", count, input.month);
}

export function surgeSpendFields(input: {
  requestId: string;
  hotspotId: string;
  summaryId: string;
  now: Date;
}): Record<string, unknown> {
  return {
    kind: "spend",
    requestId: input.requestId,
    hotspotId: input.hotspotId,
    summaryId: input.summaryId,
    createdAt: Timestamp.fromDate(input.now),
  };
}

function validLedgerId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes("/");
}

/* One grant document. The same entry id does not grant a second credit. */
export async function grantSurgeCreditEntry(
  db: Firestore,
  uid: string,
  entryId: string,
  now: Date,
): Promise<void> {
  if (
    !validLedgerId(uid) ||
    !validLedgerId(entryId) ||
    entryId.startsWith("spend_") ||
    entryId === SURGE_LEDGER_LOCK_ID
  ) {
    throw new Error("invalid_grant");
  }
  const ref = db.collection("users").doc(uid).collection(SURGE_LEDGER).doc(entryId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return;
    tx.set(ref, surgeGrantFields(now));
  });
}
