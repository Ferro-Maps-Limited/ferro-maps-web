import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {GoogleAuth} from "google-auth-library";
import {HOTSPOTS_COLLECTION} from "../surge/commit.js";
import {SHEETS_READONLY_SCOPE, loadSheetTab} from "../surge/sheets.js";
import {surgeSheetId} from "../surge/syncStadiumSurgeSheet.js";
import {appendPinRows, appendSheetValues, AppendBatchError, type SheetAppender} from "./append.js";
import {HOTSPOT_TEST_PINS_TAB, PIN_READ_FIELDS} from "./headers.js";
import {
  confirmedHotspotTab,
  rowsForNewPins,
  readHotspotPinTable,
  sheetTabPropertiesUrl,
  tabPropertiesFromBody,
  type PinDoc,
  type SheetTabProperty,
} from "./plan.js";

/*
 * 00:35, 08:35 and 16:35 UK, just after the ferro-transfer-nightly copy at :20.
 *
 * serviceAccount is HOTSPOT_TEST_PINS_SYNC_SERVICE_ACCOUNT. The default is
 * hotspot-test-pins-sync@ferro-maps-staging-v2.iam.gserviceaccount.com.
 * Another Firebase project overrides that param. This is not the Compute
 * Engine default account. That account stays view-only on the sheet.
 *
 * The account has to exist before this function is deployed. Deploy fails
 * if it does not. HOTSPOT_TEST_PINS_DRY_RUN defaults to true, so a deploy
 * still writes nothing. No secret is declared. Firestore is read
 * (hotspots_test only) and never written.
 */
export const HOTSPOT_TEST_PINS_SCHEDULE = {
  schedule: "35 0,8,16 * * *",
  timeZone: "Europe/London",
  region: "europe-west2",
  timeoutSeconds: 540,
  memory: "512MiB",
} as const;

export const hotspotTestPinsSyncServiceAccount = defineString("HOTSPOT_TEST_PINS_SYNC_SERVICE_ACCOUNT", {
  default: "hotspot-test-pins-sync@ferro-maps-staging-v2.iam.gserviceaccount.com",
});

export const hotspotTestPinsDryRun = defineString("HOTSPOT_TEST_PINS_DRY_RUN", {default: "true"});

const DRY_RUN_OFF = new Set(["false", "0", "no", "off"]);

/* Anything other than an explicit off value stays a dry run. */
export function dryRunEnabled(value: string | undefined): boolean {
  return !DRY_RUN_OFF.has((value ?? "true").trim().toLowerCase());
}

export interface HotspotPinSyncSummary {
  status: "ok" | "skipped" | "error";
  reason?: "sheet-id-missing" | "read-failed" | "tab-mismatch" | "header-mismatch" | "append-failed";
  dryRun: boolean;
  existingRows: number;
  pinsRead: number;
  appended: number;
  skippedAlreadyPresent: number;
  wouldAppend: number;
  deferredOverCap: number;
  wouldAppendIds: string[];
}

function report(
  dryRun: boolean,
  over: Partial<HotspotPinSyncSummary> = {},
): HotspotPinSyncSummary {
  return {
    status: "ok",
    dryRun,
    existingRows: 0,
    pinsRead: 0,
    appended: 0,
    skippedAlreadyPresent: 0,
    wouldAppend: 0,
    deferredOverCap: 0,
    wouldAppendIds: [],
    ...over,
  };
}

export async function loadHotspotTabProperties(sheetId: string): Promise<SheetTabProperty[]> {
  const auth = new GoogleAuth({scopes: [SHEETS_READONLY_SCOPE]});
  const client = await auth.getClient();
  const response = await client.request<unknown>({
    url: sheetTabPropertiesUrl(sheetId),
    method: "GET",
  });
  return tabPropertiesFromBody(response.data);
}

