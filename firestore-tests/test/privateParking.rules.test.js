/**
 * Gold read gate for privateParkingCells.
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
  doc,
  getDoc,
  setDoc,
  Timestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

const CELL = {
  v: 1,
  cell: "gcpvj0",
  places: [{id: "place-1", n: "Yard", p: [51.5, -0.12], s: 1}],
};

describe("privateParkingCells Gold reads", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-private-parking",
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
      await setDoc(doc(db, "users", "plain"), {name: "No expiry"});
      await setDoc(doc(db, "privateParkingCells", "gcpvj0"), CELL);
      await setDoc(doc(db, "privateParkingCells", "gcpvj0_1"), {...CELL, cell: "gcpvj0"});
      await setDoc(doc(db, "privateParkingCells", "gcpvj0", "shards", "cell_1"), {places: []});
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("allows an active Gold user to read the cell, a shard sibling, and a shard subcollection", async () => {
    const db = env.authenticatedContext("gold").firestore();
    await assertSucceeds(getDoc(doc(db, "privateParkingCells", "gcpvj0")));
    await assertSucceeds(getDoc(doc(db, "privateParkingCells", "gcpvj0_1")));
    await assertSucceeds(getDoc(doc(db, "privateParkingCells", "gcpvj0", "shards", "cell_1")));
    await assertFails(setDoc(doc(db, "privateParkingCells", "gcpvj0"), {v: 2}));
    await assertFails(setDoc(doc(db, "privateParkingCells", "gcpvj0", "shards", "cell_2"), {places: []}));
  });

  it("denies an expired user", async () => {
    const db = env.authenticatedContext("expired").firestore();
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0")));
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0_1")));
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0", "shards", "cell_1")));
  });

  it("denies a user with no subscriptionExpiresAt field", async () => {
    const db = env.authenticatedContext("plain").firestore();
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0")));
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0_1")));
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0", "shards", "cell_1")));
  });

  it("denies a signed-out user", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0")));
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0_1")));
    await assertFails(getDoc(doc(db, "privateParkingCells", "gcpvj0", "shards", "cell_1")));
  });
});
