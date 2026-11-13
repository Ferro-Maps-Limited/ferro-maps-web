import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  SUMMARY_KEYS_COLLECTION,
  UNLOCKS,
  callerFromUnlockEvent,
  handleHotspotUnlockRequest,
  type CallerAuth,
} from "../src/surge/onHotspotUnlockRequest";
import {clearDb, testDb} from "./support";

const db = testDb("demo-ferromaps-stadium-surge");
const NOW = new Date("2026-11-13T12:00:00.000Z");
const DEVICE = "a".repeat(64);
const END = Timestamp.fromDate(new Date("2026-11-13T18:00:00.000Z"));

function auth(extra: Partial<CallerAuth> = {}): CallerAuth {
  return {uid: "ada", ...extra};
}

async function seedUser(uid: string, data: Record<string, unknown>): Promise<void> {
  await db.collection("users").doc(uid).set(data);
}

async function request(
  id: string,
  uid: string,
  summaryId: string,
  deviceId: string | null = DEVICE,
): Promise<void> {
  const data: Record<string, unknown> = {
    uid,
    summaryId,
    status: "pending",
    createdAt: Timestamp.fromDate(NOW),
  };
  if (deviceId != null) data.deviceId = deviceId;
  await db.collection("hotspotUnlockRequests").doc(id).set(data);
}

async function enable(): Promise<void> {
  await db.doc("config/flags").set({plannerSummaries: true});
  await db.doc("config/plannerSummaries").set({enabled: true});
}

describe("onHotspotUnlockRequest", () => {
  before(async () => {
    await clearDb(db);
    await enable();
    const later = Timestamp.fromMillis(NOW.getTime() + 86_400_000);
    await db.collection(SUMMARY_KEYS_COLLECTION).doc("sum_open").set({
      hotspotId: "sheet_open",
      windowStart: NOW,
      windowEnd: END,
      expireAt: later,
    });
    await db.collection(SUMMARY_KEYS_COLLECTION).doc("sum_closed").set({
      hotspotId: "sheet_closed",
      windowStart: Timestamp.fromMillis(NOW.getTime() - 7_200_000),
      windowEnd: Timestamp.fromMillis(NOW.getTime() - 1),
      expireAt: later,
    });
    await db.collection(SUMMARY_KEYS_COLLECTION).doc("sum_expired").set({
      hotspotId: "sheet_open",
      windowStart: NOW,
      windowEnd: END,
      expireAt: Timestamp.fromMillis(NOW.getTime() - 1),
    });
  });

  it("writes validUntil at the forecast window end and does not add a balance", async () => {
    await seedUser("ada", {
      name: "Ada",
      activeDeviceId: DEVICE,
      surgeUnlimitedUntil: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
      ferroBalance: 0,
    });
    await request("req_done", "ada", "sum_open");
    await handleHotspotUnlockRequest(db, db.collection("hotspotUnlockRequests").doc("req_done"), auth(), NOW);
    const saved = await db.collection("hotspotUnlockRequests").doc("req_done").get();
    const unlock = await db.collection("users").doc("ada").collection(UNLOCKS).doc("sheet_open").get();
    const user = await db.collection("users").doc("ada").get();
    assert.equal(saved.get("status"), "done");
    assert.equal(saved.get("reason"), undefined);
    assert.equal(saved.get("completedAt").toMillis(), NOW.getTime());
    assert.equal(unlock.get("validUntil").toMillis(), END.toMillis());
    assert.deepEqual(Object.keys(unlock.data() ?? {}), ["validUntil"]);
    assert.equal(user.get("ferroBalance"), 0);
    assert.equal(user.get("surgeCredits"), undefined);
    assert.equal(user.get("name"), "Ada");
  });

  it("answers an already open pin with done and does not write a second unlock", async () => {
    const before = await db.collection("users").doc("ada").collection(UNLOCKS).doc("sheet_open").get();
    await request("req_again", "ada", "sum_open");
    await handleHotspotUnlockRequest(db, db.collection("hotspotUnlockRequests").doc("req_again"), auth(), NOW);
    const saved = await db.collection("hotspotUnlockRequests").doc("req_again").get();
    const unlock = await db.collection("users").doc("ada").collection(UNLOCKS).doc("sheet_open").get();
    assert.equal(saved.get("status"), "done");
    assert.equal(unlock.get("validUntil").toMillis(), before.get("validUntil").toMillis());
    assert.equal(unlock.updateTime?.toMillis(), before.updateTime?.toMillis());
  });

  it("denies no_credit, not_eligible, flag_off, device_revoked, and invalid", async () => {
    await seedUser("free", {activeDeviceId: DEVICE, name: "Free"});
    await request("req_free", "free", "sum_open");
    await handleHotspotUnlockRequest(
      db,
      db.collection("hotspotUnlockRequests").doc("req_free"),
      auth({uid: "free"}),
      NOW,
    );
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_free").get()).get("reason"), "no_credit");
    assert.equal((await db.collection("users").doc("free").collection(UNLOCKS).doc("sheet_open").get()).exists, false);

    await seedUser("ended", {
      activeDeviceId: DEVICE,
      surgeUnlimitedUntil: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
    });
    await request("req_ended", "ended", "sum_closed");
    await handleHotspotUnlockRequest(
      db,
      db.collection("hotspotUnlockRequests").doc("req_ended"),
      auth({uid: "ended"}),
      NOW,
    );
    await request("req_none", "ended", "sum_expired");
    await handleHotspotUnlockRequest(
      db,
      db.collection("hotspotUnlockRequests").doc("req_none"),
      auth({uid: "ended"}),
      NOW,
    );
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_ended").get()).get("reason"), "not_eligible");
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_none").get()).get("reason"), "not_eligible");

    await db.doc("config/plannerSummaries").set({enabled: false});
    await request("req_flag", "ada", "sum_open");
    await handleHotspotUnlockRequest(db, db.collection("hotspotUnlockRequests").doc("req_flag"), auth(), NOW);
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_flag").get()).get("reason"), "flag_off");
    await enable();

    await request("req_device", "ada", "sum_open", "b".repeat(64));
    const event = {authId: "ada", authType: "unknown" as const};
    await handleHotspotUnlockRequest(
      db,
      db.collection("hotspotUnlockRequests").doc("req_device"),
      callerFromUnlockEvent(event),
      NOW,
    );
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_device").get()).get("reason"), "device_revoked");
    assert.deepEqual(Object.keys(event).sort(), ["authId", "authType"]);

    await request("req_bad", "ada", "sum_open");
    await handleHotspotUnlockRequest(
      db,
      db.collection("hotspotUnlockRequests").doc("req_bad"),
      auth({uid: "someone-else"}),
      NOW,
    );
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_bad").get()).get("reason"), "invalid");
  });

  it("leaves a finished request alone", async () => {
    await db.collection("hotspotUnlockRequests").doc("req_left").set({
      uid: "ada",
      summaryId: "sum_open",
      status: "denied",
      reason: "no_credit",
      createdAt: Timestamp.fromDate(NOW),
    });
    await handleHotspotUnlockRequest(db, db.collection("hotspotUnlockRequests").doc("req_left"), auth(), NOW);
    const saved = await db.collection("hotspotUnlockRequests").doc("req_left").get();
    assert.equal(saved.get("status"), "denied");
    assert.equal(saved.get("reason"), "no_credit");
    assert.equal(saved.get("completedAt"), undefined);
  });
});
