import {logger} from "firebase-functions/logger";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {defineSecret} from "firebase-functions/params";
import {FieldValue, Timestamp, type DocumentReference, type Firestore, getFirestore} from "firebase-admin/firestore";
import {surgeAccountToken} from "./accountToken";
import {appleSurgeVerifier, rootCertificatesFromSecret} from "./appleVerifier";
import {
  APPLE_BUNDLE_ID,
  APPLE_PRODUCTION,
  APPLE_ROOT_CAS_SECRET,
  APPLE_SANDBOX,
  SURGE_PRODUCT_PREMIUM,
  SURGE_PRODUCT_SINGLE,
  SURGE_PRODUCT_STARDUST,
  SURGE_PRODUCT_ULTIMATE,
  SurgeVerifyError,
  type DecodedSurgeTransaction,
  type SurgeTransactionVerifier,
} from "./purchaseVerifier";
import {readPlannerUnlockConfig} from "./onHotspotUnlockRequest";
import {
  SURGE_LEDGER,
  purchaseCreditFields,
  purchaseCreditId,
} from "./surgeLedger";
import {refreshSurgeStatus} from "./surgeStatus";

export const SURGE_PURCHASE_REQUESTS = "surgePurchaseRequests";
export const SURGE_PURCHASE_CLAIMS = "surgePurchaseClaims";
export const SURGE_PURCHASES_DOC = "config/surgePurchases";

const appleRootCas = defineSecret(APPLE_ROOT_CAS_SECRET);

const SUBSCRIPTIONS: Record<string, "premium" | "ultimate" | "stardust"> = {
  [SURGE_PRODUCT_PREMIUM]: "premium",
  [SURGE_PRODUCT_ULTIMATE]: "ultimate",
  [SURGE_PRODUCT_STARDUST]: "stardust",
};

function knownProduct(productId: string): boolean {
  return productId === SURGE_PRODUCT_SINGLE || productId in SUBSCRIPTIONS;
}

async function purchasesEnabled(db: Firestore): Promise<boolean> {
  const snap = await db.doc(SURGE_PURCHASES_DOC).get();
  return snap.get("enabled") === true;
}

async function fail(
  requestRef: DocumentReference,
  now: Date,
  reason: string,
): Promise<void> {
  await requestRef.update({
    status: "failed",
    reason,
    completedAt: Timestamp.fromDate(now),
  });
}

function environmentReason(environment: string): string | null {
  if (environment === APPLE_SANDBOX) return null;
  if (environment === APPLE_PRODUCTION) return "production_environment";
  return "wrong_environment";
}

function checkTransaction(
  uid: string,
  requestProductId: string,
  transactionId: string,
  decoded: DecodedSurgeTransaction,
): string | null {
  const environment = environmentReason(decoded.environment);
  if (environment) return environment;
  if (decoded.bundleId !== APPLE_BUNDLE_ID) return "wrong_bundle";
  if (decoded.transactionId !== transactionId) return "transaction_mismatch";
  if (!knownProduct(decoded.productId) || decoded.productId !== requestProductId) {
    return "product_mismatch";
  }
  const expected = surgeAccountToken(uid);
  const actual = (decoded.appAccountToken ?? "").toLowerCase();
  if (actual !== expected) return "app_account_token_mismatch";
  if (decoded.productId !== SURGE_PRODUCT_SINGLE) {
    if (decoded.purchaseDateMs == null || decoded.expiresDateMs == null) return "invalid";
  }
  return null;
}

/*
 * One purchase document. Off unless config/surgePurchases.enabled is exactly
 * true. Sandbox only. The ledger and the user plan fields are written here.
 * The unlock decision does not read surge_status.
 */
