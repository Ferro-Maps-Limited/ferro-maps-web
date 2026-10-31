import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {createPlayClient} from "./playClient";
import {handlePlayPurchaseRequest} from "./handlePlayPurchase";

// Request-doc trigger. Callables are blocked by Domain Restricted Sharing,
// so the client creates playPurchaseRequests/{id} and listens.
// Credentials are Application Default Credentials, or PLAY_SERVICE_ACCOUNT_JSON
// when that env var is set. The secret is not bound here.
export const onPlayPurchaseRequest = onDocumentCreated(
  {
    document: "playPurchaseRequests/{requestId}",
    region: "europe-west2",
    timeoutSeconds: 60,
    memory: "256MiB",
    retry: false,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data: unknown = snap.data();
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    await handlePlayPurchaseRequest(
      getFirestore(),
      event.params.requestId,
      data as Record<string, unknown>,
      createPlayClient(),
    );
  },
);
