/*
 * surge-access-binding/v1
 *
 * Account binding and the Apple request shape. No allowance, ledger, or
 * store verification is active in this module.
 */

export const CONTRACT_ID = "surge-access-binding/v1";
/* Revision 2 withdraws client creates. Not adopted. Not a live contract. */
export const CONTRACT_REVISION = 2;

export const REQUEST_ADMISSION = {
  clientCreates: "denied",
  maxOpenPerUid: 3,
  grantsFinancialAuthority: false,
  resetsWhenPlanSwitches: false,
  multiAccountAbusePrevented: false,
} as const;

export const SIGNED_TRANSACTION_MIN = 64;
export const SIGNED_TRANSACTION_MAX = 16384;

export const ACCOUNT_REQUEST_KEYS = ["v", "uid", "createdAt"] as const;
export const IAP_REQUEST_KEYS = ["v", "uid", "platform", "signedTransaction", "createdAt"] as const;

export const FORBIDDEN_CLIENT_IAP_KEYS = [
  "productId",
  "tier",
  "price",
  "transactionId",
  "originalTransactionId",
  "entitlement",
  "grant",
  "status",
  "result",
  "outcome",
  "appAccountToken",
  "playObfuscatedId",
] as const;

/* Owner-approved catalogue counts. Store product ids are proposals only. */
export const FREE_OPENS = {
  opens: 3,
  cadence: "calendar-month",
  not: "fixed-30-days",
  anchor: "first-successful-server-authorized-open",
  anchorPersistence: "server-account",
  clientClockResetsAnchor: false,
  reinstallResetsAnchor: false,
  planSwitchResetsAnchor: false,
  active: false,
} as const;

export const PAID_WEEKLY = [
  {tier: "premium", priceGbp: "3.99", opensPerWeek: 10},
  {tier: "ultimate", priceGbp: "7.99", opensPerWeek: 30},
  {tier: "stardust", priceGbp: "14.99", opensPerWeek: "unlimited"},
] as const;

/*
 * Exhausted paid drivers buy single surges. The weekly plan keeps running.
 * No top-up pack and no forced new subscription. The product id is not a
 * store fact.
 */
export const SINGLE_SURGE = {
  priceGbp: "2.99",
  kind: "consumable",
  plan: null,
  weeklyPlanContinues: true,
  proposedProductId: "ferro.surge.single",
  productIdVerifiedInStore: false,
  active: false,
} as const;

export const PROPOSED_PLAN_PRODUCT_IDS = {
  premium: "ferro.surge.premium.weekly",
  ultimate: "ferro.surge.ultimate.weekly",
  stardust: "ferro.surge.stardust.weekly",
  verifiedInStore: false,
} as const;

/*
 * Buying a single event is an event-card grant. It does not decide whether
 * an exhausted plan still sees surge detail on the hotspot sheet.
 */
export const ACCESS_SPLIT = {
  eventCardReopenUntil: "verified-event-end",
  eventCardReopenExtraCharge: false,
  eventCardImplemented: false,
  hotspotSheetPaidPlanOnly: true,
  exhaustedPlanHotspotDetail: "unresolved",
  singlePurchaseGrantsHotspotSheet: false,
} as const;

/* One verified store transaction may grant once, and not as both allowance and credit. */
export const FUTURE_GRANT_INVARIANT = {
  active: false,
  key: "verified-store-transaction-id",
  oneTransaction: "one-grant",
  forbids: ["allowance-and-credit", "second-grant-same-transaction"],
  automaticReplenishOn: [] as const,
} as const;

export const CALENDAR_MONTH_PROPOSALS = {
  active: false,
  ownerDecided: FREE_OPENS,
  engineeringProposals: [
    {id: "zone", choice: "Europe/London", status: "proposal"},
    {id: "boundary", choice: "civil midnight plus whole calendar months, not added hours", status: "proposal"},
    {id: "preserve-day", choice: "remember the original civil day-of-month", status: "proposal"},
    {id: "clamp", choice: "if that day is missing, use the last civil day of the month", status: "proposal"},
    {id: "leap", choice: "29 February clamps to 28 in a non-leap year and is kept for a later leap year", status: "proposal"},
    {id: "dst", choice: "a London day is a civil date, not 24 hours", status: "proposal"},
    {id: "no-drift", choice: "later opens do not move the stored anchor", status: "proposal"},
  ],
  illustrations: [
    {anchorCivil: "2026-01-31", nextCivil: "2026-02-28", note: "clamp illustration, not an active clock"},
    {anchorCivil: "2028-01-31", nextCivil: "2028-02-29", note: "leap February illustration, not an active clock"},
    {anchorCivil: "2028-02-29", nextCivil: "2028-03-29", note: "day 29 exists in March, not an active clock"},
  ],
} as const;

export function proposedCalendarBoundary(): {active: false; reason: "calendar-semantics-not-approved"} {
  return {active: false, reason: "calendar-semantics-not-approved"};
}

export function chargesForHeldSubmission(): {allowanceGrants: 0; creditGrants: 0; active: false} {
  return {allowanceGrants: 0, creditGrants: 0, active: false};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class SurgeAccessError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SurgeAccessError";
    this.code = code;
  }
}

/*
 * Firebase Admin isUid is any non-empty string of at most 128 characters.
 * A uid used as a document id must also be a legal Firestore path segment:
 * not "/", not "." or "..", and not a reserved __name__. ASCII controls are
 * rejected here so a bad id fails before a write. Hyphen, dot, and underscore
 * are valid.
 */
export function assertUid(uid: string): void {
  if (typeof uid !== "string" || uid.length < 1 || uid.length > 128) {
    throw new SurgeAccessError("bad-uid");
  }
  if (uid === "." || uid === ".." || uid.includes("/") || /^__.*__$/.test(uid)) {
    throw new SurgeAccessError("bad-uid");
  }
  for (let i = 0; i < uid.length; i += 1) {
    const code = uid.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new SurgeAccessError("bad-uid");
  }
}

export function exactKeys(data: Record<string, unknown>, keys: readonly string[]): void {
  const present = Object.keys(data).sort();
  const wanted = [...keys].sort();
  if (present.length !== wanted.length || present.some((key, index) => key !== wanted[index])) {
    throw new SurgeAccessError("bad-keys");
  }
}
