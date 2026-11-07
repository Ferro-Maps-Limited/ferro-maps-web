import {contentHash, readingId} from "./readingId.js";
import {parsePercent, parsePence} from "./money.js";
import {parseUkSheetTime, parseUtcSheetTime} from "./londonTime.js";
import {
  inUk,
  normalDestination,
  parsePickupCell,
  pickupKind,
  pickupSlug,
  type ParsedPickup,
} from "./pickup.js";

/*
 * Offline importer for the four named tabs. Not exported from index.ts.
 * sheetPeakText is not stored: it is a fare-derived percentage, and pence
 * stay on surgeReadings. People columns are never copied. No raw row.
 * Ambiguous London times are rejected, not assigned to the first fold.
 */

export const IMPORTER_VERSION = "i1";
export const SYNTHETIC_MAP_ID = "synthetic-v1";

export const EVENT_HEADERS = [
  "Event ID",
  "Competition",
  "Home team",
  "Away team",
  "Ground",
  "Kick-off (UK)",
  "Expected full time (UK)",
  "Surge window starts (UK)",
  "Surge window ends (UK, est.)",
  "Baseline price check (UK, 4h before window)",
  "Hard stop (UK, FT + 3h)",
  "Ground capacity",
  "Predicted surge confidence %",
  "Priority",
  "Status",
  "Did it surge?",
  "Peak uplift %",
  "Pickup points (name | lat,lng)",
  "Fixed destination for price checks",
] as const;

export const DISRUPTION_HEADERS = [
  "Disruption ID",
  "Type",
  "Location/Station/Airport",
  "Mode",
  "Ground",
  "Kick-off (UK)",
  "Expected full time (UK)",
  "Surge window starts (UK)",
  "Surge window ends (UK, est.)",
  "Baseline price check (UK, 4h before window)",
  "Hard stop (UK, FT + 3h)",
  "Ground capacity",
  "Surge Confidence %",
  "Priority",
  "Surge Expected? (YES/NO)",
  "Status",
  "Did it surge?",
  "Peak uplift %",
  "Pickup points (name | lat,lng)",
] as const;

export const READING_HEADERS = [
  "Time (UK)",
  "Time (UTC)",
  "Event ID",
  "Phase (Baseline / Pre / During / Post)",
  "Pickup point",
  "Latitude",
  "Longitude",
  "Destination",
  "Uber product",
  "Fare shown (£)",
  "Baseline fare (£)",
  "Pickup wait (min)",
  "'Busy / fares higher' shown?",
] as const;

export const SURGE_TABS = [
  "Events",
  "Readings",
  "TPC Disruption Log",
  "TPC Readings",
] as const;

const EVENT_ID = /^\d{4}-\d{2}-\d{2}-[A-Z0-9][A-Z0-9-]*$/;
const MODES = new Set(["train", "tube", "rail", "overground", "dlr", "elizabeth", "flight", "other"]);
const PRIORITY = new Set(["high", "medium", "low"]);
const PHASES = new Set(["baseline", "pre", "during", "post"]);

export interface SurgeWrite {
  path: string;
  data: Record<string, unknown>;
  hash: string;
}

export interface ImportReject {
  tab: string;
  row: number;
  column: string;
  reason: string;
}

export interface ImportPlan {
  outcome: "headerFail" | "written" | "noChange";
  writes: SurgeWrite[];
  rejects: ImportReject[];
  flags: Record<string, number>;
}

export function isSyntheticColumnMap(value: unknown): boolean {
  return typeof value === "object" && value != null &&
    (value as {id?: unknown}).id === SYNTHETIC_MAP_ID;
}

function headersOf(matrix: unknown[][]): string[] {
  return (matrix[0] ?? []).map((cell) => typeof cell === "string" ? cell.trim() : "");
}

function hasHeaders(matrix: unknown[][] | undefined, required: readonly string[]): boolean {
  if (!matrix || matrix.length === 0) return false;
  const names = new Set(headersOf(matrix));
  return required.every((name) => names.has(name));
}

