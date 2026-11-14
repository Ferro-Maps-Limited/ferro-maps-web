/**
 * surgePurchaseRequests: the owner creates a pending row and may read it.
 * surge_status stays owner-get. Claims stay server-only.
 */
const fs = require("fs");
const path = require("path");
const {describe, it, before, beforeEach, after} = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  doc,
  getDoc,
  getDocs,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

function pending(uid, extra = {}) {
  return {
    uid,
    productId: "ferro.surge.premium.weekly",
    signedTransaction: "header.payload.signature",
    status: "pending",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

describe("surge purchase rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-purchase",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  after(async () => {
    await env.cleanup();
  });

  function dbFor(uid) {
    return env.authenticatedContext(uid).firestore();
  }

  it("lets the owner create and get a pending purchase, and denies everyone else", async () => {
    const ada = dbFor("ada");
    await assertSucceeds(setDoc(doc(ada, "surgePurchaseRequests", "tx_1"), pending("ada")));
    const saved = await assertSucceeds(getDoc(doc(ada, "surgePurchaseRequests", "tx_1")));
    assert.equal(saved.get("status"), "pending");
    assert.equal(saved.get("productId"), "ferro.surge.premium.weekly");

    const bob = dbFor("bob");
    await assertFails(getDoc(doc(bob, "surgePurchaseRequests", "tx_1")));
    await assertFails(setDoc(doc(bob, "surgePurchaseRequests", "tx_2"), pending("ada")));
    await assertFails(getDocs(collection(ada, "surgePurchaseRequests")));
    await assertFails(updateDoc(doc(ada, "surgePurchaseRequests", "tx_1"), {status: "verified"}));
    await assertFails(deleteDoc(doc(ada, "surgePurchaseRequests", "tx_1")));
    await assertFails(setDoc(doc(ada, "surgePurchaseRequests", "tx_extra"), pending("ada", {price: "2.99"})));
    await assertFails(setDoc(doc(ada, "surgePurchaseRequests", "tx_done"), pending("ada", {status: "verified"})));
    await assertFails(getDocs(collection(ada, "surgePurchaseClaims")));
    await assertFails(setDoc(doc(ada, "surgePurchaseClaims", "tx_1"), {uid: "ada"}));
    assert.match(RULES, /match \/surgePurchaseRequests\/\{transactionId\}/);
    assert.match(RULES, /allow list, update, delete: if false;/);
  });
});
