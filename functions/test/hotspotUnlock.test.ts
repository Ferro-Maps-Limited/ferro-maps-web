import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {
  DENIED_REASONS,
  activeDeviceAllowed,
  callerFromUnlockEvent,
  decideUnlock,
  handleHotspotUnlockRequest,
  type CallerAuth,
  type UnlockRequestEvent,
} from "../src/surge/onHotspotUnlockRequest";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const DEVICE = "a".repeat(64);
/* 1 Jan 2027 00:00 UK. Winter, so this is also 00:00 UTC. The whole of 31 Dec is before it. */
const GRACE_UNTIL = Date.parse("2027-01-01T00:00:00.000Z");

function auth(extra: Partial<CallerAuth> = {}): CallerAuth {
  return {uid: "ada", ...extra};
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "ada",
    summaryId: "sum_a",
    status: "pending",
    createdAt: Timestamp.fromDate(NOW),
    deviceId: DEVICE,
    ...extra,
  };
}

function summaryKey(windowEnd = Timestamp.fromMillis(NOW.getTime() + 3_600_000)): Record<string, unknown> {
  return {
    hotspotId: "sheet_a",
    windowStart: Timestamp.fromMillis(NOW.getTime()),
    windowEnd,
    expireAt: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
  };
}

function user(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeDeviceId: DEVICE,
    surgeUnlimitedUntil: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
    ...extra,
  };
}

function decide(extra: Partial<Parameters<typeof decideUnlock>[0]> = {}) {
  return decideUnlock({
    request: request(),
    auth: auth(),
    user: user(),
    summaryKey: summaryKey(),
    unlock: undefined,
    enabled: true,
    now: NOW,
    graceUntilMs: null,
    ...extra,
  });
}

