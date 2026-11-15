import * as logger from "firebase-functions/logger";
import {defineSecret} from "firebase-functions/params";
import Stripe from "stripe";
import {ParkingPaymentError} from "./contract";

// The only Stripe secret. There is no webhook signing secret.
export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

// Ferro's own Stripe account, pay@ferromaps.com. This is an account id, not a
// key. Test mode only: createStripeClient refuses a live secret, and the
// payments config must set testMode and this same id.
export const EXPECTED_STRIPE_ACCOUNT_ID = "acct_1UYo41K3YqihBBbk";

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

// Test mode until live payments are explicitly enabled. A live key is refused
// before any Stripe call. The value is never logged.
export function assertStripeTestKey(secretKey: string): void {
  if (!/^(sk|rk)_test_/.test(secretKey)) {
    throw new ParkingPaymentError(
      "failed-precondition",
      "Payments aren't available right now.",
    );
  }
}

export function createStripeClient(secretKey: string): Stripe {
  assertStripeTestKey(secretKey);
  return new Stripe(secretKey, {
    apiVersion: Stripe.API_VERSION,
    typescript: true,
    maxNetworkRetries: 2,
    appInfo: {name: "FerroMaps", url: "https://ferromaps.com"},
  });
}
