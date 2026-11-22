import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  applyLedger,
  availablePence,
  fundingAlerts,
  initialFundingState,
  withLowWater,
  withPaused,
  type FundingState,
  type LedgerEntry,
} from "../src/parking/fundingMath";
import {mergeJobStatus, refundAfterMillis, QUEUE_LIMIT_MS, DEADLINE_LEAD_MS} from "../src/parking/jobPlan";
import {
  ParkingPaymentError,
  chargeIdempotencyKey,
  paymentIntentIdempotencyKey,
  refundIdempotencyKey,
} from "../src/parking/contract";
import {containsCardNumber, redactCardNumbers} from "../src/parking/cardGuard";
import {
  assertFerroStripeAccount,
  EXPECTED_STRIPE_ACCOUNT_ID,
  ensureFerroStripeAccount,
  resetStripeAccountCheck,
} from "../src/parking/stripeClient";

const DAY = "2026-11-15";
const NEXT = "2026-11-16";

function state(over: Partial<FundingState> = {}): FundingState {
  return {...initialFundingState(DAY), balancePence: 50_000, ...over};
}

function entry(over: Partial<LedgerEntry> & Pick<LedgerEntry, "kind" | "amountPence">): LedgerEntry {
  return {id: `${over.kind}:pi_1`, ...over};
}

describe("funding ledger math", () => {
  it("available is the lesser of cash after reservations and today's cap", () => {
    const funded = state({balancePence: 500_000, spentTodayPence: 190_000});
    assert.equal(availablePence(funded, DAY), 10_000);
    assert.equal(availablePence(state({balancePence: 5_000, reservedPence: 2_000}), DAY), 3_000);
    assert.equal(availablePence(state({balancePence: 0}), DAY), 0);
  });

  it("resets spend when the London day changes and keeps the balance", () => {
    const yesterday = state({spentDay: DAY, spentTodayPence: 200_000, balancePence: 50_000});
    assert.equal(availablePence(yesterday, NEXT), 50_000);
    const topped = applyLedger(yesterday, entry({kind: "topup", amountPence: 1_000, id: "topup:a"}), NEXT);
    assert.equal(topped.spentDay, NEXT);
    assert.equal(topped.spentTodayPence, 0);
    assert.equal(topped.balancePence, 51_000);
  });

  it("reserves, commits, and releases without going negative", () => {
    let next = applyLedger(state({balancePence: 10_000}), entry({kind: "reserve", amountPence: 4_000}), DAY);
    assert.equal(next.reservedPence, 4_000);
    assert.equal(availablePence(next, DAY), 6_000);
    next = applyLedger(next, entry({kind: "commit", amountPence: 2_500, id: "commit:pi_1"}), DAY);
    assert.equal(next.balancePence, 7_500);
    assert.equal(next.reservedPence, 1_500);
    assert.equal(next.spentTodayPence, 2_500);
    next = applyLedger(next, entry({kind: "release", amountPence: 1_500, id: "release:pi_1"}), DAY);
    assert.equal(next.reservedPence, 0);
    assert.equal(next.balancePence, 7_500);
    assert.throws(() => applyLedger(next, entry({kind: "commit", amountPence: 1}), DAY));
    assert.throws(() => applyLedger(state({balancePence: 100}), entry({kind: "reserve", amountPence: 101}), DAY));
  });

  it("alerts once when available drops below £100 and again only after it recovers", () => {
    const before = state({balancePence: 15_000, lowWaterPence: 10_000});
    const reserved = applyLedger(before, entry({kind: "reserve", amountPence: 6_000}), DAY);
    const crossed = withLowWater(before, reserved, DAY);
    assert.equal(crossed.lowWaterAlerted, true);
    assert.equal(crossed.lowWaterGeneration, 1);
    const again = withLowWater(crossed, applyLedger(crossed, entry({
      kind: "reserve", amountPence: 1_000, id: "reserve:pi_2",
    }), DAY), DAY);
    assert.equal(again.lowWaterGeneration, 1);
    const recovered = withLowWater(again, applyLedger(again, entry({
      kind: "topup", amountPence: 20_000, id: "topup:b",
    }), DAY), DAY);
    assert.equal(recovered.lowWaterAlerted, false);
    const second = withLowWater(recovered, applyLedger(recovered, entry({
      kind: "reserve", amountPence: 20_000, id: "reserve:pi_3",
    }), DAY), DAY);
    assert.equal(second.lowWaterGeneration, 2);
    const alerts = fundingAlerts(before, crossed, DAY);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.id, "funding:low_water:1");
  });

  it("pause and resume each get one alert", () => {
    const before = state({balancePence: 100_000});
    const paused = withPaused(before, true);
    const resumed = withPaused(paused, false);
    assert.deepEqual(fundingAlerts(before, paused, DAY).map((alert) => alert.kind), ["paused"]);
    assert.deepEqual(fundingAlerts(paused, resumed, DAY).map((alert) => alert.kind), ["resumed"]);
    assert.equal(fundingAlerts(paused, withPaused(paused, true), DAY).length, 0);
    assert.equal(availablePence(paused, DAY), 100_000);
  });
});

