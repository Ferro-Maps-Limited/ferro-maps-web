import {onDocumentCreated, onDocumentUpdated} from "firebase-functions/v2/firestore";
import {DocumentReference, Firestore, getFirestore} from "firebase-admin/firestore";
import {createStripeClient, stripeSecretKey} from "./stripeClient";
import {acknowledgeOperatorForward, failPendingRequest, runParkingPaymentRequest} from "./payments";
import {parkingStripe} from "./stripeAdapter";
import {isPaymentIntentId} from "./contract";

// Prices a stay or confirms one. There is no callable and no inbound webhook.
// Confirm is a new document `{paymentId}_confirm`. Create also writes
// parkingPayments/{paymentIntentId} at status `created`, so the reconciler
// can finish a payment whose confirm never arrives.
// Client creation stays inside the try so a rejected key still finishes the request.
export async function handleParkingPaymentRequest(
  db: Firestore,
  secretKey: string,
  requestRef: DocumentReference,
): Promise<void> {
  try {
    const stripe = parkingStripe(createStripeClient(secretKey));
    await runParkingPaymentRequest(db, stripe, requestRef);
  } catch (err) {
    await failPendingRequest(requestRef, err);
  }
}

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
    try {
      await handleParkingPaymentRequest(getFirestore(), stripeSecretKey.value(), snapshot.ref);
    } catch (err) {
      await failPendingRequest(snapshot.ref, err);
    }
  },
);

// The operator job sets ackedAt with the Admin SDK. This deletes the plate doc.
export const onOperatorForwardAcked = onDocumentUpdated(
  {
    document: "operatorForwards/{paymentIntentId}",
    region: "europe-west2",
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.get("ackedAt") == null) return;
    const paymentIntentId = event.params.paymentIntentId;
    if (!isPaymentIntentId(paymentIntentId)) return;
    await acknowledgeOperatorForward(getFirestore(), paymentIntentId);
  },
);
