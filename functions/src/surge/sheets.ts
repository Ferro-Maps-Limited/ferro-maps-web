import {GoogleAuth} from "google-auth-library";

export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export interface SurgeTabs {
  events: unknown[][];
  readings: unknown[][];
}

export interface CategoryTabs {
  events: unknown[][];
  tpcLog: unknown[][];
  tpcReadings: unknown[][];
}

export function quotedTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/* Values URL for one tab. The sheet id is a param, not a secret, and is not logged by the job. */
export function sheetValuesUrl(sheetId: string, tab: string): string {
  return "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(sheetId) +
    "/values/" +
    encodeURIComponent(quotedTab(tab)) +
    "?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
}

async function fetchTab(sheetId: string, tab: string): Promise<unknown[][]> {
  const auth = new GoogleAuth({scopes: [SHEETS_READONLY_SCOPE]});
  const client = await auth.getClient();
  const response = await client.request<{values?: unknown[][]}>({url: sheetValuesUrl(sheetId, tab)});
  return response.data.values ?? [];
}

/*
 * Reads with the function's runtime identity. No API key and no secret.
 * Cloud Functions (2nd gen) uses the project's default Compute Engine
 * service account when the function does not set serviceAccount.
 * Share the sheet with that account as a viewer.
 */
export async function loadSurgeTabs(sheetId: string, eventsTab: string, readingsTab: string): Promise<SurgeTabs> {
  const [events, readings] = await Promise.all([
    fetchTab(sheetId, eventsTab),
    fetchTab(sheetId, readingsTab),
  ]);
  return {events, readings};
}

/*
 * Events history plus the two TPC tabs. The Events readings tab is not loaded:
 * category forecasts do not use its price checks. TPC reading rows are counted
 * by id only; fare cells are never copied out.
 */
export async function loadCategoryTabs(
  sheetId: string,
  eventsTab: string,
  tpcLogTab: string,
  tpcReadingsTab: string,
): Promise<CategoryTabs> {
  const [events, tpcLog, tpcReadings] = await Promise.all([
    fetchTab(sheetId, eventsTab),
    fetchTab(sheetId, tpcLogTab),
    fetchTab(sheetId, tpcReadingsTab),
  ]);
  return {events, tpcLog, tpcReadings};
}
