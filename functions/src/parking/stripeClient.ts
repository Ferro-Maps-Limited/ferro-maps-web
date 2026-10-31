import {defineSecret} from "firebase-functions/params";
import Stripe from "stripe";
import {ParkingPaymentError} from "./contract";

// The only Stripe secret. There is no webhook signing secret.
export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

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
