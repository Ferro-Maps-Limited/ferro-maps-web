import {onDocumentWritten} from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import {getFirestore} from "firebase-admin/firestore";
import {handleSubscriptionRequest} from "./appleGrant";

/**
 * subscriptionRequests/{uid} is the iOS path. The driver writes a pending
 * request; this function is what would write the Gold clock.
 *
 * There is no Apple verifier in this repo (the iOS functions repo was not
 * readable, and no secret is bound here). unverifiedAppleExpiry returns
 * null, so a deploy of this function does not grant Gold and does not
 * overwrite a writer that lives in the other codebase. When a verifier
 * returns an expiry, handleSubscriptionRequest sets subscriptionExpiresAt
 * and subscriptionSource "apple" together.
 */
export const onSubscriptionRequest = onDocumentWritten(
  {document: "subscriptionRequests/{uid}", region: "europe-west2"},
  async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after;
    if (!after?.exists) return;
    const data = after.data();
    if (!data) return;
    try {
      await handleSubscriptionRequest(getFirestore(), uid, data);
    } catch (err) {
      logger.error(`onSubscriptionRequest ${uid} failed`, err);
    }
  },
);