function objects(matrix: unknown[][]): Array<{row: number; values: Record<string, unknown>; blank: boolean}> {
  const header = headersOf(matrix);
  const rows = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const cells = matrix[index] ?? [];
    const values: Record<string, unknown> = {};
    let any = false;
    header.forEach((name, column) => {
      if (!name) return;
      const value = cells[column];
      values[name] = value == null ? null : value;
      if (typeof value === "string" ? value.trim() !== "" : value != null) any = true;
    });
    rows.push({row: index + 1, values, blank: !any});
  }
  return rows;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-") return null;
  return trimmed;
}

function requiredTime(value: unknown, rejects: ImportReject[], tab: string, row: number, column: string): Date | null {
  const parsed = parseUkSheetTime(value);
  if (!parsed.ok) {
    rejects.push({tab, row, column, reason: parsed.reason});
    return null;
  }
  return parsed.at;
}

function waitRange(value: unknown): {min: number; max: number} | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return {min: value, max: value};
  if (typeof value !== "string") return null;
  const textValue = value.trim();
  const one = textValue.match(/^(\d+)$/);
  if (one) return {min: Number(one[1]), max: Number(one[1])};
  const range = textValue.match(/^(\d+)-(\d+)$/);
  if (!range) return null;
  return {min: Number(range[1]), max: Number(range[2])};
}

function busy(value: unknown): boolean | null {
  if (typeof value !== "string") return null;
  const textValue = value.trim().toLowerCase();
  if (textValue === "yes") return true;
  if (textValue === "no") return false;
  return null;
}

function pointValue(lat: number | null, lng: number | null): {lat: number; lng: number} | null {
  if (lat == null || lng == null || !inUk(lat, lng)) return null;
  return {lat, lng};
}

interface BuiltEvent {
  id: string;
  data: Record<string, unknown>;
  hash: string;
  pickups: SurgeWrite[];
}

