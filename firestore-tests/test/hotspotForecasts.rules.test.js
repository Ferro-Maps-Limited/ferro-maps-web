/**
 * Gold read gate for hotspot_forecasts, and the unchanged hotspots_test rule.
 * Project ids are demo- so the emulator cannot reach a real project.
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
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

const FORECAST = {
  forecast: {state: "available", v: 1, strength: "low", confidence: "low"},
  window_start: Timestamp.fromMillis(Date.now()),
  window_end: Timestamp.fromMillis(Date.now() + 3_600_000),
  expire_at: Timestamp.fromMillis(Date.now() + 3_600_000),
};

describe("hotspot_forecasts Gold reads", () => {
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
      const future = Timestamp.fromMillis(Date.now() + 86_400_000);
      const past = Timestamp.fromMillis(Date.now() - 86_400_000);
      await setDoc(doc(db, "users", "gold"), {subscriptionExpiresAt: future});
      await setDoc(doc(db, "users", "expired"), {subscriptionExpiresAt: past});
      await setDoc(doc(db, "users", "free"), {name: "No expiry"});
      await setDoc(doc(db, "users", "text"), {subscriptionExpiresAt: "2099-01-01T00:00:00.000Z"});
      await setDoc(doc(db, "users", "number"), {subscriptionExpiresAt: Date.now() + 86_400_000});
      await setDoc(doc(db, "hotspot_forecasts", "sheet_gold"), FORECAST);
      await setDoc(doc(db, "hotspots_test", "sheet_gold"), {
        name: "Still public to any signed-in driver",
        forecast: FORECAST.forecast,
      });
    });
  });

  after(async () => {
    await env.cleanup();
  });

  function dbFor(uid) {
    if (!uid) return env.unauthenticatedContext().firestore();
    return env.authenticatedContext(uid).firestore();
  }

  function openForecasts(database) {
    return query(collection(database, "hotspot_forecasts"), where("window_end", ">", Timestamp.now()));
  }

  async function denyForecastReads(database) {
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_gold")));
    await assertFails(getDocs(collection(database, "hotspot_forecasts")));
    await assertFails(getDocs(openForecasts(database)));
  }

  async function denyForecastWrites(database) {
    await assertFails(setDoc(doc(database, "hotspot_forecasts", "new_pin"), FORECAST));
    await assertFails(updateDoc(doc(database, "hotspot_forecasts", "sheet_gold"), {forecast: {state: "no_prediction"}}));
    await assertFails(deleteDoc(doc(database, "hotspot_forecasts", "sheet_gold")));
    await assertFails(setDoc(doc(database, "hotspot_forecasts", "sheet_gold", "extra", "child"), {v: 1}));
  }

  it("keeps the hotspots_test rule text unchanged", () => {
    assert.match(RULES, /match \/hotspots_test\/\{docId\} \{\n {6}allow read: {2}if request\.auth != null;\n {6}allow write: if false;\n {4}\}/);
  });

  it("denies a signed-out user", async () => {
    const database = dbFor(null);
    await denyForecastReads(database);
    await denyForecastWrites(database);
    await assertFails(getDoc(doc(database, "hotspots_test", "sheet_gold")));
    await assertFails(setDoc(doc(database, "hotspots_test", "sheet_gold"), {name: "nope"}));
  });

  it("denies a signed-in free user with no subscriptionExpiresAt", async () => {
    const database = dbFor("free");
    await denyForecastReads(database);
    await denyForecastWrites(database);
    await assertSucceeds(getDoc(doc(database, "hotspots_test", "sheet_gold")));
    await assertFails(updateDoc(doc(database, "hotspots_test", "sheet_gold"), {name: "nope"}));
    await assertFails(deleteDoc(doc(database, "hotspots_test", "sheet_gold")));
  });

  it("denies expired Gold", async () => {
    const database = dbFor("expired");
    await denyForecastReads(database);
    await denyForecastWrites(database);
    await assertSucceeds(getDoc(doc(database, "hotspots_test", "sheet_gold")));
    await assertFails(setDoc(doc(database, "hotspots_test", "another"), {name: "nope"}));
  });

  it("denies a signed-in user with no user document", async () => {
    const database = dbFor("absent");
    await denyForecastReads(database);
    await denyForecastWrites(database);
  });

  it("denies a subscriptionExpiresAt that is a string or a number", async () => {
    const text = dbFor("text");
    await denyForecastReads(text);
    await denyForecastWrites(text);
    const number = dbFor("number");
    await denyForecastReads(number);
    await denyForecastWrites(number);
  });

  it("allows active Gold to read and denies every client write", async () => {
    const database = dbFor("gold");
    await assertSucceeds(getDoc(doc(database, "hotspot_forecasts", "sheet_gold")));
    const listed = await getDocs(openForecasts(database));
    assert.equal(listed.size, 1);
    assert.equal(listed.docs[0].id, "sheet_gold");
    await denyForecastWrites(database);
    const still = await getDoc(doc(database, "hotspot_forecasts", "sheet_gold"));
    assert.equal(still.exists(), true);
    assert.equal(still.get("forecast").state, "available");
    await assertFails(getDoc(doc(database, "hotspot_forecasts", "sheet_gold", "extra", "child")));
    await assertSucceeds(getDoc(doc(database, "hotspots_test", "sheet_gold")));
    await assertFails(updateDoc(doc(database, "hotspots_test", "sheet_gold"), {forecast: {state: "no_prediction"}}));
  });

  it("allows active Gold to list without a window_end filter", async () => {
    const database = dbFor("gold");
    const open = await getDocs(collection(database, "hotspot_forecasts"));
    assert.equal(open.size, 1);
    const free = dbFor("free");
    await assertFails(getDocs(collection(free, "hotspot_forecasts")));
  });
});
