/**
 * Signed-in read of roadCharges and its charge_points and rates.
 * The import request is admin-create only.
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
  serverTimestamp,
} = require("firebase/firestore");

const RULES = fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8");

const ZONE = {
  doc_id: "uk-lon-ulez",
  name: "London Ultra Low Emission Zone (ULEZ)",
  charge_type: "ultra_low_emission_zone",
  car_std_gbp: 12.5,
};

describe("roadCharges signed-in reads", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-road-charges",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "roadCharges", "uk-lon-ulez"), ZONE);
      await setDoc(doc(db, "roadCharges", "uk-lon-ulez", "charge_points", "example"), {point_id: "example"});
      await setDoc(doc(db, "roadCharges", "uk-lon-ulez", "rates", "car"), {amount_gbp: 12.5});
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("allows a signed-in driver to read a charge, a point, and a rate", async () => {
    const db = env.authenticatedContext("plain").firestore();
    await assertSucceeds(getDoc(doc(db, "roadCharges", "uk-lon-ulez")));
    await assertSucceeds(getDoc(doc(db, "roadCharges", "uk-lon-ulez", "charge_points", "example")));
    await assertSucceeds(getDoc(doc(db, "roadCharges", "uk-lon-ulez", "rates", "car")));
    await assertFails(setDoc(doc(db, "roadCharges", "uk-lon-ulez"), {name: "forged"}));
    await assertFails(setDoc(doc(db, "roadCharges", "uk-lon-ulez", "rates", "forged"), {amount_gbp: 0}));
    await assertFails(setDoc(doc(db, "roadCharges", "uk-lon-ulez", "charge_points", "forged"), {point_id: "forged"}));
  });

  it("denies a signed-out reader", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "roadCharges", "uk-lon-ulez")));
    await assertFails(getDoc(doc(db, "roadCharges", "uk-lon-ulez", "charge_points", "example")));
    await assertFails(getDoc(doc(db, "roadCharges", "uk-lon-ulez", "rates", "car")));
  });

  it("lets an admin create an import request and stops a driver doing so", async () => {
    const admin = env.authenticatedContext("admin-uid", {role: "admin"}).firestore();
    await assertSucceeds(setDoc(doc(admin, "roadChargesImportRequests", "run-1"), {
      requestedBy: "admin-uid",
      status: "pending",
      createdAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(admin, "roadChargesImportRequests", "run-1"), {status: "done"}));

    const driver = env.authenticatedContext("plain").firestore();
    await assertFails(setDoc(doc(driver, "roadChargesImportRequests", "run-2"), {
      requestedBy: "plain",
      status: "pending",
      createdAt: serverTimestamp(),
    }));
    await assertFails(getDoc(doc(driver, "roadChargesImportRequests", "run-1")));
    await assertSucceeds(getDoc(doc(admin, "roadChargesImportRequests", "run-1")));
  });
});
