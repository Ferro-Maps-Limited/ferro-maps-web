/**
 * config/flags and config/categories are signed-in gets.
 * Job switches such as config/liveSurge stay denied.
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
const {doc, getDoc, getDocs, setDoc, collection} = require("firebase/firestore");
const {flagsDocument} = require("../../scripts/seed-config/flags");
const {categoriesDocument} = require("../../scripts/seed-config/categories");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

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

test("a signed-in driver can get flags and categories and cannot write them", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "config/flags"), flagsDocument());
    await setDoc(doc(db, "config/categories"), categoriesDocument());
    await setDoc(doc(db, "config/appVersion"), {minimumVersion: "1.0.0"});
    await setDoc(doc(db, "config/activeBanner"), {message: "hi"});
    await setDoc(doc(db, "config/liveSurge"), {enabled: false});
  });
  const bob = env.authenticatedContext("bob").firestore();
  const anon = env.unauthenticatedContext().firestore();
  const flags = await assertSucceeds(getDoc(doc(bob, "config/flags")));
  assert.equal(flags.data().pinsV1, false);
  assert.equal(flags.data().surge, true);
  const categories = await assertSucceeds(getDoc(doc(bob, "config/categories")));
  assert.equal(categories.data().categories.length, 14);
  await assertSucceeds(getDoc(doc(bob, "config/appVersion")));
  await assertSucceeds(getDoc(doc(bob, "config/activeBanner")));
  await assertFails(getDoc(doc(anon, "config/flags")));
  await assertFails(getDoc(doc(bob, "config/liveSurge")));
  await assertFails(setDoc(doc(bob, "config/flags"), {pinsV1: true}));
  await assertFails(getDocs(collection(bob, "config")));
});
