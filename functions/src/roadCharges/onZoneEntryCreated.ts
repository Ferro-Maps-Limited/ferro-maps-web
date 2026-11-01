import * as logger from "firebase-functions/logger";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {getFirestore, Timestamp, type DocumentData, type Firestore, type UpdateData} from "firebase-admin/firestore";
import {ROAD_CHARGES_COLLECTION} from "./config.js";
import {alreadyProcessed, planZoneEntry, type VehicleInput} from "./plan.js";

function asDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stamp(value: unknown): unknown {
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner instanceof Date) out[key] = Timestamp.fromDate(inner);
    else out[key] = inner;
  }
  return out;
}

export async function processZoneEntry(
  db: Firestore,
  input: {uid: string; entryId: string; raw: Record<string, unknown>; now: Date},
): Promise<{status: string; reason: string}> {
  const entryRef = db.doc(`users/${input.uid}/zoneEntries/${input.entryId}`);
  if (alreadyProcessed(input.raw)) return {status: "skipped", reason: "already-processed"};

  const type = asString(input.raw.type);
  const vehicleId = asString(input.raw.vehicleId);
  const createdAt = asDate(input.raw.createdAt) ?? input.now;
  const vehicleSnap = vehicleId ?
    await db.doc(`users/${input.uid}/vehicles/${vehicleId}`).get() :
    null;
  const vehicle: VehicleInput = vehicleSnap?.exists ?
    {
      exists: true,
      ulezCompliant: vehicleSnap.get("ulezCompliant") === true,
      paymentMethod: asString(vehicleSnap.get("paymentMethod")),
    } :
    {exists: false};
  const configSnap = type === "cc" || type === "ulez" ?
    await db.doc(`${ROAD_CHARGES_COLLECTION}/${type}`).get() :
    null;
  const plan = planZoneEntry({
    uid: input.uid,
    entryId: input.entryId,
    type,
    travelDate: asString(input.raw.travelDate),
    vehicleId,
    zoneVersion: asString(input.raw.zoneVersion),
    createdAt,
  }, vehicle, configSnap?.exists ? configSnap.data() : null, input.now);

  const historyRef = plan.historyId ? db.doc(`users/${input.uid}/gig_history/${plan.historyId}`) : null;
  await db.runTransaction(async (tx) => {
    const entry = await tx.get(entryRef);
    if (!entry.exists || alreadyProcessed(entry.data())) return;
    if (historyRef && plan.history) {
      const history = await tx.get(historyRef);
      if (!history.exists) tx.set(historyRef, stamp(plan.history) as DocumentData);
    }
    tx.update(entryRef, stamp(plan.patch) as UpdateData<DocumentData>);
  });
  return {status: "recorded", reason: plan.patch.reminderReason};
}

export const onZoneEntryCreated = onDocumentCreated(
  {
    document: "users/{uid}/zoneEntries/{entryId}",
    region: "europe-west2",
    maxInstances: 10,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const raw = event.data?.data();
    const uid = event.params.uid;
    const entryId = event.params.entryId;
    if (!raw || !uid || !entryId) {
      logger.warn("onZoneEntryCreated missing payload");
      return;
    }
    const result = await processZoneEntry(getFirestore(), {
      uid,
      entryId,
      raw,
      now: new Date(),
    });
    logger.info("onZoneEntryCreated", {uid, entryId, status: result.status, reason: result.reason});
  },
);
