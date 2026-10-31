import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {after, beforeEach, describe, it} from "node:test";
import {initializeApp, getApps, deleteApp} from "firebase-admin/app";
import {getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {handlePlayPurchaseRequest} from "./handlePlayPurchase.js";
import {PlayApiError, createPlayClient, type PlayClient, type PlaySubscription, type VoidedPurchase} from "./playClient.js";
import {reconcilePlaySubscriptionsRun} from "./reconcilePlaySubscriptions.js";
import {
  decideEntitlement,
  parsePurchaseRequest,
  purchaseTokenHash,
} from "./subscription.js";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "demo-play-receipts";
const TOKEN = "purchase-token-GOLD-1";
const NOW = new Date("2026-10-31T12:00:00.000Z");
const PACKAGE_NAME = "com.ferromaps.app";
const PRODUCT = "gold_monthly";
const UID = "driver-1";

function db(): Firestore {
  if (getApps().length === 0) initializeApp({projectId: PROJECT_ID});
  return getFirestore();
}

async function clearDb(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error("FIRESTORE_EMULATOR_HOST is not set");
  const url = `http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, {method: "DELETE"});
  if (!res.ok) throw new Error(`clear firestore failed: ${res.status}`);
}

function millisOf(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function containsToken(value: unknown, token: string): boolean {
  return JSON.stringify(value).includes(token);
}

function activeSub(iso: string, state = "SUBSCRIPTION_STATE_ACTIVE"): PlaySubscription {
  return {
    subscriptionState: state,
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    latestOrderId: "GPA.1234-5678",
    testPurchase: true,
    lineItems: [{productId: PRODUCT, expiryTimeMs: Date.parse(iso)}],
  };
}

class FakePlay implements PlayClient {
  gets = 0;
  acks: string[] = [];
  voidedCalls = 0;
  subscription: PlaySubscription = activeSub("2027-01-15T00:00:00.000Z");
  getError: Error | null = null;
  ackError: Error | null = null;
  voided: VoidedPurchase[] = [];

  async getSubscription(): Promise<PlaySubscription> {
    this.gets += 1;
    if (this.getError) throw this.getError;
    const sub: PlaySubscription = {
      ...this.subscription,
      lineItems: this.subscription.lineItems.map((item) => ({...item})),
    };
    if (this.gets > 1) sub.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    return sub;
  }

  async acknowledge(_packageName: string, productId: string, purchaseToken: string): Promise<void> {
    this.acks.push(`${productId}:${purchaseToken}`);
    if (this.ackError) throw this.ackError;
  }

  async listVoided(): Promise<VoidedPurchase[]> {
    this.voidedCalls += 1;
    return this.voided;
  }
}

async function enable(database: Firestore, extra: Record<string, unknown> = {}): Promise<void> {
  await database.doc("config/playSubscriptions").set({
    enabled: true,
    packageName: PACKAGE_NAME,
    productIds: [PRODUCT],
    ...extra,
  });
}

async function writeRequest(
  database: Firestore,
  id: string,
  uid = UID,
  token = TOKEN,
): Promise<void> {
  await database.collection("playPurchaseRequests").doc(id).set({
    v: 1,
    uid,
    purchaseToken: token,
    productId: PRODUCT,
    packageName: PACKAGE_NAME,
    platform: "android",
    appVersion: "1.4.0",
    status: "pending",
    createdAt: Timestamp.fromDate(NOW),
  });
}

async function seedUser(
  database: Firestore,
  uid: string,
  expiresIso: string,
  source: string,
  hash: string | null = null,
): Promise<void> {
  const data: Record<string, unknown> = {
    uid,
    subscriptionExpiresAt: Timestamp.fromDate(new Date(expiresIso)),
    subscriptionSource: source,
  };
  if (hash) data.playPurchaseTokenHash = hash;
  await database.collection("users").doc(uid).set(data);
}

describe("play receipt verification", () => {
  beforeEach(async () => {
    await clearDb();
  });

  after(async () => {
    await Promise.all(getApps().map((app) => deleteApp(app)));
  });

  it("hashes the token and never uses it as the id", () => {
    const expected = createHash("sha256").update(TOKEN, "utf8").digest("hex");
    assert.equal(purchaseTokenHash(TOKEN), expected);
    assert.equal(expected.includes(TOKEN), false);
  });

  it("extends only a later expiry and revokes only the owning play token", () => {
    const hash = purchaseTokenHash(TOKEN);
    const later = decideEntitlement({
      nowMs: NOW.getTime(),
      state: "active",
      expiryMs: Date.parse("2028-01-01T00:00:00.000Z"),
      tokenHash: hash,
      productId: PRODUCT,
      user: {expiresAtMs: Date.parse("2027-01-01T00:00:00.000Z"), source: "appstore", tokenHash: null},
    });
    assert.equal(later.status, "done");
    assert.equal(later.user?.subscriptionSource, "play");

    const kept = decideEntitlement({
      nowMs: NOW.getTime(),
      state: "active",
      expiryMs: Date.parse("2027-01-01T00:00:00.000Z"),
      tokenHash: hash,
      productId: PRODUCT,
      user: {expiresAtMs: Date.parse("2030-01-01T00:00:00.000Z"), source: "appstore", tokenHash: null},
    });
    assert.equal(kept.user, null);

    const hold = decideEntitlement({
      nowMs: NOW.getTime(),
      state: "on_hold",
      expiryMs: Date.parse("2026-10-01T00:00:00.000Z"),
      tokenHash: hash,
      productId: PRODUCT,
      user: {expiresAtMs: Date.parse("2030-01-01T00:00:00.000Z"), source: "play", tokenHash: hash},
    });
    assert.equal(hold.user?.subscriptionExpiresAtMs, NOW.getTime());
    assert.equal(hold.errorCode, "on-hold");

    const other = decideEntitlement({
      nowMs: NOW.getTime(),
      state: "paused",
      expiryMs: Date.parse("2028-01-01T00:00:00.000Z"),
      tokenHash: hash,
      productId: PRODUCT,
      user: {expiresAtMs: Date.parse("2030-01-01T00:00:00.000Z"), source: "appstore", tokenHash: null},
    });
    assert.equal(other.user, null);

    const grace = decideEntitlement({
      nowMs: NOW.getTime(),
      state: "grace",
      expiryMs: Date.parse("2027-03-01T00:00:00.000Z"),
      tokenHash: hash,
      productId: PRODUCT,
      user: {expiresAtMs: null, source: null, tokenHash: null},
    });
    assert.equal(grace.status, "done");
    assert.equal(grace.user?.subscriptionSource, "play");

    const canceled = decideEntitlement({
      nowMs: NOW.getTime(),
      state: "canceled",
      expiryMs: Date.parse("2027-03-01T00:00:00.000Z"),
      tokenHash: hash,
      productId: PRODUCT,
      user: {expiresAtMs: null, source: null, tokenHash: null},
    });
    assert.equal(canceled.status, "done");
    assert.equal(parsePurchaseRequest({
      v: 1,
      status: "pending",
      platform: "ios",
      uid: UID,
      purchaseToken: TOKEN,
      productId: PRODUCT,
      packageName: PACKAGE_NAME,
      appVersion: "1",
    }), null);
  });

  it("calls subscriptionsv2.get and acknowledge without echoing the token on failure", async () => {
    const token = "tok/en+code=";
    const seen: string[] = [];
    const client = createPlayClient({
      accessToken: async () => "ya29.test",
      fetchImpl: async (url, init) => {
        seen.push(String(url));
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer ya29.test");
        if (String(url).includes(":acknowledge")) {
          return new Response(JSON.stringify({error: {message: "already acknowledged"}}), {status: 400});
        }
        return new Response(JSON.stringify({
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
          testPurchase: {},
          lineItems: [{productId: PRODUCT, expiryTime: "2027-01-15T00:00:00.000Z"}],
        }), {status: 200});
      },
    });
    const sub = await client.getSubscription(PACKAGE_NAME, token);
    assert.equal(sub.testPurchase, true);
    assert.equal(sub.lineItems[0].expiryTimeMs, Date.parse("2027-01-15T00:00:00.000Z"));
    await client.acknowledge(PACKAGE_NAME, PRODUCT, token);
    assert.equal(seen[0].includes(encodeURIComponent(token)), true);
    assert.equal(seen[1].includes(":acknowledge"), true);

    const failing = createPlayClient({
      accessToken: async () => "ya29.test",
      fetchImpl: async () => new Response("Invalid Value", {status: 400}),
    });
    await assert.rejects(
      () => failing.getSubscription(PACKAGE_NAME, token),
      (err: unknown) => {
        assert.ok(err instanceof PlayApiError);
        assert.equal(err.code, "invalid-token");
        assert.equal(err.message.includes(token), false);
        return true;
      },
    );
  });

  it("leaves an existing Gold clock alone when the flag is off", async () => {
    const database = db();
    const fake = new FakePlay();
    await seedUser(database, UID, "2030-06-01T00:00:00.000Z", "appstore");
    const before = (await database.collection("users").doc(UID).get()).data();
    await writeRequest(database, "req-off");
    await handlePlayPurchaseRequest(
      database,
      "req-off",
      (await database.collection("playPurchaseRequests").doc("req-off").get()).data() ?? {},
      fake,
      NOW,
    );
    const after = (await database.collection("users").doc(UID).get()).data();
    const req = await database.collection("playPurchaseRequests").doc("req-off").get();
    assert.deepEqual(after, before);
    assert.equal(fake.gets, 0);
    assert.equal(req.get("status"), "error");
    assert.equal(req.get("errorCode"), "flag-off");
    assert.equal(req.get("purchaseToken"), undefined);
    assert.equal(req.get("purchaseTokenHash"), purchaseTokenHash(TOKEN));
    assert.equal(containsToken(req.data(), TOKEN), false);
  });

  it("grants Gold from an active subscription and strips the raw token", async () => {
    const database = db();
    const fake = new FakePlay();
    await enable(database);
    await writeRequest(database, "req-ok");
    const raw = (await database.collection("playPurchaseRequests").doc("req-ok").get()).data() ?? {};
    await handlePlayPurchaseRequest(database, "req-ok", raw, fake, NOW);

    const hash = purchaseTokenHash(TOKEN);
    const user = await database.collection("users").doc(UID).get();
    const req = await database.collection("playPurchaseRequests").doc("req-ok").get();
    const ledger = await database.collection("playPurchases").doc(hash).get();
    const secret = await database.collection("playPurchaseSecrets").doc(hash).get();

    assert.equal(req.get("status"), "done");
    assert.equal(millisOf(req.get("expiresAt")), Date.parse("2027-01-15T00:00:00.000Z"));
    assert.equal(req.get("subscriptionState"), "active");
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), Date.parse("2027-01-15T00:00:00.000Z"));
    assert.equal(user.get("subscriptionSource"), "play");
    assert.equal(user.get("playPurchaseTokenHash"), hash);
    assert.equal(user.get("subscriptionProductId"), PRODUCT);
    assert.equal(fake.acks.length, 1);
    assert.equal(secret.get("purchaseToken"), TOKEN);
    assert.equal(ledger.get("testPurchase"), true);
    assert.equal(ledger.get("latestOrderId"), "GPA.1234-5678");
    assert.equal(containsToken(user.data(), TOKEN), false);
    assert.equal(containsToken(req.data(), TOKEN), false);
    assert.equal(containsToken(ledger.data(), TOKEN), false);
  });

  it("treats the same token for the same driver as one grant", async () => {
    const database = db();
    const fake = new FakePlay();
    await enable(database);
    await writeRequest(database, "req-a");
    await handlePlayPurchaseRequest(
      database,
      "req-a",
      (await database.collection("playPurchaseRequests").doc("req-a").get()).data() ?? {},
      fake,
      NOW,
    );
    await writeRequest(database, "req-b");
    await handlePlayPurchaseRequest(
      database,
      "req-b",
      (await database.collection("playPurchaseRequests").doc("req-b").get()).data() ?? {},
      fake,
      NOW,
    );
    const second = await database.collection("playPurchaseRequests").doc("req-b").get();
    assert.equal(second.get("status"), "done");
    assert.equal(fake.gets, 2);
    assert.equal(fake.acks.length, 1);
    const users = await database.collection("users").get();
    assert.equal(users.size, 1);
  });

  it("refuses the same token from another account", async () => {
    const database = db();
    const fake = new FakePlay();
    await enable(database);
    await writeRequest(database, "req-a");
    await handlePlayPurchaseRequest(
      database,
      "req-a",
      (await database.collection("playPurchaseRequests").doc("req-a").get()).data() ?? {},
      fake,
      NOW,
    );
    const owned = millisOf((await database.collection("users").doc(UID).get()).get("subscriptionExpiresAt"));
    await writeRequest(database, "req-b", "driver-2");
    await handlePlayPurchaseRequest(
      database,
      "req-b",
      (await database.collection("playPurchaseRequests").doc("req-b").get()).data() ?? {},
      fake,
      NOW,
    );
    const req = await database.collection("playPurchaseRequests").doc("req-b").get();
    const other = await database.collection("users").doc("driver-2").get();
    assert.equal(req.get("errorCode"), "already-linked");
    assert.equal(req.get("purchaseToken"), undefined);
    assert.equal(other.exists, false);
    assert.equal(fake.gets, 1);
    assert.equal(
      millisOf((await database.collection("users").doc(UID).get()).get("subscriptionExpiresAt")),
      owned,
    );
  });

  it("does not shorten a later App Store expiry", async () => {
    const database = db();
    const fake = new FakePlay();
    fake.subscription = activeSub("2027-01-15T00:00:00.000Z");
    await enable(database);
    await seedUser(database, UID, "2030-01-01T00:00:00.000Z", "appstore");
    await writeRequest(database, "req-keep");
    await handlePlayPurchaseRequest(
      database,
      "req-keep",
      (await database.collection("playPurchaseRequests").doc("req-keep").get()).data() ?? {},
      fake,
      NOW,
    );
    const user = await database.collection("users").doc(UID).get();
    const req = await database.collection("playPurchaseRequests").doc("req-keep").get();
    assert.equal(req.get("status"), "done");
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), Date.parse("2030-01-01T00:00:00.000Z"));
    assert.equal(user.get("subscriptionSource"), "appstore");
  });

  it("moves the clock forward when Play lasts longer", async () => {
    const database = db();
    const fake = new FakePlay();
    fake.subscription = activeSub("2028-05-01T00:00:00.000Z");
    await enable(database);
    await seedUser(database, UID, "2027-01-01T00:00:00.000Z", "appstore");
    await writeRequest(database, "req-forward");
    await handlePlayPurchaseRequest(
      database,
      "req-forward",
      (await database.collection("playPurchaseRequests").doc("req-forward").get()).data() ?? {},
      fake,
      NOW,
    );
    const user = await database.collection("users").doc(UID).get();
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), Date.parse("2028-05-01T00:00:00.000Z"));
    assert.equal(user.get("subscriptionSource"), "play");
  });

  it("does not grant an expired subscription", async () => {
    const database = db();
    const fake = new FakePlay();
    fake.subscription = activeSub("2026-01-01T00:00:00.000Z", "SUBSCRIPTION_STATE_EXPIRED");
    await enable(database);
    await seedUser(database, UID, "2030-01-01T00:00:00.000Z", "appstore");
    await writeRequest(database, "req-expired");
    await handlePlayPurchaseRequest(
      database,
      "req-expired",
      (await database.collection("playPurchaseRequests").doc("req-expired").get()).data() ?? {},
      fake,
      NOW,
    );
    const user = await database.collection("users").doc(UID).get();
    const secret = await database.collection("playPurchaseSecrets").doc(purchaseTokenHash(TOKEN)).get();
    const req = await database.collection("playPurchaseRequests").doc("req-expired").get();
    assert.equal(req.get("errorCode"), "expired");
    assert.equal(user.get("subscriptionSource"), "appstore");
    assert.equal(secret.exists, false);
  });

  it("ends Gold on account hold only when this token owns the clock", async () => {
    const database = db();
    const hash = purchaseTokenHash(TOKEN);
    const fake = new FakePlay();
    fake.subscription = activeSub("2026-10-01T00:00:00.000Z", "SUBSCRIPTION_STATE_ON_HOLD");
    await enable(database);
    await seedUser(database, UID, "2030-01-01T00:00:00.000Z", "play", hash);
    await writeRequest(database, "req-hold");
    await handlePlayPurchaseRequest(
      database,
      "req-hold",
      (await database.collection("playPurchaseRequests").doc("req-hold").get()).data() ?? {},
      fake,
      NOW,
    );
    const user = await database.collection("users").doc(UID).get();
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), NOW.getTime());
    assert.equal((await database.collection("playPurchaseRequests").doc("req-hold").get()).get("errorCode"), "on-hold");

    await seedUser(database, "driver-2", "2030-01-01T00:00:00.000Z", "appstore");
    await writeRequest(database, "req-hold-2", "driver-2", "purchase-token-GOLD-2");
    const other = new FakePlay();
    other.subscription = activeSub("2026-10-01T00:00:00.000Z", "SUBSCRIPTION_STATE_ON_HOLD");
    await handlePlayPurchaseRequest(
      database,
      "req-hold-2",
      (await database.collection("playPurchaseRequests").doc("req-hold-2").get()).data() ?? {},
      other,
      NOW,
    );
    const untouched = await database.collection("users").doc("driver-2").get();
    assert.equal(millisOf(untouched.get("subscriptionExpiresAt")), Date.parse("2030-01-01T00:00:00.000Z"));
    assert.equal(untouched.get("subscriptionSource"), "appstore");
  });

  it("pauses Gold now even when Play still shows a future line expiry", async () => {
    const database = db();
    const hash = purchaseTokenHash(TOKEN);
    const fake = new FakePlay();
    fake.subscription = activeSub("2028-01-01T00:00:00.000Z", "SUBSCRIPTION_STATE_PAUSED");
    await enable(database);
    await seedUser(database, UID, "2030-01-01T00:00:00.000Z", "play", hash);
    await writeRequest(database, "req-pause");
    await handlePlayPurchaseRequest(
      database,
      "req-pause",
      (await database.collection("playPurchaseRequests").doc("req-pause").get()).data() ?? {},
      fake,
      NOW,
    );
    const user = await database.collection("users").doc(UID).get();
    const req = await database.collection("playPurchaseRequests").doc("req-pause").get();
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), NOW.getTime());
    assert.equal(millisOf(req.get("expiresAt")), Date.parse("2028-01-01T00:00:00.000Z"));
    assert.equal(req.get("errorCode"), "paused");
  });

  it("keeps a grant when acknowledge returns a transient error", async () => {
    const database = db();
    const fake = new FakePlay();
    fake.ackError = new PlayApiError(503, "unavailable");
    await enable(database);
    await writeRequest(database, "req-ack");
    await handlePlayPurchaseRequest(
      database,
      "req-ack",
      (await database.collection("playPurchaseRequests").doc("req-ack").get()).data() ?? {},
      fake,
      NOW,
    );
    const user = await database.collection("users").doc(UID).get();
    const ledger = await database.collection("playPurchases").doc(purchaseTokenHash(TOKEN)).get();
    assert.equal(user.get("subscriptionSource"), "play");
    assert.equal(ledger.get("acknowledgementState"), "pending");
  });

  it("does not grant when acknowledge is rejected", async () => {
    const database = db();
    const fake = new FakePlay();
    fake.ackError = new PlayApiError(400, "invalid-token");
    await enable(database);
    await seedUser(database, UID, "2030-01-01T00:00:00.000Z", "appstore");
    await writeRequest(database, "req-ack-no");
    await handlePlayPurchaseRequest(
      database,
      "req-ack-no",
      (await database.collection("playPurchaseRequests").doc("req-ack-no").get()).data() ?? {},
      fake,
      NOW,
    );
    const user = await database.collection("users").doc(UID).get();
    const req = await database.collection("playPurchaseRequests").doc("req-ack-no").get();
    assert.equal(req.get("errorCode"), "invalid-token");
    assert.equal(user.get("subscriptionSource"), "appstore");
    assert.equal((await database.collection("playPurchaseSecrets").doc(purchaseTokenHash(TOKEN)).get()).exists, false);
  });

  it("maps Play failures onto the permanent and retryable codes", async () => {
    const database = db();
    await enable(database);
    await seedUser(database, UID, "2030-01-01T00:00:00.000Z", "appstore");

    const unavailable = new FakePlay();
    unavailable.getError = new PlayApiError(503, "unavailable");
    await writeRequest(database, "req-down");
    await handlePlayPurchaseRequest(
      database,
      "req-down",
      (await database.collection("playPurchaseRequests").doc("req-down").get()).data() ?? {},
      unavailable,
      NOW,
    );
    assert.equal((await database.collection("playPurchaseRequests").doc("req-down").get()).get("errorCode"), "unavailable");

    const invalid = new FakePlay();
    invalid.getError = new PlayApiError(400, "invalid-token");
    await writeRequest(database, "req-bad");
    await handlePlayPurchaseRequest(
      database,
      "req-bad",
      (await database.collection("playPurchaseRequests").doc("req-bad").get()).data() ?? {},
      invalid,
      NOW,
    );
    const bad = await database.collection("playPurchaseRequests").doc("req-bad").get();
    assert.equal(bad.get("errorCode"), "invalid-token");
    assert.equal(bad.get("purchaseToken"), undefined);

    const mismatch = new FakePlay();
    mismatch.subscription = activeSub("2027-01-15T00:00:00.000Z");
    mismatch.subscription.lineItems = [{productId: "other_sku", expiryTimeMs: Date.parse("2027-01-15T00:00:00.000Z")}];
    await writeRequest(database, "req-sku");
    await handlePlayPurchaseRequest(
      database,
      "req-sku",
      (await database.collection("playPurchaseRequests").doc("req-sku").get()).data() ?? {},
      mismatch,
      NOW,
    );
    assert.equal((await database.collection("playPurchaseRequests").doc("req-sku").get()).get("errorCode"), "product-mismatch");
    assert.equal(mismatch.acks.length, 0);

    const wrongPackage = new FakePlay();
    await database.collection("playPurchaseRequests").doc("req-pkg").set({
      v: 1,
      uid: UID,
      purchaseToken: TOKEN,
      productId: PRODUCT,
      packageName: "com.other.app",
      platform: "android",
      appVersion: "1.4.0",
      status: "pending",
      createdAt: Timestamp.fromDate(NOW),
    });
    await handlePlayPurchaseRequest(
      database,
      "req-pkg",
      (await database.collection("playPurchaseRequests").doc("req-pkg").get()).data() ?? {},
      wrongPackage,
      NOW,
    );
    assert.equal(wrongPackage.gets, 0);
    assert.equal(
      (await database.collection("playPurchaseRequests").doc("req-pkg").get()).get("errorCode"),
      "package-mismatch",
    );
    assert.equal(
      millisOf((await database.collection("users").doc(UID).get()).get("subscriptionExpiresAt")),
      Date.parse("2030-01-01T00:00:00.000Z"),
    );
  });

  it("does not call Play again once the request is terminal", async () => {
    const database = db();
    const fake = new FakePlay();
    await database.collection("playPurchaseRequests").doc("req-done").set({
      status: "done",
      purchaseToken: TOKEN,
      uid: UID,
    });
    await handlePlayPurchaseRequest(
      database,
      "req-done",
      (await database.collection("playPurchaseRequests").doc("req-done").get()).data() ?? {},
      fake,
      NOW,
    );
    assert.equal(fake.gets, 0);
    assert.equal(
      (await database.collection("playPurchaseRequests").doc("req-done").get()).get("purchaseToken"),
      TOKEN,
    );
  });

  it("extends a renewal and keeps a cancellation until the period ends", async () => {
    const database = db();
    const hash = purchaseTokenHash(TOKEN);
    const fake = new FakePlay();
    fake.subscription = activeSub("2027-02-01T00:00:00.000Z");
    fake.subscription.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    await enable(database);
    await seedUser(database, UID, "2027-01-15T00:00:00.000Z", "play", hash);
    await database.collection("playPurchases").doc(hash).set({
      v: 1,
      uid: UID,
      productId: PRODUCT,
      packageName: PACKAGE_NAME,
      subscriptionState: "active",
      expiresAt: Timestamp.fromDate(new Date("2027-01-15T00:00:00.000Z")),
      nextCheckAt: Timestamp.fromDate(new Date("2026-10-31T11:00:00.000Z")),
    });
    await database.collection("playPurchaseSecrets").doc(hash).set({purchaseToken: TOKEN, uid: UID});

    await reconcilePlaySubscriptionsRun(database, fake, NOW);
    let user = await database.collection("users").doc(UID).get();
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), Date.parse("2027-02-01T00:00:00.000Z"));
    assert.equal(fake.voidedCalls, 1);

    fake.subscription = activeSub("2027-02-01T00:00:00.000Z", "SUBSCRIPTION_STATE_CANCELED");
    fake.subscription.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    await database.collection("playPurchases").doc(hash).update({
      nextCheckAt: Timestamp.fromDate(new Date("2026-10-31T11:00:00.000Z")),
    });
    await reconcilePlaySubscriptionsRun(database, fake, NOW);
    user = await database.collection("users").doc(UID).get();
    const ledger = await database.collection("playPurchases").doc(hash).get();
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), Date.parse("2027-02-01T00:00:00.000Z"));
    assert.equal(ledger.get("subscriptionState"), "canceled");
    const nextCheck = millisOf(ledger.get("nextCheckAt"));
    assert.ok(nextCheck != null && nextCheck > NOW.getTime());
  });

  it("revokes a refund from the voided-purchases list", async () => {
    const database = db();
    const hash = purchaseTokenHash(TOKEN);
    const fake = new FakePlay();
    fake.subscription = activeSub("2026-01-01T00:00:00.000Z", "SUBSCRIPTION_STATE_EXPIRED");
    fake.subscription.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    fake.voided = [{purchaseToken: TOKEN, orderId: "GPA.1234-5678"}];
    await enable(database);
    await seedUser(database, UID, "2027-06-01T00:00:00.000Z", "play", hash);
    await database.collection("playPurchases").doc(hash).set({
      v: 1,
      uid: UID,
      productId: PRODUCT,
      packageName: PACKAGE_NAME,
      subscriptionState: "active",
      nextCheckAt: Timestamp.fromDate(new Date("2026-11-01T00:00:00.000Z")),
    });
    await database.collection("playPurchaseSecrets").doc(hash).set({purchaseToken: TOKEN});

    await reconcilePlaySubscriptionsRun(database, fake, NOW);
    const user = await database.collection("users").doc(UID).get();
    const cursor = await database.doc("playSync/cursor").get();
    const secret = await database.collection("playPurchaseSecrets").doc(hash).get();
    assert.equal(millisOf(user.get("subscriptionExpiresAt")), Date.parse("2026-01-01T00:00:00.000Z"));
    assert.equal(cursor.get("lastVoidedQueryMillis"), NOW.getTime());
    assert.equal(secret.exists, false);
    assert.equal(containsToken(user.data(), TOKEN), false);
  });

  it("does not reconcile while the flag is off", async () => {
    const database = db();
    const fake = new FakePlay();
    await seedUser(database, UID, "2030-01-01T00:00:00.000Z", "appstore");
    const before = (await database.collection("users").doc(UID).get()).data();
    await reconcilePlaySubscriptionsRun(database, fake, NOW);
    const after = (await database.collection("users").doc(UID).get()).data();
    assert.deepEqual(after, before);
    assert.equal(fake.gets, 0);
    assert.equal(fake.voidedCalls, 0);
  });
});
