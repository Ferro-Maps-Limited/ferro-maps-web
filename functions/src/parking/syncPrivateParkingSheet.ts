import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {FieldValue, getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {fetchSheetMatrix, fetchTownTabs, listFolderSpreadsheets} from "./privateSheet/sheetsClient.js";
import {
  syncPrivateParkingOnce,
  type ExistingCellDoc,
  type PlannedCellWrite,
  type SyncConfigPatch,
} from "./privateSheet/syncPlan.js";
import {townSources, type TownSnapshot, type TownSource} from "./privateSheet/towns.js";

/*
 * Hourly private-parking publisher.
 *
 * serviceAccount is PRIVATE_PARKING_SYNC_SERVICE_ACCOUNT. The default is
 * private-parking-sync@ferro-maps-staging-v2.iam.gserviceaccount.com.
 * Another Firebase project overrides that param. This is not the Compute
 * Engine default account.
 *
 * Sheet id and tab are PRIVATE_PARKING_SHEET_ID and PRIVATE_PARKING_SHEET_TAB.
 * The London workbook is 1VHtzY1001e0aRSXE6s_-IJU9YioJtjSNZ5WCOt1IO-o, tab
 * "ALL LONDON (clean)". Those defaults match functions/.env.ferro-maps-staging-v2.
 * Share that spreadsheet with the runtime account as a viewer.
 *
 * The tab is about 12,500 rows and 66 columns. fetchSheetMatrix reads it in
 * pages of 1,000 rows so one response stays within the Sheets payload cap.
 * Writes are batched at 400 ops or 8 MB, whichever comes first.
 *
 * The job returns without writing cells unless config/privateParking.enabled
 * is exactly true. That switch does not show or hide the layer in the apps.
 */
export const privateParkingSheetId = defineString("PRIVATE_PARKING_SHEET_ID", {
  default: "1VHtzY1001e0aRSXE6s_-IJU9YioJtjSNZ5WCOt1IO-o",
});
export const privateParkingSheetTab = defineString("PRIVATE_PARKING_SHEET_TAB", {
  default: "ALL LONDON (clean)",
});
export const privateParkingSyncServiceAccount = defineString("PRIVATE_PARKING_SYNC_SERVICE_ACCOUNT", {
  default: "private-parking-sync@ferro-maps-staging-v2.iam.gserviceaccount.com",
});
/*
 * Optional FM-PP cities. Empty (the default) keeps the job London-only.
 * Do not set this in a tracked env file. docs/backend-contract.md explains
 * the private deploy-time value. Real spreadsheet ids never belong in git.
 */
export const privateParkingFmppSources = defineString("PRIVATE_PARKING_FMPP_SOURCES", {
  default: "",
});
/*
 * Optional Drive folder of FM-PP town workbooks. Every spreadsheet in it is a
 * town (see privateSheet/towns.ts). When set, PRIVATE_PARKING_FMPP_SOURCES is
 * not read. Share the folder with the runtime account as a viewer, and enable
 * the Drive API in the project. Like the city list, the id stays out of git.
 */
export const privateParkingFmppFolder = defineString("PRIVATE_PARKING_FMPP_FOLDER", {
  default: "",
});

const CONFIG_PATH = "config/privateParking";
const TOWNS_COLLECTION = "privateParkingTowns";
/* Stop starting town reads after this, so writes finish inside the 540 s timeout. */
const TOWN_READ_DEADLINE_MS = 420_000;

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

async function loadTownSnapshots(db: Firestore): Promise<TownSnapshot[]> {
  const snap = await db.collection(TOWNS_COLLECTION).get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    const places = Array.isArray(data.places) ? data.places : [];
    const snapshot: Record<string, unknown> = {
      ...data,
      key: doc.id,
      town: typeof data.town === "string" ? data.town : doc.id,
      places,
      count: typeof data.count === "number" ? data.count : places.length,
    };
    return snapshot as unknown as TownSnapshot;
  });
}

async function writeTownSnapshots(db: Firestore, snapshots: TownSnapshot[]): Promise<void> {
  let batch = db.batch();
  let pending = 0;
  let bytes = 0;
  for (const snapshot of snapshots) {
    const size = Buffer.byteLength(JSON.stringify(snapshot));
    if (pending > 0 && (pending === MAX_BATCH_OPS || bytes + size > MAX_BATCH_BYTES)) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
      bytes = 0;
    }
    batch.set(db.collection(TOWNS_COLLECTION).doc(snapshot.key), snapshot);
    pending += 1;
    bytes += size;
  }
  if (pending > 0) await batch.commit();
}

function storedKeys(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function storedFmppCounts(value: unknown): Record<string, number> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) counts[key] = count;
  }
  return counts;
}