describe("authority job state machine", () => {
  it("moves queued jobs onto the desk and refuses a second terminal outcome", () => {
    assert.equal(mergeJobStatus(undefined, "queued"), "queued");
    assert.equal(mergeJobStatus("queued", "open"), "open");
    assert.equal(mergeJobStatus("queued", "expired"), "expired");
    assert.equal(mergeJobStatus("queued", "fulfilled"), "queued");
    assert.equal(mergeJobStatus("open", "fulfilled"), "fulfilled");
    assert.equal(mergeJobStatus("open", "failed"), "failed");
    assert.equal(mergeJobStatus("open", "already_paid"), "already_paid");
    assert.equal(mergeJobStatus("fulfilled", "failed"), "fulfilled");
    assert.equal(mergeJobStatus("expired", "open"), "expired");
    assert.equal(mergeJobStatus("failed", "failed"), "failed");
  });

  it("refunds at the earlier of the deadline minus three hours and 24 hours", () => {
    const queuedAt = Date.parse("2026-11-15T08:00:00Z");
    assert.equal(refundAfterMillis(queuedAt, null), queuedAt + QUEUE_LIMIT_MS);
    const soon = queuedAt + 10 * 60 * 60 * 1000;
    assert.equal(refundAfterMillis(queuedAt, soon), soon - DEADLINE_LEAD_MS);
    const far = queuedAt + 48 * 60 * 60 * 1000;
    assert.equal(refundAfterMillis(queuedAt, far), queuedAt + QUEUE_LIMIT_MS);
  });
});

describe("payment idempotency", () => {
  it("keeps the parking key and uses one refund key per payment", () => {
    assert.equal(
      paymentIntentIdempotencyKey("alice", "place-1", "visit-1", null, 610),
      "alice:place-1:visit-1:-:610",
    );
    assert.equal(chargeIdempotencyKey("alice", "congestion", "pcn-9"), "alice:congestion:pcn-9");
    assert.equal(refundIdempotencyKey("pi_abc"), "refund:pi_abc");
    assert.equal(refundIdempotencyKey("pi_abc"), refundIdempotencyKey("pi_abc"));
  });

  it("accepts only Ferro's test account", async () => {
    resetStripeAccountCheck();
    await assertFerroStripeAccount(async () => ({id: EXPECTED_STRIPE_ACCOUNT_ID}));
    await assert.rejects(
      () => assertFerroStripeAccount(async () => ({id: "acct_other"})),
      (err: unknown) => err instanceof ParkingPaymentError && err.errorCode === "failed-precondition",
    );
    resetStripeAccountCheck();
    await ensureFerroStripeAccount(async () => ({id: EXPECTED_STRIPE_ACCOUNT_ID}));
    await ensureFerroStripeAccount(async () => {
      throw new Error("should have been cached");
    });
    resetStripeAccountCheck();
  });

  it("redacts card numbers and never treats a plate as one", () => {
    assert.equal(containsCardNumber("AB12CDE"), false);
    assert.equal(containsCardNumber("4111 1111 1111 1111"), true);
    assert.equal(redactCardNumbers("zone 4111111111111111"), "zone [redacted]");
  });
});
