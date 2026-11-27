import {GoogleAuth} from "google-auth-library";
import {SHEETS_READONLY_SCOPE} from "./syncPlan.js";
import {type DriveFile, type TownRead, type TownSource} from "./towns.js";

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

/* Sheets allows 60 reads a minute for one account. One start every 1.1 s stays under it. */
export const SHEETS_MIN_GAP_MS = 1_100;
let nextSheetsStartMs = 0;

async function paced(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSheetsStartMs);
  nextSheetsStartMs = start + SHEETS_MIN_GAP_MS;
  if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
}

async function defaultGet(url: string): Promise<SheetPayload> {
  await paced();
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

/*
 * Both town tabs in one request, so one town is one Sheets read.
 * A missing tab makes Sheets refuse the whole request with 400.
 */
export function townBatchUrl(source: TownSource): string {
  const ranges = [source.locationsTab, source.tariffsTab]
    .map((tab) => "ranges=" + encodeURIComponent(quotedTab(tab)))
    .join("&");
  return "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(source.sheetId) +
    "/values:batchGet?" + ranges +
    "&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
}

export interface TownBatchPayload {
  valueRanges?: Array<{values?: unknown[][]}>;
}

export type TownGetter = (url: string) => Promise<TownBatchPayload>;

/* HTTP status of a google-auth-library error, if it has one. */
export function httpStatus(err: unknown): number | undefined {
  if (err == null || typeof err !== "object") return undefined;
  const shaped = err as {status?: unknown; code?: unknown; response?: {status?: unknown}};
  for (const value of [shaped.response?.status, shaped.status, shaped.code]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/* Wait between a 429 and its one retry. Tests pass 0. */
export const TOWN_RETRY_WAIT_MS = 30_000;

export async function fetchTownTabs(
  source: TownSource,
  get: TownGetter = defaultTownGet,
  retryWaitMs = TOWN_RETRY_WAIT_MS,
): Promise<TownRead> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = await get(townBatchUrl(source));
      const ranges = payload.valueRanges ?? [];
      return {ok: true, locations: ranges[0]?.values ?? [], tariffs: ranges[1]?.values ?? []};
    } catch (err) {
      const status = httpStatus(err);
      if (status === 429) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
          continue;
        }
        return {ok: false, reason: "rate-limited", stop: true};
      }
      if (status === 400) return {ok: false, reason: "tab-not-found"};
      if (status === 403 || status === 404) return {ok: false, reason: "no-access"};
      return {ok: false, reason: status ? `read-error:${status}` : "read-error"};
    }
  }
  return {ok: false, reason: "rate-limited", stop: true};
}

async function defaultTownGet(url: string): Promise<TownBatchPayload> {
  await paced();
  const auth = new GoogleAuth({scopes: [SHEETS_READONLY_SCOPE]});
  const client = await auth.getClient();
  const response = await client.request<TownBatchPayload>({url, method: "GET"});
  return response.data ?? {};
}

export const DRIVE_METADATA_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const MAX_DRIVE_PAGES = 20;

/* A Drive id. Anything else could change the query, so it is refused. */
export function cleanFolderId(value: string): string | null {
  const id = value.trim();
  return /^[A-Za-z0-9_-]{10,128}$/.test(id) ? id : null;
}

export function driveFolderPageUrl(folderId: string, pageToken?: string): string {
  const q = `'${folderId}' in parents and mimeType = '${SPREADSHEET_MIME}' and trashed = false`;
  const params = [
    "q=" + encodeURIComponent(q),
    "fields=" + encodeURIComponent("nextPageToken,files(id,name)"),
    "pageSize=1000",
    "supportsAllDrives=true",
    "includeItemsFromAllDrives=true",
    "corpora=allDrives",
  ];
  if (pageToken) params.push("pageToken=" + encodeURIComponent(pageToken));
  return "https://www.googleapis.com/drive/v3/files?" + params.join("&");
}

export interface DriveListPayload {
  nextPageToken?: string;
  files?: Array<{id?: unknown; name?: unknown}>;
}

export type DriveGetter = (url: string) => Promise<DriveListPayload>;

/* Spreadsheets directly in the folder. Throws when the folder cannot be listed. */
export async function listFolderSpreadsheets(
  folderId: string,
  get: DriveGetter = defaultDriveGet,
): Promise<DriveFile[]> {
  const id = cleanFolderId(folderId);
  if (!id) {
    const err = new Error("folder-id-invalid");
    err.name = "folder-id-invalid";
    throw err;
  }
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_DRIVE_PAGES; page += 1) {
    const payload = await get(driveFolderPageUrl(id, pageToken));
    for (const file of payload.files ?? []) {
      if (typeof file.id === "string" && typeof file.name === "string") files.push({id: file.id, name: file.name});
    }
    pageToken = payload.nextPageToken;
    if (!pageToken) return files;
  }
  const err = new Error("folder-too-large");
  err.name = "folder-too-large";
  throw err;
}

async function defaultDriveGet(url: string): Promise<DriveListPayload> {
  const auth = new GoogleAuth({scopes: [DRIVE_METADATA_READONLY_SCOPE]});
  const client = await auth.getClient();
  const response = await client.request<DriveListPayload>({url, method: "GET"});
  return response.data ?? {};
}
