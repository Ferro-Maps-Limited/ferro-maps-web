import assert from "node:assert/strict";
import {before, beforeEach, describe, it} from "node:test";
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {
  AUTO_HIDE_THRESHOLD,
  PARKING_REPORT_DAILY_LIMIT,
  addMonthsUtc,
  londonDay,
  processParkingReport,
} from "../src/parking/onParkingReportCreated.js";
import {testDb} from "./support.js";

const UID = "ada";
const PLACE = "place-1";
const REPORTED = new Date("2026-11-01T12:00:00.000Z");

function reportRef(db: Firestore, placeId = PLACE, uid = UID) {
  return db.collection("parkingReports").doc(`${placeId}_${uid}`);
}

async function writeReport(db: Firestore, over: Record<string, unknown> = {}): Promise<void> {
  const placeId = typeof over.placeId === "string" ? over.placeId : PLACE;
  const uid = typeof over.uid === "string" ? over.uid : UID;
  await reportRef(db, placeId, uid).set({
    v: 1,
    uid,
    placeId,
    reason: "cant_park",
    reportedAt: Timestamp.fromDate(REPORTED),
    platform: "android",
    appVersion: "1.2.3",
    ...over,
  });
}

describe("parking report dates", () => {
  it("adds 24 calendar months and uses the London day", () => {
    assert.equal(AUTO_HIDE_THRESHOLD, null);
    assert.equal(PARKING_REPORT_DAILY_LIMIT, 20);
    const expire = addMonthsUtc(REPORTED, 24);
    assert.equal(expire.toISOString(), "2028-11-01T12:00:00.000Z");
    assert.equal(londonDay(REPORTED), "2026-11-01");
    assert.equal(londonDay(new Date("2026-06-01T23:30:00.000Z")), "2026-06-02");
  });
});

describe("parking report trigger", () => {
  let db: Firestore;

  before(() => {
    db = testDb("demo-ferromaps-parking-reports");
  });

  beforeEach(async () => {
    await db.recursiveDelete(db.collection("parkingReports"));
    await db.recursiveDelete(db.collection("parkingReportStats"));
    await db.recursiveDelete(db.collection("places"));
    await db.recursiveDelete(db.collection("users"));
  });

  it("accepts a known place, sets expireAt, and increments stats", async () => {
    await db.collection("places").doc(PLACE).set({payMode: "handoff"});
    await writeReport(db);
    await processParkingReport(db, reportRef(db));
    await processParkingReport(db, reportRef(db));

    const report = (await reportRef(db).get()).data() ?? {};
    assert.equal(report.status, "accepted");
    assert.equal(report.reviewStatus, "pending");
    assert.ok(report.processedAt instanceof Timestamp);
    assert.equal(report.rejectReason, undefined);
    assert.equal(report.expireAt.toDate().toISOString(), "2028-11-01T12:00:00.000Z");
    const stats = (await db.collection("parkingReportStats").doc(PLACE).get()).data();
    assert.equal(stats?.count, 1);
    assert.equal(stats?.byReason.cant_park, 1);
    assert.equal(stats?.lastReportedAt.toDate().toISOString(), REPORTED.toISOString());
    const counter = await db.collection("users").doc(UID).collection("meta").doc("parkingReportDay").get();
    assert.equal(counter.get("day"), "2026-11-01");
    assert.equal(counter.get("count"), 1);
    assert.equal((await db.collection("places").doc(PLACE).get()).get("hidden"), undefined);

    await writeReport(db, {uid: "bea", reason: "closed"});
    await processParkingReport(db, reportRef(db, PLACE, "bea"));
    const again = (await db.collection("parkingReportStats").doc(PLACE).get()).data();
    assert.equal(again?.count, 2);
    assert.equal(again?.byReason.cant_park, 1);
    assert.equal(again?.byReason.closed, 1);
  });

  it("accepts a place that is only in the parking place index", async () => {
    await db.collection("parkingPlaceIndex").doc(PLACE).set({
      cellId: "gcpvj0",
      updatedAt: Timestamp.fromDate(REPORTED),
    });
    await writeReport(db);
    await processParkingReport(db, reportRef(db));
    const report = (await reportRef(db).get()).data() ?? {};
    assert.equal(report.status, "accepted");
    assert.equal(report.reviewStatus, "pending");
    assert.equal(report.rejectReason, undefined);
    assert.equal((await db.collection("places").doc(PLACE).get()).exists, false);
  });

  it("rejects an unknown place and does not count it", async () => {
    await writeReport(db, {placeId: "missing"});
    await processParkingReport(db, reportRef(db, "missing"));
    const report = (await reportRef(db, "missing").get()).data() ?? {};
    assert.equal(report.status, "rejected");
    assert.equal(report.rejectReason, "UNKNOWN_PLACE");
    assert.equal(report.reviewStatus, undefined);
    assert.equal(report.expireAt.toDate().toISOString(), "2028-11-01T12:00:00.000Z");
    assert.equal((await db.collection("parkingReportStats").doc("missing").get()).exists, false);
    const counter = await db.collection("users").doc(UID).collection("meta").doc("parkingReportDay").get();
    assert.equal(counter.exists, false);
  });

  it("rejects the 21st accepted report in a London day and keeps yesterday's count separate", async () => {
    await db.collection("places").doc(PLACE).set({payMode: "handoff"});
    await db.collection("places").doc("place-2").set({payMode: "handoff"});
    await db.collection("users").doc(UID).collection("meta").doc("parkingReportDay").set({
      day: "2026-11-01",
      count: PARKING_REPORT_DAILY_LIMIT,
    });
    await writeReport(db, {placeId: "place-2"});
    await processParkingReport(db, reportRef(db, "place-2"));
    const rejected = (await reportRef(db, "place-2").get()).data() ?? {};
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectReason, "RATE_LIMIT");
    assert.equal(rejected.expireAt.toDate().toISOString(), "2028-11-01T12:00:00.000Z");
    assert.equal((await db.collection("parkingReportStats").doc("place-2").get()).exists, false);
    const counter = await db.collection("users").doc(UID).collection("meta").doc("parkingReportDay").get();
    assert.equal(counter.get("count"), 20);
    assert.equal(counter.get("day"), "2026-11-01");

    const yesterday = new Date("2026-10-31T12:00:00.000Z");
    await writeReport(db, {placeId: PLACE, reportedAt: Timestamp.fromDate(yesterday)});
    await processParkingReport(db, reportRef(db));
    const accepted = (await reportRef(db).get()).data() ?? {};
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.reviewStatus, "pending");
    const rolled = await db.collection("users").doc(UID).collection("meta").doc("parkingReportDay").get();
    assert.equal(rolled.get("day"), londonDay(yesterday));
    assert.equal(rolled.get("count"), 1);
  });
});