async function writeRunState(db: Firestore, patch: SyncConfigPatch): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.lastGoodRowCount != null) data.lastGoodRowCount = patch.lastGoodRowCount;
  if (patch.lastGoodRunAt != null) data.lastGoodRunAt = Timestamp.fromDate(new Date(patch.lastGoodRunAt));
  if (patch.lastAbortReason === null) data.lastAbortReason = FieldValue.delete();
  else if (typeof patch.lastAbortReason === "string") data.lastAbortReason = patch.lastAbortReason;
  if (patch.fmppLastGoodCounts != null) data.fmppLastGoodCounts = patch.fmppLastGoodCounts;
  if (patch.townsListedKeys != null) data.townsListedKeys = patch.townsListedKeys;
  if (patch.townsLastRun != null) {
    data.townsLastRun = {...patch.townsLastRun, failed: patch.townsLastRun.failed.slice(0, 50)};
  }
  await db.doc(CONFIG_PATH).set(data, {merge: true});
}

const MAX_BATCH_OPS = 400;
const MAX_BATCH_BYTES = 8_000_000;

async function commitWrites(db: Firestore, writes: PlannedCellWrite[]): Promise<void> {
  let batch = db.batch();
  let pending = 0;
  let bytes = 0;
  for (const write of writes) {
    const data = timestamped(write);
    const size = Buffer.byteLength(JSON.stringify(data));
    if (pending > 0 && (pending === MAX_BATCH_OPS || bytes + size > MAX_BATCH_BYTES)) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
      bytes = 0;
    }
    batch.set(db.collection("privateParkingCells").doc(write.id), data);
    pending += 1;
    bytes += size;
  }
  if (pending > 0) await batch.commit();
}

export const syncPrivateParkingSheet = onSchedule(
  {
    schedule: "0 * * * *",
    timeZone: "Europe/London",
    region: "europe-west2",
    serviceAccount: privateParkingSyncServiceAccount,
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const db = getFirestore();
    const config = await db.doc(CONFIG_PATH).get();
    const enabled = config.get("enabled") === true;
    if (!enabled) {
      logger.info("syncPrivateParkingSheet skipped", {reason: "disabled"});
      return;
    }
    const startedMs = Date.now();
    let sheetId = "";
    let tab = "";
    let fmppSources = "";
    let folder = "";
    try {
      sheetId = privateParkingSheetId.value().trim();
      tab = privateParkingSheetTab.value().trim();
      fmppSources = privateParkingFmppSources.value().trim();
      folder = privateParkingFmppFolder.value().trim();
    } catch (err) {
      logger.error("syncPrivateParkingSheet params missing", {
        name: err instanceof Error ? err.name : "unknown",
      });
      return;
    }
    let towns: Parameters<typeof syncPrivateParkingOnce>[0]["towns"];
    if (folder) {
      let sources: TownSource[] | null = null;
      try {
        sources = townSources(await listFolderSpreadsheets(folder));
      } catch (err) {
        logger.warn("syncPrivateParkingSheet town folder not listed", {
          name: err instanceof Error ? err.name : "unknown",
        });
      }
      towns = {
        sources,
        lastListedKeys: storedKeys(config.get("townsListedKeys")),
        snapshots: await loadTownSnapshots(db),
        loadTown: (source) => fetchTownTabs(source),
        keepReading: () => Date.now() - startedMs < TOWN_READ_DEADLINE_MS,
      };
    }
    const storedCount = config.get("lastGoodRowCount");
    const lastGoodRowCount = typeof storedCount === "number" && Number.isFinite(storedCount) ? storedCount : null;
    const result = await syncPrivateParkingOnce({
      now: new Date(),
      enabled,
      sheetId,
      tab,
      lastGoodRowCount,
      existing: await loadExisting(db),
      loadSheet: fetchSheetMatrix,
      fmppSources,
      fmppLastGoodCounts: fmppSources ? storedFmppCounts(config.get("fmppLastGoodCounts")) : null,
      towns,
    });
    if (result.townSnapshots && result.townSnapshots.length > 0) await writeTownSnapshots(db, result.townSnapshots);
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
    if (result.config) await writeRunState(db, result.config);
    logger.info("syncPrivateParkingSheet finished", {
      writes: result.writes.length,
      expired: result.expired,
      unchanged: result.unchanged,
      imported: result.imported,
      usableRows: result.usableRows,
      ...(result.config?.fmppLastGoodCounts ? {fmppLastGoodCounts: result.config.fmppLastGoodCounts} : {}),
      ...(result.config?.townsLastRun ? {towns: result.config.townsLastRun} : {}),
    });
  },
);
