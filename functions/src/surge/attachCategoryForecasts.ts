import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {commitCategoryForecasts, type CategoryForecastPatch} from "./categoryCommit.js";
import {planCategoryForecasts, type HotspotPin} from "./categoryPlan.js";
import {loadRecordedSurges} from "./forecastHistoryCommit.js";
import {type RecordedSurge} from "./forecastHistory.js";
import {HOTSPOTS_COLLECTION} from "./commit.js";
import {PriceLeakError} from "./priceGuard.js";
import {loadCategoryTabs, type CategoryTabs} from "./sheets.js";
import {SURGE_SHEET_SCHEDULE, surgeEventsTab, surgeSheetId} from "./syncStadiumSurgeSheet.js";

export const surgeTpcLogTab = defineString("SURGE_TPC_LOG_TAB", {default: "TPC Disruption Log"});
export const surgeTpcReadingsTab = defineString("SURGE_TPC_READINGS_TAB", {default: "TPC Readings"});

/*
 * Separate from syncSurgeSheetEvents so it can be deployed by name later.
 * It does not create, delete, or rewrite pins. It only fills a forecast on
 * event pins and travel-disruption pins that already exist.
 */
export interface AttachSummary {
  status: "ok" | "skipped" | "error";
  reason?: "sheet-id-missing" | "read-failed" | "write-failed" | "price-leak";
  written: number;
  considered: number;
  available: number;
  noPrediction: number;
}

function empty(status: AttachSummary["status"], reason?: AttachSummary["reason"]): AttachSummary {
  return {status, reason, written: 0, considered: 0, available: 0, noPrediction: 0};
}

async function listHotspotPins(): Promise<HotspotPin[]> {
  const snap = await getFirestore().collection(HOTSPOTS_COLLECTION).get();
  return snap.docs.map((doc) => ({id: doc.id, data: doc.data() as Record<string, unknown>}));
}

export async function runCategoryForecastAttach(input: {
  now: Date;
  sheetId: string;
  eventsTab: string;
  tpcLogTab: string;
  tpcReadingsTab: string;
  load: (sheetId: string, eventsTab: string, tpcLogTab: string, tpcReadingsTab: string) => Promise<CategoryTabs>;
  listPins: () => Promise<HotspotPin[]>;
  commit: (patches: CategoryForecastPatch[]) => Promise<number>;
  recordedOutcomes?: RecordedSurge[];
}): Promise<AttachSummary> {
  const sheetId = input.sheetId.trim();
  if (!sheetId) return empty("skipped", "sheet-id-missing");
  let tabs: CategoryTabs;
  let pins: HotspotPin[];
  try {
    [tabs, pins] = await Promise.all([
      input.load(
        sheetId,
        input.eventsTab.trim() || "Events",
        input.tpcLogTab.trim() || "TPC Disruption Log",
        input.tpcReadingsTab.trim() || "TPC Readings",
      ),
      input.listPins(),
    ]);
  } catch (err) {
    if (err instanceof PriceLeakError) return empty("error", "price-leak");
    return empty("error", "read-failed");
  }
  let plan;
  try {
    plan = planCategoryForecasts({
      now: input.now,
      events: tabs.events,
      tpcLog: tabs.tpcLog,
      tpcReadings: tabs.tpcReadings,
      pins,
      recordedOutcomes: input.recordedOutcomes,
    });
  } catch (err) {
    if (err instanceof PriceLeakError) return empty("error", "price-leak");
    return empty("error", "read-failed");
  }
  try {
    const written = await input.commit(plan.patches);
    return {
      status: "ok",
      written,
      considered: plan.patches.length,
      available: plan.patches.filter((patch) => patch.forecast.state === "available").length,
      noPrediction: plan.patches.filter((patch) => patch.forecast.state === "no_prediction").length,
    };
  } catch (err) {
    if (err instanceof PriceLeakError) return empty("error", "price-leak");
    return empty("error", "write-failed");
  }
}

export const attachCategoryForecasts = onSchedule(SURGE_SHEET_SCHEDULE, async () => {
  let recordedOutcomes: RecordedSurge[] = [];
  if (surgeSheetId.value().trim()) {
    try {
      recordedOutcomes = await loadRecordedSurges(getFirestore());
    } catch {
      logger.error("attachCategoryForecasts could not read recorded outcomes");
    }
  }
  const summary = await runCategoryForecastAttach({
    now: new Date(),
    sheetId: surgeSheetId.value(),
    eventsTab: surgeEventsTab.value(),
    tpcLogTab: surgeTpcLogTab.value(),
    tpcReadingsTab: surgeTpcReadingsTab.value(),
    load: loadCategoryTabs,
    listPins: listHotspotPins,
    commit: async (patches) => commitCategoryForecasts(getFirestore(), patches),
    recordedOutcomes,
  });
  if (summary.status === "ok") {
    logger.info("attachCategoryForecasts finished", {
      written: summary.written,
      considered: summary.considered,
      available: summary.available,
      noPrediction: summary.noPrediction,
    });
    return;
  }
  const log = summary.status === "error" ? logger.error : logger.info;
  log("attachCategoryForecasts skipped", {reason: summary.reason ?? summary.status});
});
