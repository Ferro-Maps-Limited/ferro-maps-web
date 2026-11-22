import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, beforeEach, describe, it} from "node:test";
import {Timestamp} from "firebase-admin/firestore";
import {refundIdempotencyKey} from "../src/parking/contract";
import {
  parseRefundArgs,
  runRefundTrial,
  writeRefundLog,
  type TrialStripe,
} from "../scripts/refundTrialPayments";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-refund-trial";

function stripeMock() {
  const refunds: Array<{id: string; key: string}> = [];
  const refunded = new Set<string>();
  const stripe: TrialStripe = {
    retrievePaymentIntent: async (id) => ({
      id,
      status: "succeeded",
      amount: 610,
      currency: "gbp",
      amountRefunded: refunded.has(id) ? 610 : 0,
    }),
    refundPaymentIntent: async (id, key) => {
      refunds.push({id, key});
      refunded.add(id);
      return {id: `re_${id}`};
    },
  };
  return {stripe, refunds};
}

describe("refund trial payments", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(testDb(PROJECT));
  });

  after(async () => {
    await clearDb(testDb(PROJECT));
  });

  it("refuses to run without a project and a selection, and stays a dry-run", () => {
    assert.throws(() => parseRefundArgs(["--payment-intent", "pi_test1"]), /--project/);
    assert.throws(() => parseRefundArgs(["--project", "demo", "--execute"]), /--uid/);
    assert.throws(() => parseRefundArgs([
      "--project", "demo", "--from", "2026-11-01", "--to", "2026-11-02",
    ]), /date range/);
    assert.throws(() => parseRefundArgs([
      "--project", "demo", "--payment-intent", "pi_test1", "--uid", "alice",
    ]), /not both/);
    const args = parseRefundArgs(["--project", "demo-ferromaps", "--pi", "pi_test1"]);
    assert.equal(args.execute, false);
    assert.equal(args.project, "demo-ferromaps");
    assert.deepEqual(args.paymentIntentIds, ["pi_test1"]);
    assert.equal(args.uid, null);
  });

  it("lists a paid payment and its PaymentIntent without refunding", async () => {
    const db = testDb(PROJECT);
    await db.collection("parkingPayments").doc("pi_trial1").set({
      uid: "alice",
      status: "paid",
      amount: 610,
      createdAt: Timestamp.fromDate(new Date("2026-11-01T12:00:00.000Z")),
    });
    await db.collection("parkingPayments").doc("pi_other1").set({
      uid: "alice",
      status: "paid",
      amount: 610,
      createdAt: Timestamp.fromDate(new Date("2026-10-01T12:00:00.000Z")),
    });
    await db.collection("parkingPayments").doc("pi_bob1").set({
      uid: "bob",
      status: "paid",
      amount: 610,
      createdAt: Timestamp.fromDate(new Date("2026-11-01T12:00:00.000Z")),
    });
    const mocked = stripeMock();
    const args = parseRefundArgs([
      "--project", PROJECT, "--uid", "alice", "--from", "2026-11-01", "--to", "2026-11-01",
    ]);
    const log = await runRefundTrial(db, mocked.stripe, args);
    assert.equal(args.execute, false);
    assert.equal(log.items.length, 1);
    assert.equal(log.items[0]?.paymentIntentId, "pi_trial1");
    assert.equal(log.items[0]?.action, "would-refund");
    assert.equal(log.items[0]?.stripeStatus, "succeeded");
    assert.equal(log.items[0]?.amount, 610);
    assert.equal(log.items[0]?.previousStatus, "paid");
    assert.equal(mocked.refunds.length, 0);
    assert.equal((await db.collection("parkingPayments").doc("pi_trial1").get()).get("status"), "paid");
    const dir = await mkdtemp(join(tmpdir(), "refund-trial-"));
    const logPath = join(dir, "undo.json");
    await writeRefundLog(logPath, log);
    const written = JSON.parse(await readFile(logPath, "utf8")) as {items: Array<{action: string}>};
    assert.equal(written.items[0]?.action, "would-refund");
  });

  it("refunds only with execute, then skips the same payment", async () => {
    const db = testDb(PROJECT);
    await db.collection("parkingPayments").doc("pi_trial2").set({
      status: "paid",
      amount: 610,
      createdAt: Timestamp.now(),
    });
    const mocked = stripeMock();
    const preview = parseRefundArgs(["--project", PROJECT, "--payment-intent", "pi_trial2"]);
    await runRefundTrial(db, mocked.stripe, preview);
    assert.equal(mocked.refunds.length, 0);
    assert.equal((await db.collection("parkingPayments").doc("pi_trial2").get()).get("status"), "paid");

    const args = parseRefundArgs(["--project", PROJECT, "--execute", "--payment-intent", "pi_trial2"]);
    const log = await runRefundTrial(db, mocked.stripe, args);
    assert.equal(log.execute, true);
    assert.equal(log.items[0]?.action, "refunded");
    assert.equal(log.items[0]?.refundId, "re_pi_trial2");
    assert.equal(mocked.refunds.length, 1);
    assert.equal(mocked.refunds[0]?.key, refundIdempotencyKey("pi_trial2"));
    assert.equal((await db.collection("parkingPayments").doc("pi_trial2").get()).get("status"), "refunded");

    const again = await runRefundTrial(db, mocked.stripe, args);
    assert.equal(again.items[0]?.action, "skipped");
    assert.equal(again.items[0]?.reason, "Already refunded.");
    assert.equal(mocked.refunds.length, 1);
  });
});
