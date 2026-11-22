import * as logger from "firebase-functions/logger";
import {defineSecret, defineString} from "firebase-functions/params";
import {Firestore} from "firebase-admin/firestore";
import Stripe from "stripe";
import {ParkingPaymentError} from "./contract";

// The Stripe API key. stripeWebhook reads STRIPE_WEBHOOK_SECRET separately
// and does not create it. A live key is still refused below.
export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

// Publishable key for PaymentSheet. Not a secret. No value is stored in the repo.
// Empty until the param is set in the Cloud Functions environment.
export const stripePublishableKey = defineString("STRIPE_PUBLISHABLE_KEY", {default: ""});

// Server-only. Clients cannot read config/payments. Missing means live is off
// and the per-payment cap is the default below.
export const PAYMENTS_RUNTIME = "config/payments";

// Total charge including the Ferro fee, in pence. £50.
export const DEFAULT_MAX_PAYMENT_PENCE = 5000;

// Ferro's own Stripe account, pay@ferromaps.com. This is an account id, not a
// key. A live secret is refused unless config/payments.stripeLiveEnabled is
// exactly true. The payments config must still set testMode and this same id.
export const EXPECTED_STRIPE_ACCOUNT_ID = "acct_1UYo41K3YqihBBbk";

export type StripeKeyMode = "test" | "live";

// The only place a key mode is logged. The argument is the word test or live.
export const stripeKeyLog = {
  write(mode: StripeKeyMode): void {
    logger.info("stripe key mode", {mode});
  },
};

let acceptedAccount = false;

export function resetStripeAccountCheck(): void {
  acceptedAccount = false;
}

export async function assertFerroStripeAccount(
  retrieve: () => Promise<{id?: string}>,
): Promise<void> {
  let account: {id?: string};
  try {
    account = await retrieve();
  } catch (err) {
    logger.error("stripe account lookup failed", {
      name: err instanceof Error ? err.name : "unknown",
    });
    throw new ParkingPaymentError("unavailable", "The payment service is busy. Please try again.");
  }
  if (account.id !== EXPECTED_STRIPE_ACCOUNT_ID) {
    logger.error("stripe account is not Ferro's test account", {
      accountId: typeof account.id === "string" ? account.id : null,
    });
    throw new ParkingPaymentError("failed-precondition", "Payments aren't available right now.");
  }
}

// One successful check per process. A mismatch is never cached.
export async function ensureFerroStripeAccount(
  retrieve: () => Promise<{id?: string}>,
): Promise<void> {
  if (acceptedAccount) return;
  await assertFerroStripeAccount(retrieve);
  acceptedAccount = true;
}

export const EPHEMERAL_KEY_API_VERSION: string = Stripe.API_VERSION;

export function classifySecretKey(secretKey: string): StripeKeyMode | "other" {
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  return "other";
}

// Test keys always pass. An sk_live_ key passes only when liveAllowed is true.
// The key is never logged, and it is never put on the error.
export function assertStripeKey(secretKey: string, liveAllowed: boolean): StripeKeyMode {
  const mode = classifySecretKey(secretKey);
  if (mode === "test" || mode === "live") stripeKeyLog.write(mode);
  if (mode === "test" || (mode === "live" && liveAllowed)) return mode;
  throw new ParkingPaymentError(
    "failed-precondition",
    "Payments aren't available right now.",
  );
}

// Same refusal as before when the live switch is off.
export function assertStripeTestKey(secretKey: string): void {
  assertStripeKey(secretKey, false);
}

export function assertPublishableKey(publishableKey: string, liveAllowed: boolean): void {
  if (publishableKey.startsWith("pk_test_")) return;
  if (liveAllowed && publishableKey.startsWith("pk_live_")) return;
  throw new ParkingPaymentError(
    "failed-precondition",
    "Payments aren't available right now.",
  );
}

export async function stripeLiveEnabled(db: Firestore): Promise<boolean> {
  const snap = await db.doc(PAYMENTS_RUNTIME).get();
  return snap.get("stripeLiveEnabled") === true;
}

export async function maxPaymentPence(db: Firestore): Promise<number> {
  const snap = await db.doc(PAYMENTS_RUNTIME).get();
  const value = snap.get("maxPaymentPence");
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  return DEFAULT_MAX_PAYMENT_PENCE;
}

export function createStripeClient(secretKey: string, liveAllowed = false): Stripe {
  assertStripeKey(secretKey, liveAllowed);
  return new Stripe(secretKey, {
    apiVersion: Stripe.API_VERSION,
    typescript: true,
    maxNetworkRetries: 2,
    appInfo: {name: "FerroMaps", url: "https://ferromaps.com"},
  });
}

export async function openStripeClient(db: Firestore, secretKey: string): Promise<Stripe> {
  return createStripeClient(secretKey, await stripeLiveEnabled(db));
}
