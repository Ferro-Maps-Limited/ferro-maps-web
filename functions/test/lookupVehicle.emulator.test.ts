import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import {getApps, initializeApp} from "firebase-admin/app";
import {Timestamp, type Firestore, type QueryDocumentSnapshot} from "firebase-admin/firestore";
import {
  CACHE_TTL_MS,
  DVLA_VES_URL,
  LIMITS,
  LOOKUPS,
  REQUESTS,
  THROTTLE,
  THROTTLE_DOC,
  VEHICLE_FIELDS,
  VehicleLookupError,
  hashRegistration,
  type LookupLogEntry,
  type VehicleLookup,
  type VehicleLookupCode,
} from "../src/vehicles/contract";
import {
  handleVehicleLookupRequest,
  onVehicleLookupRequest,
  runLookupVehicle,
  type LookupDeps,
} from "../src/vehicles/lookupVehicle";
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
    assert.equal(err.message, code);
    return err;
  }
  assert.fail(`expected ${code}`);
}

async function clearCollections(db: Firestore): Promise<void> {
  for (const name of [LOOKUPS, LIMITS, THROTTLE, REQUESTS]) {
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
      "upstream_error",
    );
    for (const err of [missing, down]) {
      const dumped = JSON.stringify({code: err.code, message: err.message});
      assert.equal(dumped.includes(marker), false);
      assert.equal(dumped.includes("NF404XXX"), false);
      assert.equal(dumped.includes("SV503XXX"), false);
    }
    assert.equal((await db.collection(LOOKUPS).doc("NF404XXX").get()).exists, false);
    assert.equal((await db.collection(LOOKUPS).doc("SV503XXX").get()).exists, false);
    assertLogSafe(active.logs, ["NF404XXX", "SV503XXX", marker]);
  });

  it("writes a done request document and leaves an error code on failure", async () => {
    const createdAt = Timestamp.fromDate(START);
    const ref = db.collection(REQUESTS).doc("req-ok");
    await ref.set({uid: "user-a", registration: "ab12 cde", createdAt});
    await handleVehicleLookupRequest(active.deps(), "req-ok", {
      uid: "user-a",
      registration: "ab12 cde",
      createdAt,
    });
    const stored = (await ref.get()).data() ?? {};
    assert.equal(stored.status, "done");
    assert.equal(stored.code, undefined);
    assert.equal(stored.uid, "user-a");
    assert.ok(stored.createdAt instanceof Timestamp);
    assert.equal((stored.createdAt as Timestamp).toMillis(), createdAt.toMillis());
    const vehicle = {...stored};
    delete vehicle.uid;
    delete vehicle.createdAt;
    delete vehicle.status;
    assert.deepEqual(vehicle, expected("AB12CDE", START.toISOString()));
    assert.equal(JSON.stringify(stored).includes(API_KEY), false);
    assert.equal(stored.euroStatus, undefined);
    assert.equal(stored.model, undefined);

    active.state.respond = () => Response.json({
      errors: [{detail: "upstream-body-marker NF404XXX"}],
    }, {status: 404});
    const missing = db.collection(REQUESTS).doc("req-missing");
    await missing.set({uid: "user-a", registration: "NF404XXX", createdAt});
    await handleVehicleLookupRequest(active.deps(), "req-missing", {
      uid: "user-a",
      registration: "NF404XXX",
      createdAt,
    });
    const errorDoc = (await missing.get()).data() ?? {};
    assert.deepEqual(Object.keys(errorDoc).sort(), ["code", "createdAt", "registration", "status", "uid"]);
    assert.equal(errorDoc.status, "error");
    assert.equal(errorDoc.code, "not_found");
    assert.equal(errorDoc.registration, "NF404XXX");
    assert.equal(errorDoc.make, undefined);
    assert.equal(JSON.stringify(errorDoc).includes("upstream-body-marker"), false);
    assert.equal((await db.collection(LOOKUPS).doc("NF404XXX").get()).exists, false);
  });

  it("writes invalid, rate_limited, and upstream_error without a DVLA body", async () => {
    const createdAt = Timestamp.fromDate(START);
    const invalid = db.collection(REQUESTS).doc("req-invalid");
    await invalid.set({uid: "user-a", registration: "AB-12", createdAt});
    await handleVehicleLookupRequest(active.deps(), "req-invalid", {
      uid: "user-a",
      registration: "AB-12",
      createdAt,
    });
    assert.equal((await invalid.get()).get("status"), "error");
    assert.equal((await invalid.get()).get("code"), "invalid");
    assert.equal((await invalid.get()).get("registration"), "AB-12");
    assert.equal(active.calls.length, 0);
    assert.equal((await db.collection(LOOKUPS).doc("AB-12").get()).exists, false);

    const broken = db.collection(REQUESTS).doc("req-uid");
    await broken.set({registration: "AB12CDE", createdAt});
    await handleVehicleLookupRequest(active.deps(), "req-uid", {registration: "AB12CDE", createdAt});
    assert.equal((await broken.get()).get("code"), "invalid");
    assert.equal(active.calls.length, 0);
    assert.equal(JSON.stringify(active.logs).includes("AB12CDE"), false);

    for (let n = 1; n <= 10; n += 1) {
      active.setNow(new Date(START.getTime() + (n - 1) * 1000));
      await runLookupVehicle(active.deps(), "user-a", {registration: plate(n)});
    }
    const limited = db.collection(REQUESTS).doc("req-limited");
    await limited.set({uid: "user-a", registration: plate(11), createdAt});
    await handleVehicleLookupRequest(active.deps(), "req-limited", {
      uid: "user-a",
      registration: plate(11),
      createdAt,
    });
    assert.equal((await limited.get()).get("status"), "error");
    assert.equal((await limited.get()).get("code"), "rate_limited");
    assert.equal(active.calls.length, 10);

    active.state.respond = () => Response.json({errors: [{detail: "boom marker"}]}, {status: 503});
    const down = db.collection(REQUESTS).doc("req-down");
    await down.set({uid: "user-b", registration: "SV503XXX", createdAt});
    await handleVehicleLookupRequest(active.deps(), "req-down", {
      uid: "user-b",
      registration: "SV503XXX",
      createdAt,
    });
    const downData = (await down.get()).data() ?? {};
    assert.equal(downData.status, "error");
    assert.equal(downData.code, "upstream_error");
    assert.equal(downData.make, undefined);
    assert.equal(JSON.stringify(downData).includes("boom marker"), false);
    assert.equal((await db.collection(LOOKUPS).doc("SV503XXX").get()).exists, false);
  });

  it("does not call DVLA again once the request document is done", async () => {
    const createdAt = Timestamp.fromDate(START);
    const ref = db.collection(REQUESTS).doc("req-once");
    const data = {uid: "user-a", registration: "AB12CDE", createdAt};
    await ref.set(data);
    await handleVehicleLookupRequest(active.deps(), "req-once", data);
    assert.equal(active.calls.length, 1);
    await handleVehicleLookupRequest(active.deps(), "req-once", data);
    assert.equal(active.calls.length, 1);
    assert.equal((await ref.get()).get("status"), "done");
  });

  it("runs the trigger with the bound secret and writes the request document", async () => {
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
    const requestId = "req-trigger";
    const createdAt = Timestamp.fromDate(START);
    try {
      await db.collection(REQUESTS).doc(requestId).set({
        uid: "user-trigger",
        registration: "ab12 cde",
        createdAt,
      });
      const snap = await db.collection(REQUESTS).doc(requestId).get();
      await onVehicleLookupRequest.run({
        specversion: "1.0",
        id: "evt-1",
        source: "test",
        type: "google.cloud.firestore.document.v1.created",
        time: START.toISOString(),
        location: "europe-west2",
        project: PROJECT,
        database: "(default)",
        namespace: "(default)",
        document: `${REQUESTS}/${requestId}`,
        params: {requestId},
        data: snap as QueryDocumentSnapshot,
      });
      const stored = (await db.collection(REQUESTS).doc(requestId).get()).data() ?? {};
      assert.equal(stored.status, "done");
      assert.equal(stored.registration, "AB12CDE");
      assert.equal(stored.uid, "user-trigger");
      assert.equal(stored.make, "ROVER");
      assert.equal(stored.code, undefined);
      assert.equal(Number.isNaN(Date.parse(String(stored.fetchedAt))), false);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, DVLA_VES_URL);
      assert.equal(seen[0].body, JSON.stringify({registrationNumber: "AB12CDE"}));
      assert.equal(seen[0].headerMatched, true);
      assert.equal(JSON.stringify(stored).includes(placeholder), false);
      assert.equal((await db.collection(LOOKUPS).doc("AB12CDE").get()).exists, true);
    } finally {
      if (previous === undefined) delete process.env.DVLA_API_KEY;
      else process.env.DVLA_API_KEY = previous;
      globalThis.fetch = (async () => {
        throw new Error("live network is not allowed");
      }) as typeof fetch;
    }
  });
});