describe("hotspot unlock decision", () => {
  it("uses only snake_case denial reasons and writes the forecast window end", () => {
    assert.deepEqual([...DENIED_REASONS], [
      "device_revoked",
      "no_credit",
      "not_eligible",
      "flag_off",
      "invalid",
    ]);
    const end = Timestamp.fromMillis(NOW.getTime() + 3_600_000);
    const decision = decide({summaryKey: summaryKey(end)});
    assert.equal(decision.status, "done");
    assert.equal(decision.writeUnlock, true);
    assert.equal(decision.hotspotId, "sheet_a");
    assert.equal(decision.reason, undefined);
    assert.equal(decision.validUntil?.toMillis(), end.toMillis());
  });

  it("does not spend again when the pin is already open", () => {
    const decision = decide({
      unlock: {validUntil: Timestamp.fromMillis(NOW.getTime() + 1_000)},
    });
    assert.equal(decision.status, "done");
    assert.equal(decision.writeUnlock, false);
  });

  it("denies everyone who is not unlimited, with no balance to read", () => {
    for (const record of [
      user({surgeUnlimitedUntil: undefined}),
      user({surgeUnlimitedUntil: Timestamp.fromMillis(NOW.getTime() - 1)}),
      user({surgeUnlimitedUntil: "2099-01-01"}),
      {},
    ]) {
      const decision = decide({user: record});
      assert.equal(decision.status, "denied");
      assert.equal(decision.reason, "no_credit");
      assert.equal(decision.writeUnlock, false);
    }
  });

  it("denies a missing, expired, or finished summary key", () => {
    assert.equal(decide({summaryKey: undefined}).reason, "not_eligible");
    assert.equal(decide({
      summaryKey: {...summaryKey(), expireAt: Timestamp.fromMillis(NOW.getTime() - 1)},
    }).reason, "not_eligible");
    assert.equal(decide({
      summaryKey: summaryKey(Timestamp.fromMillis(NOW.getTime() - 1)),
    }).reason, "not_eligible");
    assert.equal(decide({
      summaryKey: summaryKey(Timestamp.fromMillis(NOW.getTime())),
    }).reason, "not_eligible");
  });

  it("denies when either planner switch is off", () => {
    assert.equal(decide({enabled: false}).reason, "flag_off");
  });

  it("refuses a different deviceId and covers the whole UK day when grace is configured", () => {
    const noStamp = request();
    delete noStamp.deviceId;
    const stillOpen = {
      user: user({surgeUnlimitedUntil: Timestamp.fromMillis(GRACE_UNTIL + 86_400_000)}),
      summaryKey: {
        hotspotId: "sheet_a",
        windowEnd: Timestamp.fromMillis(GRACE_UNTIL + 3_600_000),
        expireAt: Timestamp.fromMillis(GRACE_UNTIL + 86_400_000),
      },
      graceUntilMs: GRACE_UNTIL,
      request: noStamp,
    };
    assert.equal(decide({request: request({deviceId: "b".repeat(64)})}).reason, "device_revoked");
    assert.equal(decide({...stillOpen, now: new Date("2026-12-31T00:00:00.000Z")}).status, "done");
    assert.equal(decide({...stillOpen, now: new Date("2026-12-31T23:30:00.000Z")}).status, "done");
    assert.equal(decide({
      ...stillOpen,
      now: new Date("2027-01-01T00:00:00.000Z"),
    }).reason, "device_revoked");
    assert.equal(decide({request: noStamp, graceUntilMs: null}).reason, "device_revoked");
    assert.equal(activeDeviceAllowed({activeDeviceId: null}, null, GRACE_UNTIL, null), true);
  });

  it("checks the device before the flag, and rejects a bad request first", () => {
    assert.equal(decide({
      request: request({deviceId: "b".repeat(64)}),
      enabled: false,
    }).reason, "device_revoked");
    assert.equal(decide({auth: auth({uid: "other"})}).reason, "invalid");
    assert.equal(decide({request: request({summaryId: "a/b"})}).reason, "invalid");
    assert.equal(decide({request: request({status: "done"})}).status, "ignore");
    assert.equal(decide({request: request({createdAt: undefined})}).reason, "invalid");
  });

  it("uses the request deviceId when the event has no token claims", () => {
    const event: UnlockRequestEvent = {authId: "ada", authType: "unknown"};
    assert.deepEqual(Object.keys(event).sort(), ["authId", "authType"]);
    const caller = callerFromUnlockEvent(event);
    assert.deepEqual(caller, {uid: "ada"});
    const mismatch = decide({
      auth: caller,
      request: request({deviceId: "b".repeat(64)}),
    });
    assert.equal(mismatch.reason, "device_revoked");
    const match = decide({auth: caller, request: request({deviceId: DEVICE})});
    assert.equal(match.status, "done");
    const source = readFileSync(join(__dirname, "../src/surge/onHotspotUnlockRequest.ts"), "utf8");
    assert.equal(source.includes("device_change_limit"), false);
    assert.equal(source.includes("auth.token"), false);
  });

  it("records a server failure as error and does not attach a reason", async () => {
    const updates: Record<string, unknown>[] = [];
    const db = {
      doc() {
        return {async get() {
          return {get: () => undefined};
        }};
      },
      async runTransaction() {
        throw new Error("boom");
      },
    } as unknown as Firestore;
    const requestRef = {
      async update(data: Record<string, unknown>) {
        updates.push(data);
      },
    } as unknown as DocumentReference;
    await handleHotspotUnlockRequest(db, requestRef, auth(), NOW);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, "error");
    assert.equal(Object.prototype.hasOwnProperty.call(updates[0], "reason"), false);
  });

  it("is a request trigger, with no callable and no balance field", () => {
    const source = readFileSync(join(__dirname, "../src/surge/onHotspotUnlockRequest.ts"), "utf8");
    assert.equal(source.includes("onCall"), false);
    assert.equal(source.includes("surgeCredits"), false);
    assert.equal(source.includes("ferroBalance"), false);
    assert.equal(source.includes("onDocumentCreatedWithAuthContext"), true);
    const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    assert.equal(index.includes("onHotspotUnlockRequest"), true);
  });
});
