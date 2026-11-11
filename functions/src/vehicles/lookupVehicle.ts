import {getFirestore, type Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {defineSecret} from "firebase-functions/params";
import {HttpsError, onCall, type FunctionsErrorCode} from "firebase-functions/v2/https";
import {
  DVLA_TIMEOUT_MS,
  VehicleLookupError,
  hashRegistration,
  registrationFromRequest,
  sanitiseDvla,
  type LookupLogEntry,
  type VehicleLookup,
  type VehicleLookupCode,
} from "./contract";
import {enquireVehicle} from "./dvla";
import {readFreshLookup, reserveDvlaSlot, takeUserSlot, writeLookup} from "./store";

const dvlaApiKey = defineSecret("DVLA_API_KEY");

export interface LookupDeps {
  db: Firestore;
  apiKey: string;
  now: () => Date;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  log: (entry: LookupLogEntry) => void;
}

function logEntry(entry: LookupLogEntry): LookupLogEntry {
  const out: LookupLogEntry = {uid: entry.uid, time: entry.time, outcome: entry.outcome};
  if (entry.registrationHash) out.registrationHash = entry.registrationHash;
  return out;
}

const HTTPS_CODE: Record<VehicleLookupCode, FunctionsErrorCode> = {
  invalid_registration: "invalid-argument",
  not_found: "not-found",
  rate_limited: "resource-exhausted",
  unavailable: "unavailable",
};

const HTTPS_MESSAGE: Record<VehicleLookupCode, string> = {
  invalid_registration: "That registration is not valid.",
  not_found: "No vehicle was found for that registration.",
  rate_limited: "Too many lookups. Try again shortly.",
  unavailable: "Vehicle lookup is unavailable right now. Try again shortly.",
};

export function toHttpsError(err: VehicleLookupError): HttpsError {
  return new HttpsError(HTTPS_CODE[err.code], HTTPS_MESSAGE[err.code], {code: err.code});
}

function handlerDeps(): LookupDeps {
  return {
    db: getFirestore(),
    apiKey: dvlaApiKey.value(),
    now: () => new Date(),
    fetchImpl: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
    timeoutMs: DVLA_TIMEOUT_MS,
    log: (entry) => {
      logger.info("lookupVehicle", logEntry(entry));
    },
  };
}

export async function runLookupVehicle(
  deps: LookupDeps,
  uid: string,
  data: unknown,
): Promise<VehicleLookup> {
  const time = deps.now().toISOString();
  let registrationHash: string | undefined;
  try {
    const registration = registrationFromRequest(data);
    registrationHash = hashRegistration(registration);
    const cached = await readFreshLookup(deps.db, registration, deps.now());
    if (cached) {
      deps.log(logEntry({uid, time, outcome: "cache_hit", registrationHash}));
      return cached;
    }
    if (deps.apiKey.length === 0) throw new VehicleLookupError("unavailable");
    const allowed = await takeUserSlot(deps.db, uid, deps.now());
    if (!allowed) throw new VehicleLookupError("rate_limited");
    const slot = await reserveDvlaSlot(deps.db, deps.now());
    if (!slot) throw new VehicleLookupError("rate_limited");
    if (slot.waitMs > 0) await deps.sleep(slot.waitMs);
    const body = await enquireVehicle(deps.fetchImpl, deps.apiKey, registration, deps.timeoutMs);
    const fetchedAt = deps.now().toISOString();
    const vehicle = sanitiseDvla(registration, body, fetchedAt);
    try {
      await writeLookup(deps.db, vehicle, deps.now());
    } catch {
      // The driver still gets the sanitised record. The next lookup misses.
    }
    deps.log(logEntry({uid, time, outcome: "ok", registrationHash}));
    return vehicle;
  } catch (err) {
    const outcome = err instanceof VehicleLookupError ? err.code : "unavailable";
    deps.log(logEntry({uid, time, outcome, registrationHash}));
    if (err instanceof VehicleLookupError) throw err;
    throw new VehicleLookupError("unavailable");
  }
}

export const lookupVehicle = onCall(
  {
    region: "europe-west2",
    secrets: [dvlaApiKey],
    timeoutSeconds: 20,
    memory: "256MiB",
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (typeof uid !== "string" || uid.length === 0) {
      logger.info("lookupVehicle", logEntry({
        uid: null,
        time: new Date().toISOString(),
        outcome: "unauthenticated",
      }));
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    try {
      return await runLookupVehicle(handlerDeps(), uid, request.data);
    } catch (err) {
      if (err instanceof VehicleLookupError) throw toHttpsError(err);
      throw toHttpsError(new VehicleLookupError("unavailable"));
    }
  },
);