function eventFrom(
  kind: "event" | "disruption",
  row: {row: number; values: Record<string, unknown>},
  tab: string,
  rejects: ImportReject[],
  flags: Record<string, number>,
): BuiltEvent | null {
  const bump = (flag: string) => {
    flags[flag] = (flags[flag] ?? 0) + 1;
  };
  const idColumn = kind === "event" ? "Event ID" : "Disruption ID";
  const id = text(row.values[idColumn]);
  if (id == null || !EVENT_ID.test(id) || id.length > 56) {
    rejects.push({tab, row: row.row, column: idColumn, reason: "bad-id"});
    return null;
  }
  const category = text(row.values[kind === "event" ? "Competition" : "Type"]);
  const home = kind === "event" ? text(row.values["Home team"]) : null;
  const away = kind === "event" ? text(row.values["Away team"]) : null;
  const title = kind === "event" ?
    (away ? `${home ?? ""} v ${away}`.trim() : home) :
    text(row.values["Location/Station/Airport"]);
  if (category == null || title == null || title === "") {
    rejects.push({tab, row: row.row, column: "title", reason: "missing-title"});
    return null;
  }
  const venueName = text(row.values.Ground);
  if (venueName == null) {
    rejects.push({tab, row: row.row, column: "Ground", reason: "missing-venue"});
    return null;
  }
  const kick = parseUkSheetTime(row.values["Kick-off (UK)"]);
  const startText = kick.ok ? null : text(row.values["Kick-off (UK)"]);
  if (!kick.ok && kick.reason === "ambiguous-time") bump("ambiguousTime");
  const expectedEndAt = requiredTime(row.values["Expected full time (UK)"], rejects, tab, row.row, "Expected full time (UK)");
  const windowStart = requiredTime(row.values["Surge window starts (UK)"], rejects, tab, row.row, "Surge window starts (UK)");
  const windowEnd = requiredTime(row.values["Surge window ends (UK, est.)"], rejects, tab, row.row, "Surge window ends (UK, est.)");
  const baselineAt = requiredTime(
    row.values["Baseline price check (UK, 4h before window)"],
    rejects, tab, row.row, "Baseline price check (UK, 4h before window)",
  );
  const hardStopAt = requiredTime(row.values["Hard stop (UK, FT + 3h)"], rejects, tab, row.row, "Hard stop (UK, FT + 3h)");
  if (expectedEndAt == null || windowStart == null || windowEnd == null || baselineAt == null || hardStopAt == null) {
    return null;
  }
  if (windowEnd.getTime() <= windowStart.getTime()) {
    rejects.push({tab, row: row.row, column: "Surge window ends (UK, est.)", reason: "window-order"});
    return null;
  }
  const confidenceColumn = kind === "event" ? "Predicted surge confidence %" : "Surge Confidence %";
  const confidence = parsePercent(row.values[confidenceColumn]);
  if (confidence.bad) bump("badPercent");
  const priorityText = text(row.values.Priority);
  const priority = priorityText?.toLowerCase() ?? null;
  if (priority != null && !PRIORITY.has(priority)) {
    rejects.push({tab, row: row.row, column: "Priority", reason: "bad-priority"});
    return null;
  }
  let mode: string | null = null;
  if (kind === "disruption") {
    const modeText = text(row.values.Mode);
    mode = modeText?.toLowerCase() ?? null;
    if (mode != null && !MODES.has(mode)) {
      rejects.push({tab, row: row.row, column: "Mode", reason: "bad-mode"});
      return null;
    }
  }
  const sheetStatus = text(row.values.Status);
  const sheetResult = text(row.values["Did it surge?"]);
  if (sheetStatus == null || sheetResult == null) {
    rejects.push({tab, row: row.row, column: "Status", reason: "missing-status"});
    return null;
  }
  const expected = text(row.values["Surge Expected? (YES/NO)"]);
  const sheetExpected = expected == null ? null : expected.toUpperCase() === "YES" ? true : expected.toUpperCase() === "NO" ? false : null;
  const parsedPickups = parsePickupCell(row.values["Pickup points (name | lat,lng)"]);
  if (parsedPickups.collision) {
    rejects.push({tab, row: row.row, column: "Pickup points (name | lat,lng)", reason: "pickup-id-collision"});
    return null;
  }
  const destination = parseEventDestination(row.values["Fixed destination for price checks"]);
  if (kind === "event" && destination == null) bump("noDestination");
  const eventFlags: string[] = [];
  if (!kick.ok && kick.reason === "ambiguous-time") eventFlags.push("ambiguousTime");
  if (confidence.bad) eventFlags.push("badPercent");
  if (kind === "event" && destination == null) eventFlags.push("noDestination");
  const data: Record<string, unknown> = {
    kind,
    category,
    title,
    home,
    away,
    mode,
    venueName,
    startAt: kick.ok ? kick.at.toISOString() : null,
    startText,
    expectedEndAt: expectedEndAt.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    baselineAt: baselineAt.toISOString(),
    hardStopAt: hardStopAt.toISOString(),
    capacityText: text(row.values["Ground capacity"]),
    sheetConf: confidence.value,
    sheetPriority: priority,
    sheetExpected: kind === "disruption" ? sheetExpected : null,
    sheetStatus,
    sheetResult,
    pickupCount: parsedPickups.pickups.length,
    destination,
    flags: eventFlags,
    src: {tab, row: row.row, hash: ""},
  };
  const hash = contentHash({...data, src: {tab, row: row.row}});
  data.src = {tab, row: row.row, hash};
  const pickups = parsedPickups.pickups.map((pickup, index) => pickupWrite(id, pickup, index + 1, tab, row.row));
  return {id, data, hash, pickups};
}

function parseEventDestination(value: unknown): {name: string; p: {lat: number; lng: number} | null} | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const pieces = value.split("|").map((piece) => piece.trim());
  const name = normalDestination(pieces[0]);
  if (name == null) return null;
  const point = pieces[1]?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (!point) return {name, p: null};
  const lat = Number(point[1]);
  const lng = Number(point[2]);
  return {name, p: inUk(lat, lng) ? {lat, lng} : null};
}

function pickupWrite(eventId: string, pickup: ParsedPickup, listOrder: number, tab: string, row: number): SurgeWrite {
  const point = pointValue(pickup.lat, pickup.lng);
  const data: Record<string, unknown> = {
    name: pickup.name,
    p: point,
    pSource: point ? "eventList" : "none",
    kind: pickupKind(pickup.name),
    listOrder,
    readingCount: 0,
    src: {tab, row, hash: ""},
    flags: [],
  };
  const hash = contentHash({...data, src: {tab, row}});
  data.src = {tab, row, hash};
  return {path: `surgeEvents/${eventId}/pickups/${pickup.slug}`, data, hash};
}

interface BuiltReading {
  id: string;
  eventId: string;
  pickupName: string;
  data: Record<string, unknown>;
  hash: string;
}

