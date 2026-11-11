import {GoogleAuth} from "google-auth-library";
import {quotedTab} from "../surge/sheets.js";
import {APPEND_BATCH_SIZE, HOTSPOT_TEST_PINS_TAB} from "./headers.js";

/* Write scope for values.append only. The values read keeps the readonly scope. */
export const SHEETS_APPEND_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export class AppendBatchError extends Error {
  readonly appended: number;

  constructor(appended: number) {
    super("append-failed");
    this.name = "AppendBatchError";
    this.appended = appended;
  }
}

/*
 * Append URL for the Hotspot Test Pins tab and no other.
 * RAW so a cell is stored as text, not evaluated.
 * INSERT_ROWS adds rows under the table. It does not overwrite existing ones.
 */
export function sheetAppendUrl(sheetId: string, headerRow: number): string {
  if (!Number.isInteger(headerRow) || headerRow < 1) throw new AppendBatchError(0);
  const range = `${quotedTab(HOTSPOT_TEST_PINS_TAB)}!A${headerRow}`;
  return "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(sheetId) +
    "/values/" +
    encodeURIComponent(range) +
    ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false";
}

export function isAppendOnlyUrl(url: string): boolean {
  if (!url.includes(":append")) return false;
  if (!url.includes("insertDataOption=INSERT_ROWS")) return false;
  if (!url.includes("valueInputOption=RAW")) return false;
  if (/batchUpdate|:clear|:update/i.test(url)) return false;
  const prefix = `/values/${encodeURIComponent(`${quotedTab(HOTSPOT_TEST_PINS_TAB)}!A`)}`;
  const at = url.indexOf(prefix);
  if (at < 0) return false;
  return /^[1-9]\d*:append\?/.test(url.slice(at + prefix.length));
}

export type SheetAppender = (url: string, values: (string | number)[][]) => Promise<void>;

/* Posts new rows in batches. A failed batch stops the run and leaves earlier rows as they are. */
export async function appendPinRows(
  sheetId: string,
  headerRow: number,
  rows: (string | number)[][],
  append: SheetAppender,
  batchSize = APPEND_BATCH_SIZE,
): Promise<number> {
  const url = sheetAppendUrl(sheetId, headerRow);
  if (!isAppendOnlyUrl(url)) throw new AppendBatchError(0);
  const size = batchSize >= 1 ? Math.floor(batchSize) : APPEND_BATCH_SIZE;
  let written = 0;
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    try {
      await append(url, chunk);
    } catch {
      throw new AppendBatchError(written);
    }
    written += chunk.length;
  }
  return written;
}

/* Called only when dry run is off. The runtime account needs Editor on the sheet or this 403s. */
export async function appendSheetValues(url: string, values: (string | number)[][]): Promise<void> {
  if (!isAppendOnlyUrl(url)) throw new AppendBatchError(0);
  const auth = new GoogleAuth({scopes: [SHEETS_APPEND_SCOPE]});
  const client = await auth.getClient();
  await client.request({url, method: "POST", data: {values}});
}
