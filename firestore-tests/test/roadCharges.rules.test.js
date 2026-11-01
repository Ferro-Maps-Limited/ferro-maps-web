/**
 * CC / ULEZ rules. Project ids are demo- so the emulator cannot reach a real project.
 */
const {describe, it, before, beforeEach, after} = require("node:test");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
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
  serverTimestamp,
  Timestamp,
} = require("firebase/firestore");

const {readFileSync} = require("fs");
const {join} = require("path");

const RULES = readFileSync(join(__dirname, "../../firestore.rules"), "utf8");

function entry(type, travelDate, extra = {}) {
  return {
    v: 1,
    type,
    travelDate,
    activeVehicleId: "veh1",
    zoneVersion: "cc-2018-05-20",
    createdAt: serverTimestamp(),
    ...extra,
  };
}

function vehicle(extra = {}) {
  return {
    v: 1,
    ulezCompliant: false,
    paymentMethod: "manual",
    vrmMasked: "AB12 •••",
    type: "car",
    fuel: "petrol",
    isPHV: true,
    isWAV: false,
    updatedAt: serverTimestamp(),
    ...extra,
  };
}

function token(extra = {}) {
  return {
    token: "fcm-token-value",
    platform: "ios",
    updatedAt: serverTimestamp(),
    ...extra,
  };
}

