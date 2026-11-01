import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {fetchSheetMatrix} from "./privateSheet/sheetsClient.js";
import {
  syncPrivateParkingOnce,
  type ExistingCellDoc,
  type PlannedCellWrite,
} from "./privateSheet/syncPlan.js";

/**
 * Hourly private-parking publisher.
 *
 * Cloud Functions (2nd gen) is what `onSchedule` deploys. This function does
 * not set `serviceAccount`, so the runtime account is the Compute Engine
 * default, not the App Engine default. On ferro-maps-staging-v2
 * (project number 112345365785) that is
 * 112345365785-compute@developer.gserviceaccount.com.
 * Share the sheet with that address as a viewer.
 *
 * Sheet id and tab are params PRIVATE_PARKING_SHEET_ID and
 * PRIVATE_PARKING_SHEET_TAB. The job returns without writing unless
 * config/privateParking.enabled is exactly true.
 */
export const privateParkingSheetId = defineString("PRIVATE_PARKING_SHEET_ID");
export const privateParkingSheetTab = defineString("PRIVATE_PARKING_SHEET_TAB");

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
    const result = await syncPrivateParkingOnce({
      now: new Date(),
      enabled,
      sheetId,
      tab,
      existing: await loadExisting(db),
      loadSheet: fetchSheetMatrix,
    });
    if (result.writes.length === 0) {
      logger.info("syncPrivateParkingSheet no writes", {
        status: result.status,
        unchanged: result.unchanged,
        imported: result.imported,
      });
      return;
    }
    await commitWrites(db, result.writes);
    logger.info("syncPrivateParkingSheet wrote", {
      writes: result.writes.length,
      expired: result.expired,
      unchanged: result.unchanged,
      imported: result.imported,
    });
  },
);
