/**
 * Create-only parkingReports. The id is placeId + "_" + uid.
 * Clients cannot read. Project ids are demo- so the emulator cannot reach a real project.
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
const UID = "ada";
const PLACE = "place-1";
const REPORT_ID = `${PLACE}_${UID}`;

function report(extra = {}) {
  return {
    v: 1,
    uid: UID,
    placeId: PLACE,
    reason: "cant_park",
    reportedAt: serverTimestamp(),
    platform: "android",
    appVersion: "1.2.3",
    ...extra,
  };
}

describe("parkingReports rules", () => {
  let env;

  before(async () => {
    env = await initializeTestEnvironment({
      projectId: "demo-ferromaps-parking-report-rules",
      firestore: {rules: RULES},
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  after(async () => {
    await env.cleanup();
  });

  it("lets a signed-in driver create one report with no Gold check", async () => {
    const db = env.authenticatedContext(UID).firestore();
    await assertSucceeds(setDoc(doc(db, "parkingReports", REPORT_ID), report()));
    const ios = env.authenticatedContext("iosUser").firestore();
    await assertSucceeds(setDoc(doc(ios, "parkingReports", `${PLACE}_iosUser`), report({
      uid: "iosUser",
      platform: "ios",
    })));
  });

  it("denies a wrong uid, a wrong doc id, an extra key, a bad reason, and a client status", async () => {
    const db = env.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, "parkingReports", REPORT_ID), report({uid: "bea"})));
    await assertFails(setDoc(doc(db, "parkingReports", `${PLACE}_bea`), report()));
    await assertFails(setDoc(doc(db, "parkingReports", "nope"), report()));
    await assertFails(setDoc(doc(db, "parkingReports", REPORT_ID), report({lat: 51.5, lng: -0.12})));
    await assertFails(setDoc(doc(db, "parkingReports", REPORT_ID), report({reason: "nope"})));
    await assertFails(setDoc(doc(db, "parkingReports", REPORT_ID), report({status: "accepted"})));
    await assertFails(setDoc(doc(db, "parkingReports", REPORT_ID), report({processedAt: serverTimestamp()})));
    await assertFails(setDoc(doc(db, "parkingReports", REPORT_ID), report({rejectReason: "RATE_LIMIT"})));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(anon, "parkingReports", `${PLACE}_anon`), report({uid: "anon"})));
  });

  it("denies a second create, reads, update, and delete", async () => {
    const db = env.authenticatedContext(UID).firestore();
    const ref = doc(db, "parkingReports", REPORT_ID);
    await assertSucceeds(setDoc(ref, report()));
    await assertFails(setDoc(ref, report({reason: "closed"})));
    await assertFails(getDoc(ref));
    await assertFails(getDocs(collection(db, "parkingReports")));
    await assertFails(updateDoc(ref, {reason: "closed"}));
    await assertFails(deleteDoc(ref));
    const other = env.authenticatedContext("bea").firestore();
    await assertFails(getDoc(doc(other, "parkingReports", REPORT_ID)));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "parkingReports", REPORT_ID)));
  });

  it("denies client reads and writes of stats and the daily counter", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore();
      await setDoc(doc(admin, "parkingReportStats", PLACE), {count: 1, byReason: {cant_park: 1}});
      await setDoc(doc(admin, "users", UID, "meta", "parkingReportDay"), {day: "2026-11-01", count: 1});
    });
    const db = env.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, "parkingReportStats", PLACE)));
    await assertFails(setDoc(doc(db, "parkingReportStats", PLACE), {count: 2}));
    await assertFails(getDoc(doc(db, "users", UID, "meta", "parkingReportDay")));
    await assertFails(setDoc(doc(db, "users", UID, "meta", "parkingReportDay"), {day: "2026-11-01", count: 2}));
    await assertFails(getDoc(doc(db, "parkingPlaceIndex", PLACE)));
    await assertFails(setDoc(doc(db, "parkingPlaceIndex", PLACE), {cellId: "gcpvj0"}));
  });
});
