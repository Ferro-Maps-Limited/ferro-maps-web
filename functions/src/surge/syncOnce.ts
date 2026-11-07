/*
 * Scaffold handler only. Not exported from functions/src/index.ts, so a
 * deploy does not register SURGE params or a scheduler.
 *
 * No reviewed column map exists. enabled === true must not call loadTab.
 * There is no Cloud Scheduler retry here, and no Sheets error to sanitize,
 * because this handler does not fetch. A later map must keep a missing tab
 * distinct from an auth or transport failure, and must not log the provider
 * error text.
 */

export const SURGE_TABS = [
  "Events",
  "Readings",
  "TPC Disruption Log",
  "TPC Readings",
] as const;

export interface SurgeHandlerInput {
  /** Raw `config/surgeImport.enabled`. Missing, false, and "true" are off. */
  enabled: unknown;
  /** Ignored until a map is reviewed. Any value, including null, skips the loader. */
  columnMap: unknown;
  loadTab: (sheetId: string, tab: string) => Promise<unknown[][]>;
}

export interface SurgeHandlerResult {
  status: "disabled" | "column-map-missing";
  writes: [];
  loadCalls: 0;
}

export async function handleSurgeSync(input: SurgeHandlerInput): Promise<SurgeHandlerResult> {
  if (typeof input.loadTab !== "function") {
    return {status: "disabled", writes: [], loadCalls: 0};
  }
  if (input.enabled !== true) {
    return {status: "disabled", writes: [], loadCalls: 0};
  }
  if (input.columnMap == null) {
    return {status: "column-map-missing", writes: [], loadCalls: 0};
  }
  return {status: "column-map-missing", writes: [], loadCalls: 0};
}
