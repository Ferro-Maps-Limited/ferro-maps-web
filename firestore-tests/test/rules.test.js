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
  GeoPoint,
  deleteField,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

// SHA-256 hex. iOS hashes identifierForVendor, Android hashes ANDROID_ID.
const DEVICE_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function pinnedSignup(uid, extra = {}) {
  return {
    uid,
    name: "Ada Lovelace",
    country: "UK",
    phoneNumber: "+447700900123",
    fcmToken: "",
    avatarConfig: {},
    ferroBalance: 0,
    xp: 0,
    level: 1,
    contributionScore: 0,
    dayStreak: 1,
    isOnline: true,
    selectedAvatar: "skin-default",
    ...extra,
  };
}

// iOS omits nil: email, subscriptionExpiresAt, fleetId, carId, location,
// userStatus. All three clocks are server timestamps. No device claim.
function iosSignup(uid, extra = {}) {
  return pinnedSignup(uid, {
    activeDeviceId: DEVICE_HASH,
    createdAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
    locationUpdatedAt: serverTimestamp(),
    ...extra,
  });
}

// Android sends these keys as explicit null, and createdAt as a server timestamp.
// Signup is phone-auth only, so phoneNumber is always a string
// (UserProfileMapper.kt:49). pinnedSignup supplies "+447700900123".
function androidSignup(uid, extra = {}) {
  return pinnedSignup(uid, {
    email: null,
    subscriptionExpiresAt: null,
    fleetId: null,
    carId: null,
    location: null,
    currentStatus: null,
    lastActiveAt: null,
    locationUpdatedAt: null,
    activeDeviceId: DEVICE_HASH,
    createdAt: serverTimestamp(),
    ...extra,
  });
}

// Marketing app writes name, email, selectedAvatar, notificationsEnabled.
// It never creates users/{uid} and does not send activeDeviceId or phoneNumber.
// The pinned counters are required by the create rule; web does not send them.
function webSignup(uid, extra = {}) {
  const payload = pinnedSignup(uid, {
    email: "ada@example.com",
    notificationsEnabled: true,
    ...extra,
  });
  if (!Object.prototype.hasOwnProperty.call(extra, "phoneNumber")) {
    delete payload.phoneNumber;
  }
  return payload;
}

function writeUser(uid, data, claims) {
  const db = env.authenticatedContext(uid, claims).firestore();
  return setDoc(doc(db, `users/${uid}`), data);
}

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

