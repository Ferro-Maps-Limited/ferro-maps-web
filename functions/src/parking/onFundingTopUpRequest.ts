import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {handleFundingTopUp} from "./authorityDesk";

export const onFundingTopUpRequest = onDocumentCreated(
  {
    document: "fundingTopUpRequests/{requestId}",
    region: "europe-west2",
    retry: true,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    await handleFundingTopUp(getFirestore(), snapshot.ref);
  },
);
