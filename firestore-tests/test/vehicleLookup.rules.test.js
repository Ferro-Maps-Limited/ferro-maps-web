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
  serverTimestamp,
  Timestamp,
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

  it("names the three server-only collections and the request collection", () => {
    assert.match(RULES, /match \/vehicle_lookups\/\{vrn\}/);
    assert.match(RULES, /match \/vehicle_lookup_limits\/\{docId\}/);
    assert.match(RULES, /match \/vehicle_lookup_throttle\/\{docId\}/);
    assert.match(RULES, /match \/vehicleLookupRequests\/\{requestId\}/);
  });

  function requestBody(overrides = {}) {
    return {
      uid: "driver",
      registration: "ab12 cde",
      createdAt: serverTimestamp(),
      ...overrides,
    };
  }

  it("lets the owner create and read their own request", async () => {
    const driver = env.authenticatedContext("driver").firestore();
    const ref = doc(driver, "vehicleLookupRequests", "req-1");
    await assertSucceeds(setDoc(ref, requestBody()));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(setDoc(
      doc(driver, "vehicleLookupRequests", "req-spaces"),
      requestBody({registration: "  AB12CDE  "}),
    ));
    // A plate the trigger will call invalid is still a legal create, so the
    // phone has a document to read the code from.
    await assertSucceeds(setDoc(
      doc(driver, "vehicleLookupRequests", "req-punct"),
      requestBody({registration: "AB-12"}),
    ));
  });

  it("rejects a request that is not the owner's or has the wrong fields", async () => {
    const driver = env.authenticatedContext("driver").firestore();
    const other = env.authenticatedContext("other").firestore();
    const anon = env.unauthenticatedContext().firestore();
    const admin = env.authenticatedContext("admin-user", {role: "admin"}).firestore();
    await assertSucceeds(setDoc(doc(driver, "vehicleLookupRequests", "req-1"), requestBody()));

    await assertFails(setDoc(doc(anon, "vehicleLookupRequests", "req-anon"), requestBody()));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-uid"), requestBody({uid: "other"})));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-status"), requestBody({
      status: "done",
    })));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-code"), requestBody({
      code: "not_found",
    })));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-make"), requestBody({
      make: "ROVER",
    })));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-empty"), requestBody({
      registration: "",
    })));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-long"), requestBody({
      registration: "A".repeat(33),
    })));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-type"), requestBody({
      registration: 12,
    })));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-missing"), {
      uid: "driver",
      registration: "AB12CDE",
    }));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-time"), requestBody({
      createdAt: Timestamp.fromDate(new Date("2020-01-01T00:00:00Z")),
    })));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-slash"), requestBody({
      uid: "driver/extra",
    })));

    await assertFails(getDoc(doc(other, "vehicleLookupRequests", "req-1")));
    await assertFails(getDoc(doc(anon, "vehicleLookupRequests", "req-1")));
    await assertFails(getDoc(doc(admin, "vehicleLookupRequests", "req-1")));
    await assertFails(getDocs(collection(driver, "vehicleLookupRequests")));
    await assertFails(getDocs(collection(admin, "vehicleLookupRequests")));
    await assertFails(updateDoc(doc(driver, "vehicleLookupRequests", "req-1"), {status: "done"}));
    await assertFails(deleteDoc(doc(driver, "vehicleLookupRequests", "req-1")));
    await assertFails(setDoc(doc(driver, "vehicleLookupRequests", "req-1", "nested", "secret"), {
      registration: "AB12CDE",
    }));
  });

  it("lets the owner read a finished request and still forbids changing it", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "vehicleLookupRequests", "req-done"), {
        uid: "driver",
        registration: "AB12CDE",
        createdAt: Timestamp.fromDate(new Date("2026-11-11T12:00:00Z")),
        status: "done",
        make: "ROVER",
        colour: "BLUE",
        fetchedAt: "2026-11-11T12:00:00.000Z",
      });
    });
    const driver = env.authenticatedContext("driver").firestore();
    const other = env.authenticatedContext("other").firestore();
    const saved = await getDoc(doc(driver, "vehicleLookupRequests", "req-done"));
    assert.equal(saved.data().status, "done");
    assert.equal(saved.data().make, "ROVER");
    await assertFails(getDoc(doc(other, "vehicleLookupRequests", "req-done")));
    await assertFails(updateDoc(doc(driver, "vehicleLookupRequests", "req-done"), {
      make: "FORGED",
    }));
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
