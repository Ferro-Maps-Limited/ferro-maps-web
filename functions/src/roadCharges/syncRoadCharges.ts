import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {FieldValue, GeoPoint, getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {downloadDriveFile} from "./driveClient.js";
import {
  importRoadChargesOnce,
  type ImportOnceResult,
  type RoadChargeConfigPatch,
} from "./importOnce.js";
import {type ExistingRoadDoc} from "./plan.js";

/*
 * UK road charges, dataset v1.1 (verified 3 Nov 2026).
 *
 * The source is the .xlsx in Drive, id 1FVYnb0Ho6Cr-ITk8rO-gbJdNEVSMzDSK.
 * It is not a native Google Sheet, so this uses the Drive API, not Sheets.
 * Scope is drive.readonly. serviceAccount is ROAD_CHARGES_SYNC_SERVICE_ACCOUNT.
 * The default is road-charges-sync@ferro-maps-staging-v2.iam.gserviceaccount.com.
 * That account needs Viewer on the file, plus Datastore User and Logs Writer
 * on the project. It is not the Compute Engine default account.
 *
 * Nothing is written unless config/roadCharges.enabled is exactly true.
 * The schedule is hourly at :20 Europe/London. A pending
 * roadChargesImportRequests/{id} document runs the same import immediately.
 *
 * Documents are roadCharges/{doc_id}, with charge_points and rates underneath.
 * There is no roadCharges/cc or roadCharges/ulez alias. The iOS reader should
 * use uk-lon-congestion-charge and uk-lon-ulez. This file has no zone polygon.
 */
export const roadChargesDriveFileId = defineString("ROAD_CHARGES_DRIVE_FILE_ID", {
  default: "1FVYnb0Ho6Cr-ITk8rO-gbJdNEVSMzDSK",
});

export const roadChargesSyncServiceAccount = defineString("ROAD_CHARGES_SYNC_SERVICE_ACCOUNT", {
  default: "road-charges-sync@ferro-maps-staging-v2.iam.gserviceaccount.com",
});

const CONFIG_PATH = "config/roadCharges";
const MAX_BATCH_OPS = 400;
const MAX_BATCH_BYTES = 8_000_000;

export const ROAD_CHARGES_SCHEDULE = {
  schedule: "20 * * * *",
  timeZone: "Europe/London",
  region: "europe-west2",
  timeoutSeconds: 300,
  memory: "512MiB",
} as const;

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function loadExisting(db: Firestore): Promise<ExistingRoadDoc[]> {
  const parents = await db.collection("roadCharges").select("contentHash").get();
  const existing: ExistingRoadDoc[] = [];
  for (const parent of parents.docs) {
    const hash = parent.get("contentHash");
    existing.push({path: parent.ref.path, contentHash: typeof hash === "string" ? hash : undefined});
    const [points, rates] = await Promise.all([
      parent.ref.collection("charge_points").select("contentHash").get(),
      parent.ref.collection("rates").select("contentHash").get(),
    ]);
    for (const child of [...points.docs, ...rates.docs]) {
      const childHash = child.get("contentHash");
      existing.push({
        path: child.ref.path,
        contentHash: typeof childHash === "string" ? childHash : undefined,
      });
    }
  }
  return existing;
}

function publishData(data: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {...data, importedAt: FieldValue.serverTimestamp()};
  const location = copy.location;
  if (location && typeof location === "object" && "latitude" in location && "longitude" in location) {
    const point = location as {latitude: unknown; longitude: unknown};
    if (typeof point.latitude === "number" && typeof point.longitude === "number") {
      copy.location = new GeoPoint(point.latitude, point.longitude);
    }
  }
  return copy;
}

async function commitPlan(db: Firestore, result: ImportOnceResult): Promise<void> {
  let batch = db.batch();
  let pending = 0;
  let bytes = 0;
  const flush = async () => {
    if (pending === 0) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
    bytes = 0;
  };
  const add = async (size: number, write: () => void) => {
    if (pending > 0 && (pending === MAX_BATCH_OPS || bytes + size > MAX_BATCH_BYTES)) await flush();
    write();
    pending += 1;
    bytes += size;
  };
  for (const set of result.plan.sets) {
    const data = publishData(set.data);
    const size = Buffer.byteLength(JSON.stringify(set.data));
    await add(size, () => batch.set(db.doc(set.path), data));
  }
  for (const path of result.plan.deletes) {
    await add(path.length, () => batch.delete(db.doc(path)));
  }
  await flush();
}

async function writeConfig(db: Firestore, patch: RoadChargeConfigPatch): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.lastGoodDocCount != null) data.lastGoodDocCount = patch.lastGoodDocCount;
  if (patch.lastGoodPointCount != null) data.lastGoodPointCount = patch.lastGoodPointCount;
  if (patch.lastGoodRateCount != null) data.lastGoodRateCount = patch.lastGoodRateCount;
  if (patch.lastGoodRunAt != null) data.lastGoodRunAt = Timestamp.fromDate(new Date(patch.lastGoodRunAt));
  if (patch.lastSourceSha256 != null) data.lastSourceSha256 = patch.lastSourceSha256;
  if (patch.datasetVersion != null) data.datasetVersion = patch.datasetVersion;
  if (patch.sourceFileId != null) data.sourceFileId = patch.sourceFileId;
  if (patch.lastAbortReason === null) data.lastAbortReason = FieldValue.delete();
  else if (typeof patch.lastAbortReason === "string") data.lastAbortReason = patch.lastAbortReason;
  await db.doc(CONFIG_PATH).set(data, {merge: true});
}

