import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";
import {SURGE_ACCOUNT_TOKEN_NAMESPACE, surgeAccountToken} from "../src/surge/accountToken";
import {appleSurgeVerifier, rootCertificatesFromSecret} from "../src/surge/appleVerifier";
import {APPLE_ROOT_CAS_SECRET, SurgeVerifyError} from "../src/surge/purchaseVerifier";

function testRootPem(): string {
  const dir = mkdtempSync(join(tmpdir(), "surge-root-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    "-days", "1", "-nodes", "-subj", "/CN=surge-test",
  ], {stdio: "ignore"});
  return readFileSync(join(dir, "cert.pem"), "utf8");
}

describe("surge account token", () => {
  it("matches the iOS test vector and exports the shared namespace", () => {
    assert.equal(SURGE_ACCOUNT_TOKEN_NAMESPACE, "c5a5a951-b94c-4d05-a80c-226d6e96814e");
    assert.equal(surgeAccountToken("test-uid-123"), "1caecb6e-458b-510e-a04d-a467b892f3cc");
    assert.equal(surgeAccountToken("test-uid-123"), surgeAccountToken("test-uid-123").toLowerCase());
  });
});

describe("apple sandbox verifier", () => {
  it("reads PEM roots from the named secret and rejects a bad signature", async () => {
    assert.equal(APPLE_ROOT_CAS_SECRET, "APPLE_APP_STORE_ROOT_CAS");
    const pem = testRootPem();
    const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
    assert.deepEqual(rootCertificatesFromSecret(pem), [der]);
    const verifier = appleSurgeVerifier(rootCertificatesFromSecret(pem));
    await assert.rejects(verifier.verify("not-a-jws"), (err: unknown) => {
      return err instanceof SurgeVerifyError && err.reason === "bad_signature";
    });
  });
});
