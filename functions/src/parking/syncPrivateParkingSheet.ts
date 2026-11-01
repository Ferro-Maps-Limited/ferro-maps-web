import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {FieldValue, getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {loadInAppPlaceIds, type InAppPlaceQuery} from "./privateSheet/payMode.js";
import {planParkingPlaceIndex, type ExistingPlaceIndex, type PlaceIndexWrite} from "./privateSheet/placeIndex.js";
import {fetchSheetMatrix} from "./privateSheet/sheetsClient.js";
import {
  syncPrivateParkingOnce,
  type ExistingCellDoc,
  type PlannedCellWrite,
  type SyncConfigPatch,
} from "./privateSheet/syncPlan.js";

/*
 * Hourly private-parking publisher.
 *
 * serviceAccount is PRIVATE_PARKING_SYNC_SERVICE_ACCOUNT. The default is
 * private-parking-sync@ferro-maps-staging-v2.iam.gserviceaccount.com.
 * Another Firebase project overrides that param. This is not the Compute
 * Engine default account.
 *
 * Sheet id and tab are PRIVATE_PARKING_SHEET_ID and PRIVATE_PARKING_SHEET_TAB.
 * The job returns without writing cells unless config/privateParking.enabled
 * is exactly true. That switch does not show or hide the layer in the apps.
 */
export const privateParkingSheetId = defineString("PRIVATE_PARKING_SHEET_ID");
export const privateParkingSheetTab = defineString("PRIVATE_PARKING_SHEET_TAB");
export const privateParkingSyncServiceAccount = defineString("PRIVATE_PARKING_SYNC_SERVICE_ACCOUNT", {
  default: "private-parking-sync@ferro-maps-staging-v2.iam.gserviceaccount.com",
});

const CONFIG_PATH = "config/privateParking";

async function loadExisting(db: Firestore): Promise<ExistingCellDoc[]> {
  const snap = await db.collection("privateParkingCells").select("contentHash", "expiresAt", "cell").get();
  return snap.docs.map((doc) => {
    const expiresAt = doc.get("expiresAt");
    const contentHash = doc.get("contentHash");
    const cell = doc.get("cell");
    return {
      id: doc.id,
      cell: typeof cell === "string" ? cell : undefined,
      contentHash: typeof contentHash === "string" ? contentHash : undefined,
      expiresAtMs: expiresAt instanceof Timestamp ? expiresAt.toMillis() : undefined,
    };
  });
}

function timestamped(write: PlannedCellWrite): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ...write.data,
    generatedAt: Timestamp.fromDate(new Date(write.data.generatedAt)),
    expiresAt: Timestamp.fromDate(new Date(write.data.expiresAt)),
    places: write.data.places.map((place) => {
      const copy: Record<string, unknown> = {...place};
      if (typeof place.capturedAt === "string") {
        copy.capturedAt = Timestamp.fromDate(new Date(place.capturedAt));
      }
      if (typeof place.verifiedAt === "string") {
        copy.verifiedAt = Timestamp.fromDate(new Date(place.verifiedAt));
      }
      return copy;
    }),
  };
  return data;
}

async function writeRunState(db: Firestore, patch: SyncConfigPatch): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.lastGoodRowCount != null) data.lastGoodRowCount = patch.lastGoodRowCount;
  if (patch.lastGoodRunAt != null) data.lastGoodRunAt = Timestamp.fromDate(new Date(patch.lastGoodRunAt));
  if (patch.lastAbortReason === null) data.lastAbortReason = FieldValue.delete();
  else if (typeof patch.lastAbortReason === "string") data.lastAbortReason = patch.lastAbortReason;
  await db.doc(CONFIG_PATH).set(data, {merge: true});
}

async function loadPlaceIndex(db: Firestore): Promise<ExistingPlaceIndex[]> {
  const snap = await db.collection("parkingPlaceIndex").select("cellId").get();
  return snap.docs.map((doc) => {
    const cellId = doc.get("cellId");
    return {placeId: doc.id, cellId: typeof cellId === "string" ? cellId : undefined};
  });
}

export async function commitPlaceIndex(db: Firestore, writes: PlaceIndexWrite[], now: Date): Promise<void> {
  if (writes.length === 0) return;
  const updatedAt = Timestamp.fromDate(now);
  let batch = db.batch();
  let pending = 0;
  for (const write of writes) {
    const ref = db.collection("parkingPlaceIndex").doc(write.placeId);
    if (write.action === "delete") batch.delete(ref);
    else batch.set(ref, {cellId: write.cellId, updatedAt});
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
}

async function commitWrites(db: Firestore, writes: PlannedCellWrite[]): Promise<void> {
  let batch = db.batch();
  let pending = 0;
  for (const write of writes) {
    batch.set(db.collection("privateParkingCells").doc(write.id), timestamped(write));
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
}

export const syncPrivateParkingSheet = onSchedule(
  {
    schedule: "0 * * * *",
    timeZone: "Europe/London",
    region: "europe-west2",
    serviceAccount: privateParkingSyncServiceAccount,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const db = getFirestore();
    const config = await db.doc(CONFIG_PATH).get();
    const enabled = config.get("enabled") === true;
    if (!enabled) {
      logger.info("syncPrivateParkingSheet skipped", {reason: "disabled"});
      return;
    }
    let sheetId = "";
    let tab = "";
    try {
      sheetId = privateParkingSheetId.value().trim();
      tab = privateParkingSheetTab.value().trim();
    } catch (err) {
      logger.error("syncPrivateParkingSheet params missing", {
        name: err instanceof Error ? err.name : "unknown",
      });
      return;
    }
    const storedCount = config.get("lastGoodRowCount");
    const lastGoodRowCount = typeof storedCount === "number" && Number.isFinite(storedCount) ? storedCount : null;
    const now = new Date();
    const result = await syncPrivateParkingOnce({
      now,
      enabled,
      sheetId,
      tab,
      lastGoodRowCount,
      existing: await loadExisting(db),
      loadSheet: fetchSheetMatrix,
      loadInAppPlaceIds: () => loadInAppPlaceIds(db as unknown as InAppPlaceQuery),
    });
    if (result.status === "aborted") {
      if (result.config) await writeRunState(db, result.config);
      logger.error("syncPrivateParkingSheet aborted", {
        reason: result.abortReason,
        usableRows: result.usableRows,
      });
      return;
    }
    if (result.status !== "ok") {
      logger.info("syncPrivateParkingSheet skipped", {status: result.status});
      return;
    }
    if (result.writes.length > 0) await commitWrites(db, result.writes);
    const indexWrites = planParkingPlaceIndex({
      desired: result.indexedPlaces,
      existing: await loadPlaceIndex(db),
    });
    if (indexWrites.length > 0) await commitPlaceIndex(db, indexWrites, now);
    if (result.config) await writeRunState(db, result.config);
    logger.info("syncPrivateParkingSheet finished", {
      writes: result.writes.length,
      indexWrites: indexWrites.length,
      expired: result.expired,
      unchanged: result.unchanged,
      imported: result.imported,
      usableRows: result.usableRows,
    });
  },
);
