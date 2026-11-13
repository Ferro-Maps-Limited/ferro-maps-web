/**
 * Active-device check on hotspot_forecasts. Grace comes from
 * config/deviceCheck.graceUntil. A missing config means no grace.
 * Project ids are demo-.
 */
const {describe, it, before, beforeEach, after} = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const {doc, getDoc, getDocs, collection, setDoc, Timestamp} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const FUTURE = Timestamp.fromMillis(Date.now() + 86_400_000);
const FORECAST = {
  forecast: {state: "available", v: 1},
  window_end: Timestamp.fromMillis(Date.now() + 3_600_000),
};

describe("forecast reads check the active device", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-device",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "users", "unlimited"), {
        surgeUnlimitedUntil: FUTURE,
        activeDeviceId: "device-live",
      });
      await setDoc(doc(db, "users", "unstamped"), {surgeUnlimitedUntil: FUTURE});
      await setDoc(doc(db, "users", "credit"), {activeDeviceId: "device-live"});
      await setDoc(doc(db, "users", "credit", "hotspot_unlocks", "sheet_a"), {validUntil: FUTURE});
      await setDoc(doc(db, "hotspot_forecasts", "sheet_a"), FORECAST);
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("allows a matching stamp and refuses a wrong one", async () => {
    const matching = env.authenticatedContext("unlimited", {deviceId: "device-live"}).firestore();
    await assertSucceeds(getDoc(doc(matching, "hotspot_forecasts", "sheet_a")));
    await assertSucceeds(getDocs(collection(matching, "hotspot_forecasts")));
    const wrong = env.authenticatedContext("unlimited", {deviceId: "other-phone"}).firestore();
    await assertFails(getDoc(doc(wrong, "hotspot_forecasts", "sheet_a")));
    await assertFails(getDocs(collection(wrong, "hotspot_forecasts")));
  });

  it("refuses a missing stamp when no grace is configured, and allows it while graceUntil is ahead", async () => {
    const open = env.authenticatedContext("unlimited").firestore();
    await assertFails(getDoc(doc(open, "hotspot_forecasts", "sheet_a")));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "config/deviceCheck"), {
        graceUntil: Timestamp.fromMillis(Date.now() + 86_400_000),
      });
    });
    await assertSucceeds(getDoc(doc(open, "hotspot_forecasts", "sheet_a")));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "config/deviceCheck"), {
        graceUntil: Timestamp.fromMillis(Date.now() - 1_000),
      });
    });
    await assertFails(getDoc(doc(open, "hotspot_forecasts", "sheet_a")));
    await assertFails(getDocs(collection(open, "hotspot_forecasts")));
  });

  it("still allows a user with no activeDeviceId when grace is missing", async () => {
    const closed = env.authenticatedContext("unstamped").firestore();
    await assertSucceeds(getDoc(doc(closed, "hotspot_forecasts", "sheet_a")));
  });

  it("refuses an unlocked forecast when the device stamp is wrong", async () => {
    const wrong = env.authenticatedContext("credit", {deviceId: "other-phone"}).firestore();
    await assertFails(getDoc(doc(wrong, "hotspot_forecasts", "sheet_a")));
    const matching = env.authenticatedContext("credit", {deviceId: "device-live"}).firestore();
    await assertSucceeds(getDoc(doc(matching, "hotspot_forecasts", "sheet_a")));
    await assertFails(getDocs(collection(matching, "hotspot_forecasts")));
  });
});
