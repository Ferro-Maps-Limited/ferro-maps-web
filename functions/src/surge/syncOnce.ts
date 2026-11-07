import {importSurgeWorkbook, isSyntheticColumnMap, SURGE_TABS, type SurgeWrite} from "./importSheet.js";

/*
 * Scaffold handler only. Not exported from functions/src/index.ts, so a
 * deploy does not register SURGE params or a scheduler.
 *
 * loadTab is never called. A reviewed synthetic map may parse tabs that the
 * caller already holds in memory. Any other map fails closed.
 */

export {SURGE_TABS};

export interface SurgeHandlerInput {
  /** Raw `config/surgeImport.enabled`. Missing, false, and "true" are off. */
  enabled: unknown;
  columnMap: unknown;
  loadTab: (sheetId: string, tab: string) => Promise<unknown[][]>;
  tabs?: Record<string, unknown[][]>;
  now?: Date;
  existingHashes?: ReadonlyMap<string, string>;
}

export interface SurgeHandlerResult {
  status: "disabled" | "column-map-missing" | "header-fail" | "planned" | "no-change";
  outcome: "switchOff" | "headerFail" | "written" | "noChange" | "error";
  writes: SurgeWrite[];
  loadCalls: 0;
  rejects: {tab: string; row: number; column: string; reason: string}[];
}

function closed(
  status: SurgeHandlerResult["status"],
  outcome: SurgeHandlerResult["outcome"],
): SurgeHandlerResult {
  return {status, outcome, writes: [], loadCalls: 0, rejects: []};
}

export async function handleSurgeSync(input: SurgeHandlerInput): Promise<SurgeHandlerResult> {
  if (typeof input.loadTab !== "function") return closed("disabled", "switchOff");
  if (input.enabled !== true) return closed("disabled", "switchOff");
  if (!isSyntheticColumnMap(input.columnMap) || input.tabs == null) {
    return closed("column-map-missing", "error");
  }
  const plan = importSurgeWorkbook({
    tabs: input.tabs,
    now: input.now ?? new Date(0),
    existingHashes: input.existingHashes,
  });
  if (plan.outcome === "headerFail") {
    return {status: "header-fail", outcome: "headerFail", writes: [], loadCalls: 0, rejects: plan.rejects};
  }
  if (plan.outcome === "noChange") {
    return {status: "no-change", outcome: "noChange", writes: [], loadCalls: 0, rejects: plan.rejects};
  }
  return {status: "planned", outcome: "written", writes: plan.writes, loadCalls: 0, rejects: plan.rejects};
}
