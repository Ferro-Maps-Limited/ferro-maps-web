import {readInstant} from "../surge/forecastHistory.js";
import {formatLondonDateTime} from "../surge/time.js";
import {
  BASED_ON_EVENTS,
  CATEGORY_TYPE,
  CITY_AREA,
  CONFIDENCE_PERCENT,
  END_TIME_UK,
  EVENT_TIME_FIELDS,
  FORECAST_FIELDS,
  FORECAST_SOURCE,
  FORECAST_SOURCE_VALUES,
  FORECAST_STATUS,
  FORECAST_UPDATED_UK,
  FORECAST_WINDOW,
  HOTSPOT_TEST_PIN_HEADERS,
  HOTSPOT_TEST_PINS_GID,
  HOTSPOT_TEST_PINS_TAB,
  ID_SOURCE,
  LATITUDE,
  LONGITUDE,
  MATCHING_FIXED_PLACES,
  MAX_APPEND_PER_RUN,
  PIN_ID,
  PIN_NAME,
  REMOVE_BY,
  SNAPSHOT_TAKEN_UK,
  START_TIME_UK,
  STRENGTH_BAND,
  SURGE_ENDED,
} from "./headers.js";

const TEXT_LIMIT = 300;
const BANDS = new Set(["low", "medium", "high"]);
const SOURCE_VALUES = new Set<string>(FORECAST_SOURCE_VALUES);

export interface PinDoc {
  id: string;
  data: Record<string, unknown>;
}

export interface SheetTabProperty {
  sheetId: number;
  title: string;
}

export interface PinTable {
  existingIds: Set<string>;
  existingRows: number;
  header: string[];
  /* 1-based sheet row of the header. Appends start here so a note above it is left alone. */
  headerRow: number;
}

export interface BuiltRows {
  rows: (string | number)[][];
  ids: string[];
  skippedAlreadyPresent: number;
  deferredOverCap: number;
}

export interface AppendPlan extends BuiltRows {
  status: "ok" | "header-mismatch";
  existingRows: number;
}

export function sheetTabPropertiesUrl(sheetId: string): string {
  return "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(sheetId) +
    "?fields=sheets.properties(sheetId,title)";
}

/* Titles and gids only. Cell values from other tabs are not read. */
export function tabPropertiesFromBody(body: unknown): SheetTabProperty[] {
  if (!body || typeof body !== "object") return [];
  const sheets = (body as {sheets?: unknown}).sheets;
  if (!Array.isArray(sheets)) return [];
  const tabs: SheetTabProperty[] = [];
  for (const sheet of sheets) {
    if (!sheet || typeof sheet !== "object") continue;
    const properties = (sheet as {properties?: unknown}).properties;
    if (!properties || typeof properties !== "object") continue;
    const sheetId = (properties as {sheetId?: unknown}).sheetId;
    const title = (properties as {title?: unknown}).title;
    if (typeof sheetId !== "number" || !Number.isInteger(sheetId)) continue;
    if (typeof title !== "string") continue;
    tabs.push({sheetId, title});
  }
  return tabs;
}

