import {Timestamp, type Firestore} from "firebase-admin/firestore";

export const SURGE_LEDGER = "surge_ledger";
export const SURGE_LEDGER_LOCK_ID = "lock";
export const FREE_MONTHLY_CREDITS = 3;
/* One unlock transaction also writes the month's grants. Keep the set small. */
export const PREMIUM_MONTHLY_CREDIT_CAP = 24;

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
 * A free driver receives FREE_MONTHLY_CREDITS grant documents per London
 * month, ids grant_free_<YYYY-MM>_<1..3>. A driver with a future
 * subscriptionExpiresAt is premium and receives
 * config/plannerSummaries.premiumMonthlyCredits documents, ids
 * grant_premium_<YYYY-MM>_<n>. Missing or unusable config is 0. The unlock
 * transaction writes a missing set once. The same ids are not written again.
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

/*
 * Premium, as admin growth counts it: subscriptionExpiresAt is a timestamp
 * still ahead. That field is server-only. premiumProductId is not used.
 * There is no Stardust field in this repo.
 */
export function isPremiumSurge(user: Record<string, unknown> | undefined, nowMs: number): boolean {
  return futureStamp(user?.subscriptionExpiresAt, nowMs);
}

/* Missing, a fraction, a negative, or a value above the cap is 0. */
export function premiumMonthlyCredits(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  if (value < 0 || value > PREMIUM_MONTHLY_CREDIT_CAP) return 0;
  return value;
}

export function periodGrantId(tier: "free" | "premium", month: string, index: number): string {
  return `grant_${tier}_${month}_${index}`;
}

export interface PeriodGrant {
  id: string;
  source: "free" | "premium";
}

/* The month's grant set. Unlimited drivers get none. Premium replaces free. */
export function periodGrantPlan(input: {
  user: Record<string, unknown> | undefined;
  nowMs: number;
  month: string;
  premiumMonthlyCredits: number;
}): PeriodGrant[] {
  if (!/^\d{4}-\d{2}$/.test(input.month)) return [];
  if (isUnlimitedSurge(input.user, input.nowMs)) return [];
  if (isPremiumSurge(input.user, input.nowMs)) {
    const count = premiumMonthlyCredits(input.premiumMonthlyCredits);
    return Array.from({length: count}, (_, index) => ({
      id: periodGrantId("premium", input.month, index + 1),
      source: "premium" as const,
    }));
  }
  return Array.from({length: FREE_MONTHLY_CREDITS}, (_, index) => ({
    id: periodGrantId("free", input.month, index + 1),
    source: "free" as const,
  }));
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
