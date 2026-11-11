/**
 * DVLA lookup cache and its server-side counters are closed to every client.
 * Project ids are demo- so the emulator cannot reach a real project.
 */
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const {describe, it, before, beforeEach, after} = require("node:test");
const {
  initializeTestEnvironment,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const COLLECTIONS = [
  "vehicle_lookups",
  "vehicle_lookup_limits",
  "vehicle_lookup_throttle",
];

async function assertClosed(db, name) {
  await assertFails(getDoc(doc(db, name, "doc-1")));
  await assertFails(getDocs(collection(db, name)));
  await assertFails(setDoc(doc(db, name, "doc-new"), {registration: "AB12CDE"}));
  await assertFails(setDoc(doc(db, name, "doc-1"), {make: "FORGED"}));
  await assertFails(updateDoc(doc(db, name, "doc-1"), {make: "FORGED"}));
  await assertFails(deleteDoc(doc(db, name, "doc-1")));
  await assertFails(getDoc(doc(db, name, "doc-1", "nested", "secret")));
  await assertFails(setDoc(doc(db, name, "doc-1", "nested", "secret"), {plate: "AB12CDE"}));
}

describe("vehicle lookup rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-vehicle-rules",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (const name of COLLECTIONS) {
        await setDoc(doc(db, name, "doc-1"), {
          registration: "AB12CDE",
          make: "ROVER",
          count: 1,
          nextSlotAt: 1,
        });
      }
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("names the three server-only collections", () => {
    assert.match(RULES, /match \/vehicle_lookups\/\{vrn\}/);
    assert.match(RULES, /match \/vehicle_lookup_limits\/\{docId\}/);
    assert.match(RULES, /match \/vehicle_lookup_throttle\/\{docId\}/);
  });

  for (const name of COLLECTIONS) {
    it(`denies every client on ${name}`, async () => {
      const contexts = [
        env.unauthenticatedContext().firestore(),
        env.authenticatedContext("driver").firestore(),
        env.authenticatedContext("admin-user", {role: "admin"}).firestore(),
        env.authenticatedContext("support-user", {role: "support"}).firestore(),
      ];
      for (const db of contexts) await assertClosed(db, name);
    });
  }
});