describe("road charge rules", () => {
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
      const future = Timestamp.fromMillis(Date.now() + 86_400_000);
      const past = Timestamp.fromMillis(Date.now() - 86_400_000);
      await setDoc(doc(db, "users", "gold"), {
        subscriptionExpiresAt: future,
        activeDeviceId: "device-live",
        fcmToken: "legacy-token",
      });
      await setDoc(doc(db, "users", "expired"), {subscriptionExpiresAt: past});
      await setDoc(doc(db, "users", "plain"), {name: "No expiry"});
      await setDoc(doc(db, "users", "other"), {subscriptionExpiresAt: future});
      await setDoc(doc(db, "roadCharges", "cc"), {v: 1, zoneVersion: "cc-2018-05-20"});
      await setDoc(doc(db, "roadCharges", "ulez"), {v: 1, zoneVersion: "ulez-2023-08-29"});
      await setDoc(doc(db, "roadCharges", "secret"), {v: 1});
      await setDoc(doc(db, "users", "gold", "gig_history", "cc_veh1_2026-11-02"), {
        v: 1,
        method: "manual",
        chargePence: 2100,
      });
      await setDoc(doc(db, "users", "other", "zoneEntries", "cc_2026-11-02"), {
        v: 1,
        type: "cc",
        travelDate: "2026-11-02",
      });
    });
  });

  after(async () => {
    await env.cleanup();
  });

  it("lets a signed-in user read the two config docs and nobody write them", async () => {
    const gold = env.authenticatedContext("gold").firestore();
    const signedOut = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(gold, "roadCharges", "cc")));
    await assertSucceeds(getDoc(doc(gold, "roadCharges", "ulez")));
    await assertFails(getDoc(doc(gold, "roadCharges", "secret")));
    await assertFails(getDocs(collection(gold, "roadCharges")));
    await assertFails(setDoc(doc(gold, "roadCharges", "cc"), {v: 2}));
    await assertFails(updateDoc(doc(gold, "roadCharges", "cc"), {chargePence: 1}));
    await assertFails(deleteDoc(doc(gold, "roadCharges", "cc")));
    await assertFails(getDoc(doc(signedOut, "roadCharges", "cc")));
  });

  it("lets the owner create a zone entry once, only while Gold", async () => {
    const gold = env.authenticatedContext("gold").firestore();
    const ref = doc(gold, "users", "gold", "zoneEntries", "cc_2026-11-02");
    await assertSucceeds(setDoc(ref, entry("cc", "2026-11-02")));
    await assertSucceeds(getDoc(ref));
    await assertFails(setDoc(ref, entry("cc", "2026-11-02")));
    await assertFails(updateDoc(ref, {reminderState: "skip"}));
    await assertFails(deleteDoc(ref));
    await assertFails(setDoc(
      doc(gold, "users", "gold", "zoneEntries", "ulez_2026-11-02"),
      entry("ulez", "2026-11-02", {chargePence: 1250, method: "autopay"}),
    ));
    await assertFails(setDoc(
      doc(gold, "users", "gold", "zoneEntries", "cc_2026-11-03"),
      entry("ulez", "2026-11-03"),
    ));

    const expired = env.authenticatedContext("expired").firestore();
    await assertFails(setDoc(
      doc(expired, "users", "expired", "zoneEntries", "cc_2026-11-02"),
      entry("cc", "2026-11-02"),
    ));
    const plain = env.authenticatedContext("plain").firestore();
    await assertFails(setDoc(
      doc(plain, "users", "plain", "zoneEntries", "cc_2026-11-02"),
      entry("cc", "2026-11-02"),
    ));
    const signedOut = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(
      doc(signedOut, "users", "gold", "zoneEntries", "ulez_2026-11-03"),
      entry("ulez", "2026-11-03"),
    ));
  });

  it("keeps zone entries, history, vehicles, and tokens owner-only", async () => {
    const gold = env.authenticatedContext("gold").firestore();
    const other = env.authenticatedContext("other").firestore();
    await assertFails(getDoc(doc(gold, "users", "other", "zoneEntries", "cc_2026-11-02")));
    await assertFails(getDocs(collectionGroup(gold, "zoneEntries")));
    await assertFails(getDocs(collectionGroup(gold, "gig_history")));
    await assertFails(getDocs(collectionGroup(gold, "vehicles")));
    await assertFails(getDocs(collectionGroup(gold, "fcmTokens")));

    const history = doc(gold, "users", "gold", "gig_history", "cc_veh1_2026-11-02");
    await assertSucceeds(getDoc(history));
    await assertSucceeds(updateDoc(history, {
      paidAt: Timestamp.fromDate(new Date("2026-11-02T18:00:00Z")),
      method: "manual",
      tflReference: "TFL123",
    }));
    await assertSucceeds(updateDoc(history, {paidAt: serverTimestamp()}));
    await assertFails(updateDoc(history, {chargePence: 0}));
    await assertFails(updateDoc(history, {method: "card"}));
    await assertFails(updateDoc(history, {paidAt: "yesterday"}));
    await assertFails(updateDoc(history, {tflReference: "x".repeat(65)}));
    await assertFails(updateDoc(history, {tflReference: ""}));
    await assertFails(setDoc(doc(gold, "users", "gold", "gig_history", "cc_veh1_2026-11-03"), {v: 1}));
    await assertFails(setDoc(doc(gold, "users", "gold", "gig_history", "ulez_veh1_2026-11-02"), {v: 1}));
    await assertFails(deleteDoc(history));
    await assertFails(getDoc(doc(other, "users", "gold", "gig_history", "cc_veh1_2026-11-02")));

    const trip = doc(gold, "users", "gold", "gig_history", "shift_2026-11-02");
    await assertSucceeds(setDoc(trip, {amount: 10, note: "evening"}));
    await assertSucceeds(updateDoc(trip, {amount: 12, paidAt: "not-a-timestamp"}));
    await assertSucceeds(deleteDoc(trip));
    await assertFails(setDoc(doc(other, "users", "gold", "gig_history", "shift_other"), {amount: 1}));

    const car = doc(gold, "users", "gold", "vehicles", "veh1");
    await assertSucceeds(setDoc(car, vehicle({paymentMethod: "autopay", ulezCompliant: true})));
    await assertSucceeds(getDoc(car));
    await assertSucceeds(setDoc(doc(gold, "users", "gold", "vehicles", "van1"), vehicle({
      vrmMasked: "AB12 •••••••",
      type: "van",
      fuel: "electric",
      isPHV: false,
      isWAV: true,
    })));
    await assertFails(setDoc(car, vehicle({paymentMethod: "card"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "vehicles", "bad1"), vehicle({vrmMasked: "AB12 CDE"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "vehicles", "bad2"), vehicle({vrmMasked: "ab12 •••"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "vehicles", "bad3"), vehicle({vrmMasked: "AB12 ••••••••"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "vehicles", "bad4"), vehicle({type: "bus"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "vehicles", "bad5"), vehicle({fuel: "hydrogen"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "vehicles", "bad6"), vehicle({isPHV: "yes"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "vehicles", "veh2"), vehicle({plate: "AB12CDE"})));
    await assertFails(getDoc(doc(other, "users", "gold", "vehicles", "veh1")));
    await assertFails(deleteDoc(doc(other, "users", "gold", "vehicles", "veh1")));
    await assertSucceeds(deleteDoc(car));

    const device = doc(gold, "users", "gold", "fcmTokens", "install-id-1");
    await assertSucceeds(setDoc(device, token()));
    await assertSucceeds(getDoc(device));
    await assertFails(setDoc(device, token({platform: "web"})));
    await assertFails(setDoc(doc(gold, "users", "gold", "fcmTokens", "short"), token()));
    await assertFails(getDoc(doc(other, "users", "gold", "fcmTokens", "install-id-1")));
    await assertSucceeds(deleteDoc(device));

    const session = env.authenticatedContext("gold", {deviceId: "device-live"}).firestore();
    await assertSucceeds(updateDoc(doc(session, "users", "gold"), {fcmToken: "still-written"}));
  });
});
