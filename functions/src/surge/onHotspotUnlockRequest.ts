import {logger} from "firebase-functions/logger";
import {onDocumentCreatedWithAuthContext} from "firebase-functions/v2/firestore";
import {FieldValue, Timestamp, type DocumentReference, type Firestore, getFirestore} from "firebase-admin/firestore";
import {
  SURGE_LEDGER,
  SURGE_LEDGER_LOCK_ID,
  SURGE_MONTHLY_ALLOWANCE,
  allowanceOverride,
  availableSurgeCredits,
  periodGrantPlan,
  surgeGrantFields,
  surgeSpendDocId,
  surgeSpendFields,
} from "./surgeLedger";
import {londonYearMonth} from "./time";
export const SUMMARY_KEYS_COLLECTION = "plannerSummaryKeys";

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

export interface PlannerUnlockConfig {
  enabled: boolean;
  creditSpendEnabled: boolean;
  premiumMonthlyCredits: number;
  ultimateMonthlyCredits: number;
}

/*
 * Both planner switches, plus the credit spend switch.
 * Missing, false, or unreadable means off.
 *
 * config/plannerSummaries.creditSpendEnabled spends one ledger credit when
 * the driver is not unlimited. Missing, or any value other than true, is off.
 * While it is off, that driver is denied with no_credit and the ledger is
 * not written. Leave it off until Nafiu says spending may go live. It does
 * not replace config/flags.plannerSummaries or config/plannerSummaries.enabled.
 * Both of those still have to be on.
 *
 * The monthly numbers are SURGE_MONTHLY_ALLOWANCE: free 3, premium 10,
 * ultimate 30. premiumMonthlyCredits and ultimateMonthlyCredits on this
 * document are optional overrides. Missing, 0, or any other unusable value
 * keeps the constant. The ledger has no expireAt and this does not add a
 * TTL policy.
 */
export async function readPlannerUnlockConfig(db: Firestore): Promise<PlannerUnlockConfig> {
  const [flags, server] = await Promise.all([
    db.doc("config/flags").get(),
    db.doc("config/plannerSummaries").get(),
  ]);
  return {
    enabled: flagIsOn(flags.get("plannerSummaries")) && server.get("enabled") === true,
    creditSpendEnabled: server.get("creditSpendEnabled") === true,
    premiumMonthlyCredits: allowanceOverride(
      server.get("premiumMonthlyCredits"),
      SURGE_MONTHLY_ALLOWANCE.premium,
    ),
    ultimateMonthlyCredits: allowanceOverride(
      server.get("ultimateMonthlyCredits"),
      SURGE_MONTHLY_ALLOWANCE.ultimate,
    ),
  };
}

export async function plannerUnlockEnabled(db: Firestore): Promise<boolean> {
  const config = await readPlannerUnlockConfig(db);
  return config.enabled;
}

/*
 * config/deviceCheck.graceUntil is the first instant that is no longer inside
 * the grace. To cover the whole of 31 Dec 2026 in Europe/London, that value is
 * 1 Jan 2027 00:00 UK, not midnight at the start of 31 Dec. A missing document,
 * a missing field, or a value that is not a timestamp means there is no grace.
 * Forecast reads use the same config through deviceGraceActive().
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

function validDocId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("/");
}

export interface UnlockDecision {
  status: "done" | "denied" | "ignore";
  reason?: DeniedReason;
  hotspotId?: string;
  validUntil?: Timestamp;
  writeUnlock: boolean;
  spendCredit: boolean;
}

/* A key with no expireAt, or one that is not still ahead, cannot be used. */
function usableSummaryKey(
  data: Record<string, unknown> | undefined,
  nowMs: number,
): {hotspotId: string; windowEnd: Timestamp} | null {
  if (!data) return null;
  if (!validDocId(data.hotspotId)) return null;
  const expireAt = data.expireAt;
  const windowEnd = data.windowEnd;
  if (!(expireAt instanceof Timestamp) || expireAt.toMillis() <= nowMs) return null;
  if (!(windowEnd instanceof Timestamp) || windowEnd.toMillis() <= nowMs) return null;
  return {hotspotId: data.hotspotId, windowEnd};
}