async function runImport(db: Firestore): Promise<ImportOnceResult> {
  const config = await db.doc(CONFIG_PATH).get();
  const enabled = config.get("enabled") === true;
  let fileId = "";
  try {
    fileId = roadChargesDriveFileId.value().trim();
  } catch (err) {
    logger.error("syncRoadCharges params missing", {name: err instanceof Error ? err.name : "unknown"});
    return {
      status: "missing-params",
      charges: 0,
      points: 0,
      rates: 0,
      plan: {sets: [], deletes: [], unchanged: 0},
      config: null,
    };
  }
  const result = await importRoadChargesOnce({
    now: new Date(),
    enabled,
    fileId,
    lastGoodDocCount: finiteCount(config.get("lastGoodDocCount")),
    lastGoodPointCount: finiteCount(config.get("lastGoodPointCount")),
    lastGoodRateCount: finiteCount(config.get("lastGoodRateCount")),
    existing: enabled && fileId ? await loadExisting(db) : [],
    loadFile: downloadDriveFile,
  });
  if (result.status === "aborted") {
    if (result.config) await writeConfig(db, result.config);
    logger.error("syncRoadCharges aborted", {reason: result.abortReason, charges: result.charges});
    return result;
  }
  if (result.status !== "ok") {
    logger.info("syncRoadCharges skipped", {status: result.status});
    return result;
  }
  await commitPlan(db, result);
  if (result.config) await writeConfig(db, result.config);
  logger.info("syncRoadCharges finished", {
    charges: result.charges,
    points: result.points,
    rates: result.rates,
    sets: result.plan.sets.length,
    deletes: result.plan.deletes.length,
    unchanged: result.plan.unchanged,
    version: result.datasetVersion ?? null,
  });
  return result;
}

export const syncRoadCharges = onSchedule(
  {
    ...ROAD_CHARGES_SCHEDULE,
    serviceAccount: roadChargesSyncServiceAccount,
  },
  async () => {
    await runImport(getFirestore());
  },
);

export const onRoadChargesImportRequest = onDocumentCreated(
  {
    document: "roadChargesImportRequests/{requestId}",
    region: "europe-west2",
    serviceAccount: roadChargesSyncServiceAccount,
    retry: false,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const status = snapshot.get("status");
    if (status !== "pending") {
      logger.info("onRoadChargesImportRequest ignored", {status: typeof status === "string" ? status : "missing"});
      return;
    }
    try {
      const result = await runImport(getFirestore());
      if (result.status === "ok") {
        await snapshot.ref.update({
          status: "done",
          charges: result.charges,
          points: result.points,
          rates: result.rates,
          sets: result.plan.sets.length,
          deletes: result.plan.deletes.length,
          unchanged: result.plan.unchanged,
          datasetVersion: result.datasetVersion ?? null,
          completedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      await snapshot.ref.update({
        status: result.status === "aborted" ? "error" : "skipped",
        error: result.abortReason ?? result.status,
        completedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      logger.error("onRoadChargesImportRequest failed", {name});
      await snapshot.ref.update({
        status: "error",
        error: name,
        completedAt: FieldValue.serverTimestamp(),
      });
    }
  },
);
