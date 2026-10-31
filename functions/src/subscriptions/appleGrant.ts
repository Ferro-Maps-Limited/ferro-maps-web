import {Firestore, Timestamp} from "firebase-admin/firestore";

/**
 * StoreKit's Gold clock. WEB-BE-16: whenever this writer sets
 * subscriptionExpiresAt it also sets subscriptionSource to "apple".
 *
 * The backend contract's Play section says the StoreKit writer uses
 * "appstore". This string is the WEB-BE-16 ruling. Play only pulls the
 * clock back when subscriptionSource is "play", so "apple" is left alone.
 */
export const APPLE_SUBSCRIPTION_SOURCE = "apple" as const;

export interface AppleClockPatch {
  subscriptionExpiresAt: Timestamp;
  subscriptionSource: typeof APPLE_SUBSCRIPTION_SOURCE;
}

export function appleClockPatch(expiresAt: Timestamp): AppleClockPatch {
  return {
    subscriptionExpiresAt: expiresAt,
    subscriptionSource: APPLE_SUBSCRIPTION_SOURCE,
  };
}

/**
 * Returns an expiry only after Apple has been asked. This repo has no
 * Apple shared secret and does not trust the client document, so the
 * default verifier returns null and the user document is not written.
 */
export type AppleVerifier = (
  data: Record<string, unknown>,
) => Promise<Timestamp | null>;

export const unverifiedAppleExpiry: AppleVerifier = async () => null;

// Apply a verified StoreKit expiry. The patch is the only user write:
// a subscriptionSource on the request document is ignored.
export async function handleSubscriptionRequest(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
  verify: AppleVerifier = unverifiedAppleExpiry,
): Promise<void> {
  if (data.status !== "pending") return;
  const expiresAt = await verify(data);
  if (!expiresAt) return;
  const patch = appleClockPatch(expiresAt);
  await db.collection("users").doc(uid).update({
    subscriptionExpiresAt: patch.subscriptionExpiresAt,
    subscriptionSource: patch.subscriptionSource,
  });
}
