import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {type CallableRequest} from "firebase-functions/v2/https";
import {
  CACHE_TTL_MS,
  DVLA_VES_URL,
  LIMITS,
  LOOKUPS,
  THROTTLE,
  THROTTLE_DOC,
  VEHICLE_FIELDS,
  VehicleLookupError,
  hashRegistration,
  type LookupLogEntry,
  type VehicleLookup,
  type VehicleLookupCode,
} from "../src/vehicles/contract";
import {lookupVehicle, runLookupVehicle, toHttpsError, type LookupDeps} from "../src/vehicles/lookupVehicle";
import {testDb} from "./support";

const PROJECT = "demo-ferromaps-vehicle-lookup";
const API_KEY = "unit-test-only";
const START = new Date("2026-11-11T12:00:00.000Z");
const ORIGINAL_FETCH = globalThis.fetch;

function plate(n: number): string {
  return `T${String(n).padStart(2, "0")}STU`;
}

function dvlaOk(registration: string): Response {
  return Response.json({
    registrationNumber: registration,
    make: "ROVER",
    colour: "BLUE",
    fuelType: "PETROL",
    co2Emissions: 144,
    taxStatus: "Taxed",
    taxDueDate: "2027-03-01",
    motStatus: "Valid",
    motExpiryDate: "2026-12-01",
    typeApproval: "M1",
    monthOfFirstRegistration: "2017-11",
    monthOfFirstDvlaRegistration: "1999-01",
    euroStatus: "EURO 6",
    model: "SHOULD_NOT_APPEAR",
    engineCapacity: 1997,
  });
}

function expected(registration: string, fetchedAt: string): VehicleLookup {
  return {
    registration,
    make: "ROVER",
    colour: "BLUE",
    fuelType: "PETROL",
    co2Emissions: 144,
    taxStatus: "Taxed",
    taxDueDate: "2027-03-01",
    motStatus: "Valid",
    motExpiryDate: "2026-12-01",
    typeApproval: "M1",
    firstRegistered: "2017-11",
    fetchedAt,
  };
}

function harness(db: Firestore) {
  const calls: Array<{url: string; body: string}> = [];
  const sleeps: number[] = [];
  const logs: LookupLogEntry[] = [];
  let now = new Date(START.getTime());
  const state: {respond: (registration: string) => Response} = {
    respond: (registration) => dvlaOk(registration),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({url, body});
    const parsed = JSON.parse(body) as {registrationNumber?: unknown};
    const registration = typeof parsed.registrationNumber === "string" ? parsed.registrationNumber : "";
    assert.equal(url, DVLA_VES_URL);
    assert.equal(url.includes(registration), false);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("x-api-key"), API_KEY);
    return state.respond(registration);
  };
  const deps = (): LookupDeps => ({
    db,
    apiKey: API_KEY,
    now: () => new Date(now.getTime()),
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    timeoutMs: 50,
    log: (entry) => {
      logs.push(entry);
    },
  });
  return {calls, sleeps, logs, deps, state, setNow: (date: Date) => {
    now = date;
  }};
}

async function expectCode(run: Promise<unknown>, code: VehicleLookupCode): Promise<VehicleLookupError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof VehicleLookupError);
    assert.equal(err.code, code);
    const http = toHttpsError(err);
    assert.deepEqual(http.details, {code});
    return err;
  }
  assert.fail(`expected ${code}`);
}

