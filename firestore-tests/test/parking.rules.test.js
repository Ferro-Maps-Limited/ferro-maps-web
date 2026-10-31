/**
 * In-app pay rules. The shipped firestore.rules file is loaded as-is.
 * Project ids are demo- so the emulator cannot reach a real project.
 */
const fs = require("fs");
const path = require("path");
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
  setDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

function createBody() {
  return {
    uid: "alice",
    v: 1,
    action: "create",
    placeId: "place-1",
    visitId: "visit-1",
    operator: "RingGo",
    plate: "AB12 CDE",
    platform: "android",
    appVersion: "1.4.0",
    status: "pending",
    createdAt: serverTimestamp(),
  };
}

function confirmBody() {
  return {
    v: 1,
    action: "confirm",
    status: "pending",
    createdAt: serverTimestamp(),
    uid: "alice",
    paymentId: "pi_test1",
    paymentIntentId: "pi_test1",
    originalRequestId: "req-1",
  };
}

describe("in-app pay rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-parking-rules",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "users", "alice"), {
        subscriptionExpiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
      });
      await setDoc(doc(db, "users", "bob"), {
        subscriptionExpiresAt: Timestamp.fromMillis(Date.now() - 86_400_000),
      });
      await setDoc(doc(db, "parkingPayments", "pi_test1"), {
        uid: "alice",
        visitId: "visit-1",
        paymentIntentId: "pi_test1",
        status: "created",
        amount: 610,
      });
      await setDoc(doc(db, "parkingPaymentRequests", "req-1"), {
        uid: "alice",
        action: "create",
        status: "done",
        visitId: "visit-1",
      });
      await setDoc(doc(db, "places", "place-1"), {
        payMode: "inapp",
        operator: "RingGo",
        parkingPence: 450,
        feePence: 160,
        name: "Yard",
      });
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("lets a Gold driver create a payment request and blocks the result fields", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-create"), createBody()));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-2"), {
      ...createBody(),
      amount: 610,
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-3"), {
      ...createBody(),
      paymentIntentClientSecret: "secret",
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-4"), {
      ...createBody(),
      action: "confirm",
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "pi_test1_confirm"), createBody()));
    await assertFails(updateDoc(doc(alice, "parkingPaymentRequests", "req-create"), {status: "done"}));
    await assertFails(updateDoc(doc(alice, "parkingPaymentRequests", "req-create"), {plate: "ZZ99ZZZ"}));
  });

  it("requires Gold, the owner uid, and blocks other readers", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const stranger = env.authenticatedContext("stranger").firestore();
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-create"), createBody()));
    await assertFails(setDoc(doc(bob, "parkingPaymentRequests", "req-bob"), {
      ...createBody(),
      uid: "bob",
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-forged"), {
      ...createBody(),
      uid: "bob",
    }));
    await assertSucceeds(getDoc(doc(alice, "parkingPaymentRequests", "req-create")));
    await assertSucceeds(getDoc(doc(alice, "parkingPaymentRequests", "req-1")));
    await assertFails(getDocs(collection(alice, "parkingPaymentRequests")));
    await assertFails(getDoc(doc(stranger, "parkingPaymentRequests", "req-1")));
    await assertFails(getDoc(doc(stranger, "parkingPaymentRequests", "req-create")));
    await assertFails(getDoc(doc(bob, "parkingPaymentRequests", "req-create")));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(anon, "parkingPaymentRequests", "req-open"), createBody()));
    await assertFails(getDoc(doc(anon, "parkingPaymentRequests", "req-create")));
  });

  it("accepts a confirm document and rejects an update or a mismatched id", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "other_confirm"), confirmBody()));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "pi_test1_confirm"), {
      ...confirmBody(),
      plate: "AB12CDE",
    }));
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "pi_test1_confirm"), confirmBody()));
    await assertFails(updateDoc(doc(alice, "parkingPaymentRequests", "pi_test1_confirm"), {
      status: "done",
    }));
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(setDoc(doc(bob, "parkingPaymentRequests", "pi_test1_confirm"), {
      ...confirmBody(),
      uid: "bob",
    }));
  });

  it("lets the owner read a payment and lets nobody write one", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const stranger = env.authenticatedContext("stranger").firestore();
    await assertSucceeds(getDoc(doc(alice, "parkingPayments", "pi_test1")));
    await assertFails(getDoc(doc(stranger, "parkingPayments", "pi_test1")));
    await assertFails(setDoc(doc(alice, "parkingPayments", "pi_other"), {
      uid: "alice",
      status: "paid",
      amount: 1,
    }));
    await assertFails(updateDoc(doc(alice, "parkingPayments", "pi_test1"), {status: "paid"}));
  });

  it("denies client writes to places and operator forwards", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "places", "place-1"), {feePence: 1}));
    await assertFails(updateDoc(doc(alice, "places", "place-1"), {payMode: "handoff"}));
    await assertFails(updateDoc(doc(alice, "places", "place-1"), {name: "Renamed"}));
    await assertFails(setDoc(doc(alice, "places", "place-2"), {name: "New"}));
    await assertFails(getDoc(doc(alice, "operatorForwards", "pi_test1")));
    await assertFails(getDocs(collection(alice, "operatorForwards")));
    await assertFails(setDoc(doc(alice, "operatorForwards", "pi_test1"), {plate: "AB12CDE"}));
    await assertFails(getDoc(doc(alice, "stripeCustomers", "alice")));
    await assertFails(getDoc(doc(alice, "stripeSync", "cursor")));
  });
});
