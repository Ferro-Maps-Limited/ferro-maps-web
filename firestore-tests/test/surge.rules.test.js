/**
 * Server-only surge paths from contract §21.2.
 * Project ids are demo- so the emulator cannot reach a real project.
 * The stored price is synthetic and must stay unreadable.
 */
const fs = require("fs");
const path = require("path");
const {describe, it, before, beforeEach, after} = require("node:test");
const {
  initializeTestEnvironment,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {doc, getDoc, setDoc, Timestamp} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

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
      await setDoc(doc(db, "surgeReadings", "reading-1"), {
        eventId: "evt-1",
        pricePence: 1250,
        baselinePence: 1000,
      });
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

  it("denies a Gold driver every surge path and the import switch", async () => {
    const db = env.authenticatedContext("gold").firestore();
    await assertFails(getDoc(doc(db, "surgeReadings", "reading-1")));
    await assertFails(getDoc(doc(db, "surgeEvents", "evt-1")));
    await assertFails(getDoc(doc(db, "surgeEvents", "evt-1", "pickups", "north")));
    await assertFails(getDoc(doc(db, "surgeImports", "run-1")));
    await assertFails(getDoc(doc(db, "surgeLinks", "pin-1")));
    await assertFails(getDoc(doc(db, "surgeShadow", "evt-1_pin-1")));
    await assertFails(getDoc(doc(db, "config", "surgeImport")));
    await assertFails(setDoc(doc(db, "surgeReadings", "reading-2"), {pricePence: 1}));
    await assertFails(setDoc(doc(db, "config", "surgeImport"), {enabled: true}));
  });

  it("denies a signed-out reader", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "surgeReadings", "reading-1")));
    await assertFails(getDoc(doc(db, "surgeEvents", "evt-1", "pickups", "north")));
  });
});
