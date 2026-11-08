import {SurgeAccessError} from "./contract.js";

/*
 * TEST ONLY. An in-memory picture of ledger rules. It is not Apple
 * verification. Real signature checks live in appleValidation.ts and still
 * fail closed because no App Store app id or product allowlist is configured.
 * unavailableVerifier means "do not pretend this picture can verify a purchase."
 */

export const SYNTHETIC_LEDGER = "test-only";

export function unavailableVerifier(): never {
  throw new SurgeAccessError("verifier-unavailable");
}

export type StoreName = "apple" | "play";
export type PurchaseKind = "weekly-allowance" | "single-event";

export interface SyntheticPurchase {
  verified: boolean;
  store: StoreName;
  transactionId: string;
  uid: string;
  accountToken: string;
  expectedAccountToken: string;
  productId: string;
  appId: string;
  expectedAppId: string;
  env: string;
  expectedEnv: string;
  kind: PurchaseKind;
  weeklyOpens?: number;
}

export interface SyntheticUnlock {
  uid: string;
  eventId: string;
  source: "allowance" | "single";
  validUntil: string;
}

export interface SyntheticState {
  purchases: SyntheticPurchase[];
  opensUsed: Record<string, number>;
  singleCredits: Record<string, number>;
  unlocks: SyntheticUnlock[];
  revoked: string[];
}

export interface SyntheticResult {
  status: "recorded" | "refused" | "reopened";
  granted: false;
  delivered: false;
  allowanceGrants: number;
  creditGrants: number;
}

const REFUSED: SyntheticResult = {
  status: "refused",
  granted: false,
  delivered: false,
  allowanceGrants: 0,
  creditGrants: 0,
};

export function emptySyntheticState(): SyntheticState {
  return {purchases: [], opensUsed: {}, singleCredits: {}, unlocks: [], revoked: []};
}

function samePurchase(left: SyntheticPurchase, right: SyntheticPurchase): boolean {
  return left.store === right.store && left.transactionId === right.transactionId;
}

/* One synthetic transaction grants one kind, or nothing. Never both, never twice. */
export function applySyntheticPurchase(state: SyntheticState, input: SyntheticPurchase): SyntheticResult {
  if (input.verified !== true) return REFUSED;
  if (input.env !== input.expectedEnv || input.appId !== input.expectedAppId) return REFUSED;
  if (input.accountToken !== input.expectedAccountToken) return REFUSED;
  if (input.kind !== "weekly-allowance" && input.kind !== "single-event") return REFUSED;
  const prior = state.purchases.find((row) => samePurchase(row, input));
  if (prior) {
    if (prior.uid !== input.uid) return REFUSED;
    return {status: "recorded", granted: false, delivered: false, allowanceGrants: 0, creditGrants: 0};
  }
  if (state.revoked.includes(`${input.store}:${input.transactionId}`)) return REFUSED;
  state.purchases.push({...input});
  if (input.kind === "weekly-allowance") {
    return {status: "recorded", granted: false, delivered: false, allowanceGrants: 1, creditGrants: 0};
  }
  state.singleCredits[input.uid] = (state.singleCredits[input.uid] ?? 0) + 1;
  return {status: "recorded", granted: false, delivered: false, allowanceGrants: 0, creditGrants: 1};
}

/* A refund does not put opens or credits back. */
export function applySyntheticRevoke(state: SyntheticState, store: StoreName, transactionId: string): SyntheticResult {
  const key = `${store}:${transactionId}`;
  if (!state.revoked.includes(key)) state.revoked.push(key);
  const prior = state.purchases.find((row) => row.store === store && row.transactionId === transactionId);
  if (prior?.kind === "single-event") {
    state.singleCredits[prior.uid] = Math.max(0, (state.singleCredits[prior.uid] ?? 0) - 1);
  }
  return {status: "recorded", granted: false, delivered: false, allowanceGrants: 0, creditGrants: 0};
}

/*
 * Reopening an unlock before its verified end costs nothing, including across
 * a weekly or monthly reset. This does not extend the end and does not write
 * a delivered purchase.
 */
export function openSyntheticEvent(
  state: SyntheticState,
  uid: string,
  eventId: string,
  nowIso: string,
  verifiedEnd: string,
  weeklyLimit: number,
): SyntheticResult {
  const existing = state.unlocks.find((row) => row.uid === uid && row.eventId === eventId);
  if (existing && nowIso < existing.validUntil) {
    return {status: "reopened", granted: false, delivered: false, allowanceGrants: 0, creditGrants: 0};
  }
  if (existing) return REFUSED;
  const used = state.opensUsed[uid] ?? 0;
  if (used < weeklyLimit) {
    state.opensUsed[uid] = used + 1;
    state.unlocks.push({uid, eventId, source: "allowance", validUntil: verifiedEnd});
    return {status: "recorded", granted: false, delivered: false, allowanceGrants: 0, creditGrants: 0};
  }
  const credits = state.singleCredits[uid] ?? 0;
  if (credits < 1) return REFUSED;
  state.singleCredits[uid] = credits - 1;
  state.unlocks.push({uid, eventId, source: "single", validUntil: verifiedEnd});
  return {status: "recorded", granted: false, delivered: false, allowanceGrants: 0, creditGrants: 0};
}
