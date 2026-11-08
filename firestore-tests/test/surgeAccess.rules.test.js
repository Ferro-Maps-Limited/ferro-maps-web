/**
 * Root rules stay the production file. The surge prototype is a separate
 * emulator target and is not what firebase.json publishes.
 */
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const {describe, it, before, after} = require("node:test");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {doc, setDoc, getDoc, getDocs, collection, serverTimestamp} = require("firebase/firestore");

const ROOT = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const PROTOTYPE = fs.readFileSync(
  path.join(__dirname, "../../firestore.surge-access.prototype.rules"),
  "utf8",
);
const CONFIG = fs.readFileSync(path.join(__dirname, "../../firebase.json"), "utf8");
const IAP = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const ASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function iapBody(uid) {
  return {
    v: 1,
    uid,
    platform: "apple",
    signedTransaction: "s".repeat(64),
    createdAt: serverTimestamp(),
  };
}

describe("production rules ignore the surge prototype", () => {
  let env;

  before(async () => {
    assert.equal(JSON.parse(CONFIG).firestore.rules, "firestore.rules");
    for (const marker of ["iapRequests", "surgeAccountRequests", "surgeAdmission"]) {
      assert.equal(ROOT.includes(marker), false, marker);
    }
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-rules-baseline",
      firestore: {rules: ROOT},
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("still accepts a legacy Gold request and denies surge paths", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "subscriptionRequests/alice"), {
      uid: "alice",
      status: "pending",
    }));
    await assertFails(setDoc(doc(alice, `iapRequests/${IAP}`), iapBody("alice")));
    await assertFails(setDoc(doc(alice, `surgeAccountRequests/${ASK}`), {
      v: 1,
      uid: "alice",
      createdAt: serverTimestamp(),
    }));
  });
});

describe("surge prototype rules are a denied demo target", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-surge-access-prototype",
      firestore: {rules: PROTOTYPE},
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("denies a valid ask, a hyphen uid, reads, and a flood of creates", async () => {
    const alice = env.authenticatedContext("user-with.dot_1").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(alice, `iapRequests/${IAP}`), iapBody("user-with.dot_1")));
    await assertFails(setDoc(doc(alice, `surgeAccountRequests/${ASK}`), {
      v: 1,
      uid: "user-with.dot_1",
      createdAt: serverTimestamp(),
    }));
    await assertFails(getDoc(doc(alice, `iapRequests/${IAP}`)));
    await assertFails(getDocs(collection(alice, "iapRequests")));
    await assertFails(setDoc(doc(alice, "surgePurchaseEvidence/apple_1"), {result: "delivered"}));
    await assertFails(setDoc(doc(anon, `iapRequests/${IAP}`), iapBody("user-with.dot_1")));
    for (let index = 0; index < 10; index += 1) {
      const id = `44444444-5555-4666-8777-88888888888${index}`;
      await assertFails(setDoc(doc(alice, `iapRequests/${id}`), iapBody("user-with.dot_1")));
    }
  });
});
