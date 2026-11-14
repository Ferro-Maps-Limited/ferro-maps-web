import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import {
  APPLE_BUNDLE_ID,
  APPLE_PRODUCTION,
  APPLE_SANDBOX,
  SurgeVerifyError,
  type SurgeTransactionVerifier,
} from "./purchaseVerifier";

/* PEM text from Secret Manager, one or more Apple root certificates. */
export function rootCertificatesFromSecret(value: string): Buffer[] {
  const pems = value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return pems.map((pem) => {
    const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    return Buffer.from(body, "base64");
  });
}

/*
 * Production path. Roots come from the APPLE_ROOT_CAS_SECRET value.
 * Online revocation checks stay off. The library is pinned to Sandbox,
 * so a Production transaction fails before a grant.
 */
export function appleSurgeVerifier(rootCertificates: Buffer[]): SurgeTransactionVerifier {
  const verifier = new SignedDataVerifier(
    rootCertificates,
    false,
    Environment.SANDBOX,
    APPLE_BUNDLE_ID,
  );
  return {
    async verify(signedTransaction: string) {
      try {
        const decoded = await verifier.verifyAndDecodeTransaction(signedTransaction);
        const environment = String(decoded.environment ?? "");
        if (environment === APPLE_PRODUCTION) throw new SurgeVerifyError("production_environment");
        if (environment !== APPLE_SANDBOX) throw new SurgeVerifyError("wrong_environment");
        return {
          transactionId: decoded.transactionId ?? "",
          productId: decoded.productId ?? "",
          bundleId: decoded.bundleId ?? "",
          environment,
          appAccountToken: decoded.appAccountToken ?? null,
          purchaseDateMs: typeof decoded.purchaseDate === "number" ? decoded.purchaseDate : null,
          expiresDateMs: typeof decoded.expiresDate === "number" ? decoded.expiresDate : null,
        };
      } catch (err) {
        if (err instanceof SurgeVerifyError) throw err;
        if (err instanceof VerificationException) {
          if (err.status === VerificationStatus.INVALID_ENVIRONMENT) {
            throw new SurgeVerifyError("production_environment");
          }
          if (err.status === VerificationStatus.INVALID_APP_IDENTIFIER) {
            throw new SurgeVerifyError("wrong_bundle");
          }
        }
        throw new SurgeVerifyError("bad_signature");
      }
    },
  };
}