/* The one tab this job may append to. Any other gid or title is a refusal. */
export function confirmedHotspotTab(tabs: SheetTabProperty[]): string | null {
  const matches = tabs.filter((tab) => {
    return tab.sheetId === HOTSPOT_TEST_PINS_GID && tab.title === HOTSPOT_TEST_PINS_TAB;
  });
  return matches.length === 1 ? HOTSPOT_TEST_PINS_TAB : null;
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function headerCells(row: unknown[]): string[] {
  const cells = row.map(cellText);
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function headerMatches(cells: string[]): boolean {
  if (cells.length !== HOTSPOT_TEST_PIN_HEADERS.length) return false;
  return HOTSPOT_TEST_PIN_HEADERS.every((expected, index) => cells[index] === expected);
}

/*
 * The header is the row that equals HOTSPOT_TEST_PIN_HEADERS. A note above it
 * is ignored. Zero matches, or more than one, is a mismatch: write nothing.
 */
export function readHotspotPinTable(matrix: unknown[][]): PinTable | null {
  let found: {index: number; header: string[]} | null = null;
  for (let index = 0; index < matrix.length; index += 1) {
    const header = headerCells(matrix[index] ?? []);
    if (!headerMatches(header)) continue;
    if (found) return null;
    found = {index, header};
  }
  if (!found) return null;
  const idColumn = found.header.indexOf(PIN_ID);
  if (idColumn < 0) return null;
  const existingIds = new Set<string>();
  let existingRows = 0;
  for (let index = found.index + 1; index < matrix.length; index += 1) {
    const id = cellText((matrix[index] ?? [])[idColumn]);
    if (!id) continue;
    existingIds.add(id);
    existingRows += 1;
  }
  return {existingIds, existingRows, header: found.header, headerRow: found.index + 1};
}

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/[\r\n]+/g, " ");
  if (trimmed.length <= TEXT_LIMIT) return trimmed;
  return trimmed.slice(0, TEXT_LIMIT);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readLatLng(value: unknown): {lat: number; lng: number} | null {
  const record = asRecord(value);
  if (!record) return null;
  const lat = typeof record.latitude === "number" ? record.latitude : record.lat;
  const lng = typeof record.longitude === "number" ? record.longitude : record.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {lat, lng};
}

function londonCell(value: unknown): string {
  const ms = readInstant(value);
  if (ms == null) return "";
  return formatLondonDateTime(ms) ?? "";
}

function eventField(record: Record<string, unknown>, field: typeof EVENT_TIME_FIELDS[number]): unknown {
  return record[field];
}

function allowedEventTimes(value: unknown): {start: string; end: string} {
  const record = asRecord(value);
  if (!record) return {start: "", end: ""};
  const start = londonCell(eventField(record, "start_time"));
  const end = londonCell(eventField(record, "end_time")) || londonCell(eventField(record, "closing_time"));
  return {start, end};
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function sourceValue(value: unknown): string {
  const token = text(value);
  return SOURCE_VALUES.has(token) ? token : "";
}

function forecastField(record: Record<string, unknown>, field: typeof FORECAST_FIELDS[number]): unknown {
  return record[field];
}

function forecastCells(data: Record<string, unknown>): Record<string, string | number> {
  const forecast = asRecord(data.forecast);
  const state = forecast ? text(forecastField(forecast, "state")) : "";
  let status = "";
  if (!forecast || state === "no_prediction") status = "no prediction";
  else if (state === "available") status = "likely surge";
  const start = forecast ? londonCell(forecastField(forecast, "startAt")) : "";
  const end = forecast ? londonCell(forecastField(forecast, "endAt")) : "";
  const strengthRaw = forecast ? text(forecastField(forecast, "strength")) : "";
  const confidence = forecast ? wholeNumber(forecastField(forecast, "confidencePercent"), 0, 100) : null;
  const nestedSource = forecast ? sourceValue(forecastField(forecast, "confidenceSource")) : "";
  const basedOn = forecast ? wholeNumber(forecastField(forecast, "basedOnEvents"), 0, 100000) : null;
  const topSource = sourceValue(data.forecastSource);
  return {
    [FORECAST_STATUS]: status,
    [FORECAST_WINDOW]: start && end ? `${start} to ${end}` : "",
    [STRENGTH_BAND]: BANDS.has(strengthRaw) ? strengthRaw : "",
    [CONFIDENCE_PERCENT]: confidence == null ? "" : confidence,
    [BASED_ON_EVENTS]: basedOn == null ? "" : basedOn,
    [FORECAST_SOURCE]: topSource || nestedSource,
  };
}

function cityArea(data: Record<string, unknown>): string {
  const city = text(data.city);
  const area = text(data.area);
  if (city && area && city !== area) {
    const joined = `${city} / ${area}`;
    return joined.length <= TEXT_LIMIT ? joined : joined.slice(0, TEXT_LIMIT);
  }
  return city || area;
}

function surgeEndedCell(value: unknown): string {
  if (value === true) return "YES";
  if (value === false) return "NO";
  return "";
}

/* One new row, keyed by the header names. Unlisted pin fields are not copied. */
export function rowForPin(pin: PinDoc, header: readonly string[], now: Date): (string | number)[] {
  const data = pin.data;
  const place = readLatLng(data.location);
  const times = allowedEventTimes(data.events);
  const start = londonCell(data.window_start) || times.start;
  const removeBy = londonCell(data.removeBy) || londonCell(data.expire_at);
  const snapshot = formatLondonDateTime(now.getTime()) ?? "";
  const values: Record<string, string | number> = {
    [PIN_ID]: pin.id.trim(),
    [PIN_NAME]: text(data.name),
    [CATEGORY_TYPE]: text(data.category),
    [ID_SOURCE]: text(data.idSource),
    [LATITUDE]: place ? place.lat : "",
    [LONGITUDE]: place ? place.lng : "",
    [CITY_AREA]: cityArea(data),
    [START_TIME_UK]: start,
    [END_TIME_UK]: times.end,
    [REMOVE_BY]: removeBy,
    [SURGE_ENDED]: surgeEndedCell(data.surgeEnded),
    [FORECAST_UPDATED_UK]: londonCell(data.forecastUpdatedAt),
    [MATCHING_FIXED_PLACES]: "",
    [SNAPSHOT_TAKEN_UK]: snapshot,
    ...forecastCells(data),
  };
  return header.map((column) => values[column] ?? "");
}

export function rowsForNewPins(input: {
  table: PinTable;
  pins: PinDoc[];
  now: Date;
  cap?: number;
}): BuiltRows {
  const seen = new Set(input.table.existingIds);
  let skippedAlreadyPresent = 0;
  const fresh: PinDoc[] = [];
  for (const pin of input.pins) {
    const id = pin.id.trim();
    if (!id) continue;
    if (seen.has(id)) {
      skippedAlreadyPresent += 1;
      continue;
    }
    seen.add(id);
    fresh.push({id, data: pin.data});
  }
  fresh.sort((left, right) => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  const cap = input.cap == null ? MAX_APPEND_PER_RUN : input.cap;
  const take = Math.max(0, cap);
  const chosen = fresh.slice(0, take);
  return {
    rows: chosen.map((pin) => rowForPin(pin, input.table.header, input.now)),
    ids: chosen.map((pin) => pin.id),
    skippedAlreadyPresent,
    deferredOverCap: fresh.length - chosen.length,
  };
}

export function planHotspotPinAppend(input: {
  matrix: unknown[][];
  pins: PinDoc[];
  now: Date;
  cap?: number;
}): AppendPlan {
  const table = readHotspotPinTable(input.matrix);
  if (!table) {
    return {
      status: "header-mismatch",
      existingRows: 0,
      rows: [],
      ids: [],
      skippedAlreadyPresent: 0,
      deferredOverCap: 0,
    };
  }
  const built = rowsForNewPins({table, pins: input.pins, now: input.now, cap: input.cap});
  return {status: "ok", existingRows: table.existingRows, ...built};
}
