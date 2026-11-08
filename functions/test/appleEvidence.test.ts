import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {Environment} from "@apple/app-store-server-library";
import {issueSurgeAccountBinding} from "../src/surgeAccess/accountBinding.js";
import {
  acceptVerifiedPurchase,
  assessDecodedClaims,
  validateAdmittedApplePurchase,
  verifyAppleSignedTransaction,
  type AuthoritativeAppleConfig,
} from "../src/surgeAccess/appleValidation.js";
import {holdSurgeIapRequest} from "../src/surgeAccess/iapRequest.js";
import {PURCHASE_EVIDENCE, putPurchaseEvidence} from "../src/surgeAccess/purchaseEvidence.js";
import {SurgeAccessError} from "../src/surgeAccess/contract.js";
import {testDb} from "./support.js";

const SENTINEL = "forged.not-an-apple-transaction." + "x".repeat(40);
const UID = "appleuser0001";
const REQUEST = "abababab-cdcd-4efe-8f0f-121212121212";

/* Not an App Store Connect configuration. Named so a failure cannot be read as our app. */
const EXAMPLE: AuthoritativeAppleConfig = {
  bundleId: "example.unverified.app",
  environment: Environment.SANDBOX,
  appAppleId: null,
  productIds: ["example-unverified-product"],
};

function code(err: unknown): string {
  assert.ok(err instanceof SurgeAccessError);
  assert.equal(err.message.includes(SENTINEL), false);
  assert.equal(err.message.includes("example-unverified-product"), false);
  return err.code;
}

describe("Apple signed transaction validation", () => {
  it("fails closed without server app configuration", async () => {
    const db = testDb("demo-surge-access");
    await assert.rejects(validateAdmittedApplePurchase(db, REQUEST, UID), (err) => code(err) === "apple-config-missing");
    await assert.rejects(
      acceptVerifiedPurchase(db, REQUEST, UID, {...EXAMPLE, productIds: []}),
      (err) => code(err) === "product-allowlist-missing",
    );
    await assert.rejects(
      acceptVerifiedPurchase(db, REQUEST, UID, {
        bundleId: EXAMPLE.bundleId,
        environment: Environment.PRODUCTION,
        appAppleId: null,
        productIds: EXAMPLE.productIds,
      }),
      (err) => code(err) === "apple-config-missing",
    );
    await assert.rejects(
      verifyAppleSignedTransaction(SENTINEL, {
        ...EXAMPLE,
        environment: Environment.LOCAL_TESTING as AuthoritativeAppleConfig["environment"],
      }),
      (err) => code(err) === "apple-environment-rejected",
    );
  });

  it("rejects a forged blob with the pinned Apple roots and does not echo it", async () => {
    await assert.rejects(
      verifyAppleSignedTransaction(SENTINEL, EXAMPLE),
      (err) => code(err) === "apple-verification-failed",
    );
    const fakeJwt = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0cmFuc2FjdGlvbklkIjoiMSJ9.bm90LWFwcGxl";
    await assert.rejects(
      verifyAppleSignedTransaction(fakeJwt.padEnd(64, "a"), EXAMPLE),
      (err) => code(err) === "apple-verification-failed" && String(err).includes("bm90LWFwcGxl") === false,
    );
  });

  it("does not treat an unsigned decoded fixture as a purchase", () => {
    const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const base = {
      transactionId: "1000000000000001",
      originalTransactionId: "1000000000000001",
      bundleId: EXAMPLE.bundleId,
      environment: Environment.SANDBOX,
      productId: "example-unverified-product",
      appAccountToken: token,
    };
    assert.throws(() => assessDecodedClaims({...base, revocationDate: 1}, EXAMPLE), (err) => {
      return code(err) === "revoked-or-refunded";
    });
    assert.throws(() => assessDecodedClaims({...base, productId: "some-other-sku"}, EXAMPLE), (err) => {
      return code(err) === "product-not-allowed";
    });
    assert.throws(() => assessDecodedClaims({...base, bundleId: "other.app"}, EXAMPLE), (err) => {
      return code(err) === "apple-verification-failed";
    });
  });
});

describe("purchase evidence emulator", () => {
  const db = testDb("demo-surge-access");

  it("stores one synthetic row and rejects a second account", async () => {
    const draft = {
      provenance: "synthetic-test" as const,
      transactionId: "testtx1",
      originalTransactionId: "testtx1",
      uid: UID,
      appAccountToken: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      bundleId: "example.unverified.app",
      environment: "Sandbox",
      productId: "example-unverified-product",
      requestId: REQUEST,
      snapshotSha256: "ab".repeat(32),
    };
    await Promise.all(Array.from({length: 6}, () => putPurchaseEvidence(db, draft)));
    const rows = await db.collection(PURCHASE_EVIDENCE).where("transactionId", "==", "testtx1").get();
    assert.equal(rows.size, 1);
    const stored = await db.collection(PURCHASE_EVIDENCE).doc("apple_testtx1").get();
    assert.equal(stored.get("result"), "evidence-recorded");
    assert.equal(stored.get("provenance"), "synthetic-test");
    assert.equal(JSON.stringify(stored.data()).includes(SENTINEL), false);
    assert.equal(stored.get("signedTransaction"), undefined);
    await assert.rejects(
      putPurchaseEvidence(db, {...draft, uid: "otheruser0001"}),
      (err) => code(err) === "evidence-conflict",
    );
    assert.equal((await db.collection(PURCHASE_EVIDENCE).doc("apple_testtx1").get()).get("uid"), UID);
    await assert.rejects(
      putPurchaseEvidence(db, {...draft, provenance: "apple-library"}),
      (err) => code(err) === "evidence-untrusted",
    );
    const user = await db.collection("users").doc(UID).get();
    assert.equal(user.exists, false);
  });

  it("does not record evidence for a forged stored payload", async () => {
    const requestId = "cdcdcdcd-efef-4aba-8bab-343434343434";
    await issueSurgeAccountBinding(db, UID);
    await holdSurgeIapRequest(db, requestId, UID, SENTINEL);
    await assert.rejects(
      acceptVerifiedPurchase(db, requestId, UID, EXAMPLE),
      (err) => code(err) === "apple-verification-failed",
    );
    const request = await db.collection("iapRequests").doc(requestId).get();
    assert.equal(request.get("status"), "held");
    assert.equal(request.get("signedTransaction"), SENTINEL);
    const evidence = await db.collection(PURCHASE_EVIDENCE).where("requestId", "==", requestId).get();
    assert.equal(evidence.size, 0);
  });
});
