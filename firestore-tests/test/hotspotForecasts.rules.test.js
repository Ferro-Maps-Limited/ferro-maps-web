/**
 * Surge-credit reads for hotspot_forecasts. Gold (subscriptionExpiresAt)
 * does not grant a forecast. Project ids are demo- so the emulator cannot
 * reach a real project.
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
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  updateDoc,
  deleteDoc,
  Timestamp,
  serverTimestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const DEVICE_HASH = "a".repeat(64);

const FORECAST = {
  forecast: {state: "available", v: 1, strength: "low", confidence: "low"},
  window_start: Timestamp.fromMillis(Date.now()),
  window_end: Timestamp.fromMillis(Date.now() + 3_600_000),
  expire_at: Timestamp.fromMillis(Date.now() + 3_600_000),
};

function futureStamp() {
  return Timestamp.fromMillis(Date.now() + 86_400_000);
}

function pastStamp() {
  return Timestamp.fromMillis(Date.now() - 86_400_000);
}

function iosSignup(uid, extra = {}) {
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
    activeDeviceId: DEVICE_HASH,
    createdAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
    locationUpdatedAt: serverTimestamp(),
    ...extra,
  };
}

function androidSignup(uid, extra = {}) {
  return iosSignup(uid, {
    email: null,
    subscriptionExpiresAt: null,
    fleetId: null,
    carId: null,
    location: null,
    currentStatus: null,
    lastActiveAt: null,
    locationUpdatedAt: null,
    ...extra,
  });
}

function payCreate(uid) {
  return {
    uid,
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

describe("hotspot_forecasts surge credit reads", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-forecasts",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const future = futureStamp();
      const past = pastStamp();
      await setDoc(doc(db, "users", "free"), {name: "No credit"});
      await setDoc(doc(db, "users", "gold"), {subscriptionExpiresAt: future});
      await setDoc(doc(db, "users", "unlimited"), {
        surgeUnlimitedUntil: future,
        activeDeviceId: "device-live",
        name: "Unlimited",
      });
      await setDoc(doc(db, "users", "text"), {surgeUnlimitedUntil: "2099-01-01T00:00:00.000Z"});
      await setDoc(doc(db, "users", "number"), {surgeUnlimitedUntil: Date.now() + 86_400_000});
      await setDoc(doc(db, "users", "past"), {surgeUnlimitedUntil: past});
      await setDoc(doc(db, "users", "credit"), {name: "Credit", activeDeviceId: "device-live"});
      await setDoc(doc(db, "users", "credit", "hotspot_unlocks", "sheet_a"), {validUntil: future});
      await setDoc(doc(db, "users", "credit", "hotspot_unlocks", "sheet_expired"), {validUntil: past});
      await setDoc(doc(db, "users", "credit", "hotspot_unlocks", "sheet_missing"), {note: "no until"});
      await setDoc(doc(db, "users", "credit", "hotspot_unlocks", "sheet_text"), {
        validUntil: "2099-01-01T00:00:00.000Z",
      });
      await setDoc(doc(db, "users", "credit", "hotspot_unlocks", "sheet_number"), {
        validUntil: Date.now() + 86_400_000,
      });
      await setDoc(doc(db, "users", "other"), {name: "Other"});
      await setDoc(doc(db, "users", "other", "hotspot_unlocks", "sheet_a"), {validUntil: future});
      for (const id of ["sheet_a", "sheet_b", "sheet_expired", "sheet_missing", "sheet_text", "sheet_number"]) {
        await setDoc(doc(db, "hotspot_forecasts", id), FORECAST);
      }
      await setDoc(doc(db, "hotspots_test", "sheet_a"), {
        name: "Still public to any signed-in driver",
        forecast: FORECAST.forecast,
      });
      await setDoc(doc(db, "privateParkingCells", "gcpvj0"), {v: 1, cell: "gcpvj0"});
    });
  });

  after(async () => {
    await env.cleanup();
  });

  function dbFor(uid, claims) {
    if (!uid) return env.unauthenticatedContext().firestore();
    const token = claims === undefined ? {deviceId: "device-live"} : claims;
    return env.authenticatedContext(uid, token).firestore();
  }

  function openForecasts(database) {
    return query(collection(database, "hotspot_forecasts"), where("window_end", ">", Timestamp.now()));
  }

  async function denyForecastReads(database) {
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_a")));
    await assertFails(getDocs(collection(database, "hotspot_forecasts")));
    await assertFails(getDocs(openForecasts(database)));
  }

  async function denyForecastWrites(database) {
    await assertFails(setDoc(doc(database, "hotspot_forecasts", "new_pin"), FORECAST));
    await assertFails(updateDoc(doc(database, "hotspot_forecasts", "sheet_a"), {
      forecast: {state: "no_prediction"},
    }));
    await assertFails(deleteDoc(doc(database, "hotspot_forecasts", "sheet_a")));
  }

  it("keeps the hotspots_test rule text unchanged", () => {
    assert.match(RULES, /match \/hotspots_test\/\{docId\} \{\n {6}allow read: {2}if request\.auth != null;\n {6}allow write: if false;\n {4}\}/);
    assert.match(RULES, /function isUnlimited\(\)/);
    assert.match(RULES, /function hasHotspotUnlock\(hotspotId\)/);
    assert.match(RULES, /'surgeUnlimitedUntil'/);
    assert.match(RULES, /allow list: if isUnlimited\(\) && forecastDeviceAllowed\(\);/);
    assert.match(RULES, /allow get: if \(isUnlimited\(\) \|\| hasHotspotUnlock\(hotspotId\)\) && forecastDeviceAllowed\(\);/);
    assert.match(RULES, /request\.auth\.token\.deviceId\s*== get\(\/databases\/\$\(database\)\/documents\/users\/\$\(request\.auth\.uid\)\)\.data\.activeDeviceId/);
  });

  it("denies a signed-out user", async () => {
    const database = dbFor(null);
    await denyForecastReads(database);
    await denyForecastWrites(database);
    await assertFails(getDoc(doc(database, "hotspots_test", "sheet_a")));
    await assertFails(setDoc(doc(database, "hotspots_test", "sheet_a"), {name: "nope"}));
  });

  it("denies a signed-in user with no user document", async () => {
    const database = dbFor("absent");
    await denyForecastReads(database);
    await denyForecastWrites(database);
  });

  it("denies a free user with no credit for get and list", async () => {
    const database = dbFor("free");
    await denyForecastReads(database);
    await denyForecastWrites(database);
    await assertSucceeds(getDoc(doc(database, "hotspots_test", "sheet_a")));
    await assertFails(updateDoc(doc(database, "hotspots_test", "sheet_a"), {name: "nope"}));
    await assertFails(deleteDoc(doc(database, "hotspots_test", "sheet_a")));
  });

  it("denies a future subscriptionExpiresAt when there is no surge credit", async () => {
    const database = dbFor("gold");
    await denyForecastReads(database);
    await denyForecastWrites(database);
  });

  it("denies surgeUnlimitedUntil as a string, a number, or a past time", async () => {
    await denyForecastReads(dbFor("text"));
    await denyForecastReads(dbFor("number"));
    await denyForecastReads(dbFor("past"));
  });

  it("allows unlimited for get, the window_end query, and an unfiltered list", async () => {
    const database = dbFor("unlimited");
    await assertSucceeds(getDoc(doc(database, "hotspot_forecasts", "sheet_a")));
    await assertSucceeds(getDoc(doc(database, "hotspot_forecasts", "sheet_b")));
    const windowed = await getDocs(openForecasts(database));
    assert.equal(windowed.size, 6);
    const open = await getDocs(collection(database, "hotspot_forecasts"));
    assert.equal(open.size, 6);
    await denyForecastWrites(database);
  });

  it("allows a credit user to get the unlocked forecast only", async () => {
    const database = dbFor("credit");
    const unlocked = await assertSucceeds(getDoc(doc(database, "hotspot_forecasts", "sheet_a")));
    assert.equal(unlocked.get("forecast").state, "available");
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_b")));
    await assertFails(getDocs(collection(database, "hotspot_forecasts")));
    await assertFails(getDocs(openForecasts(database)));
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_expired")));
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_missing")));
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_text")));
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_number")));
    await denyForecastWrites(database);
  });

  it("denies client writes on hotspot_unlocks, including the owner's uid", async () => {
    const database = dbFor("credit");
    const own = doc(database, "users", "credit", "hotspot_unlocks", "sheet_new");
    await assertFails(setDoc(own, {validUntil: futureStamp()}));
    await assertFails(updateDoc(doc(database, "users", "credit", "hotspot_unlocks", "sheet_a"), {
      validUntil: futureStamp(),
    }));
    await assertFails(deleteDoc(doc(database, "users", "credit", "hotspot_unlocks", "sheet_a")));
  });

  it("lets a user read their own unlocks and not another user's", async () => {
    const credit = dbFor("credit");
    const own = await assertSucceeds(getDoc(doc(credit, "users", "credit", "hotspot_unlocks", "sheet_a")));
    assert.ok(own.get("validUntil") instanceof Timestamp);
    const listed = await getDocs(collection(credit, "users", "credit", "hotspot_unlocks"));
    assert.equal(listed.size, 5);
    await assertFails(getDoc(doc(credit, "users", "other", "hotspot_unlocks", "sheet_a")));
    await assertFails(getDocs(collection(credit, "users", "other", "hotspot_unlocks")));
    const other = dbFor("other");
    await assertSucceeds(getDoc(doc(other, "users", "other", "hotspot_unlocks", "sheet_a")));
    await assertFails(getDoc(doc(other, "users", "credit", "hotspot_unlocks", "sheet_a")));
  });

  it("stops a client setting or changing surgeUnlimitedUntil", async () => {
    const future = futureStamp();
    const ios = env.authenticatedContext("ios-new").firestore();
    await assertFails(setDoc(doc(ios, "users", "ios-new"), iosSignup("ios-new", {surgeUnlimitedUntil: future})));
    await assertSucceeds(setDoc(doc(ios, "users", "ios-new"), iosSignup("ios-new")));
    const android = env.authenticatedContext("android-new").firestore();
    await assertFails(setDoc(
      doc(android, "users", "android-new"),
      androidSignup("android-new", {surgeUnlimitedUntil: future}),
    ));
    await assertSucceeds(setDoc(doc(android, "users", "android-new"), androidSignup("android-new")));
    const saved = await getDoc(doc(ios, "users", "ios-new"));
    assert.equal(saved.get("surgeUnlimitedUntil"), undefined);

    const editor = env.authenticatedContext("unlimited", {deviceId: "device-live"}).firestore();
    await assertFails(updateDoc(doc(editor, "users", "unlimited"), {surgeUnlimitedUntil: future}));
    await assertSucceeds(updateDoc(doc(editor, "users", "unlimited"), {name: "Still unlimited"}));
    const kept = await getDoc(doc(editor, "users", "unlimited"));
    assert.equal(kept.get("name"), "Still unlimited");
    assert.ok(kept.get("surgeUnlimitedUntil") instanceof Timestamp);
  });

  it("stops a client setting or changing surgePlan", async () => {
    const ios = env.authenticatedContext("ios-plan").firestore();
    await assertFails(setDoc(doc(ios, "users", "ios-plan"), iosSignup("ios-plan", {surgePlan: "ultimate"})));
    await assertFails(setDoc(doc(ios, "users", "ios-plan"), iosSignup("ios-plan", {surgePlan: "stardust"})));
    await assertSucceeds(setDoc(doc(ios, "users", "ios-plan"), iosSignup("ios-plan")));
    assert.equal((await getDoc(doc(ios, "users", "ios-plan"))).get("surgePlan"), undefined);

    const editor = env.authenticatedContext("unlimited", {deviceId: "device-live"}).firestore();
    await assertFails(updateDoc(doc(editor, "users", "unlimited"), {surgePlan: "premium"}));
    await assertFails(updateDoc(doc(editor, "users", "unlimited"), {surgePlan: "ultimate"}));
    const kept = await getDoc(doc(editor, "users", "unlimited"));
    assert.equal(kept.get("surgePlan"), undefined);
    assert.equal(RULES.includes("'surgePlan'"), true);
    const starter = env.authenticatedContext("ios-start").firestore();
    await assertFails(setDoc(doc(starter, "users", "ios-start"), iosSignup("ios-start", {
      subscriptionPeriodStart: Timestamp.fromMillis(Date.now()),
    })));
    await assertFails(updateDoc(doc(editor, "users", "unlimited"), {
      subscriptionPeriodStart: Timestamp.fromMillis(Date.now()),
    }));
    assert.equal(RULES.includes("'subscriptionPeriodStart'"), true);
  });

  it("leaves hotspots_test, parking, and other isGold users unchanged", async () => {
    const gold = dbFor("gold");
    await assertSucceeds(getDoc(doc(gold, "hotspots_test", "sheet_a")));
    await assertFails(updateDoc(doc(gold, "hotspots_test", "sheet_a"), {name: "nope"}));
    await assertSucceeds(getDoc(doc(gold, "privateParkingCells", "gcpvj0")));
    await assertSucceeds(setDoc(doc(gold, "parkingPaymentRequests", "req-gold"), payCreate("gold")));
    await assertFails(getDoc(doc(gold, "hotspot_forecasts", "sheet_a")));

    const unlimited = dbFor("unlimited");
    await assertFails(getDoc(doc(unlimited, "privateParkingCells", "gcpvj0")));
    await assertFails(setDoc(doc(unlimited, "parkingPaymentRequests", "req-unlimited"), payCreate("unlimited")));
    await assertSucceeds(getDoc(doc(unlimited, "hotspots_test", "sheet_a")));
    await assertSucceeds(getDoc(doc(unlimited, "hotspot_forecasts", "sheet_a")));
  });
});
