import {createHash} from "node:crypto";
import {Environment, SignedDataVerifier, VerificationException} from "@apple/app-store-server-library";
import type {JWSTransactionDecodedPayload} from "@apple/app-store-server-library";
import {PINNED_APPLE_ROOTS} from "./appleRoots.js";
import {BILLING_ACCOUNTS} from "./accountBinding.js";
import {IAP_REQUESTS} from "./iapRequest.js";
import {putPurchaseEvidence, type EvidenceDraft} from "./purchaseEvidence.js";
import {markLibraryVerified} from "./verifiedMark.js";
import {SIGNED_TRANSACTION_MAX, SIGNED_TRANSACTION_MIN, SurgeAccessError, isUuid} from "./contract.js";
import type {Firestore} from "firebase-admin/firestore";

/*
 * Real Apple signed-transaction check using Apple's App Store Server Library
 * and the pinned Apple root certificates. Online OCSP checks stay on.
 * There is no App Store Connect configuration in this repo, so the
 * authoritative config is missing and the purchase path fails closed.
 * This is not a surge grant and it does not finish the Apple transaction.
 */

export const APPLE_ONLINE_CHECKS = true;

export interface AuthoritativeAppleConfig {
  bundleId: string;
  environment: Environment.SANDBOX | Environment.PRODUCTION;
  appAppleId: number | null;
  productIds: readonly string[];
}

export function loadAuthoritativeAppleConfig(): null {
  return null;
}

export function pinnedAppleRootBuffers(): Buffer[] {
  return PINNED_APPLE_ROOTS.map((root) => Buffer.from(root.derBase64, "base64"));
}

export function assertAuthoritativeConfig(
  config: AuthoritativeAppleConfig | null,
): asserts config is AuthoritativeAppleConfig {
  if (config == null) throw new SurgeAccessError("apple-config-missing");
  if (config.environment !== Environment.SANDBOX && config.environment !== Environment.PRODUCTION) {
    throw new SurgeAccessError("apple-environment-rejected");
  }
  if (typeof config.bundleId !== "string" || config.bundleId.length < 1 || config.bundleId.length > 256) {
    throw new SurgeAccessError("apple-config-missing");
  }
  if (config.environment === Environment.PRODUCTION) {
    if (config.appAppleId == null || !Number.isInteger(config.appAppleId) || config.appAppleId <= 0) {
      throw new SurgeAccessError("apple-config-missing");
    }
  }
  if (!Array.isArray(config.productIds) || config.productIds.length === 0) {
    throw new SurgeAccessError("product-allowlist-missing");
  }
}

export interface VerifiedAppleTransaction {
  kind: "apple-library";
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  environment: string;
  productId: string;
  appAccountToken: string;
}

function payloadOk(payload: unknown): payload is string {
  return typeof payload === "string" &&
    payload.length >= SIGNED_TRANSACTION_MIN &&
    payload.length <= SIGNED_TRANSACTION_MAX;
}

function snapshotHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/*
 * Checks one signed transaction against the pinned Apple roots.
 * enableOnlineChecks is true: a chain that reaches an Apple root is also
 * checked with Apple's OCSP responders. A forged blob fails before that
 * network call. LocalTesting and Xcode are rejected because the library
 * skips signature checks for those environments.
 */
export async function verifyAppleSignedTransaction(
  signedTransaction: string,
  config: AuthoritativeAppleConfig,
): Promise<VerifiedAppleTransaction> {
  assertAuthoritativeConfig(config);
  if (!payloadOk(signedTransaction)) throw new SurgeAccessError("bad-payload");
  const verifier = new SignedDataVerifier(
    pinnedAppleRootBuffers(),
    APPLE_ONLINE_CHECKS,
    config.environment,
    config.bundleId,
    config.appAppleId ?? undefined,
  );
  let decoded: JWSTransactionDecodedPayload;
  try {
    decoded = await verifier.verifyAndDecodeTransaction(signedTransaction);
  } catch (err) {
    if (err instanceof VerificationException || err instanceof Error) {
      throw new SurgeAccessError("apple-verification-failed");
    }
    throw new SurgeAccessError("apple-verification-failed");
  }
  const verified = assessDecodedClaims(decoded, config);
  markLibraryVerified(verified);
  return verified;
}

