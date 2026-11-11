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
  watchlist?: unknown[][];
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

/* Reads one tab with GET. There is no append, update, or clear in this file. */
export type SheetValuesGetter = (url: string) => Promise<unknown[][]>;

async function defaultGet(url: string): Promise<unknown[][]> {
  const auth = new GoogleAuth({scopes: [SHEETS_READONLY_SCOPE]});
  const client = await auth.getClient();
  const response = await client.request<{values?: unknown[][]}>({url, method: "GET"});
  return response.data.values ?? [];
}

async function fetchTab(sheetId: string, tab: string, get: SheetValuesGetter): Promise<unknown[][]> {
  return get(sheetValuesUrl(sheetId, tab));
}

/* One tab, still a values GET. Appending stays outside this file. */
export async function loadSheetTab(
  sheetId: string,
  tab: string,
  get: SheetValuesGetter = defaultGet,
): Promise<unknown[][]> {
  return fetchTab(sheetId, tab, get);
}

/*
 * Reads with the function's runtime identity. No API key and no secret.
 * Cloud Functions (2nd gen) uses the project's default Compute Engine
 * service account when the function does not set serviceAccount.
 * Share the sheet with that account as a viewer.
 */
export async function loadSurgeTabs(
  sheetId: string,
  eventsTab: string,
  readingsTab: string,
  get: SheetValuesGetter = defaultGet,
): Promise<SurgeTabs> {
  const [events, readings] = await Promise.all([
    fetchTab(sheetId, eventsTab, get),
    fetchTab(sheetId, readingsTab, get),
  ]);
  return {events, readings};
}

export interface ForecastHistoryTabs {
  readings: unknown[][];
  checkIns: unknown[][];
}

/* A missing proposed tab is empty. Any other failure still fails the read. */
export function isMissingTabError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  const status = typeof err === "object" && err && "response" in err ?
    (err as {response?: {status?: number}}).response?.status :
    undefined;
  if (/unable to parse range/i.test(message)) return true;
  return status === 404;
}

/* The proposed Check-ins tab. A missing tab is empty. Any other failure still fails the read. */
export async function loadCheckInsTab(
  sheetId: string,
  checkInsTab: string,
  get: SheetValuesGetter = defaultGet,
): Promise<unknown[][]> {
  try {
    return await fetchTab(sheetId, checkInsTab, get);
  } catch (err) {
    if (isMissingTabError(err)) return [];
    throw err;
  }
}

/*
 * Readings, plus Check-ins when that tab exists.
 * Both are values reads. Existing tabs are not edited.
 */
export async function loadForecastHistoryTabs(
  sheetId: string,
  readingsTab: string,
  checkInsTab: string,
  get: SheetValuesGetter = defaultGet,
): Promise<ForecastHistoryTabs> {
  const [readings, checkIns] = await Promise.all([
    fetchTab(sheetId, readingsTab, get),
    loadCheckInsTab(sheetId, checkInsTab, get),
  ]);
  return {readings, checkIns};
}

/*
 * Events history plus the two TPC tabs, and the watchlist when that tab exists.
 * The Events readings tab is not loaded: category forecasts do not use its
 * price checks. TPC reading rows are counted by id only. Watchlist fare cells
 * stay inside the scorer. A missing watchlist tab is empty. Any other failure
 * still fails the read. Existing tabs are not edited.
 */
export async function loadCategoryTabs(
  sheetId: string,
  eventsTab: string,
  tpcLogTab: string,
  tpcReadingsTab: string,
  getOrWatchlist?: SheetValuesGetter | string,
  watchlistTab = "TPC Watchlist Readings",
): Promise<CategoryTabs> {
  const get = typeof getOrWatchlist === "function" ? getOrWatchlist : defaultGet;
  const watchlistName = typeof getOrWatchlist === "string" ? getOrWatchlist : watchlistTab;
  const [events, tpcLog, tpcReadings, watchlist] = await Promise.all([
    fetchTab(sheetId, eventsTab, get),
    fetchTab(sheetId, tpcLogTab, get),
    fetchTab(sheetId, tpcReadingsTab, get),
    loadCheckInsTab(sheetId, watchlistName, get),
  ]);
  return {events, tpcLog, tpcReadings, watchlist};
}

/*
 * Events, Fixed Places, the watchlist, and the TPC log. Fixed Places and the
 * watchlist are newer tabs: a missing tab is empty. Events and the TPC log
 * are not. This is a values read. Nothing here writes a tab.
 */
export async function loadPlaceTabs(
  sheetId: string,
  eventsTab: string,
  fixedPlacesTab: string,
  watchlistTab: string,
  tpcLogTab: string,
  get: SheetValuesGetter = defaultGet,
): Promise<{events: unknown[][]; fixedPlaces: unknown[][]; watchlist: unknown[][]; tpcLog: unknown[][]}> {
  const loadOne = async (tab: string, optional: boolean): Promise<unknown[][]> => {
    try {
      return await fetchTab(sheetId, tab, get);
    } catch (err) {
      if (optional && isMissingTabError(err)) return [];
      throw err;
    }
  };
  const [events, fixedPlaces, watchlist, tpcLog] = await Promise.all([
    loadOne(eventsTab, false),
    loadOne(fixedPlacesTab, true),
    loadOne(watchlistTab, true),
    loadOne(tpcLogTab, false),
  ]);
  return {events, fixedPlaces, watchlist, tpcLog};
}
