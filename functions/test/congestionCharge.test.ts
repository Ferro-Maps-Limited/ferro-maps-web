import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {
  CONGESTION_ROAD_CHARGE_ID,
  congestionDay,
  congestionVisitId,
  isCongestionChargingDay,
  lateDeadlineDay,
} from "../src/parking/congestionCharge";
import {ParkingPaymentError} from "../src/parking/contract";
import {runParkingPaymentRequest, type ParkingStripe, type PaymentIntentShape} from "../src/parking/payments";
import {remindOpenJobsNearDeadline} from "../src/parking/authorityDesk";
import {paidNotice} from "../src/parking/notices";
import {pricingClock} from "../src/parking/sheetPricing";
import {EXPECTED_STRIPE_ACCOUNT_ID} from "../src/parking/stripeClient";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-congestion";
const PUBLISHABLE = "pk_test_example";
const ms = (iso: string): number => Date.parse(iso);

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ParkingPaymentError) return err.errorCode;
    throw err;
  }
  return "none";
}

describe("congestion charge days and deadlines", () => {
  it("charges every day except Christmas Day to the New Year's Day bank holiday", () => {
    assert.equal(isCongestionChargingDay("2026-11-28"), true); // a Saturday
    assert.equal(isCongestionChargingDay("2026-12-24"), true);
    assert.equal(isCongestionChargingDay("2026-12-25"), false);
    assert.equal(isCongestionChargingDay("2026-12-31"), false);
    assert.equal(isCongestionChargingDay("2027-01-01"), false);
    assert.equal(isCongestionChargingDay("2027-01-02"), true);
    // 1 Jan 2028 is a Saturday, so the bank holiday is Monday 3 Jan.
    assert.equal(isCongestionChargingDay("2028-01-03"), false);
    assert.equal(isCongestionChargingDay("2028-01-04"), true);
    assert.equal(isCongestionChargingDay("2029-01-02"), null); // past the bank holiday table
  });

  it("takes a late payment until midnight on the 3rd charging day after", () => {
    assert.equal(lateDeadlineDay("2026-11-27"), "2026-11-30");
    assert.equal(lateDeadlineDay("2026-12-23"), "2027-01-03"); // 24 Dec, then 2 and 3 Jan
    assert.equal(lateDeadlineDay("2026-12-24"), "2027-01-04");
  });

  it("prices today as standard, the last 3 charging days as late, and refuses the rest", () => {
    const now = ms("2026-11-27T10:00:00Z");
    assert.deepEqual(congestionDay(now, "2026-11-27"),
      {band: "standard", deadlineDay: "2026-11-30", deadlineAtMs: ms("2026-12-01T00:00:00Z")});
    assert.equal(congestionDay(now, "2026-11-24").band, "late");
    assert.equal(refusal(() => congestionDay(now, "2026-11-23")), "past-deadline");
    assert.equal(refusal(() => congestionDay(now, "2026-11-28")), "invalid-argument"); // tomorrow
    assert.equal(refusal(() => congestionDay(now, "2026-02-30")), "invalid-argument");
    assert.equal(refusal(() => congestionDay(ms("2026-12-29T10:00:00Z"), "2026-12-25")), "no-charge-now");
    assert.equal(congestionDay(ms("2026-12-29T10:00:00Z"), "2026-12-24").band, "late");
    // London time decides the day: 23:30 UTC in summer is already the next day there.
    assert.equal(congestionDay(ms("2026-06-01T22:30:00Z"), "2026-06-01").band, "standard");
    assert.equal(congestionDay(ms("2026-06-01T23:30:00Z"), "2026-06-01").band, "late");
    assert.equal(congestionDay(ms("2026-06-01T23:30:00Z"), "2026-06-02").band, "standard");
  });

  it("keeps the registration out of the payment's visit id", () => {
    const id = congestionVisitId("2026-11-27", "AB12CDE");
    assert.match(id, /^cc_[0-9a-f]{32}$/);
    assert.equal(id, congestionVisitId("2026-11-27", "AB12CDE"));
    assert.notEqual(id, congestionVisitId("2026-11-26", "AB12CDE"));
  });

  it("tells the driver and the desk when TfL must be paid by", () => {
    const text = paidNotice({
      paymentIntentId: "pi_cc1", uid: "alice", plate: "AB12CDE", occurredOn: "2026-11-27",
      zone: "London Congestion Charge", chargeType: "congestion", authorityPence: 1800, driverAmountPence: 1960,
      feePence: 160, paymentUrl: "https://tfl.gov.uk/", deadlineAtMs: ms("2026-12-01T00:00:00Z"),
    }).text;
    assert.match(text, /Pay by: 30 Nov, 23:59/);
    assert.match(text, /Zone: London Congestion Charge/);
  });
});