function noSpend(
  status: "done" | "denied" | "ignore",
  extra: Partial<UnlockDecision> = {},
): UnlockDecision {
  return {...extra, status, writeUnlock: false, spendCredit: false};
}

export function decideUnlock(input: {
  request: Record<string, unknown>;
  auth: CallerAuth;
  user: Record<string, unknown> | undefined;
  summaryKey: Record<string, unknown> | undefined;
  unlock: Record<string, unknown> | undefined;
  enabled: boolean;
  now: Date;
  graceUntilMs: number | null;
  creditSpendEnabled?: boolean;
  availableCredits?: number;
  alreadySpentThisRequest?: boolean;
}): UnlockDecision {
  const status = input.request.status;
  if (status === "done" || status === "denied" || status === "error") {
    return noSpend("ignore");
  }
  const uid = input.request.uid;
  const summaryId = input.request.summaryId;
  const createdAt = input.request.createdAt;
  if (
    status !== "pending" ||
    typeof uid !== "string" ||
    !uid ||
    !validDocId(summaryId) ||
    !(createdAt instanceof Timestamp) ||
    input.auth.uid !== uid
  ) {
    return noSpend("denied", {reason: "invalid"});
  }
  const nowMs = input.now.getTime();
  if (!activeDeviceAllowed(input.user, presentedDeviceId(input.request), nowMs, input.graceUntilMs)) {
    return noSpend("denied", {reason: "device_revoked"});
  }
  if (!input.enabled) return noSpend("denied", {reason: "flag_off"});
  if (input.creditSpendEnabled !== true) {
    const unlimited = futureTimestamp(input.user?.surgeUnlimitedUntil, nowMs);
    if (!unlimited) return noSpend("denied", {reason: "no_credit"});
    const key = usableSummaryKey(input.summaryKey, nowMs);
    if (!key) return noSpend("denied", {reason: "not_eligible"});
    const existing = futureTimestamp(input.unlock?.validUntil, nowMs);
    if (existing) return noSpend("done", {hotspotId: key.hotspotId});
    return {
      status: "done",
      hotspotId: key.hotspotId,
      validUntil: key.windowEnd,
      writeUnlock: true,
      spendCredit: false,
    };
  }
  const key = usableSummaryKey(input.summaryKey, nowMs);
  if (!key) return noSpend("denied", {reason: "not_eligible"});
  const existing = futureTimestamp(input.unlock?.validUntil, nowMs);
  if (existing) return noSpend("done", {hotspotId: key.hotspotId});
  if (input.alreadySpentThisRequest === true) {
    return {
      status: "done",
      hotspotId: key.hotspotId,
      validUntil: key.windowEnd,
      writeUnlock: true,
      spendCredit: false,
    };
  }
  const unlimited = futureTimestamp(input.user?.surgeUnlimitedUntil, nowMs);
  if (unlimited) {
    return {
      status: "done",
      hotspotId: key.hotspotId,
      validUntil: key.windowEnd,
      writeUnlock: true,
      spendCredit: false,
    };
  }
  if ((input.availableCredits ?? 0) >= 1) {
    return {
      status: "done",
      hotspotId: key.hotspotId,
      validUntil: key.windowEnd,
      writeUnlock: true,
      spendCredit: true,
    };
  }
  return noSpend("denied", {reason: "no_credit"});
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
 * One request document. The summary id is looked up in plannerSummaryKeys.
 * A future surgeUnlimitedUntil writes users/{uid}/hotspot_unlocks/{hotspotId}
 * with validUntil set to that key's windowEnd and does not touch the ledger.
 * When creditSpendEnabled is exactly true, the London month's grant set is
 * written if it is missing, then one credit is spent in this same
 * transaction. Free is 3, a paid driver is 10, and surgePlan "ultimate"
 * is 30. A future surgeUnlimitedUntil still spends nothing. No credit left
 * is denied with no_credit and nothing new is written. The user document
 * is not changed. The phone is not given a remaining total.
 */
export async function handleHotspotUnlockRequest(
  db: Firestore,
  requestRef: DocumentReference,
  auth: CallerAuth,
  now: Date,
): Promise<void> {
  let enabled = false;
  let creditSpendEnabled = false;
  let premiumAllowance: number = SURGE_MONTHLY_ALLOWANCE.premium;
  let ultimateAllowance: number = SURGE_MONTHLY_ALLOWANCE.ultimate;
  let graceUntilMs: number | null = null;
  try {
    const [config, grace] = await Promise.all([
      readPlannerUnlockConfig(db),
      readDeviceGraceUntil(db),
    ]);
    enabled = config.enabled;
    creditSpendEnabled = config.creditSpendEnabled;
    premiumAllowance = config.premiumMonthlyCredits;
    ultimateAllowance = config.ultimateMonthlyCredits;
    graceUntilMs = grace;
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
      const summaryId = typeof request.summaryId === "string" ? request.summaryId : "";
      const uid = typeof request.uid === "string" ? request.uid : "";
      const userRef = uid ? db.collection("users").doc(uid) : null;
      const userSnap = userRef ? await tx.get(userRef) : null;
      const keySnap = validDocId(summaryId) ?
        await tx.get(db.collection(SUMMARY_KEYS_COLLECTION).doc(summaryId)) :
        null;
      const keyData = keySnap?.exists ? keySnap.data() : undefined;
      const hotspotId = typeof keyData?.hotspotId === "string" ? keyData.hotspotId : "";
      const unlockRef = userRef && validDocId(hotspotId) ? userRef.collection(UNLOCKS).doc(hotspotId) : null;
      const unlockSnap = unlockRef ? await tx.get(unlockRef) : null;
      const userData = userSnap?.exists ? userSnap.data() : undefined;
      const ledgerSnap = creditSpendEnabled && userRef ? await tx.get(userRef.collection(SURGE_LEDGER)) : null;
      if (creditSpendEnabled && userRef) {
        await tx.get(userRef.collection(SURGE_LEDGER).doc(SURGE_LEDGER_LOCK_ID));
      }
      const month = londonYearMonth(now.getTime());
      const grantPlan = creditSpendEnabled && month ? periodGrantPlan({
        user: userData,
        nowMs: now.getTime(),
        month,
        premiumMonthlyCredits: premiumAllowance,
        ultimateMonthlyCredits: ultimateAllowance,
      }) : [];
      if (userRef) {
        for (const grant of grantPlan) {
          await tx.get(userRef.collection(SURGE_LEDGER).doc(grant.id));
        }
      }
      const ledger = ledgerSnap?.docs ?? [];
      const present = new Set(ledger.map((entry) => entry.id));
      const missingGrants = grantPlan.filter((grant) => !present.has(grant.id));
      const spendDocId = surgeSpendDocId(requestRef.id);
      const decision = decideUnlock({
        request,
        auth,
        user: userData,
        summaryKey: keyData,
        unlock: unlockSnap?.exists ? unlockSnap.data() : undefined,
        enabled,
        now,
        graceUntilMs,
        creditSpendEnabled,
        availableCredits: availableSurgeCredits([
          ...ledger.map((entry) => entry.data()),
          ...missingGrants.map(() => ({kind: "grant"})),
        ]),
        alreadySpentThisRequest: ledger.some((entry) => {
          return entry.id === spendDocId && entry.get("kind") === "spend";
        }),
      });
      if (decision.status === "ignore") return;
      const writeRef = decision.hotspotId && userRef ?
        userRef.collection(UNLOCKS).doc(decision.hotspotId) :
        unlockRef;
      if (
        decision.spendCredit &&
        userRef &&
        decision.hotspotId &&
        !present.has(spendDocId)
      ) {
        for (const grant of missingGrants) {
          tx.set(userRef.collection(SURGE_LEDGER).doc(grant.id), surgeGrantFields(now, grant.source));
        }
        tx.set(userRef.collection(SURGE_LEDGER).doc(spendDocId), surgeSpendFields({
          requestId: requestRef.id,
          hotspotId: decision.hotspotId,
          summaryId,
          now,
        }));
        tx.set(userRef.collection(SURGE_LEDGER).doc(SURGE_LEDGER_LOCK_ID), {
          kind: "lock",
          updatedAt: Timestamp.fromDate(now),
        });
      }
      if (decision.writeUnlock && writeRef && decision.validUntil) {
        tx.set(writeRef, {validUntil: decision.validUntil});
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
