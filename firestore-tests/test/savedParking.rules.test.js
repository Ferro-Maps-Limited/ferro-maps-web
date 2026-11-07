/**
 * Owner read of saved_parking and meta/savedParking. Clients cannot write.
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
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
const PLACE = "a".repeat(64);

const SAVE = {
  savedAt: new Date(),
  name: "Yard",
  lat: 51.5,
  lng: -0.12,
  cellId: "gcpvj0",
};

describe("saved_parking rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-saved-parking",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "users", "ada", "saved_parking", PLACE), SAVE);
      await setDoc(doc(db, "users", "ada", "meta", "savedParking"), {count: 1});
      await setDoc(doc(db, "users", "lapsed", "saved_parking", PLACE), SAVE);
      await setDoc(doc(db, "users", "lapsed", "meta", "savedParking"), {count: 1});
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("lets the owner read the save and the counter, with no Gold check", async () => {
    const db = env.authenticatedContext("ada").firestore();
    const save = await assertSucceeds(getDoc(doc(db, "users", "ada", "saved_parking", PLACE)));
    if (!save.exists() || save.data().name !== "Yard") throw new Error("owner read missed the save");
    const listed = await assertSucceeds(getDocs(collection(db, "users", "ada", "saved_parking")));
    if (listed.size !== 1) throw new Error(`expected one save, saw ${listed.size}`);
    const count = await assertSucceeds(getDoc(doc(db, "users", "ada", "meta", "savedParking")));
    if (!count.exists() || count.data().count !== 1) throw new Error("owner read missed the counter");

    const lapsed = env.authenticatedContext("lapsed").firestore();
    await assertSucceeds(getDoc(doc(lapsed, "users", "lapsed", "saved_parking", PLACE)));
    await assertSucceeds(getDoc(doc(lapsed, "users", "lapsed", "meta", "savedParking")));
  });

  it("denies another user and a signed-out user", async () => {
    const other = env.authenticatedContext("bea").firestore();
    await assertFails(getDoc(doc(other, "users", "ada", "saved_parking", PLACE)));
    await assertFails(getDocs(collection(other, "users", "ada", "saved_parking")));
    await assertFails(getDoc(doc(other, "users", "ada", "meta", "savedParking")));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "users", "ada", "saved_parking", PLACE)));
    await assertFails(getDoc(doc(anon, "users", "ada", "meta", "savedParking")));
  });

  it("denies client creates, updates, and deletes of the save and the counter", async () => {
    const db = env.authenticatedContext("ada").firestore();
    const saveRef = doc(db, "users", "ada", "saved_parking", PLACE);
    const otherRef = doc(db, "users", "ada", "saved_parking", "b".repeat(64));
    const counterRef = doc(db, "users", "ada", "meta", "savedParking");
    const shaped = {
      savedAt: serverTimestamp(),
      name: "n".repeat(120),
      lat: 90,
      lng: -180,
      cellId: "c".repeat(64),
    };
    await assertFails(setDoc(otherRef, shaped));
    await assertFails(setDoc(otherRef, {...shaped, name: "n".repeat(121)}));
    await assertFails(setDoc(otherRef, {...shaped, lat: 90.1}));
    await assertFails(setDoc(otherRef, {...shaped, lng: -180.1}));
    await assertFails(setDoc(otherRef, {...shaped, cellId: "c".repeat(65)}));
    await assertFails(updateDoc(saveRef, {name: "Changed"}));
    await assertFails(setDoc(saveRef, shaped));
    await assertFails(deleteDoc(saveRef));
    await assertFails(setDoc(counterRef, {count: 0}));
    await assertFails(updateDoc(counterRef, {count: 2}));
    await assertFails(deleteDoc(counterRef));
    await assertFails(setDoc(doc(db, "users", "bea", "saved_parking", PLACE), shaped));
    await assertFails(setDoc(doc(db, "users", "bea", "meta", "savedParking"), {count: 1}));
  });
});
