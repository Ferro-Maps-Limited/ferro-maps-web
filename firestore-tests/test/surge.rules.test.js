/**
 * Server-only surge paths from contract §21.2.
 * Project ids are demo- so the emulator cannot reach a real project.
 * Stored prices are synthetic.
 */
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {describe, it, before, beforeEach, after} = require("node:test");
const {
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  Timestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

const DOCS = [
  ["surgeImports", "run-1"],
  ["surgeEvents", "evt-1"],
  ["surgeEvents", "evt-1", "pickups", "north"],
  ["surgeReadings", "reading-1"],
  ["surgeLinks", "pin-1"],
  ["surgeShadow", "evt-1_pin-1"],
];

const LIST_PATHS = [
  ["surgeImports"],
  ["surgeEvents"],
  ["surgeEvents", "evt-1", "pickups"],
  ["surgeReadings"],
  ["surgeLinks"],
  ["surgeShadow"],
];

const GROUPS = [
  "surgeImports",
  "surgeEvents",
  "pickups",
  "surgeReadings",
  "surgeLinks",
  "surgeShadow",
];

async function expectDenied(promise) {
  try {
    await promise;
    throw new Error("expected permission-denied");
  } catch (err) {
    assert.equal(err.code, "permission-denied", err.message);
  }
}

describe("surge server-only paths", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-surge",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const future = Timestamp.fromMillis(Date.now() + 86_400_000);
      await setDoc(doc(db, "users", "gold"), {subscriptionExpiresAt: future});
      await setDoc(doc(db, "surgeReadings", "reading-1"), {eventId: "evt-1", pricePence: 1250});
      await setDoc(doc(db, "surgeEvents", "evt-1"), {title: "Synthetic fixture"});
      await setDoc(doc(db, "surgeEvents", "evt-1", "pickups", "north"), {name: "North gate"});
      await setDoc(doc(db, "surgeImports", "run-1"), {rowsRead: 1});
      await setDoc(doc(db, "surgeLinks", "pin-1"), {eventId: "evt-1", class: "none"});
      await setDoc(doc(db, "surgeShadow", "evt-1_pin-1"), {predictedBand: "low"});
      await setDoc(doc(db, "config", "surgeImport"), {enabled: false});
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("denies get, list, collection-group, create, update, and delete on every path", async () => {
    const db = env.authenticatedContext("gold").firestore();
    for (const parts of DOCS) {
      const ref = doc(db, ...parts);
      await expectDenied(getDoc(ref));
      await expectDenied(setDoc(doc(db, ...parts.slice(0, -1), "new-child"), {pricePence: 1}));
      await expectDenied(updateDoc(ref, {pricePence: 1}));
      await expectDenied(deleteDoc(ref));
    }
    for (const parts of LIST_PATHS) {
      await expectDenied(getDocs(collection(db, ...parts)));
    }
    for (const name of GROUPS) {
      await expectDenied(getDocs(collectionGroup(db, name)));
    }
    await expectDenied(getDoc(doc(db, "config", "surgeImport")));
    await expectDenied(setDoc(doc(db, "config", "surgeImport"), {enabled: true}));
  });

  it("denies a signed-out reader the same lists", async () => {
    const db = env.unauthenticatedContext().firestore();
    for (const parts of DOCS) {
      await expectDenied(getDoc(doc(db, ...parts)));
      await expectDenied(setDoc(doc(db, ...parts.slice(0, -1), "anon-child"), {v: 1}));
    }
    for (const parts of LIST_PATHS) {
      await expectDenied(getDocs(collection(db, ...parts)));
    }
  });
});
