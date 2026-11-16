import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {handleAuthorityAction} from "./authorityDesk";
import {refundStripe} from "./stripeAdapter";
import {createStripeClient, ensureFerroStripeAccount, stripeSecretKey} from "./stripeClient";

export const onAuthorityPaymentActionRequest = onDocumentCreated(
  {
    document: "authorityPaymentActionRequests/{requestId}",
    region: "europe-west2",
    secrets: [stripeSecretKey],
    retry: true,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const raw = createStripeClient(stripeSecretKey.value());
    await ensureFerroStripeAccount(() => raw.accounts.retrieve(null));
    await handleAuthorityAction(getFirestore(), refundStripe(raw), snapshot.ref);
  },
);
