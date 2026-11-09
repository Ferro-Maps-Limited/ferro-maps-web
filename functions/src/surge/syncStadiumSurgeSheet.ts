import * as logger from "firebase-functions/logger";
import {defineString} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore} from "firebase-admin/firestore";
import {commitStadiumEvents} from "./commit.js";
import {planStadiumEvents, type StadiumEventRecord} from "./plan.js";
import {loadSurgeTabs, type SurgeTabs} from "./sheets.js";
import {PriceLeakError} from "./priceGuard.js";

export const surgeSheetId = defineString("SURGE_SHEET_ID", {default: ""});
export const surgeEventsTab = defineString("SURGE_EVENTS_TAB", {default: "Events"});
export const surgeReadingsTab = defineString("SURGE_READINGS_TAB", {default: "Readings"});

/*
 * Every 15 minutes, London time, europe-west2. Any Events-tab row, not only football.
 * serviceAccount is omitted on purpose: the runtime default account reads the sheet.
 * No secret is declared.
 */
export const SURGE_SHEET_SCHEDULE = {
  schedule: "*/15 * * * *",
  timeZone: "Europe/London",
  region: "europe-west2",
  timeoutSeconds: 300,
  memory: "512MiB",
} as const;

export interface SyncSummary {
  status: "ok" | "skipped" | "error";
  reason?: "sheet-id-missing" | "read-failed" | "write-failed" | "price-leak";
  written: number;
  skipped: number;
  rejected: number;
  available: number;
  noPrediction: number;
  surgeEnded: number;
  venueLookup: number;
  skippedVenueUnverified: number;
}

function empty(status: SyncSummary["status"], reason?: SyncSummary["reason"]): SyncSummary {
  return {
    status,
    reason,
    written: 0,
    skipped: 0,
    rejected: 0,
    available: 0,
    noPrediction: 0,
    surgeEnded: 0,
    venueLookup: 0,
    skippedVenueUnverified: 0,
  };
}

export async function runStadiumSurgeSync(input: {
  now: Date;
  sheetId: string;
  eventsTab: string;
  readingsTab: string;
  load: (sheetId: string, eventsTab: string, readingsTab: string) => Promise<SurgeTabs>;
  commit: (records: StadiumEventRecord[]) => Promise<number>;
}): Promise<SyncSummary> {
  const sheetId = input.sheetId.trim();
  if (!sheetId) return empty("skipped", "sheet-id-missing");
  let tabs: SurgeTabs;
  try {
    tabs = await input.load(sheetId, input.eventsTab.trim() || "Events", input.readingsTab.trim() || "Readings");
  } catch (err) {
    if (err instanceof PriceLeakError) return empty("error", "price-leak");
    return empty("error", "read-failed");
  }
  const plan = planStadiumEvents({now: input.now, events: tabs.events, readings: tabs.readings});
  try {
    const written = await input.commit(plan.records);
    return {
      status: "ok",
      written,
      skipped: plan.skipped,
      rejected: plan.rejected,
      available: plan.records.filter((record) => record.forecast.state === "available").length,
      noPrediction: plan.records.filter((record) => record.forecast.state === "no_prediction").length,
      surgeEnded: plan.records.filter((record) => record.surgeEnded).length,
      venueLookup: plan.venueLookup,
      skippedVenueUnverified: plan.skippedVenueUnverified,
    };
  } catch (err) {
    if (err instanceof PriceLeakError) return empty("error", "price-leak");
    return empty("error", "write-failed");
  }
}

export const syncSurgeSheetEvents = onSchedule(SURGE_SHEET_SCHEDULE, async () => {
  const summary = await runStadiumSurgeSync({
    now: new Date(),
    sheetId: surgeSheetId.value(),
    eventsTab: surgeEventsTab.value(),
    readingsTab: surgeReadingsTab.value(),
    load: loadSurgeTabs,
    commit: async (records) => commitStadiumEvents(getFirestore(), records),
  });
  if (summary.status === "ok") {
    logger.info("syncSurgeSheetEvents finished", {
      written: summary.written,
      skipped: summary.skipped,
      rejected: summary.rejected,
      available: summary.available,
      noPrediction: summary.noPrediction,
      surgeEnded: summary.surgeEnded,
      venueLookup: summary.venueLookup,
      skippedVenueUnverified: summary.skippedVenueUnverified,
    });
    return;
  }
  const log = summary.status === "error" ? logger.error : logger.info;
  log("syncSurgeSheetEvents skipped", {reason: summary.reason ?? summary.status});
});
