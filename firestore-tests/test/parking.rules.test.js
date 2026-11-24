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

  it("lets any signed-in driver create a request and blocks other readers", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const stranger = env.authenticatedContext("stranger").firestore();
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-create"), createBody()));
    await assertSucceeds(setDoc(doc(bob, "parkingPaymentRequests", "req-bob"), {
      ...createBody(),
      uid: "bob",
    }));
    const cara = env.authenticatedContext("cara").firestore();
    await assertSucceeds(setDoc(doc(cara, "parkingPaymentRequests", "req-cara"), {
      ...createBody(),
      uid: "cara",
      chargeType: "parking",
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

  it("keeps the ledger, jobs, and outbox off drivers and lets an admin read the desk", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "authorityPayments", "pi_test1"), {
        uid: "alice",
        status: "open",
        plate: "AB12CDE",
        authorityPence: 450,
      });
      await setDoc(doc(db, "funding", "state"), {balancePence: 100, paused: false});
      await setDoc(doc(db, "fundingLedger", "topup_1"), {kind: "topup", amountPence: 100});
      await setDoc(doc(db, "paymentNotifications", "pi_test1:paid"), {status: "pending", text: "hi"});
    });
    const alice = env.authenticatedContext("alice").firestore();
    const admin = env.authenticatedContext("admin-uid", {role: "admin"}).firestore();
    const support = env.authenticatedContext("support-uid", {role: "support"}).firestore();
    await assertFails(getDoc(doc(alice, "authorityPayments", "pi_test1")));
    await assertFails(getDoc(doc(alice, "funding", "state")));
    await assertFails(getDoc(doc(alice, "fundingLedger", "topup_1")));
    await assertFails(getDoc(doc(alice, "paymentNotifications", "pi_test1:paid")));
    await assertFails(getDoc(doc(support, "authorityPayments", "pi_test1")));
    await assertSucceeds(getDoc(doc(admin, "authorityPayments", "pi_test1")));
    await assertSucceeds(getDoc(doc(admin, "funding", "state")));
    await assertSucceeds(getDoc(doc(admin, "fundingLedger", "topup_1")));
    await assertFails(getDoc(doc(admin, "paymentNotifications", "pi_test1:paid")));
    await assertFails(setDoc(doc(admin, "fundingLedger", "topup_2"), {kind: "topup", amountPence: 1}));
    await assertFails(updateDoc(doc(admin, "funding", "state"), {balancePence: 1}));
    await assertSucceeds(setDoc(doc(admin, "fundingTopUpRequests", "top-1"), {
      requestedBy: "admin-uid",
      amountPence: 5000,
      note: "desk top-up",
      status: "pending",
      createdAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(alice, "fundingTopUpRequests", "top-2"), {
      requestedBy: "alice",
      amountPence: 5000,
      status: "pending",
      createdAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(admin, "authorityPaymentActionRequests", "act-1"), {
      requestedBy: "admin-uid",
      paymentIntentId: "pi_test1",
      action: "fail",
      status: "pending",
      createdAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(admin, "authorityPaymentActionRequests", "act-2"), {
      requestedBy: "admin-uid",
      paymentIntentId: "pi_test1",
      action: "fulfill",
      status: "pending",
      createdAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(admin, "authorityPaymentActionRequests", "act-1"), {status: "done"}));
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-ulez"), {
      uid: "alice",
      v: 1,
      action: "create",
      chargeType: "ulez",
      plate: "AB12 CDE",
      platform: "ios",
      appVersion: "1.4.0",
      status: "pending",
      createdAt: serverTimestamp(),
      authorityPence: 1250,
      zone: "London ULEZ",
      occurredOn: "2026-11-15",
      paymentUrl: "https://tfl.gov.uk/modes/driving/pay-to-drive-in-london",
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-card"), {
      ...createBody(),
      cardNumber: "4242424242424242",
    }));
  });

  it("allows an optional whole-minute duration from 15 to 1440 and nothing else", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-missing"), createBody()));
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-15"), {
      ...createBody(),
      durationMinutes: 15,
    }));
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-1440"), {
      ...createBody(),
      durationMinutes: 1440,
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-14"), {
      ...createBody(),
      durationMinutes: 14,
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-1441"), {
      ...createBody(),
      durationMinutes: 1441,
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-float"), {
      ...createBody(),
      durationMinutes: 30.5,
    }));
    await assertFails(setDoc(doc(alice, "parkingPaymentRequests", "req-text"), {
      ...createBody(),
      durationMinutes: "30",
    }));
  });

  it("allows an optional private parking cell id, a geohash6 or one of its shards", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-cell"), {
      ...createBody(),
      cellId: "gcpvj0",
    }));
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-shard"), {
      ...createBody(),
      cellId: "gcpvj0_3",
    }));
    for (const [id, cellId] of [
      ["req-short", "gcpvj"],
      ["req-letter", "gcpvja"],
      ["req-shard9", "gcpvj0_9"],
      ["req-path", "gcpvj0/x"],
      ["req-number", 123456],
    ]) {
      await assertFails(setDoc(doc(alice, "parkingPaymentRequests", id), {...createBody(), cellId}));
    }
  });

  it("allows an optional PaymentIntent id to add time to", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(setDoc(doc(alice, "parkingPaymentRequests", "req-extend"), {
      ...createBody(),
      extendsPaymentId: "pi_3Uf8yAK3Yqih",
      durationMinutes: 60,
    }));
    for (const [id, extendsPaymentId] of [
      ["req-ext-blank", ""],
      ["req-ext-prefix", "ch_123"],
      ["req-ext-path", "pi_1/2"],
      ["req-ext-number", 42],
    ]) {
      await assertFails(setDoc(doc(alice, "parkingPaymentRequests", id), {...createBody(), extendsPaymentId}));
    }
  });

  it("keeps config/payments server-only", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(alice, "config", "payments")));
    await assertFails(setDoc(doc(alice, "config", "payments"), {stripeLiveEnabled: true}));
  });
});
