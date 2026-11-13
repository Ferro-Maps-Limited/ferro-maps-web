import assert from "node:assert/strict";
import {createHash} from "crypto";
import {readFileSync, readdirSync, statSync} from "node:fs";
import {join} from "node:path";
import {after, before, describe, it} from "node:test";
import {type Firestore} from "firebase-admin/firestore";
import {
  DVLA_TIMEOUT_MS,
  DVLA_VES_URL,
  LIMITS,
  LOOKUPS,
  REQUESTS,
  REQUEST_FIELDS,
  THROTTLE,
  VEHICLE_FIELDS,
  VehicleLookupError,
  hashRegistration,
  normaliseRegistration,
  registrationFromRequest,
  sanitiseDvla,
  type VehicleLookup,
  type VehicleLookupCode,
} from "../src/vehicles/contract";
import {enquireVehicle} from "../src/vehicles/dvla";
import {
  doneUpdate,
  errorUpdate,
  onVehicleLookupRequest,
  runLookupVehicle,
  type LookupDeps,
} from "../src/vehicles/lookupVehicle";

const API_KEY = "unit-test-only";
const FETCHED_AT = "2026-11-11T12:00:00.000Z";
const ORIGINAL_FETCH = globalThis.fetch;

const FULL_DVLA = {
  registrationNumber: "OTHERREG",
  make: "ROVER",
  colour: " BLUE ",
  color: "RED",
  fuelType: "PETROL",
  co2Emissions: 144,
  taxStatus: "Taxed",
  taxDueDate: "2027-03-01",
  motStatus: "Valid",
  motExpiryDate: "2026-12-01",
  typeApproval: "M1",
  monthOfFirstRegistration: "2017-11",
  monthOfFirstDvlaRegistration: "1999-01",
  yearOfManufacture: 2017,
  engineCapacity: 1997,
  euroStatus: "EURO 6",
  model: "SHOULD_NOT_APPEAR",
  wheelplan: "2 AXLE RIGID BODY",
};

function expectVehicle(actual: VehicleLookup): void {
  assert.deepEqual(actual, {
    registration: "AB12CDE",
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
    fetchedAt: FETCHED_AT,
  });
  assert.deepEqual(Object.keys(actual), [...VEHICLE_FIELDS]);
}

function assertLookupCode(err: unknown, code: VehicleLookupCode): void {
  assert.ok(err instanceof VehicleLookupError);
  assert.equal(err.code, code);
  assert.equal(err.message, code);
  const dumped = JSON.stringify({name: err.name, code: err.code, message: err.message});
  for (const leak of ["AB12CDE", "OTHERREG", "SHOULD_NOT_APPEAR", "EURO 6", "engineCapacity", "1997", API_KEY]) {
    assert.equal(dumped.includes(leak), false, leak);
  }
}

interface Captured {
  url: string;
  method: string;
  body: string;
  redirect: RequestRedirect | undefined;
  apiKey: string | null;
}

function capturingFetch(
  status: number,
  body: unknown,
  captured: Captured[] = [],
  failNetwork = false,
): typeof fetch {
  return async (input, init) => {
    captured.push({
      url: String(input),
      method: init?.method ?? "",
      body: typeof init?.body === "string" ? init.body : "",
      redirect: init?.redirect,
      apiKey: new Headers(init?.headers).get("x-api-key"),
    });
    if (failNetwork) throw new Error("network failed for registrationNumber AB12CDE");
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, {status, headers: {"content-type": "application/json"}});
  };
}

