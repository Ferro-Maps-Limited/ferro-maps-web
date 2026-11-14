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
import {SURGE_LEDGER, grantSurgeCreditEntry} from "../src/surge/surgeLedger";
import {londonLocalToUtcMs} from "../src/surge/time";
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

function assertNoTotalField(data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    assert.equal(key === "balance" || key === "count", false, key);
  }
}

async function ledger(uid: string) {
  return db.collection("users").doc(uid).collection(SURGE_LEDGER).get();
}

function kinds(uidDocs: {get(field: string): unknown}[]): string[] {
  return uidDocs.map((entry) => String(entry.get("kind"))).sort();
}

async function spendSwitch(on: boolean): Promise<void> {
  await db.doc("config/flags").set({plannerSummaries: true});
  const data: Record<string, unknown> = {enabled: true};
  if (on) data.creditSpendEnabled = true;
  await db.doc("config/plannerSummaries").set(data);
}

async function windowKey(id: string, hotspotId: string): Promise<void> {
  await db.collection(SUMMARY_KEYS_COLLECTION).doc(id).set({
    hotspotId,
    windowStart: Timestamp.fromDate(NOW),
    windowEnd: END,
    expireAt: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
  });
}

async function runUnlock(id: string, uid: string, now = NOW): Promise<void> {
  await handleHotspotUnlockRequest(
    db,
    db.collection("hotspotUnlockRequests").doc(id),
    auth({uid}),
    now,
  );
}

function londonAt(year: number, month: number, day: number, hour: number, minute: number): Date {
  const ms = londonLocalToUtcMs(year, month, day, hour, minute);
  if (ms == null) throw new Error("missing london instant");
  return new Date(ms);
}

