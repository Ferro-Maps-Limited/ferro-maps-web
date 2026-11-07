import {SHEETS_READONLY_SCOPE} from "../parking/privateSheet/syncPlan.js";

/*
 * §21.2. Modelled on the private-parking sync: no network unless the job is
 * enabled and the sheet id is set, abort when a required tab or its header
 * is missing, and no store writes from this version.
 *
 * §21 does not name the sheet columns. Passing a matrix of prices into the
 * store would be guessing, so a readable sheet still stops at
 * `column-map-missing` and returns no row bodies.
 */

export const SURGE_TABS = [
  "Events",
  "Readings",
  "TPC Disruption Log",
  "TPC Readings",
] as const;

export {SHEETS_READONLY_SCOPE};

export interface SurgeSyncInput {
  enabled: boolean;
  sheetId: string;
  loadTab: (sheetId: string, tab: string) => Promise<unknown[][]>;
}

export interface SurgeSyncResult {
  status: "disabled" | "missing-params" | "aborted";
  abortReason?: "tab-missing" | "header-missing" | "column-map-missing";
  tabsChecked: number;
  writes: [];
}

function stopped(status: "disabled" | "missing-params"): SurgeSyncResult {
  return {status, tabsChecked: 0, writes: []};
}

function aborted(
  reason: NonNullable<SurgeSyncResult["abortReason"]>,
  tabsChecked: number,
): SurgeSyncResult {
  return {status: "aborted", abortReason: reason, tabsChecked, writes: []};
}

function headerPresent(matrix: unknown[][]): boolean {
  const header = matrix[0];
  if (!header || header.length === 0) return false;
  return header.some((cell) => typeof cell === "string" && cell.trim().length > 0);
}

export async function syncSurgeOnce(input: SurgeSyncInput): Promise<SurgeSyncResult> {
  if (input.enabled !== true) return stopped("disabled");
  if (input.sheetId.trim().length === 0) return stopped("missing-params");
  let tabsChecked = 0;
  for (const tab of SURGE_TABS) {
    let matrix: unknown[][];
    try {
      matrix = await input.loadTab(input.sheetId, tab);
    } catch {
      return aborted("tab-missing", tabsChecked);
    }
    tabsChecked += 1;
    if (!headerPresent(matrix)) return aborted("header-missing", tabsChecked);
  }
  return aborted("column-map-missing", tabsChecked);
}