function readingFrom(
  row: {row: number; values: Record<string, unknown>},
  tab: string,
  events: Map<string, BuiltEvent>,
  rejects: ImportReject[],
  flags: Record<string, number>,
): BuiltReading | null {
  const eventId = text(row.values["Event ID"]);
  const event = eventId ? events.get(eventId) : undefined;
  if (eventId == null || event == null) {
    rejects.push({tab, row: row.row, column: "Event ID", reason: "unknown-event"});
    return null;
  }
  const taken = parseUkSheetTime(row.values["Time (UK)"]);
  if (!taken.ok) {
    rejects.push({tab, row: row.row, column: "Time (UK)", reason: taken.reason});
    if (taken.reason === "ambiguous-time") flags.ambiguousTime = (flags.ambiguousTime ?? 0) + 1;
    return null;
  }
  const phaseText = text(row.values["Phase (Baseline / Pre / During / Post)"])?.toLowerCase() ?? "";
  if (!PHASES.has(phaseText)) {
    rejects.push({tab, row: row.row, column: "Phase (Baseline / Pre / During / Post)", reason: "bad-phase"});
    return null;
  }
  const pickupName = text(row.values["Pickup point"]);
  if (pickupName == null) {
    rejects.push({tab, row: row.row, column: "Pickup point", reason: "missing-pickup"});
    return null;
  }
  const slug = pickupSlug(pickupName);
  const product = text(row.values["Uber product"])?.toLowerCase() ?? "";
  if (product === "" || product.includes("|") || slug.includes("|")) {
    rejects.push({tab, row: row.row, column: "Uber product", reason: "bad-product"});
    return null;
  }
  const fare = parsePence(row.values["Fare shown (£)"]);
  const baseline = parsePence(row.values["Baseline fare (£)"]);
  if (fare.reject || baseline.reject) {
    rejects.push({tab, row: row.row, column: "Fare shown (£)", reason: "bad-fare"});
    return null;
  }
  const readingFlags: string[] = [];
  if (fare.noFare) readingFlags.push("noFare");
  if (fare.fare3dp || baseline.fare3dp) {
    readingFlags.push("fare3dp");
    flags.fare3dp = (flags.fare3dp ?? 0) + 1;
  }
  const utc = parseUtcSheetTime(row.values["Time (UTC)"]);
  if (utc && utc.getTime() !== taken.at.getTime()) {
    readingFlags.push("utcMismatch");
    flags.utcMismatch = (flags.utcMismatch ?? 0) + 1;
  }
  const lat = typeof row.values.Latitude === "number" ? row.values.Latitude : Number(row.values.Latitude);
  const lng = typeof row.values.Longitude === "number" ? row.values.Longitude : Number(row.values.Longitude);
  const destination = normalDestination(row.values.Destination);
  const wait = waitRange(row.values["Pickup wait (min)"]);
  const id = readingId({eventId, pickupId: slug, takenAt: taken.at, product});
  const knownPickup = event.pickups.some((pickup) => pickup.path.endsWith(`/${slug}`));
  if (!knownPickup) readingFlags.push("pickupNotListed");
  const data: Record<string, unknown> = {
    eventId,
    pickupId: slug,
    takenAt: taken.at.toISOString(),
    phase: phaseText,
    product,
    destination,
    pricePence: fare.pence,
    baselinePence: baseline.pence,
    waitMin: wait?.min ?? null,
    waitMax: wait?.max ?? null,
    busyShown: busy(row.values["'Busy / fares higher' shown?"]),
    p: pointValue(Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null),
    src: {tab, row: row.row, hash: ""},
    flags: readingFlags,
  };
  const hash = contentHash({...data, src: {tab, row: row.row}});
  data.src = {tab, row: row.row, hash};
  return {id, eventId, pickupName, data, hash};
}