describe("surge credit spend", () => {
  before(async () => {
    await windowKey("sum_credit_a", "sheet_credit_a");
    await windowKey("sum_credit_b", "sheet_credit_b");
    await windowKey("sum_credit_c", "sheet_credit_c");
    await windowKey("sum_credit_d", "sheet_credit_d");
  });

  it("spends one credit, and a second tap on the same summary spends nothing", async () => {
    await spendSwitch(true);
    await seedUser("tap", {activeDeviceId: DEVICE, name: "Tap"});
    await grantSurgeCreditEntry(db, "tap", "grant_tap", NOW);
    await grantSurgeCreditEntry(db, "tap", "grant_tap", NOW);
    await request("req_tap_1", "tap", "sum_credit_a");
    await runUnlock("req_tap_1", "tap");
    await request("req_tap_2", "tap", "sum_credit_a");
    await runUnlock("req_tap_2", "tap");
    const saved = await ledger("tap");
    const unlock = await db.collection("users").doc("tap").collection(UNLOCKS).doc("sheet_credit_a").get();
    const first = await db.collection("hotspotUnlockRequests").doc("req_tap_1").get();
    const second = await db.collection("hotspotUnlockRequests").doc("req_tap_2").get();
    assert.equal(first.get("status"), "done");
    assert.equal(second.get("status"), "done");
    assert.equal(second.get("reason"), undefined);
    assert.deepEqual(
      saved.docs.filter((entry) => entry.get("kind") === "grant").map((entry) => entry.id).sort(),
      ["grant_free_2026-11_1", "grant_free_2026-11_2", "grant_free_2026-11_3", "grant_tap"],
    );
    assert.equal(saved.docs.filter((entry) => entry.get("kind") === "spend").length, 1);
    assert.equal(saved.docs.find((entry) => entry.get("kind") === "spend")?.id, "spend_req_tap_1");
    assert.equal(unlock.get("validUntil").toMillis(), END.toMillis());
    for (const entry of saved.docs) assertNoTotalField(entry.data() ?? {});
    const user = await db.collection("users").doc("tap").get();
    assert.deepEqual(user.data(), {activeDeviceId: DEVICE, name: "Tap"});
  });

  it("does not spend again when the same request id is replayed", async () => {
    await spendSwitch(true);
    await seedUser("replay", {activeDeviceId: DEVICE, name: "Replay"});
    await grantSurgeCreditEntry(db, "replay", "grant_replay", NOW);
    await request("req_replay", "replay", "sum_credit_a");
    const ref = db.collection("hotspotUnlockRequests").doc("req_replay");
    await runUnlock("req_replay", "replay");
    await runUnlock("req_replay", "replay");
    await ref.update({status: "pending"});
    await runUnlock("req_replay", "replay");
    const saved = await ledger("replay");
    assert.equal((await ref.get()).get("status"), "done");
    assert.equal(saved.docs.filter((entry) => entry.get("kind") === "spend").length, 1);
    assert.equal(saved.docs.filter((entry) => entry.get("kind") === "grant").length, 4);
  });

  it("denies a premium driver when the allowance is missing and writes nothing", async () => {
    await spendSwitch(true);
    await seedUser("broke", {
      activeDeviceId: DEVICE,
      name: "Broke",
      subscriptionExpiresAt: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
    });
    await request("req_broke", "broke", "sum_credit_a");
    await runUnlock("req_broke", "broke");
    const saved = await db.collection("hotspotUnlockRequests").doc("req_broke").get();
    const unlock = await db.collection("users").doc("broke").collection(UNLOCKS).doc("sheet_credit_a").get();
    assert.equal(saved.get("status"), "denied");
    assert.equal(saved.get("reason"), "no_credit");
    assert.equal(unlock.exists, false);
    assert.equal((await ledger("broke")).size, 0);
  });

  it("spends the one credit on the first pin and denies the second pin", async () => {
    await db.doc("config/flags").set({plannerSummaries: true});
    await db.doc("config/plannerSummaries").set({
      enabled: true,
      creditSpendEnabled: true,
      premiumMonthlyCredits: 1,
    });
    await seedUser("one", {
      activeDeviceId: DEVICE,
      name: "One",
      subscriptionExpiresAt: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
    });
    await request("req_one_a", "one", "sum_credit_a");
    await runUnlock("req_one_a", "one");
    await request("req_one_b", "one", "sum_credit_b");
    await runUnlock("req_one_b", "one");
    const saved = await ledger("one");
    const second = await db.collection("hotspotUnlockRequests").doc("req_one_b").get();
    const unlockB = await db.collection("users").doc("one").collection(UNLOCKS).doc("sheet_credit_b").get();
    assert.equal(second.get("reason"), "no_credit");
    assert.equal(unlockB.exists, false);
    assert.deepEqual(
      saved.docs.filter((entry) => entry.get("kind") === "grant").map((entry) => entry.id),
      ["grant_premium_2026-11_1"],
    );
    assert.equal(saved.docs.filter((entry) => entry.get("kind") === "spend").length, 1);
    assert.equal(
      (await db.collection("users").doc("one").collection(UNLOCKS).doc("sheet_credit_a").get()).exists,
      true,
    );
  });

  it("does not spend for an unlimited driver", async () => {
    await spendSwitch(true);
    await seedUser("unlimited", {
      activeDeviceId: DEVICE,
      name: "Unlimited",
      surgeUnlimitedUntil: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
    });
    await grantSurgeCreditEntry(db, "unlimited", "grant_unlimited", NOW);
    await request("req_unlimited", "unlimited", "sum_credit_b");
    await runUnlock("req_unlimited", "unlimited");
    const saved = await ledger("unlimited");
    const unlock = await db.collection("users").doc("unlimited").collection(UNLOCKS).doc("sheet_credit_b").get();
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_unlimited").get()).get("status"), "done");
    assert.deepEqual(kinds(saved.docs), ["grant"]);
    assert.equal(unlock.exists, true);
  });

  it("does not spend when the pin is already unlocked", async () => {
    await spendSwitch(true);
    await seedUser("open", {activeDeviceId: DEVICE, name: "Open"});
    await grantSurgeCreditEntry(db, "open", "grant_open", NOW);
    const unlockRef = db.collection("users").doc("open").collection(UNLOCKS).doc("sheet_credit_c");
    await unlockRef.set({validUntil: END});
    const before = await unlockRef.get();
    await request("req_open", "open", "sum_credit_c");
    await runUnlock("req_open", "open");
    const after = await unlockRef.get();
    const saved = await ledger("open");
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_open").get()).get("status"), "done");
    assert.deepEqual(kinds(saved.docs), ["grant"]);
    assert.equal(after.updateTime?.toMillis(), before.updateTime?.toMillis());
  });

  it("spends nothing while the spend switch is missing or false", async () => {
    await seedUser("held", {activeDeviceId: DEVICE, name: "Held"});
    await grantSurgeCreditEntry(db, "held", "grant_held", NOW);
    await spendSwitch(false);
    await request("req_held_off", "held", "sum_credit_a");
    await runUnlock("req_held_off", "held");
    await db.doc("config/plannerSummaries").set({enabled: true, creditSpendEnabled: false});
    await request("req_held_false", "held", "sum_credit_b");
    await runUnlock("req_held_false", "held");
    const saved = await ledger("held");
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_held_off").get()).get("reason"), "no_credit");
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_held_false").get()).get("reason"), "no_credit");
    assert.deepEqual(kinds(saved.docs), ["grant"]);
    assert.equal(
      (await db.collection("users").doc("held").collection(UNLOCKS).doc("sheet_credit_a").get()).exists,
      false,
    );
  });

  it("does not spend when the planner switch is off", async () => {
    await seedUser("flagged", {activeDeviceId: DEVICE, name: "Flagged"});
    await grantSurgeCreditEntry(db, "flagged", "grant_flagged", NOW);
    await db.doc("config/flags").set({plannerSummaries: true});
    await db.doc("config/plannerSummaries").set({enabled: false, creditSpendEnabled: true});
    await request("req_flagged", "flagged", "sum_credit_a");
    await runUnlock("req_flagged", "flagged");
    const saved = await ledger("flagged");
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_flagged").get()).get("reason"), "flag_off");
    assert.deepEqual(kinds(saved.docs), ["grant"]);
  });

  it("does not let two concurrent requests spend the same credit", async () => {
    await spendSwitch(true);
    await seedUser("race", {
      activeDeviceId: DEVICE,
      name: "Race",
      subscriptionExpiresAt: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
    });
    await grantSurgeCreditEntry(db, "race", "grant_race", NOW);
    await request("req_race_a", "race", "sum_credit_a");
    await request("req_race_b", "race", "sum_credit_b");
    await Promise.all([
      runUnlock("req_race_a", "race"),
      runUnlock("req_race_b", "race"),
    ]);
    const saved = await ledger("race");
    const spends = saved.docs.filter((entry) => entry.get("kind") === "spend");
    const first = await db.collection("hotspotUnlockRequests").doc("req_race_a").get();
    const second = await db.collection("hotspotUnlockRequests").doc("req_race_b").get();
    const statuses = [first.get("status"), second.get("status")].sort();
    const reasons = [first.get("reason") ?? null, second.get("reason") ?? null].sort();
    assert.equal(spends.length, 1);
    assert.deepEqual(statuses, ["denied", "done"]);
    assert.deepEqual(reasons, ["no_credit", null]);
    const unlocks = await db.collection("users").doc("race").collection(UNLOCKS).get();
    assert.equal(unlocks.size, 1);
  });

  it("gives a free driver three credits and then no_credit", async () => {
    await spendSwitch(true);
    await seedUser("monthly", {activeDeviceId: DEVICE, name: "Monthly"});
    const pins = ["a", "b", "c", "d"] as const;
    for (const pin of pins) {
      await request(`req_month_${pin}`, "monthly", `sum_credit_${pin}`);
      await runUnlock(`req_month_${pin}`, "monthly");
    }
    const saved = await ledger("monthly");
    const grantIds = saved.docs.filter((entry) => entry.get("kind") === "grant").map((entry) => entry.id).sort();
    const spends = saved.docs.filter((entry) => entry.get("kind") === "spend");
    assert.deepEqual(grantIds, ["grant_free_2026-11_1", "grant_free_2026-11_2", "grant_free_2026-11_3"]);
    assert.equal(spends.length, 3);
    assert.equal((await db.collection("hotspotUnlockRequests").doc("req_month_d").get()).get("reason"), "no_credit");
    assert.equal(
      (await db.collection("users").doc("monthly").collection(UNLOCKS).doc("sheet_credit_d").get()).exists,
      false,
    );
    await runUnlock("req_month_a", "monthly");
    const again = await ledger("monthly");
    assert.equal(again.docs.filter((entry) => entry.get("kind") === "grant").length, 3);
    assert.equal(again.docs.filter((entry) => entry.get("kind") === "spend").length, 3);
  });

  it("writes a new grant set on the next London month and not a second set for the same month", async () => {
    await spendSwitch(true);
    await seedUser("edge", {activeDeviceId: DEVICE, name: "Edge"});
    const endOfOctober = londonAt(2026, 10, 31, 23, 59);
    const startOfNovember = londonAt(2026, 11, 1, 0, 0);
    await request("req_oct", "edge", "sum_credit_a");
    await runUnlock("req_oct", "edge", endOfOctober);
    await request("req_oct_again", "edge", "sum_credit_b");
    await runUnlock("req_oct_again", "edge", endOfOctober);
    await request("req_nov", "edge", "sum_credit_c");
    await runUnlock("req_nov", "edge", startOfNovember);
    const saved = await ledger("edge");
    const grantIds = saved.docs.filter((entry) => entry.get("kind") === "grant").map((entry) => entry.id).sort();
    assert.deepEqual(grantIds, [
      "grant_free_2026-10_1",
      "grant_free_2026-10_2",
      "grant_free_2026-10_3",
      "grant_free_2026-11_1",
      "grant_free_2026-11_2",
      "grant_free_2026-11_3",
    ]);
    assert.equal(saved.docs.filter((entry) => entry.get("kind") === "spend").length, 3);
  });

  it("uses the London month across the spring clock change", async () => {
    await spendSwitch(true);
    await seedUser("spring", {activeDeviceId: DEVICE, name: "Spring"});
    await request("req_march", "spring", "sum_credit_a");
    await runUnlock("req_march", "spring", londonAt(2026, 3, 31, 23, 59));
    await request("req_april", "spring", "sum_credit_b");
    await runUnlock("req_april", "spring", londonAt(2026, 4, 1, 0, 0));
    const saved = await ledger("spring");
    const grantIds = saved.docs.filter((entry) => entry.get("kind") === "grant").map((entry) => entry.id).sort();
    assert.ok(grantIds.includes("grant_free_2026-03_1"));
    assert.ok(grantIds.includes("grant_free_2026-04_1"));
    assert.equal(grantIds.filter((id) => id.startsWith("grant_free_2026-03_")).length, 3);
    assert.equal(grantIds.filter((id) => id.startsWith("grant_free_2026-04_")).length, 3);
  });

  it("does not grant a monthly set while the spend switch is off", async () => {
    await spendSwitch(false);
    await seedUser("quiet", {activeDeviceId: DEVICE, name: "Quiet"});
    await request("req_quiet", "quiet", "sum_credit_a");
    await runUnlock("req_quiet", "quiet");
    const saved = await db.collection("hotspotUnlockRequests").doc("req_quiet").get();
    assert.equal(saved.get("reason"), "no_credit");
    assert.equal((await ledger("quiet")).size, 0);
    assert.equal(
      (await db.collection("users").doc("quiet").collection(UNLOCKS).doc("sheet_credit_a").get()).exists,
      false,
    );
  });

  it("does not double-grant when two first spends in a new month run together", async () => {
    await spendSwitch(true);
    await seedUser("fresh", {activeDeviceId: DEVICE, name: "Fresh"});
    await request("req_fresh_a", "fresh", "sum_credit_a");
    await request("req_fresh_b", "fresh", "sum_credit_b");
    await Promise.all([
      runUnlock("req_fresh_a", "fresh"),
      runUnlock("req_fresh_b", "fresh"),
    ]);
    const saved = await ledger("fresh");
    const grantIds = saved.docs.filter((entry) => entry.get("kind") === "grant").map((entry) => entry.id).sort();
    const spends = saved.docs.filter((entry) => entry.get("kind") === "spend");
    const first = await db.collection("hotspotUnlockRequests").doc("req_fresh_a").get();
    const second = await db.collection("hotspotUnlockRequests").doc("req_fresh_b").get();
    assert.deepEqual(grantIds, ["grant_free_2026-11_1", "grant_free_2026-11_2", "grant_free_2026-11_3"]);
    assert.equal(spends.length, 2);
    assert.equal(first.get("status"), "done");
    assert.equal(second.get("status"), "done");
    for (const entry of saved.docs) assertNoTotalField(entry.data() ?? {});
  });
});