describe("paying the congestion charge through Ferro", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
    pricingClock.nowMs = () => ms("2026-11-27T10:00:00Z");
  });

  after(async () => {
    pricingClock.nowMs = () => Date.now();
    await clearDb(testDb(PROJECT));
  });

  function echoingStripe() {
    const creates: {amount?: number; metadata?: Record<string, string>}[] = [];
    let n = 0;
    const stripe: ParkingStripe = {
      customers: {create: async () => ({id: "cus_test"})},
      paymentIntents: {
        create: async (params) => {
          creates.push(params as {amount?: number});
          n += 1;
          const pi: PaymentIntentShape = {id: `pi_cc${n}`, client_secret: `pi_cc${n}_secret`, status: "requires_payment_method",
            amount: params.amount ?? 0, currency: "gbp", customer: "cus_test"};
          return pi;
        },
        retrieve: async (id) => ({id, client_secret: `${id}_secret`, status: "requires_payment_method", amount: 1960,
          currency: "gbp", customer: "cus_test"}),
        cancel: async (id) => ({id, client_secret: `${id}_secret`, status: "canceled", amount: 1960, currency: "gbp",
          customer: "cus_test"}),
      },
      ephemeralKeys: {create: async () => ({secret: "ek_test"})},
    };
    return {stripe, creates};
  }

  async function seed(opts: {on?: unknown; rates?: boolean} = {}): Promise<void> {
    const db = testDb(PROJECT);
    await db.doc("config/parkingPayments").set({enabled: true, testMode: true, stripeAccountId: EXPECTED_STRIPE_ACCOUNT_ID});
    await db.doc("config/payments").set("on" in opts ? (opts.on === undefined ? {} : {congestionCharges: opts.on}) :
      {congestionCharges: true});
    const zone = db.collection("roadCharges").doc(CONGESTION_ROAD_CHARGE_ID);
    await zone.set({name: "London Congestion Charge (CCZ)", status: "active", charge_basis: "per_day"});
    if (opts.rates === false) {
      // clearDb leaves subcollections, so the rates go one by one.
      for (const doc of (await zone.collection("rates").get()).docs) await doc.ref.delete();
      return;
    }
    await zone.collection("rates").doc("car-standard").set({vehicle_class: "car", payment_method: "standard",
      amount_gbp: 18, unit: "per_day"});
    await zone.collection("rates").doc("car-late").set({vehicle_class: "car", payment_method: "late",
      amount_gbp: 21, unit: "per_day"});
    await zone.collection("rates").doc("ev-auto").set({vehicle_class: "ev_car", payment_method: "auto_pay",
      amount_gbp: 13.5, unit: "per_day"});
  }

  async function pay(day: string, extra: Record<string, unknown> = {}, stripe = echoingStripe()) {
    const db = testDb(PROJECT);
    const id = `req-${Math.random().toString(36).slice(2)}`;
    const ref = db.collection("parkingPaymentRequests").doc(id);
    await ref.set({
      uid: "alice", v: 1, action: "create", chargeType: "congestion", plate: "AB12 CDE", platform: "ios",
      appVersion: "1.3.1", status: "pending", createdAt: Timestamp.now(), zone: CONGESTION_ROAD_CHARGE_ID,
      occurredOn: day, ...extra,
    });
    await runParkingPaymentRequest(db, stripe.stripe, ref, PUBLISHABLE);
    const request = (await ref.get()).data();
    const pid = request?.paymentIntentId as string | undefined;
    const payment = pid ? (await db.collection("parkingPayments").doc(pid).get()).data() : undefined;
    return {request, payment, creates: stripe.creates};
  }

  it("stays off until config/payments.congestionCharges is exactly true", async () => {
    for (const on of [undefined, "true", 1]) {
      await clearDb(testDb(PROJECT));
      await seed({on});
      const {request, creates} = await pay("2026-11-27");
      assert.equal(request?.errorCode, "failed-precondition", JSON.stringify(request));
      assert.equal(creates.length, 0);
    }
  });

  it("charges today's standard price plus the Ferro fee and records the TfL deadline", async () => {
    await seed();
    const {request, payment, creates} = await pay("2026-11-27");
    assert.equal(request?.status, "done", JSON.stringify(request));
    assert.equal(creates[0].amount, 1800 + 160);
    assert.equal(payment?.chargeType, "congestion");
    assert.equal(payment?.authorityPence, 1800);
    assert.equal(payment?.chargeBand, "standard");
    assert.equal(payment?.roadChargeId, CONGESTION_ROAD_CHARGE_ID);
    assert.equal(payment?.zone, "London Congestion Charge");
    assert.equal(payment?.occurredOn, "2026-11-27");
    assert.equal((payment?.deadlineAt as Timestamp).toMillis(), ms("2026-12-01T00:00:00Z"));
    assert.match(String(payment?.paymentUrl), /^https:\/\/tfl\.gov\.uk\//);
    assert.match(String(payment?.visitId), /^cc_/);
    assert.ok(!JSON.stringify(payment).includes("AB12"), "no plate on the payment");
  });

  it("charges the late price for the last 3 charging days and refuses older or future days", async () => {
    await seed();
    const late = await pay("2026-11-26");
    assert.equal(late.creates[0].amount, 2100 + 160);
    assert.equal(late.payment?.chargeBand, "late");
    assert.equal((late.payment?.deadlineAt as Timestamp).toMillis(), ms("2026-11-30T00:00:00Z"));
    assert.equal((await pay("2026-11-23")).request?.errorCode, "past-deadline");
    assert.equal((await pay("2026-11-28")).request?.errorCode, "invalid-argument");
  });

  it("takes nothing for a day with no charge, and refuses without a published rate", async () => {
    await seed();
    pricingClock.nowMs = () => ms("2026-12-29T10:00:00Z");
    assert.equal((await pay("2026-12-25")).request?.errorCode, "no-charge-now");
    assert.equal((await pay("2026-12-24")).creates[0]?.amount, 2100 + 160);
    await clearDb(testDb(PROJECT));
    await seed({rates: false});
    pricingClock.nowMs = () => ms("2026-11-27T10:00:00Z");
    assert.equal((await pay("2026-11-27")).request?.errorCode, "failed-precondition");
  });

  it("is one charge per car per day, whichever account pays it", async () => {
    await seed();
    const db = testDb(PROJECT);
    const first = await pay("2026-11-27");
    await db.collection("parkingPayments").doc(first.request?.paymentIntentId as string).update({status: "paid"});
    const bob = await pay("2026-11-27", {uid: "bob"});
    assert.equal(bob.request?.errorCode, "already-paid");
    assert.equal(bob.creates.length, 0);
    const otherCar = await pay("2026-11-27", {uid: "bob", plate: "XY99 ZZZ"});
    assert.equal(otherCar.request?.status, "done", JSON.stringify(otherCar.request));
  });

  it("still refuses a road charge that carries its own price", async () => {
    await seed();
    const {request, creates} = await pay("2026-11-27", {authorityPence: 100});
    assert.equal(request?.errorCode, "failed-precondition");
    assert.equal(creates.length, 0);
  });

  it("reminds the desk once when an open job's deadline is under 6 hours away", async () => {
    const db = testDb(PROJECT);
    const now = ms("2026-11-30T19:00:00Z");
    const job = (id: string, deadlineIso: string, status = "open") => db.collection("authorityPayments").doc(id).set({
      v: 1, paymentIntentId: id, uid: "alice", chargeType: "congestion", plate: "AB12CDE", occurredOn: "2026-11-27",
      zone: "London Congestion Charge", authorityPence: 1800, feePence: 160, driverAmountPence: 1960,
      paymentUrl: "https://tfl.gov.uk/", deadlineAt: Timestamp.fromMillis(ms(deadlineIso)), status,
    });
    await job("pi_soon1", "2026-12-01T00:00:00Z");
    await job("pi_later1", "2026-12-02T00:00:00Z");
    await job("pi_queued1", "2026-12-01T00:00:00Z", "queued");
    await remindOpenJobsNearDeadline(db, now);
    await remindOpenJobsNearDeadline(db, now + 60_000);
    const notices = await db.collection("paymentNotifications").get();
    assert.deepEqual(notices.docs.map((d) => d.id), ["pi_soon1:deadline"]);
    const text = String(notices.docs[0].get("text"));
    assert.match(text, /due within 6 hours/);
    assert.match(text, /Pay by: 30 Nov, 23:59/);
    assert.match(text, /Plate: AB12CDE/);
    assert.ok((await db.collection("authorityPayments").doc("pi_soon1").get()).get("deadlineRemindedAt"));
  });
});
