import {logger} from "firebase-functions/logger";
import {onDocumentCreatedWithAuthContext} from "firebase-functions/v2/firestore";
import {FieldValue, Timestamp, type DocumentReference, type Firestore, getFirestore} from "firebase-admin/firestore";
import {FORECASTS_COLLECTION} from "./collections.js";

export const UNLOCK_REQUESTS = "hotspotUnlockRequests";
export const UNLOCKS = "hotspot_unlocks";
export const DEVICE_CHECK_DOC = "config/deviceCheck";

export const DENIED_REASONS = [
  "device_revoked",
  "no_credit",
  "not_eligible",
  "flag_off",
  "invalid",
] as const;

export type DeniedReason = typeof DENIED_REASONS[number];

export interface CallerAuth {
  uid: string | null;
}

/*
 * The 2nd-gen Firestore auth event exposes authId and authType only.
 * Custom claims, including deviceId, are not on the event. The phone writes
 * deviceId on the request, and the rules require it to match the token.
 */
export interface UnlockRequestEvent {
  authId?: string;
  authType?: string;
}

export function callerFromUnlockEvent(event: UnlockRequestEvent): CallerAuth {
  const uid = typeof event.authId === "string" && event.authId.length > 0 ? event.authId : null;
  return {uid};
}

function flagIsOn(value: unknown): boolean {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as {enabled?: unknown}).enabled === true;
}

/* Both switches. Missing, false, or unreadable means off. */
export async function plannerUnlockEnabled(db: Firestore): Promise<boolean> {
  const [flags, server] = await Promise.all([
    db.doc("config/flags").get(),
    db.doc("config/plannerSummaries").get(),
  ]);
  return flagIsOn(flags.get("plannerSummaries")) && server.get("enabled") === true;
}

/*
 * config/deviceCheck.graceUntil is the first instant that is no longer inside
 * the grace. To cover the whole of 31 Dec 2026 in Europe/London, that value is
 * 1 Jan 2027 00:00 UK, not midnight at the start of 31 Dec. A missing document,
 * a missing field, or a value that is not a timestamp means there is no grace.
 */
export async function readDeviceGraceUntil(db: Firestore): Promise<number | null> {
  const snap = await db.doc(DEVICE_CHECK_DOC).get();
  const value = snap.get("graceUntil");
  return value instanceof Timestamp ? value.toMillis() : null;
}

/* The device id written on the request. A missing or empty value is no stamp. */
export function presentedDeviceId(request: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(request, "deviceId")) return null;
  const deviceId = request.deviceId;
  if (typeof deviceId !== "string" || deviceId.length === 0) return null;
  return deviceId;
}

/*
 * Compare the request's deviceId with users/{uid}.activeDeviceId.
 * No activeDeviceId is allowed. A request with no deviceId is allowed only
 * while now is strictly before graceUntil. A different deviceId is refused.
 */
export function activeDeviceAllowed(
  user: Record<string, unknown> | undefined,
  presented: string | null,
  nowMs: number,
  graceUntilMs: number | null,
): boolean {
  if (!user || !Object.prototype.hasOwnProperty.call(user, "activeDeviceId") || user.activeDeviceId == null) {
    return true;
  }
  if (typeof user.activeDeviceId !== "string") return false;
  if (presented == null) return graceUntilMs != null && nowMs < graceUntilMs;
  return presented === user.activeDeviceId;
}

function futureTimestamp(value: unknown, nowMs: number): Timestamp | null {
  if (!(value instanceof Timestamp)) return null;
  return value.toMillis() > nowMs ? value : null;
}

function validHotspotId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("/");
}

export interface UnlockDecision {
  status: "done" | "denied" | "ignore";
  reason?: DeniedReason;
  validUntil?: Timestamp;
  writeUnlock: boolean;
}

