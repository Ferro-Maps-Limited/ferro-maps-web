import {createSign, generateKeyPairSync, verify, type KeyObject} from "node:crypto";
import {APPLE_BUNDLE_ID, APPLE_SANDBOX, type DecodedSurgeTransaction, type SurgeTransactionVerifier, SurgeVerifyError} from "../src/surge/purchaseVerifier";

export interface FixtureKeys {
  publicKey: KeyObject;
  sign(payload: Record<string, unknown>): string;
}

export function fixtureKeys(): FixtureKeys {
  const {privateKey, publicKey} = generateKeyPairSync("ec", {namedCurve: "prime256v1"});
  return {
    publicKey,
    sign(payload: Record<string, unknown>): string {
      const header = Buffer.from(JSON.stringify({alg: "ES256", typ: "JWT"})).toString("base64url");
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signer = createSign("SHA256");
      signer.update(`${header}.${body}`);
      signer.end();
      const signature = signer.sign({key: privateKey, dsaEncoding: "ieee-p1363"}).toString("base64url");
      return `${header}.${body}.${signature}`;
    },
  };
}

export function sandboxPayload(input: {
  transactionId: string;
  productId: string;
  appAccountToken: string;
  purchaseDateMs: number;
  expiresDateMs?: number | null;
  bundleId?: string;
  environment?: string;
}): Record<string, unknown> {
  return {
    transactionId: input.transactionId,
    productId: input.productId,
    bundleId: input.bundleId ?? APPLE_BUNDLE_ID,
    environment: input.environment ?? APPLE_SANDBOX,
    appAccountToken: input.appAccountToken,
    purchaseDate: input.purchaseDateMs,
    expiresDate: input.expiresDateMs ?? null,
  };
}

/* Checks the ES256 signature, then returns the payload. A bad signature is bad_signature. */
export function fixtureVerifier(publicKey: KeyObject): SurgeTransactionVerifier {
  return {
    async verify(signedTransaction: string): Promise<DecodedSurgeTransaction> {
      const parts = signedTransaction.split(".");
      if (parts.length !== 3) throw new SurgeVerifyError("bad_signature");
      const [header, body, signature] = parts;
      const ok = verify(
        "sha256",
        Buffer.from(`${header}.${body}`),
        {key: publicKey, dsaEncoding: "ieee-p1363"},
        Buffer.from(signature, "base64url"),
      );
      if (!ok) throw new SurgeVerifyError("bad_signature");
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
      return {
        transactionId: typeof payload.transactionId === "string" ? payload.transactionId : "",
        productId: typeof payload.productId === "string" ? payload.productId : "",
        bundleId: typeof payload.bundleId === "string" ? payload.bundleId : "",
        environment: typeof payload.environment === "string" ? payload.environment : "",
        appAccountToken: typeof payload.appAccountToken === "string" ? payload.appAccountToken : null,
        purchaseDateMs: typeof payload.purchaseDate === "number" ? payload.purchaseDate : null,
        expiresDateMs: typeof payload.expiresDate === "number" ? payload.expiresDate : null,
      };
    },
  };
}