function addReadingPickups(events: Map<string, BuiltEvent>, readings: BuiltReading[]): void {
  for (const reading of readings) {
    const event = events.get(reading.eventId);
    if (!event) continue;
    const slug = String(reading.data.pickupId);
    if (event.pickups.some((pickup) => pickup.path.endsWith(`/${slug}`))) continue;
    const same = readings.filter((item) => {
      return item.eventId === reading.eventId && item.data.pickupId === slug;
    });
    const points = same.map((item) => item.data.p).filter((point): point is {lat: number; lng: number} => {
      return point != null;
    });
    const counts = new Map<string, {point: {lat: number; lng: number}; count: number}>();
    for (const point of points) {
      const key = `${point.lat},${point.lng}`;
      const found = counts.get(key);
      if (found) found.count += 1;
      else counts.set(key, {point, count: 1});
    }
    const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
    const tie = ranked.length > 1 && ranked[0].count === ranked[1].count;
    const chosen = !tie && ranked[0] ? ranked[0].point : null;
    const data: Record<string, unknown> = {
      name: reading.pickupName,
      p: chosen,
      pSource: chosen ? "reading" : "none",
      kind: pickupKind(reading.pickupName),
      listOrder: null,
      readingCount: same.length,
      src: {tab: "Readings", row: 0, hash: ""},
      flags: tie ? ["positionTie"] : ["pickupNotListed"],
    };
    const hash = contentHash({...data, src: {tab: "Readings", row: 0}});
    data.src = {tab: "Readings", row: 0, hash};
    event.pickups.push({path: `surgeEvents/${reading.eventId}/pickups/${slug}`, data, hash});
  }
}

function withoutRow(data: Record<string, unknown>): Record<string, unknown> {
  const src = data.src as {tab: string; hash?: string};
  return {...data, src: {tab: src.tab, hash: ""}};
}

function rowOf(reading: BuiltReading): number {
  return (reading.data.src as {row: number}).row;
}

export function importSurgeWorkbook(input: {
  tabs: Record<string, unknown[][]>;
  now: Date;
  existingHashes?: ReadonlyMap<string, string>;
}): ImportPlan {
  const rejects: ImportReject[] = [];
  const flags: Record<string, number> = {};
  const tables: Array<[string, readonly string[]]> = [
    ["Events", EVENT_HEADERS],
    ["TPC Disruption Log", DISRUPTION_HEADERS],
    ["Readings", READING_HEADERS],
    ["TPC Readings", READING_HEADERS],
  ];
  for (const [tab, required] of tables) {
    if (!hasHeaders(input.tabs[tab], required)) {
      return {outcome: "headerFail", writes: [], rejects, flags};
    }
  }
  const events = new Map<string, BuiltEvent>();
  for (const [tab, kind] of [["Events", "event"], ["TPC Disruption Log", "disruption"]] as const) {
    for (const row of objects(input.tabs[tab] ?? [])) {
      if (row.blank) continue;
      const built = eventFrom(kind, row, tab, rejects, flags);
      if (built) events.set(built.id, built);
    }
  }
  const readings: BuiltReading[] = [];
  for (const tab of ["Readings", "TPC Readings"]) {
    for (const row of objects(input.tabs[tab] ?? [])) {
      if (row.blank) continue;
      const built = readingFrom(row, tab, events, rejects, flags);
      if (built) readings.push(built);
    }
  }
  addReadingPickups(events, readings);
  const byId = new Map<string, BuiltReading[]>();
  for (const reading of readings) {
    const list = byId.get(reading.id) ?? [];
    list.push(reading);
    byId.set(reading.id, list);
  }
  const readingWrites: SurgeWrite[] = [];
  for (const [id, group] of byId) {
    const bodies = new Set(group.map((item) => contentHash(withoutRow(item.data))));
    if (bodies.size > 1) {
      const src = group[0].data.src as {tab: string; row: number};
      rejects.push({tab: src.tab, row: src.row, column: "Fare shown (£)", reason: "payload-differs"});
      continue;
    }
    const kept = [...group].sort((a, b) => rowOf(a) - rowOf(b))[0];
    readingWrites.push({path: `surgeReadings/${id}`, data: kept.data, hash: kept.hash});
  }
  const writes: SurgeWrite[] = [];
  for (const event of events.values()) {
    writes.push({path: `surgeEvents/${event.id}`, data: event.data, hash: event.hash});
    writes.push(...event.pickups);
  }
  writes.push(...readingWrites);
  const existing = input.existingHashes ?? new Map<string, string>();
  const changed = writes.filter((write) => existing.get(write.path) !== write.hash);
  if (changed.length === 0) return {outcome: "noChange", writes: [], rejects, flags};
  return {outcome: "written", writes: changed, rejects, flags};
}
