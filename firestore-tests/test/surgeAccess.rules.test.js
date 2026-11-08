/**
 * Surge account-binding and iapRequests rules. Demo project only.
 * The legacy subscriptionRequests path is checked so this file does not replace it.
 */
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const {describe, it, before, beforeEach, after} = require("node:test");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  where,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const ASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const IAP = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const PAYLOAD = "s".repeat(64);

function askBody(uid) {
  return {v: 1, uid, createdAt: serverTimestamp()};
}

function iapBody(uid, extra = {}) {
  return {
    v: 1,
    uid,
    platform: "apple",
    signedTransaction: PAYLOAD,
    createdAt: serverTimestamp(),
    ...extra,
  };
}

describe("surge access rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-surge-access-rules",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  after(async () => {
    await env.cleanup();
  });

  it("keeps the legacy Gold request path and does not treat iapRequests as that path", async () => {
    assert.match(RULES, /match \/subscriptionRequests\/\{uid\}/);
    assert.match(RULES, /match \/iapRequests\/\{requestId\}/);
    assert.equal(RULES.includes("onSurgeIapRequest"), false);
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "subscriptionRequests/alice"), {
      uid: "alice",
      status: "pending",
    }));
    await assertFails(setDoc(doc(alice, `iapRequests/${IAP}`), {
      uid: "alice",
      status: "pending",
    }));
  });

  it("issues no client write on the binding record and hides reverse maps", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(alice, "surgeBillingAccounts/alice"), {
      appAccountToken: ASK,
    }));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "surgeBillingAccounts/alice"), {
        v: 1,
        uid: "alice",
        appAccountToken: ASK,
        playObfuscatedId: IAP,
      });
      await setDoc(doc(ctx.firestore(), `surgeAccountTokens/${ASK}`), {uid: "alice"});
      await setDoc(doc(ctx.firestore(), `surgePlayAccountIds/${IAP}`), {uid: "alice"});
    });
    await assertSucceeds(getDoc(doc(alice, "surgeBillingAccounts/alice")));
    await assertFails(getDoc(doc(bob, "surgeBillingAccounts/alice")));
    await assertFails(getDoc(doc(anon, "surgeBillingAccounts/alice")));
    await assertFails(getDocs(collection(alice, "surgeBillingAccounts")));
    await assertFails(updateDoc(doc(alice, "surgeBillingAccounts/alice"), {appAccountToken: IAP}));
    await assertFails(getDoc(doc(alice, `surgeAccountTokens/${ASK}`)));
    await assertFails(getDoc(doc(alice, `surgePlayAccountIds/${IAP}`)));
  });

  it("accepts an account ask and rejects updates, lists, and chosen tokens", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    const ref = doc(alice, `surgeAccountRequests/${ASK}`);
    await assertFails(setDoc(doc(anon, `surgeAccountRequests/${ASK}`), askBody("alice")));
    await assertFails(setDoc(doc(alice, `surgeAccountRequests/${ASK}`), askBody("bob")));
    await assertFails(setDoc(ref, {...askBody("alice"), appAccountToken: ASK}));
    await assertSucceeds(setDoc(ref, askBody("alice")));
    await assertSucceeds(getDoc(ref));
    await assertFails(getDoc(doc(bob, `surgeAccountRequests/${ASK}`)));
    await assertFails(getDocs(collection(alice, "surgeAccountRequests")));
    await assertFails(updateDoc(ref, {status: "issued", appAccountToken: ASK}));
    await assertFails(deleteDoc(ref));
  });

  it("blocks forged iap results, queries, and cross-account reads", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    const ref = doc(alice, `iapRequests/${IAP}`);
    await assertFails(setDoc(doc(anon, `iapRequests/${IAP}`), iapBody("alice")));
    await assertFails(setDoc(doc(alice, `iapRequests/${IAP}`), iapBody("bob")));
    await assertFails(setDoc(ref, iapBody("alice", {status: "delivered"})));
    await assertFails(setDoc(ref, iapBody("alice", {productId: "ferro.surge.single"})));
    await assertFails(setDoc(ref, iapBody("alice", {transactionId: "store-1"})));
    await assertFails(setDoc(ref, iapBody("alice", {grant: true})));
    await assertFails(setDoc(ref, iapBody("alice", {tier: "premium"})));
    await assertFails(setDoc(ref, iapBody("alice", {price: "2.99"})));
    await assertFails(setDoc(ref, iapBody("alice", {v: 2})));
    await assertFails(setDoc(ref, iapBody("alice", {platform: "android"})));
    await assertFails(setDoc(ref, iapBody("alice", {signedTransaction: "short"})));
    await assertFails(setDoc(ref, iapBody("alice", {signedTransaction: "s".repeat(16385)})));
    await assertFails(setDoc(ref, iapBody("alice", {signedTransaction: 1})));
    await assertSucceeds(setDoc(ref, iapBody("alice")));
    await assertSucceeds(getDoc(ref));
    await assertFails(getDoc(doc(bob, `iapRequests/${IAP}`)));
    await assertFails(getDoc(doc(anon, `iapRequests/${IAP}`)));
    await assertFails(getDocs(query(collection(alice, "iapRequests"), where("uid", "==", "alice"))));
    await assertFails(updateDoc(ref, {status: "delivered", outcome: "granted"}));
    await assertFails(updateDoc(ref, {signedTransaction: "s".repeat(64)}));
    await assertFails(deleteDoc(ref));
    await assertFails(setDoc(doc(alice, "surgeLedger/alice"), {opens: 99}));
    await assertFails(setDoc(doc(alice, "hotspots_test/pin-1"), {
      liveSurge: {band: "high"},
      signedTransaction: PAYLOAD,
    }));
  });
});