export async function handleSurgePurchaseRequest(
  db: Firestore,
  requestRef: DocumentReference,
  verifier: SurgeTransactionVerifier,
  now: Date,
): Promise<void> {
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists) return;
  const request = requestSnap.data() ?? {};
  if (request.status === "verified" || request.status === "failed") return;
  if (request.status !== "pending") return;
  const uid = typeof request.uid === "string" ? request.uid : "";
  const productId = typeof request.productId === "string" ? request.productId : "";
  const signedTransaction = typeof request.signedTransaction === "string" ? request.signedTransaction : "";
  if (!uid || !productId || !signedTransaction) {
    await fail(requestRef, now, "invalid");
    return;
  }
  let enabled = false;
  try {
    enabled = await purchasesEnabled(db);
  } catch (err) {
    logger.error("onSurgePurchaseRequest could not read the switch", err);
    await fail(requestRef, now, "error");
    return;
  }
  if (!enabled) {
    await fail(requestRef, now, "flag_off");
    return;
  }
  let decoded: DecodedSurgeTransaction;
  try {
    decoded = await verifier.verify(signedTransaction);
  } catch (err) {
    const reason = err instanceof SurgeVerifyError ? err.reason : "bad_signature";
    await fail(requestRef, now, reason);
    return;
  }
  const problem = checkTransaction(uid, productId, requestRef.id, decoded);
  if (problem) {
    await fail(requestRef, now, problem);
    return;
  }
  const claimRef = db.collection(SURGE_PURCHASE_CLAIMS).doc(requestRef.id);
  let applied = false;
  try {
    applied = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(requestRef);
      const claim = await tx.get(claimRef);
      const userRef = db.collection("users").doc(uid);
      await tx.get(userRef);
      const purchaseRef = userRef.collection(SURGE_LEDGER).doc(purchaseCreditId(requestRef.id));
      const purchaseSnap = await tx.get(purchaseRef);
      if (!fresh.exists || fresh.get("status") !== "pending") return false;
      const claimedUid = claim.get("uid");
      if (typeof claimedUid === "string" && claimedUid !== uid) {
        tx.update(requestRef, {
          status: "failed",
          reason: "already_claimed",
          completedAt: Timestamp.fromDate(now),
        });
        return false;
      }
      if (claim.exists) {
        tx.update(requestRef, {
          status: "verified",
          reason: FieldValue.delete(),
          completedAt: Timestamp.fromDate(now),
        });
        return false;
      }
      const plan = SUBSCRIPTIONS[decoded.productId];
      if (plan && decoded.purchaseDateMs != null && decoded.expiresDateMs != null) {
        const patch: Record<string, unknown> = {
          surgePlan: plan,
          subscriptionExpiresAt: Timestamp.fromMillis(decoded.expiresDateMs),
          subscriptionPeriodStart: Timestamp.fromMillis(decoded.purchaseDateMs),
        };
        if (plan === "stardust") {
          patch.surgeUnlimitedUntil = Timestamp.fromMillis(decoded.expiresDateMs);
        }
        tx.set(userRef, patch, {merge: true});
      } else if (decoded.productId === SURGE_PRODUCT_SINGLE && !purchaseSnap.exists) {
        tx.set(purchaseRef, purchaseCreditFields({
          transactionId: requestRef.id,
          productId: decoded.productId,
          now,
        }));
      }
      tx.set(claimRef, {uid, productId: decoded.productId, createdAt: Timestamp.fromDate(now)});
      tx.update(requestRef, {
        status: "verified",
        reason: FieldValue.delete(),
        completedAt: Timestamp.fromDate(now),
      });
      return true;
    });
  } catch (err) {
    logger.error("onSurgePurchaseRequest failed", err);
    await fail(requestRef, now, "error");
    return;
  }
  if (!applied) return;
  try {
    const config = await readPlannerUnlockConfig(db);
    await refreshSurgeStatus(
      db,
      uid,
      now,
      config.premiumMonthlyCredits,
      config.ultimateMonthlyCredits,
    );
  } catch (err) {
    logger.error("onSurgePurchaseRequest could not refresh surge status", err);
  }
}

export const onSurgePurchaseRequest = onDocumentCreated(
  {
    document: `${SURGE_PURCHASE_REQUESTS}/{transactionId}`,
    region: "europe-west2",
    retry: false,
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: [appleRootCas],
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const roots = rootCertificatesFromSecret(appleRootCas.value());
    await handleSurgePurchaseRequest(
      getFirestore(),
      snapshot.ref,
      appleSurgeVerifier(roots),
      new Date(),
    );
  },
);
