import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {createStripeClient, stripeSecretKey} from "./stripeClient";
import {reconcileParkingPaymentsOnce} from "./reconcile";
import {reconcileStripe} from "./stripeAdapter";

// Every five minutes, retrieve PaymentIntents still pending after two minutes
// and apply refund and dispute events since the stored cursor. This is the
// status source of truth. There is no inbound Stripe webhook.
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
      const stripe = reconcileStripe(createStripeClient(stripeSecretKey.value()));
      await reconcileParkingPaymentsOnce(getFirestore(), stripe, Date.now());
    } catch (err) {
      logger.error("reconcileParkingPayments failed", {
        name: err instanceof Error ? err.name : "unknown",
      });
      throw err;
    }
  },
);
