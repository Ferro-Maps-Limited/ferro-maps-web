import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {createStripeClient, stripeSecretKey} from "./stripeClient";
import {reconcileParkingPaymentsOnce, type ReconcileStripe} from "./reconcile";

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
    const stripe = createStripeClient(stripeSecretKey.value()) as unknown as ReconcileStripe;
    await reconcileParkingPaymentsOnce(getFirestore(), stripe, Date.now());
  },
);
