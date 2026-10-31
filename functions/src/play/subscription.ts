import {createHash} from "crypto";

/**
 * Named Secret Manager placeholder. Read from the environment when present.
 * This module never calls `secrets:set`, and the functions do not bind the
 * secret, so a missing value falls through to Application Default Credentials.
 */
export const PLAY_SERVICE_ACCOUNT_SECRET = "PLAY_SERVICE_ACCOUNT_JSON";

export const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export const PLAY_REQUESTS = "playPurchaseRequests";
export const PLAY_PURCHASES = "playPurchases";
export const PLAY_SECRETS = "playPurchaseSecrets";
export const PLAY_CURSOR = "playSync/cursor";
export const PLAY_CONFIG_PATH = "config/playSubscriptions";

export const RECONCILE_BATCH = 50;
export const POLL_INTERVAL_MS = 60 * 60 * 1000;
/** Inside Play's 3-day acknowledgement window. Older pending requests are dropped. */
export const UNACKNOWLEDGED_REQUEST_MS = 72 * 60 * 60 * 1000;
export const VOIDED_OVERLAP_MS = 5 * 60 * 1000;
/** The voided-purchases API rejects a start older than 30 days. */
export const VOIDED_MAX_LOOKBACK_MS = (30 * 24 * 60 * 60 * 1000) - (60 * 1000);

export type SubscriptionState =
  | "active"
  | "grace"
  | "canceled"
  | "on_hold"
  | "paused"
  | "expired"
  | "pending"
  | "refunded";

export interface PlayConfig {
  enabled: boolean;
  packageName: string;
  productIds: string[];
}

export interface UserClock {
  expiresAtMs: number | null;
  source: string | null;
  tokenHash: string | null;
}

export interface ClockPatch {
  subscriptionExpiresAtMs: number;
  subscriptionSource?: "play";
  playPurchaseTokenHash?: string;
  subscriptionProductId?: string;
}

export interface EntitlementDecision {
  status: "done" | "error";
  errorCode?: string;
  error?: string;
  expiresAtMs: number | null;
  user: ClockPatch | null;
  poll: boolean;
}

export interface ParsedPurchaseRequest {
  uid: string;
  purchaseToken: string;
  productId: string;
  packageName: string;
  appVersion: string;
}

const ERROR_TEXT: Record<string, string> = {
  "flag-off": "Gold purchases are not available right now.",
  "failed-precondition": "Gold purchases are not available right now.",
  "invalid-payload": "This purchase could not be checked.",
  "invalid-token": "This purchase could not be checked.",
  "not-found": "This purchase could not be checked.",
  "package-mismatch": "This purchase could not be checked.",
  "product-mismatch": "This purchase is not FerroMaps Gold.",
  "already-linked": "This purchase is already linked to another account.",
  "expired": "This subscription has ended.",
  "refunded": "This subscription was refunded.",
  "on-hold": "Update the payment method in Google Play to keep Gold.",
  "paused": "This subscription is paused.",
  "pending": "This purchase is not finished yet.",
  "account-mismatch": "This purchase does not match this account.",
  "ack-expired": "This purchase was not confirmed in time.",
  "unavailable": "Try again in a moment.",
  "deadline-exceeded": "Try again in a moment.",
  "internal": "Try again in a moment.",
};

// SHA-256 hex of the raw token. The ledger id is this, never the token.
export function purchaseTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// SHA-256 hex of the uid. The client sends this as Play's obfuscated account id.
export function uidAccountHash(uid: string): string {
  return createHash("sha256").update(uid, "utf8").digest("hex");
}

export function errorText(code: string): string {
  return ERROR_TEXT[code] ?? ERROR_TEXT.internal;
}

