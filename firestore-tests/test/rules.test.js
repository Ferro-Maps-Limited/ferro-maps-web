/**
 * Rules for the writes the apps already make.
 * The rules body is iOS 73508bb. Run from firestore-tests: npm test
 * The project id is demo- so the emulator cannot reach a real project.
 */
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
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
  deleteDoc,
  serverTimestamp,
  Timestamp,
  deleteField,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

function userDoc(uid) {
  return {
    uid,
    name: "Driver",
    country: "UK",
    xp: 0,
    level: 1,
    ferroBalance: 0,
    contributionScore: 0,
    activeDeviceId: "device-live",
  };
}

let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-ferromaps-rules",
    firestore: {rules: RULES},
  });
});

test.beforeEach(async () => {
  await env.clearFirestore();
});

test.after(async () => {
  await env.cleanup();
});

async function seed(writes) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [id, data] of writes) {
      await setDoc(doc(db, id), data);
    }
  });
}

test("73508bb markers are present", () => {
  assert.match(RULES, /function appVersionValid\(\)/);
  assert.match(RULES, /'appVersion'/);
  assert.match(RULES, /function graceEnds\(\)/);
  assert.match(RULES, /timestamp\.date\(2026, 12, 31\)/);
  assert.match(RULES, /resource\.data\.status == 'error'/);
  assert.match(RULES, /'errorCode'/);
  assert.match(RULES, /allow list: if isAdmin\(\)/);
  const now = Date.now();
  assert.ok(now >= Date.parse("2026-10-15T00:00:00Z"));
  assert.ok(now < Date.parse("2026-12-31T00:00:00Z"));
});

test("the owner may write a 32-character appVersion", async () => {
  await seed([["users/bob", userDoc("bob")]]);
  const bob = env.authenticatedContext("bob").firestore();
  await assertSucceeds(updateDoc(doc(bob, "users/bob"), {
    appVersion: "1.2.3",
  }));
  await assertSucceeds(updateDoc(doc(bob, "users/bob"), {
    appVersion: "a".repeat(32),
  }));
});

test("appVersion over 32 characters, a non-string, and xp are denied", async () => {
  await seed([["users/bob", userDoc("bob")]]);
  const bob = env.authenticatedContext("bob").firestore();
  await assertFails(updateDoc(doc(bob, "users/bob"), {appVersion: "a".repeat(33)}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {appVersion: 12}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {xp: 999999}));
});

test("device claim: no claim is allowed until 31 Dec 2026, a wrong claim is not", async () => {
  await seed([["users/bob", userDoc("bob")]]);
  const noClaim = env.authenticatedContext("bob").firestore();
  await assertSucceeds(updateDoc(doc(noClaim, "users/bob"), {name: "Bobby"}));
  const wrong = env.authenticatedContext("bob", {deviceId: "other-phone"}).firestore();
  await assertFails(updateDoc(doc(wrong, "users/bob"), {name: "Bobby"}));
  const matching = env.authenticatedContext("bob", {deviceId: "device-live"}).firestore();
  await assertSucceeds(updateDoc(doc(matching, "users/bob"), {
    fcmToken: "token",
    isOnline: true,
  }));
});

test("account deletion create, owner get, and error to pending reset", async () => {
  const bob = env.authenticatedContext("bob").firestore();
  const other = env.authenticatedContext("other").firestore();
  await assertFails(setDoc(doc(bob, "accountDeletionRequests/bob"), {
    status: "pending",
    createdAt: serverTimestamp(),
    errorCode: "timeout",
  }));
  await assertSucceeds(setDoc(doc(bob, "accountDeletionRequests/bob"), {
    status: "pending",
    createdAt: serverTimestamp(),
  }));
  await assertSucceeds(getDoc(doc(bob, "accountDeletionRequests/bob")));
  await assertFails(getDoc(doc(other, "accountDeletionRequests/bob")));
  await assertFails(deleteDoc(doc(bob, "accountDeletionRequests/bob")));

  await seed([["accountDeletionRequests/bob", {
    status: "error",
    createdAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")),
    error: "Couldn't finish deleting your account. Please try again.",
    errorCode: "data-cleanup-failed",
    completedAt: Timestamp.fromDate(new Date("2026-10-02T00:00:00Z")),
  }]]);
  await assertSucceeds(updateDoc(doc(bob, "accountDeletionRequests/bob"), {
    status: "pending",
    error: deleteField(),
    errorCode: deleteField(),
    completedAt: deleteField(),
  }));
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), {
    status: "done",
  }));
});

test("admins can list drivers, deletion requests, and another driver's outcomes", async () => {
  await seed([
    ["users/bob", userDoc("bob")],
    ["accountDeletionRequests/bob", {
      status: "pending",
      createdAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")),
    }],
    ["hotspotOutcomes/o1", {uid: "bob", hotspotId: "h1"}],
    ["notificationLog/n1", {uid: "bob", opened: false}],
  ]);
  const admin = env.authenticatedContext("admin-user", {role: "admin"}).firestore();
  const bob = env.authenticatedContext("bob").firestore();
  const users = await assertSucceeds(getDocs(collection(admin, "users")));
  assert.equal(users.size, 1);
  await assertFails(getDocs(collection(bob, "users")));
  await assertSucceeds(getDoc(doc(admin, "users/bob")));
  const deletions = await assertSucceeds(getDocs(collection(admin, "accountDeletionRequests")));
  assert.equal(deletions.size, 1);
  await assertFails(getDocs(collection(bob, "accountDeletionRequests")));
  await assertSucceeds(getDoc(doc(admin, "hotspotOutcomes/o1")));
  await assertFails(getDoc(doc(env.authenticatedContext("stranger").firestore(), "hotspotOutcomes/o1")));
  await assertSucceeds(getDoc(doc(admin, "notificationLog/n1")));
});

test("the contact form can be submitted signed out, and only staff can read it", async () => {
  const anon = env.unauthenticatedContext().firestore();
  const ticket = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    message: "The map is blank.",
    agreedToPolicy: true,
    submittedAt: serverTimestamp(),
    status: "open",
    ticketNumber: 1761900000000,
    subject: "The map is blank.",
    replies: [],
  };
  await assertSucceeds(setDoc(doc(anon, "supportRequests/t1"), ticket));
  await assertFails(setDoc(doc(anon, "supportRequests/t2"), {
    ...ticket,
    status: "closed",
  }));
  await assertFails(setDoc(doc(anon, "supportRequests/t3"), {
    ...ticket,
    email: "not-an-email",
  }));

  const driver = env.authenticatedContext("bob").firestore();
  const admin = env.authenticatedContext("admin-user", {role: "admin"}).firestore();
  const support = env.authenticatedContext("support-user", {role: "support"}).firestore();
  await assertFails(getDoc(doc(driver, "supportRequests/t1")));
  await assertSucceeds(getDoc(doc(admin, "supportRequests/t1")));
  await assertSucceeds(getDoc(doc(support, "supportRequests/t1")));
  await assertFails(updateDoc(doc(driver, "supportRequests/t1"), {status: "closed"}));
  await assertSucceeds(updateDoc(doc(support, "supportRequests/t1"), {status: "closed"}));
  await assertFails(deleteDoc(doc(admin, "supportRequests/t1")));
});