test("signup allowlist, server-only Gold fields, and the device hash are named", () => {
  assert.match(RULES, /function signupUserKeys\(\)/);
  assert.match(RULES, /function serverOnlyUserKeys\(\)/);
  assert.match(RULES, /'subscriptionExpiresAt'/);
  assert.match(RULES, /'subscriptionSource'/);
  assert.match(RULES, /'playPurchaseTokenHash'/);
  assert.match(RULES, /'subscriptionProductId'/);
  assert.match(RULES, /function activeDeviceIdAllowedOnCreate\(\)/);
  assert.match(RULES, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(RULES, /'showOnDriverMap'/);
  assert.match(RULES, /'userStatus'/);
  assert.match(RULES, /'currentStatus'/);
});

test("iOS signup omits nil fields and sends a 64-hex device id with no claim", async () => {
  await assertSucceeds(writeUser("ada", iosSignup("ada")));
  const saved = await assertSucceeds(getDoc(doc(
    env.authenticatedContext("ada").firestore(),
    "users/ada",
  )));
  assert.equal(saved.get("subscriptionExpiresAt"), undefined);
  assert.equal(saved.get("email"), undefined);
  assert.equal(saved.get("fleetId"), undefined);
  assert.equal(saved.get("carId"), undefined);
  assert.equal(saved.get("location"), undefined);
  assert.equal(saved.get("userStatus"), undefined);
  assert.equal(saved.get("activeDeviceId"), DEVICE_HASH);
  assert.equal(saved.get("dayStreak"), 1);
  assert.equal(saved.get("isOnline"), true);
  assert.equal(saved.get("selectedAvatar"), "skin-default");
});

test("Android signup sends explicit nulls and a server createdAt", async () => {
  const payload = androidSignup("ada");
  assert.equal(payload.email, null);
  assert.equal(payload.subscriptionExpiresAt, null);
  assert.equal(payload.subscriptionSource, undefined);
  assert.equal(payload.showOnDriverMap, undefined);
  assert.equal(payload.phoneNumber, "+447700900123");
  assert.equal(payload.activeDeviceId, DEVICE_HASH);
  await assertSucceeds(writeUser("ada", payload));
  const saved = await assertSucceeds(getDoc(doc(
    env.authenticatedContext("ada").firestore(),
    "users/ada",
  )));
  assert.equal(saved.get("email"), null);
  assert.equal(saved.get("subscriptionExpiresAt"), null);
  assert.equal(saved.get("fleetId"), null);
  assert.equal(saved.get("carId"), null);
  assert.equal(saved.get("location"), null);
  assert.equal(saved.get("currentStatus"), null);
  assert.equal(saved.get("lastActiveAt"), null);
  assert.equal(saved.get("locationUpdatedAt"), null);
  assert.ok(saved.get("createdAt"));
  assert.equal(saved.get("userStatus"), undefined);
  assert.equal(saved.get("phoneNumber"), "+447700900123");
  assert.equal(saved.get("activeDeviceId"), DEVICE_HASH);
});

test("web sends no activeDeviceId; the marketing profile fields are allowed", async () => {
  const payload = webSignup("ada");
  assert.equal("activeDeviceId" in payload, false);
  await assertSucceeds(writeUser("ada", payload));
  const saved = await assertSucceeds(getDoc(doc(
    env.authenticatedContext("ada").firestore(),
    "users/ada",
  )));
  assert.equal(saved.get("email"), "ada@example.com");
  assert.equal(saved.get("notificationsEnabled"), true);
  assert.equal(saved.get("selectedAvatar"), "skin-default");
  assert.equal(saved.get("activeDeviceId"), undefined);
});

test("subscriptionSource and subscriptionExpiresAt may be null and not a grant", async () => {
  await assertSucceeds(writeUser("nulls", iosSignup("nulls", {
    subscriptionExpiresAt: null,
    subscriptionSource: null,
  })));
  const future = Timestamp.fromDate(new Date("2030-01-01T00:00:00Z"));
  const past = Timestamp.fromDate(new Date("2020-01-01T00:00:00Z"));
  await assertFails(writeUser("future", iosSignup("future", {subscriptionExpiresAt: future})));
  await assertFails(writeUser("past", iosSignup("past", {subscriptionExpiresAt: past})));
  await assertFails(writeUser("src-apple", iosSignup("src-apple", {subscriptionSource: "apple"})));
  await assertFails(writeUser("src-play", iosSignup("src-play", {subscriptionSource: "play"})));
  await assertFails(writeUser("hash", iosSignup("hash", {playPurchaseTokenHash: "abc"})));
  await assertFails(writeUser("product", iosSignup("product", {subscriptionProductId: "gold_monthly"})));
});

test("activeDeviceId matches a claim, or a 64-hex hash when there is no claim", async () => {
  await assertSucceeds(writeUser("claimed", iosSignup("claimed"), {deviceId: DEVICE_HASH}));

  await assertFails(writeUser("mismatch", iosSignup("mismatch", {
    activeDeviceId: OTHER_HASH,
  }), {deviceId: DEVICE_HASH}));

  const omitted = iosSignup("omitted");
  delete omitted.activeDeviceId;
  await assertFails(writeUser("omitted", omitted, {deviceId: DEVICE_HASH}));

  await assertFails(writeUser("word", iosSignup("word", {activeDeviceId: "device-live"})));
  await assertFails(writeUser("upper", iosSignup("upper", {activeDeviceId: "A".repeat(64)})));
  await assertFails(writeUser("short", iosSignup("short", {activeDeviceId: "a".repeat(63)})));
  await assertFails(writeUser("null-device", iosSignup("null-device", {activeDeviceId: null})));
});

test("another uid, an unknown key, and showOnDriverMap are denied on create", async () => {
  const ada = env.authenticatedContext("ada").firestore();
  await assertFails(setDoc(doc(ada, "users/bob"), iosSignup("bob")));
  await assertFails(writeUser("ada", iosSignup("ada", {uid: "bob"})));
  await assertFails(writeUser("mystery", iosSignup("mystery", {mystery: 1})));
  await assertFails(writeUser("mapflag", iosSignup("mapflag", {showOnDriverMap: true})));
  await assertFails(writeUser("suspend", iosSignup("suspend", {isSuspended: false})));
});

test("starting values cannot be inflated", async () => {
  const cases = [
    ["xp", {xp: 1}],
    ["level", {level: 2}],
    ["ferro", {ferroBalance: 1}],
    ["score", {contributionScore: 1}],
    ["streak0", {dayStreak: 0}],
    ["streak2", {dayStreak: 2}],
    ["offline", {isOnline: false}],
    ["avatar", {selectedAvatar: 1}],
    ["config", {avatarConfig: "nope"}],
    ["token", {fcmToken: null}],
  ];
  for (const [id, extra] of cases) {
    await assertFails(writeUser(id, iosSignup(id, extra)));
  }
});

test("nullable signup fields accept null or a real value, and reject a bad type", async () => {
  await assertSucceeds(writeUser("nulls", iosSignup("nulls", {
    email: null,
    fleetId: null,
    carId: "car-1",
    userStatus: null,
    currentStatus: "online",
    location: new GeoPoint(51.5, -0.12),
  })));
  await assertSucceeds(writeUser("map", iosSignup("map", {
    userStatus: "active",
    fleetId: "fleet-1",
    location: {latitude: 51.5, longitude: -0.12},
  })));
  await assertFails(writeUser("loc", iosSignup("loc", {location: "london"})));
  await assertFails(writeUser("status", iosSignup("status", {userStatus: 1})));
  await assertFails(writeUser("current", iosSignup("current", {currentStatus: 1})));
  await assertFails(writeUser("email", iosSignup("email", {email: 1})));
  await assertFails(writeUser("fleet", iosSignup("fleet", {fleetId: 9})));
  await assertFails(writeUser("car", iosSignup("car", {carId: 9})));
});

test("signup timestamps are missing, null, or the server time", async () => {
  const old = Timestamp.fromDate(new Date("2020-01-01T00:00:00Z"));
  await assertFails(writeUser("created", iosSignup("created", {createdAt: old})));
  await assertFails(writeUser("active", iosSignup("active", {lastActiveAt: old})));
  await assertFails(writeUser("moved", iosSignup("moved", {locationUpdatedAt: old})));
  await assertSucceeds(writeUser("null-clocks", iosSignup("null-clocks", {
    createdAt: null,
    lastActiveAt: null,
    locationUpdatedAt: null,
  })));
});

test("showOnDriverMap is a bool on update and is not a signup field", async () => {
  await seed([["users/bob", userDoc("bob")]]);
  const bob = env.authenticatedContext("bob", {deviceId: "device-live"}).firestore();
  await assertSucceeds(updateDoc(doc(bob, "users/bob"), {showOnDriverMap: true}));
  await assertSucceeds(updateDoc(doc(bob, "users/bob"), {showOnDriverMap: false}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {showOnDriverMap: "yes"}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {showOnDriverMap: 1}));

  const ada = env.authenticatedContext("ada").firestore();
  await assertFails(setDoc(doc(ada, "users/ada"), iosSignup("ada", {showOnDriverMap: true})));
});

test("a client update cannot set Gold fields or activeDeviceId", async () => {
  await seed([["users/bob", {
    ...userDoc("bob"),
    subscriptionExpiresAt: null,
    subscriptionSource: null,
  }]]);
  const bob = env.authenticatedContext("bob", {deviceId: "device-live"}).firestore();
  const future = Timestamp.fromDate(new Date("2030-01-01T00:00:00Z"));
  await assertFails(updateDoc(doc(bob, "users/bob"), {subscriptionExpiresAt: future}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {subscriptionSource: "apple"}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {subscriptionSource: "play"}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {activeDeviceId: OTHER_HASH}));
  await assertFails(updateDoc(doc(bob, "users/bob"), {playPurchaseTokenHash: "abc"}));
  await assertSucceeds(updateDoc(doc(bob, "users/bob"), {
    name: "Bobby",
    notificationsEnabled: false,
  }));

  const session = env.authenticatedContext("bob").firestore();
  await assertSucceeds(setDoc(doc(session, "deviceSessionRequests/bob"), {
    deviceId: DEVICE_HASH,
    status: "pending",
    createdAt: serverTimestamp(),
  }));
});
