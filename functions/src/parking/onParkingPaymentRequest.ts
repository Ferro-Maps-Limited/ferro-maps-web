import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {createStripeClient, stripeSecretKey} from "./stripeClient";
import {runParkingPaymentRequest, type ParkingStripe} from "./payments";

// Prices a stay or confirms one. There is no callable and no inbound webhook.
// Confirm is a new document `{paymentId}_confirm`. Create also writes
// parkingPayments/{paymentIntentId} at status `created`, so the reconciler
// can finish a payment whose confirm never arrives.
export const onParkingPaymentRequest = onDocumentCreated(
  {
    document: "parkingPaymentRequests/{requestId}",
    region: "europe-west2",
    secrets: [stripeSecretKey],
    retry: false,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const stripe = createStripeClient(stripeSecretKey.value()) as unknown as ParkingStripe;
    await runParkingPaymentRequest(getFirestore(), stripe, snapshot.ref);
  },
);