export function normalizePlayState(playState: string): SubscriptionState {
  switch (playState) {
  case "SUBSCRIPTION_STATE_ACTIVE":
    return "active";
  case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
    return "grace";
  case "SUBSCRIPTION_STATE_CANCELED":
    return "canceled";
  case "SUBSCRIPTION_STATE_ON_HOLD":
    return "on_hold";
  case "SUBSCRIPTION_STATE_PAUSED":
    return "paused";
  case "SUBSCRIPTION_STATE_PENDING":
    return "pending";
  case "SUBSCRIPTION_STATE_EXPIRED":
  case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
    return "expired";
  default:
    return "expired";
  }
}

// Active, grace, and a cancel that has not reached its period end.
export function isEntitled(state: SubscriptionState, expiryMs: number, nowMs: number): boolean {
  if (state !== "active" && state !== "grace" && state !== "canceled") return false;
  return expiryMs > nowMs;
}

export function shouldPoll(state: SubscriptionState, expiryMs: number, nowMs: number): boolean {
  if (state === "on_hold" || state === "paused" || state === "pending") return true;
  if (state === "active" || state === "grace" || state === "canceled") return expiryMs > nowMs;
  return false;
}

export function errorCodeForState(state: SubscriptionState): string {
  switch (state) {
  case "on_hold":
    return "on-hold";
  case "paused":
    return "paused";
  case "pending":
    return "pending";
  case "refunded":
    return "refunded";
  default:
    return "expired";
  }
}

// Forward-only Gold clock. A later Play expiry extends it and takes ownership.
// A revoke pulls it earlier only when this token already owns it.
export function decideEntitlement(input: {
  nowMs: number;
  state: SubscriptionState;
  expiryMs: number;
  tokenHash: string;
  productId: string;
  user: UserClock;
}): EntitlementDecision {
  const poll = shouldPoll(input.state, input.expiryMs, input.nowMs);
  if (isEntitled(input.state, input.expiryMs, input.nowMs)) {
    const current = input.user.expiresAtMs ?? 0;
    const user: ClockPatch | null = input.expiryMs > current ? {
      subscriptionExpiresAtMs: input.expiryMs,
      subscriptionSource: "play",
      playPurchaseTokenHash: input.tokenHash,
      subscriptionProductId: input.productId,
    } : null;
    return {status: "done", expiresAtMs: input.expiryMs, user, poll};
  }

  const code = errorCodeForState(input.state);
  const owns = input.user.source === "play" && input.user.tokenHash === input.tokenHash;
  let revokeMs: number | null = null;
  if (owns) {
    const target = (input.state === "paused" || input.state === "on_hold") ?
      input.nowMs :
      Math.min(input.expiryMs, input.nowMs);
    const current = input.user.expiresAtMs;
    if (current == null || current > target) revokeMs = target;
  }
  return {
    status: "error",
    errorCode: code,
    error: errorText(code),
    expiresAtMs: input.expiryMs,
    user: revokeMs == null ? null : {subscriptionExpiresAtMs: revokeMs},
    poll,
  };
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 1 || value.length > max) return null;
  if (/\s/.test(value)) return null;
  return value;
}

// Client create shape. Null means invalid-payload.
export function parsePurchaseRequest(data: Record<string, unknown>): ParsedPurchaseRequest | null {
  if (data.v !== 1) return null;
  if (data.status !== "pending") return null;
  if (data.platform !== "android") return null;
  const uid = boundedString(data.uid, 128);
  const purchaseToken = boundedString(data.purchaseToken, 4096);
  const productId = boundedString(data.productId, 128);
  const packageName = boundedString(data.packageName, 256);
  if (!uid || !purchaseToken || !productId || !packageName) return null;
  if (typeof data.appVersion !== "string") return null;
  if (data.appVersion.length < 1 || data.appVersion.length > 32) return null;
  return {uid, purchaseToken, productId, packageName, appVersion: data.appVersion};
}

// A string token we can hash and then delete, even when the rest is invalid.
export function hashableToken(data: Record<string, unknown>): string | null {
  return boundedString(data.purchaseToken, 4096);
}
