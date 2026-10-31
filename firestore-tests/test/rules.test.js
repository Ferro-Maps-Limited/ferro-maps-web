/**
 * Rules for the writes the apps already make.
 * The shipped file is loaded as-is. Grace tests substitute only the
 * graceEnds() date in a copy, so the suite does not depend on the clock.
 * The project ids are demo- so the emulator cannot reach a real project.
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

const RULES_PATH = path.join(__dirname, "../../firestore.rules");
const RULES = fs.readFileSync(RULES_PATH, "utf8");
const SHIPPED_GRACE = "timestamp.date(2026, 12, 31)";

function withGrace(dateCall) {
  const hits = RULES.split(SHIPPED_GRACE).length - 1;
  if (hits !== 1) {
    throw new Error(`expected one ${SHIPPED_GRACE} in the shipped rules, found ${hits}`);
  }
  return RULES.replace(SHIPPED_GRACE, dateCall);
}

const RULES_GRACE_OPEN = withGrace("timestamp.date(2099, 1, 1)");
const RULES_GRACE_CLOSED = withGrace("timestamp.date(2020, 1, 1)");

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

function errorDeletion(status = "error") {
  return {
    status,
    createdAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")),
    error: "Couldn't finish deleting your account. Please try again.",
    errorCode: "data-cleanup-failed",
    completedAt: Timestamp.fromDate(new Date("2026-10-02T00:00:00Z")),
  };
}

const validReset = {
  status: "pending",
  error: deleteField(),
  errorCode: deleteField(),
  completedAt: deleteField(),
};

let env;
let openEnv;
let closedEnv;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-ferromaps-rules",
    firestore: {rules: RULES},
  });
  openEnv = await initializeTestEnvironment({
    projectId: "demo-ferromaps-grace-open",
    firestore: {rules: RULES_GRACE_OPEN},
  });
  closedEnv = await initializeTestEnvironment({
    projectId: "demo-ferromaps-grace-closed",
    firestore: {rules: RULES_GRACE_CLOSED},
  });
});

test.beforeEach(async () => {
  await env.clearFirestore();
});

test.after(async () => {
  await env.cleanup();
  await openEnv.cleanup();
  await closedEnv.cleanup();
});

async function seed(target, writes) {
  await target.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [id, data] of writes) {
      await setDoc(doc(db, id), data);
    }
  });
}

test("shipped rules keep appVersion, the reset, admin reads, and the 31 Dec 2026 grace", () => {
  assert.match(RULES, /function appVersionValid\(\)/);
  assert.match(RULES, /'appVersion'/);
  assert.match(RULES, /function graceEnds\(\)/);
  assert.match(RULES, /timestamp\.date\(2026, 12, 31\)/);
  assert.match(RULES, /resource\.data\.status == 'error'/);
  assert.match(RULES, /'errorCode'/);
  assert.match(RULES, /allow list: if isAdmin\(\)/);
  assert.equal(
      RULES_GRACE_OPEN.replace("timestamp.date(2099, 1, 1)", SHIPPED_GRACE),
      RULES,
  );
  assert.equal(
      RULES_GRACE_CLOSED.replace("timestamp.date(2020, 1, 1)", SHIPPED_GRACE),
      RULES,
  );
});

test("the owner may write a 32-character appVersion", async () => {
  await seed(env, [["users/bob", userDoc("bob")]]);
  const bob = env.authenticatedContext("bob", {deviceId: "device-live"}).firestore();
  await assertSucceeds(updateDoc(doc(bob, "users/bob"), {
    appVersion: "1.2.3",
  }));
  await assertSucceeds(updateDoc(doc(bob, "users/bob"), {
    appVersion: "a".repeat(32),
  }));
});

test("appVersion over 32 characters, a non-string, and xp are denied", async () => {
  await seed(env, [["users/bob", userDoc("bob")]]);
  const bob = env.authenticatedContext("bob", {deviceId: "device-live"}).firestore();
  await assertFails(updateDoc(doc(bob, "users/bob"), {appVersion: "a".repeat(33)}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {appVersion: 12}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {xp: 999999}));
});

test("a closed grace refuses a write that has no matching device claim", async () => {
  await closedEnv.clearFirestore();
  await seed(closedEnv, [["users/bob", userDoc("bob")]]);
  const noClaim = closedEnv.authenticatedContext("bob").firestore();
  await assertFails(updateDoc(doc(noClaim, "users/bob"), {name: "Bobby"}));
  const wrong = closedEnv.authenticatedContext("bob", {deviceId: "other-phone"}).firestore();
  await assertFails(updateDoc(doc(wrong, "users/bob"), {name: "Bobby"}));
  const matching = closedEnv.authenticatedContext("bob", {deviceId: "device-live"}).firestore();
  await assertSucceeds(updateDoc(doc(matching, "users/bob"), {name: "Bobby"}));
});

test("an open grace allows a write with no device claim and still refuses the wrong device", async () => {
  await openEnv.clearFirestore();
  await seed(openEnv, [["users/bob", userDoc("bob")]]);
  const noClaim = openEnv.authenticatedContext("bob").firestore();
  await assertSucceeds(updateDoc(doc(noClaim, "users/bob"), {name: "Bobby"}));
  const wrong = openEnv.authenticatedContext("bob", {deviceId: "other-phone"}).firestore();
  await assertFails(updateDoc(doc(wrong, "users/bob"), {name: "Bobby"}));
  const matching = openEnv.authenticatedContext("bob", {deviceId: "device-live"}).firestore();
  await assertSucceeds(updateDoc(doc(matching, "users/bob"), {
    fcmToken: "token",
    isOnline: true,
  }));
});

test("account deletion create and owner get", async () => {
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
});

test("the owner may reset an error deletion to pending, and forgeries are denied", async () => {
  const bob = env.authenticatedContext("bob").firestore();
  const other = env.authenticatedContext("other").firestore();
  const createdAt = errorDeletion().createdAt;

  await seed(env, [["accountDeletionRequests/bob", errorDeletion()]]);
  await assertSucceeds(updateDoc(doc(bob, "accountDeletionRequests/bob"), validReset));
  const reset = await getDoc(doc(bob, "accountDeletionRequests/bob"));
  assert.equal(reset.data().status, "pending");
  assert.equal("error" in reset.data(), false);
  assert.equal("errorCode" in reset.data(), false);
  assert.equal("completedAt" in reset.data(), false);
  assert.equal(reset.data().createdAt.toMillis(), createdAt.toMillis());

  await seed(env, [["accountDeletionRequests/bob", errorDeletion()]]);
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), {
    status: "done",
    error: deleteField(),
    errorCode: deleteField(),
    completedAt: deleteField(),
  }));

  await seed(env, [["accountDeletionRequests/bob", errorDeletion()]]);
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), {
    status: "pending",
    error: deleteField(),
    completedAt: deleteField(),
  }));

  await seed(env, [["accountDeletionRequests/bob", errorDeletion()]]);
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), {
    status: "pending",
    error: deleteField(),
    errorCode: "forged",
    completedAt: deleteField(),
  }));

  await seed(env, [["accountDeletionRequests/bob", errorDeletion()]]);
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), {
    ...validReset,
    createdAt: serverTimestamp(),
  }));

  await seed(env, [["accountDeletionRequests/bob", errorDeletion()]]);
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), {
    ...validReset,
    note: "extra",
  }));

  await seed(env, [["accountDeletionRequests/bob", errorDeletion()]]);
  await assertFails(updateDoc(doc(other, "accountDeletionRequests/bob"), validReset));

  await seed(env, [["accountDeletionRequests/bob", errorDeletion("done")]]);
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), validReset));

  await seed(env, [["accountDeletionRequests/bob", errorDeletion("pending")]]);
  await assertFails(updateDoc(doc(bob, "accountDeletionRequests/bob"), validReset));
});

test("admins can list drivers, deletion requests, and another driver's outcomes", async () => {
  await seed(env, [
    ["users/bob", userDoc("bob")],
    ["accountDeletionRequests/bob", {
      status: "pending",
      createdAt: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")),
    }],
    ["hotspotOutcomes/o1", {uid: "bob", hotspotId: "h1"}],
    ["notificationLog/n1", {uid: "bob", opened: false}],
  ]);
  const admin = env.authenticatedContext("admin-user", {role: "admin"}).firestore();
  const driver = env.authenticatedContext("bob").firestore();
  const users = await assertSucceeds(getDocs(collection(admin, "users")));
  assert.equal(users.size, 1);
  await assertFails(getDocs(collection(driver, "users")));
  await assertSucceeds(getDoc(doc(admin, "users/bob")));
  const deletions = await assertSucceeds(getDocs(collection(admin, "accountDeletionRequests")));
  assert.equal(deletions.size, 1);
  await assertFails(getDocs(collection(driver, "accountDeletionRequests")));
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
