import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {SurgeAccessError} from "../src/surgeAccess/contract.js";
import {
  SYNTHETIC_LEDGER,
  applySyntheticPurchase,
  applySyntheticRevoke,
  emptySyntheticState,
  openSyntheticEvent,
  unavailableVerifier,
  type SyntheticPurchase,
} from "../src/surgeAccess/syntheticLedger.js";

const END = "2026-11-08T22:00:00.000Z";
const BEFORE = "2026-11-08T20:00:00.000Z";
const AFTER = "2026-11-09T00:00:00.000Z";

function purchase(overrides: Partial<SyntheticPurchase> = {}): SyntheticPurchase {
  return {
    verified: true,
    store: "apple",
    transactionId: "test-tx-1",
    uid: "alice",
    accountToken: "binding-alice",
    expectedAccountToken: "binding-alice",
    productId: "fixture-weekly",
    appId: "fixture-app",
    expectedAppId: "fixture-app",
    env: "sandbox-test",
    expectedEnv: "sandbox-test",
    kind: "weekly-allowance",
    weeklyOpens: 10,
    ...overrides,
  };
}

describe("synthetic purchase ledger (test only)", () => {
  it("is labeled test-only and the runtime adapter refuses to verify", () => {
    assert.equal(SYNTHETIC_LEDGER, "test-only");
    assert.throws(() => unavailableVerifier(), (err) => {
      return err instanceof SurgeAccessError && err.code === "verifier-unavailable";
    });
  });

  it("records one kind once and refuses unverified, mismatched, and cross-user replay", () => {
    const state = emptySyntheticState();
    const weekly = applySyntheticPurchase(state, purchase());
    const again = applySyntheticPurchase(state, purchase());
    const single = applySyntheticPurchase(state, purchase({
      transactionId: "test-tx-2",
      kind: "single-event",
      productId: "fixture-single",
    }));
    const unverified = applySyntheticPurchase(state, purchase({transactionId: "test-tx-3", verified: false}));
    const wrongApp = applySyntheticPurchase(state, purchase({transactionId: "test-tx-4", appId: "other-app"}));
    const wrongEnv = applySyntheticPurchase(state, purchase({transactionId: "test-tx-5", env: "production"}));
    const wrongAccount = applySyntheticPurchase(state, purchase({
      transactionId: "test-tx-6",
      accountToken: "binding-bob",
    }));
    const stolen = applySyntheticPurchase(state, purchase({uid: "bob"}));
    assert.equal(weekly.allowanceGrants, 1);
    assert.equal(weekly.creditGrants, 0);
    assert.equal(weekly.delivered, false);
    assert.equal(again.allowanceGrants, 0);
    assert.equal(single.creditGrants, 1);
    assert.equal(single.allowanceGrants, 0);
    assert.equal(state.purchases.length, 2);
    for (const row of [unverified, wrongApp, wrongEnv, wrongAccount, stolen]) {
      assert.equal(row.status, "refused");
      assert.equal(row.granted, false);
    }
    assert.equal(state.purchases.some((row) => row.uid === "bob"), false);
  });

  it("spends allowance and a single separately, reopens until the verified end, and does not refill on revoke", () => {
    const state = emptySyntheticState();
    applySyntheticPurchase(state, purchase({weeklyOpens: 1}));
    applySyntheticPurchase(state, purchase({transactionId: "test-tx-2", kind: "single-event"}));
    const first = openSyntheticEvent(state, "alice", "event-a", BEFORE, END, 1);
    const reopen = openSyntheticEvent(state, "alice", "event-a", BEFORE, END, 1);
    const paid = openSyntheticEvent(state, "alice", "event-b", BEFORE, END, 1);
    const third = openSyntheticEvent(state, "alice", "event-c", BEFORE, END, 1);
    const afterEnd = openSyntheticEvent(state, "alice", "event-a", AFTER, END, 1);
    const usedBeforeRevoke = state.opensUsed.alice;
    applySyntheticRevoke(state, "apple", "test-tx-1");
    assert.equal(first.status, "recorded");
    assert.equal(reopen.status, "reopened");
    assert.equal(reopen.creditGrants, 0);
    assert.equal(paid.status, "recorded");
    assert.equal(state.unlocks.find((row) => row.eventId === "event-b")?.source, "single");
    assert.equal(third.status, "refused");
    assert.equal(afterEnd.status, "refused");
    assert.equal(state.opensUsed.alice, usedBeforeRevoke);
    assert.equal(state.unlocks.every((row) => row.validUntil === END), true);
    for (const row of [first, reopen, paid, third, afterEnd]) assert.equal(row.delivered, false);
  });
});
