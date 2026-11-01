import assert from "node:assert/strict";
import {before, beforeEach, test} from "node:test";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {
  APPLE_SUBSCRIPTION_SOURCE,
  appleClockPatch,
  handleSubscriptionRequest,
} from "./appleGrant";

const PROJECT_ID = "demo-ferromaps-apple";
const EXPIRES = Timestamp.fromDate(new Date("2030-01-01T00:00:00Z"));

before(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("FIRESTORE_EMULATOR_HOST is not set");
  }
  if (getApps().length === 0) {
    initializeApp({projectId: PROJECT_ID});
  }
});

beforeEach(async () => {
  const db = getFirestore();
  await db.recursiveDelete(db.collection("users"));
  await db.recursiveDelete(db.collection("subscriptionRequests"));
  await db.collection("users").doc("alice").set({
    uid: "alice",
    name: "Ada Lovelace",
    xp: 0,
  });
});

test("the Apple patch sets the clock and subscriptionSource together", () => {
  const patch = appleClockPatch(EXPIRES);
  assert.equal(patch.subscriptionSource, APPLE_SUBSCRIPTION_SOURCE);
  assert.equal(patch.subscriptionSource, "apple");
  assert.equal(patch.subscriptionExpiresAt.toMillis(), EXPIRES.toMillis());
  assert.equal(Object.keys(patch).length, 2);
});

test("a verified subscription request writes subscriptionSource apple", async () => {
  const db = getFirestore();
  await db.collection("subscriptionRequests").doc("alice").set({
    uid: "alice",
    status: "pending",
    subscriptionSource: "play",
    subscriptionExpiresAt: EXPIRES,
  });

  await handleSubscriptionRequest(db, "alice", {
    status: "pending",
    subscriptionSource: "play",
    subscriptionExpiresAt: Timestamp.fromDate(new Date("2099-01-01T00:00:00Z")),
  }, async () => EXPIRES);

  const saved = await db.collection("users").doc("alice").get();
  assert.equal(saved.get("subscriptionSource"), "apple");
  assert.equal(saved.get("subscriptionExpiresAt").toMillis(), EXPIRES.toMillis());
  assert.equal(saved.get("name"), "Ada Lovelace");
});

test("without a verifier the request cannot plant Gold", async () => {
  const db = getFirestore();
  await handleSubscriptionRequest(db, "alice", {
    status: "pending",
    subscriptionSource: "apple",
    subscriptionExpiresAt: EXPIRES,
  });

  const saved = await db.collection("users").doc("alice").get();
  assert.equal(saved.get("subscriptionSource"), undefined);
  assert.equal(saved.get("subscriptionExpiresAt"), undefined);
});
