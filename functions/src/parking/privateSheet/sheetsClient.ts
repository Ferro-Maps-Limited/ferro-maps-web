import {GoogleAuth} from "google-auth-library";
import {SHEETS_READONLY_SCOPE} from "./syncPlan.js";

/* One page stays under the Sheets values response cap on a 66-column tab. */
export const SHEET_PAGE_ROWS = 1000;
/* Grid rowCount includes empty rows at the bottom. Above this is not the London tab. */
export const MAX_SHEET_ROWS = 60_000;

/* Quote a tab name for the Sheets A1 range. The tab is config, not a secret. */
export function quotedTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export function sheetMetaUrl(sheetId: string): string {
  const fields = "sheets(properties(title,gridProperties(rowCount)))";
  return "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(sheetId) +
    "?fields=" + encodeURIComponent(fields);
}

export function sheetPageUrl(sheetId: string, tab: string, startRow: number, endRow: number): string {
  const range = `${quotedTab(tab)}!${startRow}:${endRow}`;
  return "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(sheetId) +
    "/values/" +
    encodeURIComponent(range) +
    "?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
}

export interface SheetProperties {
  title?: string;
  gridProperties?: {rowCount?: number};
}

export interface SheetPayload {
  values?: unknown[][];
  sheets?: Array<{properties?: SheetProperties}>;
}

export type SheetGetter = (url: string) => Promise<SheetPayload>;

function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

function rowCountFor(payload: SheetPayload, tab: string): number {
  const sheets = payload.sheets ?? [];
  const match = sheets.find((sheet) => sheet.properties?.title === tab);
  const rowCount = match?.properties?.gridProperties?.rowCount;
  if (!match || typeof rowCount !== "number" || !Number.isFinite(rowCount)) {
    throw namedError("tab-not-found");
  }
  if (rowCount > MAX_SHEET_ROWS) throw namedError("sheet-too-large");
  return rowCount;
}

/*
 * Read one tab in row pages.
 * A short page is padded to the range that was asked for. The API omits
 * empty rows at the end of a range, and a page that ends on those rows
 * would otherwise look like the end of a 12,500-row tab.
 */
export async function matrixFromPages(
  sheetId: string,
  tab: string,
  get: SheetGetter,
): Promise<unknown[][]> {
  const rowCount = rowCountFor(await get(sheetMetaUrl(sheetId)), tab);
  const matrix: unknown[][] = [];
  let start = 1;
  while (start <= rowCount) {
    const end = Math.min(start + SHEET_PAGE_ROWS - 1, rowCount);
    const page = (await get(sheetPageUrl(sheetId, tab, start, end))).values ?? [];
    if (page.length === 0) break;
    const expected = end - start + 1;
    for (let index = 0; index < expected; index += 1) matrix.push(page[index] ?? []);
    start = end + 1;
  }
  return matrix;
}

async function defaultGet(url: string): Promise<SheetPayload> {
  const auth = new GoogleAuth({scopes: [SHEETS_READONLY_SCOPE]});
  const client = await auth.getClient();
  const response = await client.request<SheetPayload>({url, method: "GET"});
  return response.data ?? {};
}

/*
 * Values for one tab, using the function's runtime service account.
 * Read-only Sheets scope. Tests pass `get` and do not call this default.
 */
export async function fetchSheetMatrix(
  sheetId: string,
  tab: string,
  get: SheetGetter = defaultGet,
): Promise<unknown[][]> {
  return matrixFromPages(sheetId, tab, get);
}