export function decideUnlock(input: {
  request: Record<string, unknown>;
  auth: CallerAuth;
  user: Record<string, unknown> | undefined;
  forecast: Record<string, unknown> | undefined;
  unlock: Record<string, unknown> | undefined;
  enabled: boolean;
  now: Date;
  graceUntilMs: number | null;
}): UnlockDecision {
  const status = input.request.status;
  if (status === "done" || status === "denied" || status === "error") {
    return {status: "ignore", writeUnlock: false};
  }
  const uid = input.request.uid;
  const hotspotId = input.request.hotspotId;
  const createdAt = input.request.createdAt;
  if (
    status !== "pending" ||
    typeof uid !== "string" ||
    !uid ||
    !validHotspotId(hotspotId) ||
    !(createdAt instanceof Timestamp) ||
    input.auth.uid !== uid
  ) {
    return {status: "denied", reason: "invalid", writeUnlock: false};
  }
  const nowMs = input.now.getTime();
  if (!activeDeviceAllowed(input.user, presentedDeviceId(input.request), nowMs, input.graceUntilMs)) {
    return {status: "denied", reason: "device_revoked", writeUnlock: false};
  }
  if (!input.enabled) return {status: "denied", reason: "flag_off", writeUnlock: false};
  const unlimited = futureTimestamp(input.user?.surgeUnlimitedUntil, nowMs);
  if (!unlimited) return {status: "denied", reason: "no_credit", writeUnlock: false};
  const forecast = input.forecast?.forecast;
  const forecastRecord = forecast && typeof forecast === "object" && !Array.isArray(forecast) ?
    forecast as Record<string, unknown> :
    undefined;
  const endAt = forecastRecord?.state === "available" ? forecastRecord.endAt : undefined;
  const windowEnd = futureTimestamp(endAt, nowMs);
  if (!(windowEnd instanceof Timestamp)) {
    return {status: "denied", reason: "not_eligible", writeUnlock: false};
  }
  const existing = futureTimestamp(input.unlock?.validUntil, nowMs);
  if (existing) return {status: "done", writeUnlock: false};
  return {status: "done", validUntil: windowEnd, writeUnlock: true};
}

async function finishError(requestRef: DocumentReference, now: Date): Promise<void> {
  try {
    await requestRef.update({
      status: "error",
      completedAt: Timestamp.fromDate(now),
    });
  } catch (err) {
    logger.error("onHotspotUnlockRequest could not record the error", err);
  }
}

/*
 * One request document. Unlimited access writes users/{uid}/hotspot_unlocks/{hotspotId}
 * with validUntil set to the forecast window end. The user document is not changed.
 */
export async function handleHotspotUnlockRequest(
  db: Firestore,
  requestRef: DocumentReference,
  auth: CallerAuth,
  now: Date,
): Promise<void> {
  let enabled = false;
  let graceUntilMs: number | null = null;
  try {
    [enabled, graceUntilMs] = await Promise.all([
      plannerUnlockEnabled(db),
      readDeviceGraceUntil(db),
    ]);
  } catch (err) {
    logger.error("onHotspotUnlockRequest could not read the planner switch", err);
    await finishError(requestRef, now);
    return;
  }
  try {
    await db.runTransaction(async (tx) => {
      const requestSnap = await tx.get(requestRef);
      if (!requestSnap.exists) return;
      const request = requestSnap.data() ?? {};
      if (request.status !== "pending") return;
      const hotspotId = typeof request.hotspotId === "string" ? request.hotspotId : "";
      const uid = typeof request.uid === "string" ? request.uid : "";
      const userRef = uid ? db.collection("users").doc(uid) : null;
      const userSnap = userRef ? await tx.get(userRef) : null;
      const forecastSnap = validHotspotId(hotspotId) ?
        await tx.get(db.collection(FORECASTS_COLLECTION).doc(hotspotId)) :
        null;
      const unlockRef = userRef && validHotspotId(hotspotId) ?
        userRef.collection(UNLOCKS).doc(hotspotId) :
        null;
      const unlockSnap = unlockRef ? await tx.get(unlockRef) : null;
      const decision = decideUnlock({
        request,
        auth,
        user: userSnap?.exists ? userSnap.data() : undefined,
        forecast: forecastSnap?.exists ? forecastSnap.data() : undefined,
        unlock: unlockSnap?.exists ? unlockSnap.data() : undefined,
        enabled,
        now,
        graceUntilMs,
      });
      if (decision.status === "ignore") return;
      if (decision.writeUnlock && unlockRef && decision.validUntil) {
        tx.set(unlockRef, {validUntil: decision.validUntil});
      }
      const update: Record<string, unknown> = {
        status: decision.status,
        completedAt: Timestamp.fromDate(now),
      };
      if (decision.status === "denied" && decision.reason) update.reason = decision.reason;
      if (decision.status === "done") update.reason = FieldValue.delete();
      tx.update(requestRef, update);
    });
  } catch (err) {
    logger.error("onHotspotUnlockRequest failed", err);
    await finishError(requestRef, now);
  }
}

export const onHotspotUnlockRequest = onDocumentCreatedWithAuthContext(
  {
    document: `${UNLOCK_REQUESTS}/{id}`,
    region: "europe-west2",
    retry: false,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    await handleHotspotUnlockRequest(
      getFirestore(),
      snapshot.ref,
      callerFromUnlockEvent(event),
      new Date(),
    );
  },
);
