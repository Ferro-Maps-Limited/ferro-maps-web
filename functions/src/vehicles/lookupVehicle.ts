import {getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {defineSecret} from "firebase-functions/params";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {
  DVLA_TIMEOUT_MS,
  REQUEST_TTL_MS,
  REQUESTS,
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
const vehicleHmacSecret = defineSecret("VEHICLE_HMAC_SECRET");

export interface LookupDeps {
  db: Firestore;
  apiKey: string;
  hmacSecret: string;
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

function handlerDeps(): LookupDeps {
  return {
    db: getFirestore(),
    apiKey: dvlaApiKey.value(),
    hmacSecret: vehicleHmacSecret.value(),
    now: () => new Date(),
    fetchImpl: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
    timeoutMs: DVLA_TIMEOUT_MS,
    log: (entry) => {
      logger.info("onVehicleLookupRequest", logEntry(entry));
    },
  };
}

// A Firebase uid. A slash would make the per-user limit id an illegal document id.
function requestUid(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const uid = (data as {uid?: unknown}).uid;
  if (typeof uid !== "string" || uid.length === 0 || uid.length > 128 || uid.includes("/")) return null;
  return uid;
}

export function doneUpdate(vehicle: VehicleLookup): {status: "done"} & VehicleLookup {
  return {status: "done", ...vehicle};
}

export function errorUpdate(code: VehicleLookupCode): {status: "error"; code: VehicleLookupCode} {
  return {status: "error", code};
}

// Does not overwrite a result that is already written. A second delivery of the
// create event must not replace a done record with a later error.
async function writeTerminal(
  db: Firestore,
  requestId: string,
  fields: object,
  now: Date,
): Promise<void> {
  const ref = db.collection(REQUESTS).doc(requestId);
  const update: Record<string, unknown> = {
    ...fields,
    expireAt: Timestamp.fromMillis(now.getTime() + REQUEST_TTL_MS),
  };
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const status = snap.get("status");
    if (status === "done" || status === "error") return;
    tx.update(ref, update);
  });
}

// A second delivery must not call DVLA. Only a pending or unset status is claimed.
export async function claimVehicleLookup(
  db: Firestore,
  requestId: string,
  now: Date,
): Promise<boolean> {
  const ref = db.collection(REQUESTS).doc(requestId);
  const expireAt = Timestamp.fromMillis(now.getTime() + REQUEST_TTL_MS);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const status = snap.get("status");
    if (status != null && status !== "pending") return false;
    tx.update(ref, {status: "processing", expireAt});
    return true;
  });
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
    if (deps.hmacSecret.length === 0) throw new VehicleLookupError("vehicle_check_unavailable");
    registrationHash = hashRegistration(registration, deps.hmacSecret);
    const cached = await readFreshLookup(deps.db, registration, registrationHash, deps.now());
    if (cached) {
      deps.log(logEntry({uid, time, outcome: "cache_hit", registrationHash}));
      return cached;
    }
    if (deps.apiKey.length === 0) throw new VehicleLookupError("vehicle_check_unavailable");
    const slot = await reserveDvlaSlot(deps.db, deps.now());
    if (!slot) throw new VehicleLookupError("rate_limited");
    const allowed = await takeUserSlot(deps.db, uid, deps.now());
    if (!allowed) throw new VehicleLookupError("rate_limited");
    if (slot.waitMs > 0) await deps.sleep(slot.waitMs);
    const body = await enquireVehicle(deps.fetchImpl, deps.apiKey, registration, deps.timeoutMs);
    const fetchedAt = deps.now().toISOString();
    const vehicle = sanitiseDvla(registration, body, fetchedAt);
    try {
      await writeLookup(deps.db, vehicle, registrationHash, deps.now());
    } catch {
      // The driver still gets the sanitised record. The next lookup misses.
    }
    deps.log(logEntry({uid, time, outcome: "ok", registrationHash}));
    return vehicle;
  } catch (err) {
    const outcome = err instanceof VehicleLookupError ? err.code : "vehicle_check_unavailable";
    deps.log(logEntry({uid, time, outcome, registrationHash}));
    if (err instanceof VehicleLookupError) throw err;
    throw new VehicleLookupError("vehicle_check_unavailable");
  }
}

export async function handleVehicleLookupRequest(
  deps: LookupDeps,
  requestId: string,
  data: unknown,
): Promise<void> {
  const ref = deps.db.collection(REQUESTS).doc(requestId);
  const existing = await ref.get();
  if (!existing.exists) return;
  const status = existing.get("status");
  if (status === "done" || status === "error" || status === "processing") return;

  const uid = requestUid(data);
  if (!uid) {
    deps.log(logEntry({uid: null, time: deps.now().toISOString(), outcome: "invalid"}));
    await writeTerminal(deps.db, requestId, errorUpdate("invalid"), deps.now());
    return;
  }

  const claimed = await claimVehicleLookup(deps.db, requestId, deps.now());
  if (!claimed) return;

  try {
    const vehicle = await runLookupVehicle(deps, uid, data);
    await writeTerminal(deps.db, requestId, doneUpdate(vehicle), deps.now());
  } catch (err) {
    const code = err instanceof VehicleLookupError ? err.code : "vehicle_check_unavailable";
    try {
      await writeTerminal(deps.db, requestId, errorUpdate(code), deps.now());
    } catch {
      deps.log(logEntry({uid, time: deps.now().toISOString(), outcome: "vehicle_check_unavailable"}));
    }
  }
}

// Request-doc trigger. Callables cannot be invoked on this project: Domain
// Restricted Sharing blocks the allUsers Cloud Run invoker. The phone creates
// vehicleLookupRequests/{id} and listens; this writes status back.
// Built when this module loads, which is before setGlobalOptions in index.ts,
// so the global maxInstances cap does not apply here.
export const onVehicleLookupRequest = onDocumentCreated(
  {
    document: "vehicleLookupRequests/{requestId}",
    region: "europe-west2",
    secrets: [dvlaApiKey, vehicleHmacSecret],
    maxInstances: 3,
    timeoutSeconds: 20,
    memory: "256MiB",
    retry: false,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await handleVehicleLookupRequest(handlerDeps(), event.params.requestId, snap.data());
  },
);
