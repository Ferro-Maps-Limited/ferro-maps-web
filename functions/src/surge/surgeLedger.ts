import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {londonMonthStartMs, londonYearMonth, nextLondonMonthStartMs} from "./time";

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

/* Premium, ultimate, and stardust each last seven days from the latest payment. */
export const PAID_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

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
 *
 * Free resets with the London month. A paid period resets seven days after
 * subscriptionPeriodStart. When that field is missing, the payment time is
 * subscriptionExpiresAt minus seven days, or surgeUnlimitedUntil minus seven
 * days when that is the only clock. Spends outside the open window do not
 * count. A grant document is an audit trail and does not raise the allowance.
 */

export interface AllowanceWindow {
  key: string;
  startMs: number;
  endMs: number;
}

function stampMs(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

/*
 * The latest payment. subscriptionPeriodStart wins. Otherwise the payment is
 * seven days before the expiry the server already stored.
 */
export function paidPeriodStartMs(user: Record<string, unknown> | undefined): number | null {
  const start = stampMs(user?.subscriptionPeriodStart);
  if (start != null) return start;
  const expires = stampMs(user?.subscriptionExpiresAt);
  if (expires != null) return expires - PAID_PERIOD_MS;
  const unlimited = stampMs(user?.surgeUnlimitedUntil);
  if (unlimited != null) return unlimited - PAID_PERIOD_MS;
  return null;
}

/* Free: the London month that contains now. Paid and stardust: seven days from the latest payment. */
export function allowanceWindow(
  user: Record<string, unknown> | undefined,
  nowMs: number,
): AllowanceWindow | null {
  if (isPaidSurge(user, nowMs) || isUnlimitedSurge(user, nowMs)) {
    const startMs = paidPeriodStartMs(user);
    if (startMs == null) return null;
    return {
      key: new Date(startMs).toISOString(),
      startMs,
      endMs: startMs + PAID_PERIOD_MS,
    };
  }
  const key = londonYearMonth(nowMs);
  const startMs = londonMonthStartMs(nowMs);
  const endMs = nextLondonMonthStartMs(nowMs);
  if (!key || startMs == null || endMs == null) return null;
  return {key, startMs, endMs};
}

export function surgeSpendDocId(requestId: string): string {
  return `spend_${requestId}`;
}

/* This month's allowance for the driver's current tier. Unlimited is zero here. */
export function monthlyAllowance(input: {
  user: Record<string, unknown> | undefined;
  nowMs: number;
  premiumMonthlyCredits: unknown;
  ultimateMonthlyCredits: unknown;
}): number {
  if (isUnlimitedSurge(input.user, input.nowMs)) return 0;
  if (!isPaidSurge(input.user, input.nowMs)) return SURGE_MONTHLY_ALLOWANCE.free;
  if (input.user?.surgePlan === "ultimate") {
    return allowanceOverride(input.ultimateMonthlyCredits, SURGE_MONTHLY_ALLOWANCE.ultimate);
  }
  return allowanceOverride(input.premiumMonthlyCredits, SURGE_MONTHLY_ALLOWANCE.premium);
}

export function surgeSpendTier(
  user: Record<string, unknown> | undefined,
  nowMs: number,
): SurgeGrantTier {
  if (!isPaidSurge(user, nowMs)) return "free";
  if (user?.surgePlan === "ultimate") return "ultimate";
  return "premium";
}

function spendInWindow(entry: Record<string, unknown>, window: AllowanceWindow): boolean {
  if (entry.kind !== "spend") return false;
  if (entry.period === window.key) return true;
  const createdAt = entry.createdAt;
  if (!(createdAt instanceof Timestamp)) return false;
  const ms = createdAt.toMillis();
  return ms >= window.startMs && ms < window.endMs;
}

/* Spends in this allowance window. Grant documents are not counted. */
export function spendsInPeriod(
  entries: readonly Record<string, unknown>[],
  window: AllowanceWindow,
): number {
  let spends = 0;
  for (const entry of entries) {
    if (spendInWindow(entry, window)) spends += 1;
  }
  return spends;
}

/*
 * Allowance for the open window, minus spends in that window.
 * A closed window has nothing left. Grant documents are not added.
 */
export function availableSurgeCredits(input: {
  allowance: number;
  window: AllowanceWindow;
  nowMs: number;
  entries: readonly Record<string, unknown>[];
}): number {
  if (input.nowMs < input.window.startMs || input.nowMs >= input.window.endMs) return 0;
  const left = input.allowance - spendsInPeriod(input.entries, input.window);
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

export function periodGrantId(tier: SurgeGrantTier, periodKey: string, index: number): string {
  return `grant_${tier}_${periodKey}_${index}`;
}

export interface PeriodGrant {
  id: string;
  source: SurgeGrantTier;
}

function grantSet(tier: SurgeGrantTier, count: number, periodKey: string): PeriodGrant[] {
  return Array.from({length: count}, (_, index) => ({
    id: periodGrantId(tier, periodKey, index + 1),
    source: tier,
  }));
}

function validPeriodKey(value: string): boolean {
  return value.length > 0 && value.length <= 80 && !value.includes("/");
}

/* Audit grants for this window. Unlimited drivers get none. A paid plan replaces free. */
export function periodGrantPlan(input: {
  user: Record<string, unknown> | undefined;
  nowMs: number;
  periodKey: string;
  premiumMonthlyCredits: unknown;
  ultimateMonthlyCredits: unknown;
}): PeriodGrant[] {
  if (!validPeriodKey(input.periodKey)) return [];
  if (isUnlimitedSurge(input.user, input.nowMs)) return [];
  const count = monthlyAllowance(input);
  return grantSet(surgeSpendTier(input.user, input.nowMs), count, input.periodKey);
}

export function surgeSpendFields(input: {
  requestId: string;
  hotspotId: string;
  summaryId: string;
  now: Date;
  period: string;
  tier: SurgeGrantTier;
}): Record<string, unknown> {
  return {
    kind: "spend",
    requestId: input.requestId,
    hotspotId: input.hotspotId,
    summaryId: input.summaryId,
    period: input.period,
    tier: input.tier,
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
