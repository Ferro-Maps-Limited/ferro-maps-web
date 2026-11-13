import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {Timestamp, type DocumentReference, type Firestore} from "firebase-admin/firestore";
import {
  DENIED_REASONS,
  DEVICE_GRACE_ENDS_MS,
  activeDeviceAllowed,
  callerFromUnlockEvent,
  decideUnlock,
  handleHotspotUnlockRequest,
  type CallerAuth,
} from "../src/surge/onHotspotUnlockRequest";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const DEVICE = "a".repeat(64);

function auth(extra: Partial<CallerAuth> = {}): CallerAuth {
  return {uid: "ada", hasDeviceClaim: true, deviceId: DEVICE, ...extra};
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "ada",
    hotspotId: "sheet_a",
    status: "pending",
    createdAt: Timestamp.fromDate(NOW),
    ...extra,
  };
}

function user(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeDeviceId: DEVICE,
    surgeUnlimitedUntil: Timestamp.fromMillis(NOW.getTime() + 86_400_000),
    ...extra,
  };
}

function forecast(endAt = Timestamp.fromMillis(NOW.getTime() + 3_600_000)): Record<string, unknown> {
  return {forecast: {state: "available", endAt, strength: "high", confidencePercent: 80}};
}

function decide(extra: Partial<Parameters<typeof decideUnlock>[0]> = {}) {
  return decideUnlock({
    request: request(),
    auth: auth(),
    user: user(),
    forecast: forecast(),
    unlock: undefined,
    enabled: true,
    now: NOW,
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
    const decision = decide({forecast: forecast(end)});
    assert.equal(decision.status, "done");
    assert.equal(decision.writeUnlock, true);
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

  it("denies a missing forecast and a window that has ended", () => {
    assert.equal(decide({forecast: undefined}).reason, "not_eligible");
    assert.equal(decide({forecast: {forecast: {state: "no_prediction"}}}).reason, "not_eligible");
    assert.equal(decide({
      forecast: {forecast: {state: "available", endAt: Timestamp.fromMillis(NOW.getTime() - 1)}},
    }).reason, "not_eligible");
    assert.equal(decide({
      forecast: {forecast: {state: "available", endAt: Timestamp.fromMillis(NOW.getTime())}},
    }).reason, "not_eligible");
  });

  it("denies when either planner switch is off", () => {
    assert.equal(decide({enabled: false}).reason, "flag_off");
  });

  it("refuses a wrong device stamp and keeps the grace for a missing stamp", () => {
    const later = new Date(DEVICE_GRACE_ENDS_MS - 1);
    const stillOpen = {
      user: user({surgeUnlimitedUntil: Timestamp.fromMillis(DEVICE_GRACE_ENDS_MS + 86_400_000)}),
      forecast: forecast(Timestamp.fromMillis(DEVICE_GRACE_ENDS_MS + 3_600_000)),
    };
    assert.equal(decide({auth: auth({deviceId: "b".repeat(64)})}).reason, "device_revoked");
    assert.equal(decide({
      ...stillOpen,
      auth: auth({hasDeviceClaim: false, deviceId: null}),
      now: later,
    }).status, "done");
    assert.equal(decide({
      ...stillOpen,
      auth: auth({hasDeviceClaim: false, deviceId: null}),
      now: new Date(DEVICE_GRACE_ENDS_MS),
    }).reason, "device_revoked");
    const open = activeDeviceAllowed(
      user({activeDeviceId: null}),
      auth({hasDeviceClaim: false, deviceId: null}),
      DEVICE_GRACE_ENDS_MS,
    );
    assert.equal(open, true);
  });

  it("checks the device before the flag, and rejects a bad request first", () => {
    assert.equal(decide({
      auth: auth({deviceId: "other"}),
      enabled: false,
    }).reason, "device_revoked");
    assert.equal(decide({auth: auth({uid: "other"})}).reason, "invalid");
    assert.equal(decide({request: request({hotspotId: "a/b"})}).reason, "invalid");
    assert.equal(decide({request: request({status: "done"})}).status, "ignore");
    assert.equal(decide({request: request({createdAt: undefined})}).reason, "invalid");
  });

  it("reads a device stamp from the token and the uid from authId", () => {
    assert.deepEqual(callerFromUnlockEvent({
      authId: "ada",
      auth: {uid: "ada", token: {deviceId: DEVICE}},
    }), {uid: "ada", hasDeviceClaim: true, deviceId: DEVICE});
    assert.deepEqual(callerFromUnlockEvent({authId: "ada"}), {
      uid: "ada",
      hasDeviceClaim: false,
      deviceId: null,
    });
    assert.equal(callerFromUnlockEvent({
      authId: "ada",
      auth: {token: {deviceId: ""}},
    }).hasDeviceClaim, true);
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