describe("lookupVehicle", () => {
  before(() => {
    globalThis.fetch = (async () => {
      throw new Error("live network is not allowed");
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("uppercases and removes whitespace", () => {
    assert.equal(normaliseRegistration("ab12 cde"), "AB12CDE");
    assert.equal(normaliseRegistration("  ab12\tcde\n"), "AB12CDE");
    assert.equal(normaliseRegistration("ab12\u00a0cde"), "AB12CDE");
    assert.equal(registrationFromRequest({registration: " ab12 cde ", extra: true}), "AB12CDE");
  });

  it("accepts registrations of 2 to 8 letters and digits", () => {
    assert.equal(normaliseRegistration("ab"), "AB");
    assert.equal(normaliseRegistration("abcd1234"), "ABCD1234");
  });

  it("rejects symbols, the wrong length, and non-strings", () => {
    for (const input of ["A", "ABCDEFGHI", "AB-12CDE", "AB12 CDE!", "", "   ", 12, null, undefined]) {
      assert.throws(() => normaliseRegistration(input), (err: unknown) => {
        assert.ok(err instanceof VehicleLookupError);
        assert.equal(err.code, "invalid");
        return true;
      });
    }
  });

  it("rejects a request that is not an object with a registration", () => {
    for (const data of [null, "AB12CDE", ["AB12CDE"], {plate: "AB12CDE"}, {}]) {
      assert.throws(() => registrationFromRequest(data), (err: unknown) => {
        assert.ok(err instanceof VehicleLookupError);
        assert.equal(err.code, "invalid");
        return true;
      });
    }
  });

  it("hashes the normalised registration", () => {
    const hash = hashRegistration(normaliseRegistration("ab12 cde"));
    assert.equal(hash, hashRegistration("AB12CDE"));
    assert.equal(hash, createHash("sha256").update("AB12CDE", "utf8").digest("hex"));
    assert.equal(hash.length, 64);
    assert.equal(hash.includes("AB12CDE"), false);
  });

  it("maps the DVLA fields and drops the rest", () => {
    const vehicle = sanitiseDvla("AB12CDE", FULL_DVLA, FETCHED_AT);
    expectVehicle(vehicle);
    const dumped = JSON.stringify(vehicle);
    for (const leak of ["OTHERREG", "SHOULD_NOT_APPEAR", "EURO 6", "engineCapacity", "1997", "1999-01", "RED"]) {
      assert.equal(dumped.includes(leak), false, leak);
    }
  });

  it("returns null for missing fields", () => {
    assert.deepEqual(sanitiseDvla("AB12CDE", {}, FETCHED_AT), {
      registration: "AB12CDE",
      make: null,
      colour: null,
      fuelType: null,
      co2Emissions: null,
      taxStatus: null,
      taxDueDate: null,
      motStatus: null,
      motExpiryDate: null,
      typeApproval: null,
      firstRegistered: null,
      fetchedAt: FETCHED_AT,
    });
  });

  it("does not guess firstRegistered, colour, or co2Emissions", () => {
    const guessed = sanitiseDvla("AB12CDE", {
      monthOfFirstDvlaRegistration: "1999-01",
      color: "RED",
      co2Emissions: "144",
      make: "   ",
      fuelType: 12,
    }, FETCHED_AT);
    assert.equal(guessed.firstRegistered, null);
    assert.equal(guessed.colour, null);
    assert.equal(guessed.co2Emissions, null);
    assert.equal(guessed.make, null);
    assert.equal(guessed.fuelType, null);
    assert.equal(sanitiseDvla("AB12CDE", {co2Emissions: 0}, FETCHED_AT).co2Emissions, 0);
  });

  it("writes done with the vehicle fields and error with a code", () => {
    const done = doneUpdate(sanitiseDvla("AB12CDE", FULL_DVLA, FETCHED_AT));
    assert.equal(done.status, "done");
    assert.equal("code" in done, false);
    assert.deepEqual(Object.keys(done).sort(), ["status", ...VEHICLE_FIELDS].sort());

    const codes: VehicleLookupCode[] = ["invalid", "not_found", "rate_limited", "upstream_error"];
    for (const code of codes) {
      const error = errorUpdate(code);
      assert.deepEqual(error, {status: "error", code});
      assert.equal(JSON.stringify(error).includes("AB12CDE"), false);
    }
  });

  it("maps DVLA 400 to invalid and drops the error body", async () => {
    const captured: Captured[] = [];
    const err = await enquireVehicle(
      capturingFetch(400, {errors: [{detail: "Invalid format AB12CDE", registrationNumber: "AB12CDE"}]}, captured),
      API_KEY,
      "AB12CDE",
      DVLA_TIMEOUT_MS,
    ).then(() => {
      throw new Error("expected a rejection");
    }, (caught: unknown) => caught);
    assertLookupCode(err, "invalid");
    assert.equal(captured[0]?.url, DVLA_VES_URL);
  });

  it("maps DVLA 404 to not_found and drops the error body", async () => {
    const err = await enquireVehicle(
      capturingFetch(404, {errors: [{detail: "Record for vehicle AB12CDE not found"}]}),
      API_KEY,
      "AB12CDE",
      1000,
    ).catch((caught: unknown) => caught);
    assertLookupCode(err, "not_found");
  });

  it("maps DVLA 429 to rate_limited and drops the error body", async () => {
    const err = await enquireVehicle(
      capturingFetch(429, {message: "Slow down AB12CDE", retryAfter: 1}),
      API_KEY,
      "AB12CDE",
      1000,
    ).catch((caught: unknown) => caught);
    assertLookupCode(err, "rate_limited");
  });

  it("maps DVLA 5xx and other statuses to upstream_error", async () => {
    for (const status of [401, 403, 500, 503]) {
      const err = await enquireVehicle(
        capturingFetch(status, {errors: [{detail: "boom AB12CDE"}]}),
        API_KEY,
        "AB12CDE",
        1000,
      ).catch((caught: unknown) => caught);
      assertLookupCode(err, "upstream_error");
    }
    const empty = await enquireVehicle(
      async () => new Response(null, {status: 204}),
      API_KEY,
      "AB12CDE",
      1000,
    ).catch((caught: unknown) => caught);
    assertLookupCode(empty, "upstream_error");
  });

  it("maps a network failure to upstream_error without the thrown text", async () => {
    const err = await enquireVehicle(
      capturingFetch(0, "", [], true),
      API_KEY,
      "AB12CDE",
      1000,
    ).catch((caught: unknown) => caught);
    assertLookupCode(err, "upstream_error");
    assert.equal(err instanceof VehicleLookupError && err.message.includes("network failed"), false);
  });

  it("maps a timeout to upstream_error", async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, {once: true});
    });
    const started = Date.now();
    // AbortSignal.timeout does not keep the event loop alive on its own.
    const keepAlive = setInterval(() => undefined, 10);
    const err = await enquireVehicle(fetchImpl, API_KEY, "AB12CDE", 40).catch((caught: unknown) => caught);
    clearInterval(keepAlive);
    assert.ok(err instanceof VehicleLookupError);
    assert.equal(err.code, "upstream_error");
    assert.ok(Date.now() - started < 2000);
  });

  it("rejects a DVLA 200 that is not an object", async () => {
    for (const body of ["not-json", "[]", "null"]) {
      const err = await enquireVehicle(capturingFetch(200, body), API_KEY, "AB12CDE", 1000)
        .catch((caught: unknown) => caught);
      assert.ok(err instanceof VehicleLookupError);
      assert.equal(err.code, "upstream_error");
    }
  });

  it("posts the registration in the body and never the URL", async () => {
    const captured: Captured[] = [];
    const body = await enquireVehicle(capturingFetch(200, FULL_DVLA, captured), API_KEY, "AB12CDE", 1000);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, DVLA_VES_URL);
    assert.equal(captured[0].url.includes("AB12CDE"), false);
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].redirect, "error");
    assert.equal(captured[0].apiKey, API_KEY);
    assert.equal(captured[0].body, JSON.stringify({registrationNumber: "AB12CDE"}));
    assert.equal(body.make, "ROVER");
  });

  it("does not log or store an invalid registration", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const deps: LookupDeps = {
      db: new Proxy({}, {get: () => {
        throw new Error("firestore should not be touched");
      }}) as Firestore,
      apiKey: API_KEY,
      now: () => new Date(FETCHED_AT),
      fetchImpl: (async () => {
        throw new Error("live network is not allowed");
      }) as typeof fetch,
      sleep: async () => undefined,
      timeoutMs: 40,
      log: (entry) => {
        logs.push({...entry});
      },
    };
    const sentinel = "PLATELEAK-driver@example.com";
    await assert.rejects(
      () => runLookupVehicle(deps, "user-a", {registration: sentinel}),
      (err: unknown) => {
        assert.ok(err instanceof VehicleLookupError);
        assert.equal(err.code, "invalid");
        return true;
      },
    );
    assert.equal(logs.length, 1);
    assert.deepEqual(Object.keys(logs[0]).sort(), ["outcome", "time", "uid"]);
    assert.equal(logs[0].outcome, "invalid");
    assert.equal(logs[0].uid, "user-a");
    assert.equal(JSON.stringify(logs).includes("PLATELEAK"), false);
    assert.equal(JSON.stringify(logs).includes("example.com"), false);
    assert.equal(JSON.stringify(logs).includes(API_KEY), false);
  });

  it("binds DVLA_API_KEY only to the request trigger in europe-west2", () => {
    const endpoint = onVehicleLookupRequest.__endpoint;
    assert.deepEqual(endpoint.region, ["europe-west2"]);
    assert.deepEqual(endpoint.secretEnvironmentVariables, [{key: "DVLA_API_KEY"}]);
    assert.equal(endpoint.httpsTrigger, undefined);
    assert.equal(endpoint.callableTrigger, undefined);
    assert.equal(endpoint.eventTrigger?.eventType, "google.cloud.firestore.document.v1.created");
    assert.equal(endpoint.eventTrigger?.retry, false);
    assert.equal(
      endpoint.eventTrigger?.eventFilterPathPatterns?.document,
      "vehicleLookupRequests/{requestId}",
    );
    assert.equal(JSON.stringify(endpoint.secretEnvironmentVariables).includes(API_KEY), false);

    const root = join(__dirname, "../src");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        if (readFileSync(path, "utf8").includes("DVLA_API_KEY")) hits.push(path);
      }
    };
    walk(root);
    assert.deepEqual(hits.map((path) => path.slice(root.length + 1)), ["vehicles/lookupVehicle.ts"]);
  });

  it("exports the request trigger and denies the server-only collections", () => {
    const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    assert.match(index, /export \{onVehicleLookupRequest\} from "\.\/vehicles\/lookupVehicle"/);
    assert.equal(index.includes("export {lookupVehicle}"), false);
    const rules = readFileSync(join(__dirname, "../../firestore.rules"), "utf8");
    for (const name of [LOOKUPS, LIMITS, THROTTLE]) {
      assert.match(rules, new RegExp(`match /${name}/`));
      assert.match(rules, /allow read, write: if false;/);
    }
    assert.match(rules, new RegExp(`match /${REQUESTS}/\\{requestId\\}`));
    for (const field of REQUEST_FIELDS) {
      assert.equal(rules.includes(`'${field}'`), true, field);
    }
    const source = readFileSync(join(__dirname, "../src/vehicles/lookupVehicle.ts"), "utf8");
    assert.match(source, /onDocumentCreated/);
    assert.equal(source.includes("onCall"), false);
    assert.equal(source.includes("HttpsError"), false);
    assert.match(source, /timeoutMs: DVLA_TIMEOUT_MS/);
    assert.equal(DVLA_TIMEOUT_MS, 5_000);
  });
});