/* Read-only. select() asks only for the allowlisted fields. */
export async function listHotspotTestPins(): Promise<PinDoc[]> {
  const snap = await getFirestore().collection(HOTSPOTS_COLLECTION).select(...PIN_READ_FIELDS).get();
  return snap.docs.map((doc) => ({id: doc.id, data: doc.data()}));
}

export async function runHotspotTestPinSync(input: {
  now: Date;
  sheetId: string;
  dryRun: boolean;
  loadProperties: (sheetId: string) => Promise<SheetTabProperty[]>;
  loadMatrix: (sheetId: string) => Promise<unknown[][]>;
  listPins: () => Promise<PinDoc[]>;
  append: SheetAppender;
  batchSize?: number;
}): Promise<HotspotPinSyncSummary> {
  const dryRun = input.dryRun;
  const sheetId = input.sheetId.trim();
  if (!sheetId) return report(dryRun, {status: "skipped", reason: "sheet-id-missing"});

  let properties: SheetTabProperty[];
  try {
    properties = await input.loadProperties(sheetId);
  } catch {
    return report(dryRun, {status: "error", reason: "read-failed"});
  }
  if (!confirmedHotspotTab(properties)) {
    return report(dryRun, {status: "error", reason: "tab-mismatch"});
  }

  let matrix: unknown[][];
  try {
    matrix = await input.loadMatrix(sheetId);
  } catch {
    return report(dryRun, {status: "error", reason: "read-failed"});
  }
  const table = readHotspotPinTable(matrix);
  if (!table) return report(dryRun, {status: "error", reason: "header-mismatch"});

  let pins: PinDoc[];
  try {
    pins = await input.listPins();
  } catch {
    return report(dryRun, {status: "error", reason: "read-failed", existingRows: table.existingRows});
  }
  const built = rowsForNewPins({table, pins, now: input.now});
  const counts = {
    existingRows: table.existingRows,
    pinsRead: pins.length,
    skippedAlreadyPresent: built.skippedAlreadyPresent,
    deferredOverCap: built.deferredOverCap,
    wouldAppend: built.rows.length,
    wouldAppendIds: built.ids,
  };
  if (dryRun || built.rows.length === 0) return report(dryRun, counts);

  try {
    const appended = await appendPinRows(sheetId, table.headerRow, built.rows, input.append, input.batchSize);
    return report(dryRun, {...counts, appended, wouldAppend: appended});
  } catch (err) {
    const appended = err instanceof AppendBatchError ? err.appended : 0;
    return report(dryRun, {...counts, status: "error", reason: "append-failed", appended});
  }
}

export const syncHotspotTestPins = onSchedule(
  {
    ...HOTSPOT_TEST_PINS_SCHEDULE,
    serviceAccount: hotspotTestPinsSyncServiceAccount,
  },
  async () => {
    const summary = await runHotspotTestPinSync({
      now: new Date(),
      sheetId: surgeSheetId.value(),
      dryRun: dryRunEnabled(hotspotTestPinsDryRun.value()),
      loadProperties: loadHotspotTabProperties,
      loadMatrix: (sheetId) => loadSheetTab(sheetId, HOTSPOT_TEST_PINS_TAB),
      listPins: listHotspotTestPins,
      append: appendSheetValues,
    });
    const counts = {
      existingRows: summary.existingRows,
      pinsRead: summary.pinsRead,
      appended: summary.appended,
      skippedAlreadyPresent: summary.skippedAlreadyPresent,
      dryRun: summary.dryRun,
      wouldAppend: summary.wouldAppend,
      deferredOverCap: summary.deferredOverCap,
    };
    if (summary.status === "ok" && summary.dryRun) {
      logger.info("syncHotspotTestPins dry run", {...counts, wouldAppendIds: summary.wouldAppendIds});
      return;
    }
    if (summary.status === "ok") {
      logger.info("syncHotspotTestPins finished", counts);
      return;
    }
    const log = summary.status === "error" ? logger.error : logger.info;
    log("syncHotspotTestPins skipped", {reason: summary.reason ?? summary.status, ...counts});
  },
);
