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

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");
let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-ferromaps-pin-rules",
    firestore: {rules: RULES},
  });
});

test.after(async () => {
  await env.cleanup();
});

test("pins and pinTiles are signed-in reads and are not writable", async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "pins/p1"), {v: 1, g5: "u4pru"});
    await setDoc(doc(db, "pinTiles/u4pru"), {v: 1});
  });
  const bob = env.authenticatedContext("bob").firestore();
  const anon = env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(bob, "pins/p1")));
  await assertFails(getDoc(doc(anon, "pins/p1")));
  await assertFails(setDoc(doc(bob, "pins/p2"), {v: 1}));
  await assertSucceeds(getDoc(doc(bob, "pinTiles/u4pru")));
  await assertFails(getDocs(collection(bob, "pinTiles")));
  await assertFails(setDoc(doc(bob, "pinTiles/u4pru"), {v: 2}));
  assert.match(RULES, /match \/pins\/\{pinId\}/);
  assert.match(RULES, /match \/pinTiles\/\{tileId\}/);
});
