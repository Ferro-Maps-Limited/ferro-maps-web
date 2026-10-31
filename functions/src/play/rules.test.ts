import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {after, before, beforeEach, describe, it} from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "demo-play-receipts";
const rulesPath = path.resolve(__dirname, "../../../firestore.rules");

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    uid: "alice",
    purchaseToken: "token-1",
    productId: "gold_monthly",
    packageName: "com.ferromaps.app",
    platform: "android",
    appVersion: "1.4.0",
    status: "pending",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    ...overrides,
  };
}

function userBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "alice",
    name: "Ada Lovelace",
    country: "GB",
    xp: 0,
    level: 1,
    ferroBalance: 0,
    contributionScore: 0,
    ...extra,
  };
}

describe("playPurchaseRequests rules", () => {
  let env: RulesTestEnvironment;

  before(async () => {
    const raw = process.env.FIRESTORE_EMULATOR_HOST ?? "";
    const [host, portRaw] = raw.split(":");
    const port = Number(portRaw);
    if (!host || !port) throw new Error("FIRESTORE_EMULATOR_HOST is not set");
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(rulesPath, "utf8"),
        host,
        port,
      },
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  after(async () => {
    await env.cleanup();
  });

  it("lets the owner create and read a pending Play receipt", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const ref = alice.doc("playPurchaseRequests/req-1");
    await assertSucceeds(ref.set(requestBody()));
    await assertSucceeds(ref.get());
    const version = "a".repeat(32);
    await assertSucceeds(alice.doc("playPurchaseRequests/req-32").set(requestBody({appVersion: version})));
  });

  it("rejects a malformed create, another reader, and any update", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(alice.doc("playPurchaseRequests/req-1").set(requestBody()));

    await assertFails(anon.doc("playPurchaseRequests/req-x").set(requestBody()));
    await assertFails(alice.doc("playPurchaseRequests/req-uid").set(requestBody({uid: "bob"})));
    await assertFails(alice.doc("playPurchaseRequests/req-ios").set(requestBody({platform: "ios"})));
    await assertFails(alice.doc("playPurchaseRequests/req-long").set(requestBody({
      appVersion: "a".repeat(33),
    })));
    await assertFails(alice.doc("playPurchaseRequests/req-empty").set(requestBody({purchaseToken: ""})));
    await assertFails(alice.doc("playPurchaseRequests/req-done").set(requestBody({status: "done"})));
    await assertFails(alice.doc("playPurchaseRequests/req-extra").set(requestBody({expiresAt: 1})));
    await assertFails(alice.doc("playPurchaseRequests/req-v").set(requestBody({v: 2})));
    await assertFails(alice.doc("playPurchaseRequests/req-time").set(requestBody({
      createdAt: firebase.firestore.Timestamp.fromDate(new Date("2020-01-01T00:00:00Z")),
    })));

    await assertFails(bob.doc("playPurchaseRequests/req-1").get());
    await assertFails(alice.doc("playPurchaseRequests/req-1").update({status: "done"}));
    await assertFails(alice.doc("playPurchaseRequests/req-1").delete());
    await assertFails(alice.collection("playPurchaseRequests").get());
  });

  it("hides the ledger, the sealed token, the cursor, and the server flag", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("playPurchases/abc").set({uid: "alice"}));
    await assertFails(alice.doc("playPurchases/abc").get());
    await assertFails(alice.doc("playPurchaseSecrets/abc").get());
    await assertFails(alice.doc("playPurchaseSecrets/abc").set({purchaseToken: "raw"}));
    await assertFails(alice.doc("playSync/cursor").get());
    await assertFails(alice.doc("config/playSubscriptions").get());
  });

  it("keeps Gold fields server-only and still allows a normal profile write", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    const future = firebase.firestore.Timestamp.fromDate(new Date("2030-01-01T00:00:00Z"));
    await assertFails(alice.doc("users/alice").set(userBody({subscriptionExpiresAt: future})));
    await assertFails(alice.doc("users/alice").set(userBody({subscriptionSource: "play"})));
    await assertFails(alice.doc("users/alice").set(userBody({playPurchaseTokenHash: "abc"})));
    await assertFails(alice.doc("users/alice").set(userBody({subscriptionProductId: "gold_monthly"})));

    await assertSucceeds(alice.doc("users/alice").set(userBody()));
    await assertSucceeds(alice.doc("users/alice").update({name: "Ada L"}));
    await assertFails(alice.doc("users/alice").update({subscriptionExpiresAt: future}));
    await assertFails(alice.doc("users/alice").update({subscriptionSource: "play"}));
    await assertFails(alice.doc("users/alice").update({playPurchaseTokenHash: "abc"}));
    const saved = await alice.doc("users/alice").get();
    assert.equal(saved.data()?.name, "Ada L");
    assert.equal(saved.data()?.subscriptionExpiresAt, undefined);
  });
});
