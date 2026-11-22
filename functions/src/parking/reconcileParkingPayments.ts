import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {createStripeClient, ensureFerroStripeAccount, stripeSecretKey} from "./stripeClient";
import {reconcileParkingPaymentsOnce} from "./reconcile";
import {reconcileStripe} from "./stripeAdapter";

// Every five minutes, retrieve PaymentIntents still pending after two minutes
// and apply refund and dispute events since the stored cursor. This stays the
// fallback when stripeWebhook is off, late, or repeated. Both write status
// through the same settle path.
export const reconcileParkingPayments = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "Europe/London",
    region: "europe-west2",
    secrets: [stripeSecretKey],
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    try {
      const raw = createStripeClient(stripeSecretKey.value());
      await ensureFerroStripeAccount(() => raw.accounts.retrieve(null));
      await reconcileParkingPaymentsOnce(getFirestore(), reconcileStripe(raw), Date.now());
    } catch (err) {
      logger.error("reconcileParkingPayments failed", {
        name: err instanceof Error ? err.name : "unknown",
      });
      throw err;
    }
  },
);
