/**
 * hotspot_forecast_summaries is a signed-in read. Clients cannot write.
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
  setDoc,
  updateDoc,
  deleteDoc,
  Timestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

const SUMMARY = {
  windowStart: Timestamp.fromMillis(Date.parse("2026-07-15T16:00:00.000Z")),
  windowEnd: Timestamp.fromMillis(Date.parse("2026-07-15T18:00:00.000Z")),
  confidence: 75,
  geohash4: "gcpv",
  expireAt: Timestamp.fromMillis(Date.parse("2026-07-15T23:00:00.000Z")),
};

describe("hotspot_forecast_summaries rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-summaries",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "hotspot_forecast_summaries", "opaque_a"), SUMMARY);
      await setDoc(doc(ctx.firestore(), "plannerSummaryKeys", "opaque_a"), {
        hotspotId: "sheet_secret",
        windowStart: SUMMARY.windowStart,
        windowEnd: SUMMARY.windowEnd,
        expireAt: SUMMARY.expireAt,
      });
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("lets a signed-in driver read one summary and list them", async () => {
    const database = env.authenticatedContext("ada").firestore();
    const saved = await assertSucceeds(getDoc(doc(database, "hotspot_forecast_summaries", "opaque_a")));
    assert.equal(saved.get("confidence"), 75);
    assert.equal(saved.get("geohash4"), "gcpv");
    assert.equal(saved.get("startAt"), undefined);
    assert.equal(saved.get("name"), undefined);
    assert.equal(saved.get("venue"), undefined);
    assert.equal(saved.get("hotspotId"), undefined);
    const listed = await assertSucceeds(getDocs(collection(database, "hotspot_forecast_summaries")));
    assert.equal(listed.size, 1);
  });

  it("denies a signed-out read", async () => {
    const database = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(database, "hotspot_forecast_summaries", "opaque_a")));
    await assertFails(getDocs(collection(database, "hotspot_forecast_summaries")));
  });

  it("denies every client write", async () => {
    const database = env.authenticatedContext("ada").firestore();
    await assertFails(setDoc(doc(database, "hotspot_forecast_summaries", "pin_b"), SUMMARY));
    await assertFails(updateDoc(doc(database, "hotspot_forecast_summaries", "opaque_a"), {confidence: 1}));
    await assertFails(deleteDoc(doc(database, "hotspot_forecast_summaries", "opaque_a")));
  });

  it("denies every client read and write of the summary key", async () => {
    const database = env.authenticatedContext("ada").firestore();
    await assertFails(getDoc(doc(database, "plannerSummaryKeys", "opaque_a")));
    await assertFails(getDocs(collection(database, "plannerSummaryKeys")));
    await assertFails(setDoc(doc(database, "plannerSummaryKeys", "opaque_b"), {hotspotId: "sheet_secret"}));
    await assertFails(deleteDoc(doc(database, "plannerSummaryKeys", "opaque_a")));
  });

  it("keeps the hotspots_test rule unchanged", () => {
    assert.match(RULES, /match \/hotspots_test\/\{docId\} \{\n {6}allow read: {2}if request\.auth != null;\n {6}allow write: if false;\n {4}\}/);
    assert.match(RULES, /match \/hotspot_forecast_summaries\/\{summaryId\} \{\n {6}allow read: if request\.auth != null;\n {6}allow write: if false;\n {4}\}/);
    assert.match(RULES, /match \/plannerSummaryKeys\/\{summaryId\} \{\n {6}allow read, write: if false;\n {4}\}/);
  });
});