export function assessDecodedClaims(
  decoded: JWSTransactionDecodedPayload,
  config: AuthoritativeAppleConfig,
): VerifiedAppleTransaction {
  const transactionId = decoded.transactionId ?? "";
  const originalTransactionId = decoded.originalTransactionId ?? "";
  const productId = decoded.productId ?? "";
  const bundleId = decoded.bundleId ?? "";
  const appAccountToken = decoded.appAccountToken ?? "";
  if (!transactionId || transactionId.includes("/") || transactionId.length > 128) {
    throw new SurgeAccessError("apple-verification-failed");
  }
  if (!originalTransactionId || originalTransactionId.includes("/") || originalTransactionId.length > 128) {
    throw new SurgeAccessError("apple-verification-failed");
  }
  if (!productId || !config.productIds.includes(productId)) throw new SurgeAccessError("product-not-allowed");
  if (bundleId !== config.bundleId || decoded.environment !== config.environment) {
    throw new SurgeAccessError("apple-verification-failed");
  }
  if (!isUuid(appAccountToken)) throw new SurgeAccessError("account-token-mismatch");
  if (decoded.revocationDate != null || decoded.revocationReason != null) {
    throw new SurgeAccessError("revoked-or-refunded");
  }
  const verified: VerifiedAppleTransaction = {
    kind: "apple-library",
    transactionId,
    originalTransactionId,
    bundleId,
    environment: config.environment,
    productId,
    appAccountToken,
  };
  return verified;
}

export async function validateAdmittedApplePurchase(
  db: Firestore,
  requestId: string,
  authUid: string,
): Promise<void> {
  const config = loadAuthoritativeAppleConfig();
  await acceptVerifiedPurchase(db, requestId, authUid, config);
}

/*
 * Reads the admitted stored request and the server binding. It does not
 * take a signed blob, a product list, or an account token from the caller.
 */
export async function acceptVerifiedPurchase(
  db: Firestore,
  requestId: string,
  authUid: string,
  config: AuthoritativeAppleConfig | null,
): Promise<void> {
  assertAuthoritativeConfig(config);
  if (!isUuid(requestId)) throw new SurgeAccessError("bad-request-id");
  const request = await db.collection(IAP_REQUESTS).doc(requestId).get();
  if (!request.exists) throw new SurgeAccessError("request-missing");
  const body = request.data() as Record<string, unknown>;
  if (body.uid !== authUid) throw new SurgeAccessError("owner-mismatch");
  if (body.admitted !== true) throw new SurgeAccessError("unadmitted");
  if (body.platform !== "apple" || body.v !== 1) throw new SurgeAccessError("stored-shape");
  if (!payloadOk(body.signedTransaction)) throw new SurgeAccessError("bad-payload");
  const binding = await db.collection(BILLING_ACCOUNTS).doc(authUid).get();
  const boundToken = binding.get("appAccountToken");
  if (typeof boundToken !== "string") throw new SurgeAccessError("binding-missing");
  const verified = await verifyAppleSignedTransaction(body.signedTransaction, config);
  if (verified.appAccountToken !== boundToken) throw new SurgeAccessError("account-token-mismatch");
  const draft: EvidenceDraft = {
    provenance: "apple-library",
    transactionId: verified.transactionId,
    originalTransactionId: verified.originalTransactionId,
    uid: authUid,
    appAccountToken: verified.appAccountToken,
    bundleId: verified.bundleId,
    environment: verified.environment,
    productId: verified.productId,
    requestId,
    snapshotSha256: snapshotHash(body.signedTransaction),
  };
  await putPurchaseEvidence(db, draft, verified);
}
