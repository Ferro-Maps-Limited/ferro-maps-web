/**
 * surgeAlerts is server-only. Project ids are demo-.
 */
const fs = require("fs");
const path = require("path");
const {describe, it, before, beforeEach, after} = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {doc, getDoc, setDoc} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

describe("surge active alert rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-surge-active",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "surgeAlerts", "sheet_a|1"), {
        hotspotId: "sheet_a",
      });
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("denies a signed-in read and write", async () => {
    const database = env.authenticatedContext("ada").firestore();
    await assertFails(getDoc(doc(database, "surgeAlerts", "sheet_a|1")));
    await assertFails(setDoc(doc(database, "surgeAlerts", "sheet_b|1"), {hotspotId: "sheet_b"}));
    assert.match(RULES, /match \/surgeAlerts\/\{episodeId\} \{\n {6}allow read, write: if false;\n {4}\}/);
  });
});
