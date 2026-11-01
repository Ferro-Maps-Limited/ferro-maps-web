import {GoogleAuth} from "google-auth-library";
import {SHEETS_READONLY_SCOPE} from "./syncPlan.js";

/* Quote a tab name for the Sheets A1 range. The tab is config, not a secret. */
export function quotedTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/*
 * Values for one tab, using the function's runtime service account.
 * Read-only Sheets scope. Not called from tests.
 */
export async function fetchSheetMatrix(sheetId: string, tab: string): Promise<unknown[][]> {
  const auth = new GoogleAuth({scopes: [SHEETS_READONLY_SCOPE]});
  const client = await auth.getClient();
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(sheetId) +
    "/values/" +
    encodeURIComponent(quotedTab(tab)) +
    "?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
  const response = await client.request<{values?: unknown[][]}>({url});
  return response.data.values ?? [];
}
