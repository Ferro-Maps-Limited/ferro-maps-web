import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {fetchSheetMatrix} from "../parking/privateSheet/sheetsClient.js";
import {syncSurgeOnce} from "./syncOnce.js";

/*
 * Hourly reader for the SURGE sheet. Not deployed by the change that adds it.
 *
 * Writes nothing unless config/surgeImport.enabled is exactly true.
 * Even then, syncSurgeOnce stops before any surge* document: the column map
 * is not in the contract yet. publishSurgeForecast is not exported.
 * There is no default service account. SURGE_SHEET_ID is a param, never a
 * literal, and it is not written to the log.
 */
export const surgeSheetId = defineString("SURGE_SHEET_ID");
export const surgeSyncServiceAccount = defineString("SURGE_SYNC_SERVICE_ACCOUNT");

const CONFIG_PATH = "config/surgeImport";

export const syncSurgeSheet = onSchedule(
  {
    schedule: "0 * * * *",
    timeZone: "Europe/London",
    region: "europe-west2",
    serviceAccount: surgeSyncServiceAccount,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const db = getFirestore();
    const config = await db.doc(CONFIG_PATH).get();
    if (config.get("enabled") !== true) {
      logger.info("syncSurgeSheet skipped", {reason: "disabled"});
      return;
    }
    let sheetId = "";
    try {
      sheetId = surgeSheetId.value().trim();
    } catch (err) {
      logger.error("syncSurgeSheet params missing", {
        name: err instanceof Error ? err.name : "unknown",
      });
      return;
    }
    const result = await syncSurgeOnce({
      enabled: true,
      sheetId,
      loadTab: fetchSheetMatrix,
    });
    if (result.status === "aborted" && result.abortReason) {
      await db.doc(CONFIG_PATH).set({lastAbortReason: result.abortReason}, {merge: true});
      logger.error("syncSurgeSheet aborted", {reason: result.abortReason, tabsChecked: result.tabsChecked});
      return;
    }
    logger.info("syncSurgeSheet skipped", {status: result.status});
  },
);
