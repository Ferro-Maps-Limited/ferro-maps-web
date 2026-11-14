export const APPLE_BUNDLE_ID = "com.ferromaps.FerroMaps";
export const APPLE_SANDBOX = "Sandbox";
export const APPLE_PRODUCTION = "Production";

/* Secret Manager name. The value is PEM root certificates, added by Nafiu. */
export const APPLE_ROOT_CAS_SECRET = "APPLE_APP_STORE_ROOT_CAS";

export const SURGE_PRODUCT_PREMIUM = "ferro.surge.premium.weekly";
export const SURGE_PRODUCT_ULTIMATE = "ferro.surge.ultimate.weekly";
export const SURGE_PRODUCT_STARDUST = "ferro.surge.stardust.weekly";
export const SURGE_PRODUCT_SINGLE = "ferro.surge.single";

export class SurgeVerifyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface DecodedSurgeTransaction {
  transactionId: string;
  productId: string;
  bundleId: string;
  environment: string;
  appAccountToken: string | null;
  purchaseDateMs: number | null;
  expiresDateMs: number | null;
}

/* Signature check. The production implementation is Apple's library. Tests inject their own. */
export interface SurgeTransactionVerifier {
  verify(signedTransaction: string): Promise<DecodedSurgeTransaction>;
}
