import {onCall, HttpsError, type CallableRequest} from "firebase-functions/v2/https";
import {getFirestore, type Firestore, type Transaction} from "firebase-admin/firestore";
import {addDays, londonDayKey} from "../admin/london.js";
import {isLondonDayKey, isZoneType, parseRoadChargeConfig, ROAD_CHARGES_COLLECTION} from "./config.js";
import {historyDocId, planZoneEntry, type VehicleInput} from "./plan.js";

export type LogTripCode =
  | "unauthenticated"
  | "permission-denied"
  | "invalid-argument"
  | "not-found"
  | "failed-precondition";

export type LogTripResult =
  | {ok: true; alreadyExists: boolean}
  | {ok: false; code: LogTripCode; message: string};

export interface LogTripBody {
  type?: unknown;
  vehicleId?: unknown;
  travelDate?: unknown;
}

const VEHICLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function fail(code: LogTripCode, message: string): LogTripResult {
  return {ok: false, code, message};
}

export function travelDateInPayWindow(travelDate: string, now: Date, payByDaysAfter: number): boolean {
  if (!isLondonDayKey(travelDate)) return false;
  const today = londonDayKey(now);
  if (travelDate > today) return false;
  return travelDate >= addDays(today, -payByDaysAfter);
}

function vehicleFrom(data: Record<string, unknown> | undefined): VehicleInput {
  const payment = data?.paymentMethod;
  return {
    exists: true,
    ulezCompliant: data?.ulezCompliant === true,
    paymentMethod: payment === "autopay" || payment === "manual" ? payment : undefined,
  };
}

// Auth and Gold are required. The history row is created once and marked manual.
// A second call returns alreadyExists and does not change the row.
export async function logRoadChargeTripRun(
  db: Firestore,
  input: {uid: string | null; body: LogTripBody; now: Date},
): Promise<LogTripResult> {
  if (!input.uid) return fail("unauthenticated", "Sign in required.");
  const uid = input.uid;
  const type = input.body.type;
  const vehicleId = input.body.vehicleId;
  const travelDate = input.body.travelDate;
  if (typeof type !== "string" || !isZoneType(type)) {
    return fail("invalid-argument", "type must be cc or ulez.");
  }
  if (typeof vehicleId !== "string" || !VEHICLE_ID.test(vehicleId)) {
    return fail("invalid-argument", "vehicleId is not valid.");
  }
  if (typeof travelDate !== "string" || !isLondonDayKey(travelDate)) {
    return fail("invalid-argument", "travelDate must be a London yyyy-MM-dd.");
  }
  if (travelDate > londonDayKey(input.now)) {
    return fail("invalid-argument", "travelDate cannot be in the future.");
  }

  const user = await db.doc(`users/${uid}`).get();
  const expires = user.get("subscriptionExpiresAt");
  const expiresMs = expires && typeof expires.toMillis === "function" ? expires.toMillis() : null;
  if (expiresMs == null || expiresMs <= input.now.getTime()) {
    return fail("permission-denied", "Gold is required.");
  }

  const vehicleSnap = await db.doc(`users/${uid}/vehicles/${vehicleId}`).get();
  if (!vehicleSnap.exists) return fail("not-found", "That vehicle does not exist.");

  const configSnap = await db.doc(`${ROAD_CHARGES_COLLECTION}/${type}`).get();
  const parsed = parseRoadChargeConfig(type, configSnap.exists ? configSnap.data() : null);
  if (!parsed.ok) return fail("failed-precondition", "Road charge config is not available.");
  if (!travelDateInPayWindow(travelDate, input.now, parsed.config.payByDaysAfter)) {
    return fail("invalid-argument", "travelDate is outside the pay window.");
  }

  const stored = vehicleFrom(vehicleSnap.data());
  const plan = planZoneEntry({
    uid,
    entryId: `${type}_${travelDate}`,
    type,
    travelDate,
    activeVehicleId: vehicleId,
    zoneVersion: parsed.config.zoneVersion,
    createdAt: input.now,
  }, {
    exists: true,
    ulezCompliant: stored.ulezCompliant,
    paymentMethod: "manual",
  }, configSnap.data(), input.now, "manual");
  if (!plan.history || !plan.historyId) {
    return fail("failed-precondition", "The trip could not be recorded.");
  }

  const historyId = historyDocId(type, vehicleId, travelDate);
  const historyRef = db.doc(`users/${uid}/gig_history/${historyId}`);
  const history = plan.history;
  let alreadyExists = false;
  await db.runTransaction(async (tx: Transaction) => {
    const existing = await tx.get(historyRef);
    if (existing.exists) {
      alreadyExists = true;
      return;
    }
    tx.set(historyRef, history);
  });
  return {ok: true, alreadyExists};
}

function httpsError(result: Extract<LogTripResult, {ok: false}>): HttpsError {
  return new HttpsError(result.code, result.message);
}

export const logRoadChargeTrip = onCall(
  {region: "europe-west2", invoker: "private", timeoutSeconds: 30, memory: "256MiB"},
  async (request: CallableRequest<LogTripBody>) => {
    const result = await logRoadChargeTripRun(getFirestore(), {
      uid: request.auth?.uid ?? null,
      body: request.data ?? {},
      now: new Date(),
    });
    if (!result.ok) throw httpsError(result);
    return {ok: true, alreadyExists: result.alreadyExists};
  },
);

