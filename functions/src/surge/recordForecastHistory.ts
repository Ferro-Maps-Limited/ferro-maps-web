import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {commitForecastHistory} from "./forecastHistoryCommit.js";
import {stripPinForecastFieldsEnabled} from "./stripPinForecast.js";
import {
  postEventOutcomes,
  proposeForecastHistory,
  type HistoryPin,
  type HistoryProposal,
} from "./forecastHistory.js";
import {PriceLeakError} from "./priceGuard.js";
import {loadForecastHistoryTabs, type ForecastHistoryTabs} from "./sheets.js";
import {HOTSPOTS_COLLECTION} from "./commit.js";
import {SURGE_SHEET_SCHEDULE, surgeCheckInsTab, surgeReadingsTab, surgeSheetId} from "./syncStadiumSurgeSheet.js";

/*
 * Separate from syncSurgeSheetEvents and attachCategoryForecasts so each can
 * still be deployed by name. This job only fills forecastHistory. It does not
 * create pins, and it does not call a ride-hail app. Checks are rows on the sheet.
 */
export interface HistorySummary {
  status: "ok" | "skipped" | "error";
  reason?: "sheet-id-missing" | "read-failed" | "write-failed" | "price-leak";
  written: number;
  considered: number;
  snapshotted: number;
  known: number;
  unknown: number;
}

function empty(status: HistorySummary["status"], reason?: HistorySummary["reason"]): HistorySummary {
  return {status, reason, written: 0, considered: 0, snapshotted: 0, known: 0, unknown: 0};
}

async function listHotspotPins(): Promise<HistoryPin[]> {
  const snap = await getFirestore().collection(HOTSPOTS_COLLECTION).get();
  return snap.docs.map((doc) => ({id: doc.id, data: doc.data() as Record<string, unknown>}));
}

export async function runForecastHistory(input: {
  now: Date;
  sheetId: string;
  readingsTab: string;
  checkInsTab: string;
  load: (sheetId: string, readingsTab: string, checkInsTab: string) => Promise<ForecastHistoryTabs>;
  listPins: () => Promise<HistoryPin[]>;
  commit: (proposals: HistoryProposal[]) => Promise<number>;
}): Promise<HistorySummary> {
  const sheetId = input.sheetId.trim();
  if (!sheetId) return empty("skipped", "sheet-id-missing");
  let tabs: ForecastHistoryTabs;
  let pins: HistoryPin[];
  try {
    [tabs, pins] = await Promise.all([
      input.load(
        sheetId,
        input.readingsTab.trim() || "Readings",
        input.checkInsTab.trim() || "Check-ins",
      ),
      input.listPins(),
    ]);
  } catch (err) {
    if (err instanceof PriceLeakError) return empty("error", "price-leak");
    return empty("error", "read-failed");
  }
  const outcomes = postEventOutcomes(tabs.readings, tabs.checkIns);
  const proposals: HistoryProposal[] = [];
  for (const pin of pins) {
    const proposal = proposeForecastHistory(pin, input.now.getTime(), outcomes);
    if (proposal) proposals.push(proposal);
  }
  try {
    const written = await input.commit(proposals);
    return {
      status: "ok",
      written,
      considered: proposals.length,
      snapshotted: proposals.filter((proposal) => proposal.preEvent).length,
      known: proposals.filter((proposal) => {
        return proposal.outcome?.surged === "yes" || proposal.outcome?.surged === "no";
      }).length,
      unknown: proposals.filter((proposal) => proposal.outcome?.surged === "unknown").length,
    };
  } catch (err) {
    if (err instanceof PriceLeakError) return empty("error", "price-leak");
    return empty("error", "write-failed");
  }
}

export const recordForecastHistory = onSchedule(SURGE_SHEET_SCHEDULE, async () => {
  const summary = await runForecastHistory({
    now: new Date(),
    sheetId: surgeSheetId.value(),
    readingsTab: surgeReadingsTab.value(),
    checkInsTab: surgeCheckInsTab.value(),
    load: loadForecastHistoryTabs,
    listPins: listHotspotPins,
    commit: async (proposals) => {
      const db = getFirestore();
      return commitForecastHistory(db, proposals, {
        stripPinForecastFields: await stripPinForecastFieldsEnabled(db),
      });
    },
  });
  if (summary.status === "ok") {
    logger.info("recordForecastHistory finished", {
      written: summary.written,
      considered: summary.considered,
      snapshotted: summary.snapshotted,
      known: summary.known,
      unknown: summary.unknown,
    });
    return;
  }
  const log = summary.status === "error" ? logger.error : logger.info;
  log("recordForecastHistory skipped", {reason: summary.reason ?? summary.status});
});