async function clearCollections(db: Firestore): Promise<void> {
  for (const name of [LOOKUPS, LIMITS, THROTTLE]) {
    const snap = await db.collection(name).get();
    if (snap.empty) continue;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

function assertLogSafe(logs: LookupLogEntry[], plates: string[]): void {
  const allowed = new Set(["uid", "time", "outcome", "registrationHash"]);
  const dumped = JSON.stringify(logs);
  for (const entry of logs) {
    for (const key of Object.keys(entry)) assert.equal(allowed.has(key), true, key);
    if (entry.registrationHash) {
      assert.match(entry.registrationHash, /^[0-9a-f]{64}$/);
    }
  }
  for (const value of [...plates, API_KEY, "EURO 6", "SHOULD_NOT_APPEAR", "engineCapacity", "1997"]) {
    assert.equal(dumped.includes(value), false, value);
  }
}

describe("lookupVehicle on the Firestore emulator", () => {
  const db = testDb(PROJECT);
  let active: ReturnType<typeof harness>;

  before(() => {
    globalThis.fetch = (async () => {
      throw new Error("live network is not allowed");
    }) as typeof fetch;
    if (!getApps().some((app) => app.name === "[DEFAULT]")) {
      initializeApp({projectId: PROJECT});
    }
  });

  beforeEach(async () => {
    await clearCollections(db);
    active = harness(db);
  });

  after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("stores a sanitised cache record and logs only the hash", async () => {
    const result = await runLookupVehicle(active.deps(), "user-a", {registration: "ab12 cde"});
    assert.deepEqual(result, expected("AB12CDE", START.toISOString()));
    assert.deepEqual(Object.keys(result), [...VEHICLE_FIELDS]);
    assert.equal(active.calls.length, 1);
    assert.equal(active.calls[0].body, JSON.stringify({registrationNumber: "AB12CDE"}));
    assert.equal(active.calls[0].url.includes("AB12CDE"), false);

    const snap = await db.collection(LOOKUPS).doc("AB12CDE").get();
    const stored = snap.data() ?? {};
    assert.deepEqual(Object.keys(stored).sort(), [...VEHICLE_FIELDS, "expireAt"].sort());
    assert.equal(stored.euroStatus, undefined);
    assert.equal(stored.model, undefined);
    assert.equal(stored.engineCapacity, undefined);
    assert.ok(stored.expireAt instanceof Timestamp);
    assert.equal(stored.expireAt.toMillis() - Date.parse(String(stored.fetchedAt)), CACHE_TTL_MS);
    assert.equal(active.logs[0]?.outcome, "ok");
    assert.equal(active.logs[0]?.registrationHash, hashRegistration("AB12CDE"));
    assertLogSafe(active.logs, ["AB12CDE"]);
  });

  it("serves a fresh cache hit without DVLA, a user slot, or a throttle slot", async () => {
    await runLookupVehicle(active.deps(), "user-a", {registration: "AB12CDE"});
    const nextSlot = (await db.collection(THROTTLE).doc(THROTTLE_DOC).get()).get("nextSlotAt");
    active.setNow(new Date(START.getTime() + 60_000));
    active.logs.length = 0;
    const again = await runLookupVehicle(active.deps(), "user-a", {registration: " ab12 cde "});
    assert.equal(active.calls.length, 1);
    assert.equal(again.fetchedAt, START.toISOString());
    assert.equal(again.registration, "AB12CDE");
    assert.equal(active.logs[0]?.outcome, "cache_hit");
    assert.equal((await db.collection(THROTTLE).doc(THROTTLE_DOC).get()).get("nextSlotAt"), nextSlot);
    const limits = await db.collection(LIMITS).get();
    assert.equal(limits.size, 1);
    assert.equal(limits.docs[0].get("count"), 1);
    assert.equal(JSON.stringify(limits.docs[0].data()).includes("AB12CDE"), false);
    assertLogSafe(active.logs, ["AB12CDE"]);
  });

  it("keeps a record until 24 hours and refetches when it expires", async () => {
    await runLookupVehicle(active.deps(), "user-a", {registration: "AB12CDE"});
    active.setNow(new Date(START.getTime() + CACHE_TTL_MS - 1));
    const fresh = await runLookupVehicle(active.deps(), "user-a", {registration: "AB12CDE"});
    assert.equal(active.calls.length, 1);
    assert.equal(fresh.fetchedAt, START.toISOString());

    await db.collection(LOOKUPS).doc("AB12CDE").set({euroStatus: "EURO 6", model: "SHOULD_NOT_APPEAR"}, {merge: true});
    const expiredAt = new Date(START.getTime() + CACHE_TTL_MS);
    active.setNow(expiredAt);
    const renewed = await runLookupVehicle(active.deps(), "user-a", {registration: "AB12CDE"});
    assert.equal(active.calls.length, 2);
    assert.equal(renewed.fetchedAt, expiredAt.toISOString());
    const stored = (await db.collection(LOOKUPS).doc("AB12CDE").get()).data() ?? {};
    assert.equal(stored.euroStatus, undefined);
    assert.equal(stored.model, undefined);
    assert.equal(stored.firstRegistered, "2017-11");
  });

  it("allows 10 DVLA lookups per user each minute", async () => {
    for (let n = 1; n <= 10; n += 1) {
      active.setNow(new Date(START.getTime() + (n - 1) * 1000));
      const result = await runLookupVehicle(active.deps(), "user-a", {registration: plate(n)});
      assert.equal(result.registration, plate(n));
    }
    assert.equal(active.calls.length, 10);
    active.setNow(new Date(START.getTime() + 9_000));
    await expectCode(runLookupVehicle(active.deps(), "user-a", {registration: plate(11)}), "rate_limited");
    assert.equal(active.calls.length, 10);

    const other = await runLookupVehicle(active.deps(), "user-b", {registration: plate(12)});
    assert.equal(other.registration, plate(12));
    assert.equal(active.calls.length, 11);

    const cached = await runLookupVehicle(active.deps(), "user-a", {registration: plate(1)});
    assert.equal(cached.registration, plate(1));
    assert.equal(active.calls.length, 11);

    active.setNow(new Date(START.getTime() + 60_000));
    const reset = await runLookupVehicle(active.deps(), "user-a", {registration: plate(13)});
    assert.equal(reset.registration, plate(13));
    assert.equal(active.calls.length, 12);

    const limits = await db.collection(LIMITS).get();
    const counts = limits.docs
      .filter((doc) => doc.get("uid") === "user-a")
      .map((doc) => doc.get("count"))
      .sort();
    assert.deepEqual(counts, [1, 10]);
    assert.equal(JSON.stringify(limits.docs.map((doc) => doc.data())).includes("T01STU"), false);
  });

  it("spaces DVLA calls and shares that throttle across users", async () => {
    active.setNow(START);
    for (let n = 1; n <= 5; n += 1) {
      await runLookupVehicle(active.deps(), "user-a", {registration: plate(n)});
    }
    assert.deepEqual(active.sleeps, [500, 1000, 1500, 2000]);
    assert.equal((await db.collection(THROTTLE).doc(THROTTLE_DOC).get()).get("nextSlotAt"), START.getTime() + 2500);

    await expectCode(runLookupVehicle(active.deps(), "user-b", {registration: plate(6)}), "rate_limited");
    assert.equal(active.calls.length, 5);
    assert.equal((await db.collection(THROTTLE).doc(THROTTLE_DOC).get()).get("nextSlotAt"), START.getTime() + 2500);

    active.setNow(new Date(START.getTime() + 3000));
    await runLookupVehicle(active.deps(), "user-b", {registration: plate(6)});
    assert.equal(active.calls.length, 6);
    assert.equal((await db.collection(THROTTLE).doc(THROTTLE_DOC).get()).get("nextSlotAt"), START.getTime() + 3500);
    const throttle = JSON.stringify((await db.collection(THROTTLE).doc(THROTTLE_DOC).get()).data());
    assert.equal(throttle.includes("T01STU"), false);
  });

  it("does not cache a DVLA error or return its body", async () => {
    const marker = "upstream-body-marker";
    active.state.respond = (registration) => Response.json({
      errors: [{detail: `${marker} ${registration}`, registrationNumber: registration}],
    }, {status: registration === "NF404XXX" ? 404 : 503});

    const missing = await expectCode(
      runLookupVehicle(active.deps(), "user-a", {registration: "NF404XXX"}),
      "not_found",
    );
    const down = await expectCode(
      runLookupVehicle(active.deps(), "user-a", {registration: "SV503XXX"}),
      "unavailable",
    );
    for (const err of [missing, down]) {
      const dumped = JSON.stringify(toHttpsError(err).toJSON());
      assert.equal(dumped.includes(marker), false);
      assert.equal(dumped.includes("NF404XXX"), false);
      assert.equal(dumped.includes("SV503XXX"), false);
    }
    assert.equal((await db.collection(LOOKUPS).doc("NF404XXX").get()).exists, false);
    assert.equal((await db.collection(LOOKUPS).doc("SV503XXX").get()).exists, false);
    assertLogSafe(active.logs, ["NF404XXX", "SV503XXX", marker]);
  });

  it("runs the callable with the bound secret and a normalised body", async () => {
    const previous = process.env.DVLA_API_KEY;
    const placeholder = `not-a-real-key-${process.pid}`;
    process.env.DVLA_API_KEY = placeholder;
    const seen: Array<{url: string; body: string; headerMatched: boolean}> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      const header = new Headers(init?.headers).get("x-api-key");
      seen.push({url, body, headerMatched: header === placeholder && header.startsWith("not-a-real-key-")});
      return dvlaOk("AB12CDE");
    }) as typeof fetch;
    try {
      const result = await lookupVehicle.run({
        data: {registration: "ab12 cde"},
        acceptsStreaming: false,
        auth: {uid: "user-callable", rawToken: "not-a-token", token: {uid: "user-callable"}},
      } as CallableRequest<{registration: string}>);
      assert.deepEqual(result, expected("AB12CDE", result.fetchedAt));
      assert.equal(Number.isNaN(Date.parse(result.fetchedAt)), false);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, DVLA_VES_URL);
      assert.equal(seen[0].body, JSON.stringify({registrationNumber: "AB12CDE"}));
      assert.equal(seen[0].headerMatched, true);
      assert.equal((await getFirestore().collection(LOOKUPS).doc("AB12CDE").get()).exists, true);
    } finally {
      if (previous === undefined) delete process.env.DVLA_API_KEY;
      else process.env.DVLA_API_KEY = previous;
      globalThis.fetch = (async () => {
        throw new Error("live network is not allowed");
      }) as typeof fetch;
    }
  });
});
