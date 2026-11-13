import {rowsFromMatrix} from "../parking/privateSheet/rows.js";
import {
  BASELINE_FARE,
  CHECK_IN_PHASE,
  CHECK_IN_PLACE,
  DID_IT_SURGE,
  EVENT_ID,
  FARE_SHOWN,
  NORMAL_FARE,
  PHASE,
  PICKUP_POINT,
  TIME_UK,
  TIME_UTC,
  UPLIFT_PERCENT,
} from "./headers.js";
import {normLabel, parseOutcome, parseUpliftFraction, sheetEventKey, type ParsedEvent} from "./parse.js";
import {londonLocalToUtcMs, parseSheetTime} from "./time.js";
import {MIN_STRENGTH_UPLIFT, STRENGTH_HIGH_AT, STRENGTH_MEDIUM_AT, strengthBand, type Band} from "./thresholds.js";
import {normVenueName} from "./venueLocations.js";

/* Freeze the forecast once, on the first run inside the four hours before the event starts. */
export const PRE_EVENT_LEAD_MS = 4 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
/* Same StopPoint id the travel forecast already accepts. */
const STOP_ID = /^(910G[A-Z0-9]{3,})_(\d{4}-\d{2}-\d{2})_H(\d{2})$/;

export interface PreEventSnapshot {
  snapshotAt: string;
  state: "available" | "no_prediction";
  strength?: Band;
  confidencePercent?: number;
  basedOnEvents?: number;
  startAt?: string;
  endAt?: string;
}

export interface OutcomeSnapshot {
  surged: "yes" | "no" | "unknown";
  windowStartAt?: string;
  windowEndAt?: string;
  strength?: Band;
  readingCount: number;
  readingTimes: string[];
}

export interface ForecastHistory {
  preEvent?: PreEventSnapshot;
  outcome?: OutcomeSnapshot;
}

export interface HistoryPin {
  id: string;
  data: Record<string, unknown>;
}

export interface HistoryProposal {
  id: string;
  preEvent?: PreEventSnapshot;
  outcome?: OutcomeSnapshot;
}

/* A sheet row that was still pending, completed from a stored post-event outcome. */
export interface RecordedSurge {
  sheetEventId: string;
  surged: "yes" | "no";
  strength: Band | null;
}

interface Check {
  eventId: string;
  timeMs: number;
  pickup: string;
  surged: "yes" | "no" | null;
  uplift: number | null;
  explicit: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function readInstant(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && "toDate" in value && typeof (value as {toDate: unknown}).toDate === "function") {
    const date = (value as {toDate: () => Date}).toDate();
    const ms = date instanceof Date ? date.getTime() : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function instantIso(value: unknown): string | null {
  const ms = readInstant(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function isBand(value: unknown): value is Band {
  return value === "low" || value === "medium" || value === "high";
}

/* A present value that does not parse, or two present values that disagree, is not used. */
function oneInstant(values: unknown[]): number | null {
  const found: number[] = [];
  for (const value of values) {
    if (value == null || value === "") continue;
    const ms = readInstant(value);
    if (ms == null) return null;
    found.push(ms);
  }
  if (found.length === 0) return null;
  if (found.some((ms) => ms !== found[0])) return null;
  return found[0];
}

function money(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[£,\s]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/* Fare over baseline, kept in this function only. A missing pair is not a guess. */
function upliftFromFares(fare: unknown, baseline: unknown): number | null {
  const fareN = money(fare);
  const baseN = money(baseline);
  if (fareN == null || baseN == null || baseN <= 0) return null;
  const uplift = fareN / baseN - 1;
  if (!Number.isFinite(uplift)) return null;
  return uplift;
}

function isPostPhase(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "post";
}

function checkInPhase(value: unknown): "pre" | "post" | "fixed" | "" {
  if (typeof value !== "string") return "";
  const phase = value.trim().toLowerCase();
  if (phase === "pre") return "pre";
  if (phase === "post") return "post";
  if (phase === "fixed") return "fixed";
  return "";
}

function classify(
  values: Record<string, unknown>,
  normalFareKey: string,
): {surged: "yes" | "no" | null; uplift: number | null; explicit: boolean} {
  const marked = parseOutcome(values[DID_IT_SURGE]);
  const explicit = marked === "yes" || marked === "no";
  const fromFares = upliftFromFares(values[FARE_SHOWN], values[normalFareKey]);
  const uplift = fromFares ?? parseUpliftFraction(values[UPLIFT_PERCENT]);
  if (explicit) return {surged: marked === "yes" ? "yes" : "no", uplift, explicit: true};
  if (uplift == null) return {surged: null, uplift: null, explicit: false};
  if (uplift >= MIN_STRENGTH_UPLIFT) return {surged: "yes", uplift, explicit: false};
  return {surged: "no", uplift: null, explicit: false};
}

/* Same checker as post-event history. The uplift stays in this function. */
export function classifySurgeCheck(
  values: Record<string, unknown>,
  normalFareKey: string,
): "yes" | "no" | null {
  return classify(values, normalFareKey).surged;
}

function checkKey(check: Check): string {
  return `${check.eventId}|${check.timeMs}|${normLabel(check.pickup)}`;
}

function higher(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

/* Two copies of one check collapse. Two explicit answers that disagree decide nothing. */
function mergeChecks(left: Check, right: Check): Check {
  if (left.explicit && right.explicit && left.surged !== right.surged) {
    return {...left, surged: null, uplift: null, explicit: true};
  }
  const primary = left.explicit && !right.explicit ? left : right.explicit && !left.explicit ? right : null;
  let surged: Check["surged"] = null;
  if (primary) surged = primary.surged;
  else if (left.surged === "yes" || right.surged === "yes") surged = "yes";
  else if (left.surged === "no" || right.surged === "no") surged = "no";
  return {
    eventId: left.eventId,
    timeMs: left.timeMs,
    pickup: left.pickup,
    surged,
    uplift: surged === "yes" ? higher(left.uplift, right.uplift) : null,
    explicit: left.explicit || right.explicit,
  };
}

function addCheck(map: Map<string, Check>, check: Check): void {
  const key = checkKey(check);
  const prior = map.get(key);
  map.set(key, prior ? mergeChecks(prior, check) : check);
}

function checksFrom(matrix: unknown[][], source: "readings" | "checkins"): Check[] {
  const found: Check[] = [];
  for (const row of rowsFromMatrix(matrix)) {
    if (row.blank) continue;
    const values = row.values;
    if (source === "readings" && !isPostPhase(values[PHASE])) continue;
    /* Pre and Fixed rows stay on the tab. They are not the result of the event. */
    if (source === "checkins" && checkInPhase(values[CHECK_IN_PHASE]) !== "post") continue;
    const idCell = source === "checkins" ? values[CHECK_IN_PLACE] : values[EVENT_ID];
    const eventId = sheetEventKey(text(idCell));
    const timeMs = parseSheetTime(values[TIME_UK], "uk") ?? parseSheetTime(values[TIME_UTC], "utc");
    if (!eventId || timeMs == null) continue;
    const judged = classify(values, source === "checkins" ? NORMAL_FARE : BASELINE_FARE);
    found.push({
      eventId,
      timeMs,
      pickup: text(values[PICKUP_POINT]),
      surged: judged.surged,
      uplift: judged.uplift,
      explicit: judged.explicit,
    });
  }
  return found;
}

function outcomeFromChecks(checks: Check[]): OutcomeSnapshot {
  const readingTimes = checks.map((check) => new Date(check.timeMs).toISOString()).sort();
  const yes = checks.filter((check) => check.surged === "yes");
  const decided = checks.some((check) => check.surged === "yes" || check.surged === "no");
  const outcome: OutcomeSnapshot = {
    surged: !decided ? "unknown" : yes.length > 0 ? "yes" : "no",
    readingCount: checks.length,
    readingTimes,
  };
  if (outcome.surged !== "yes") return outcome;
  const times = yes.map((check) => check.timeMs).sort((left, right) => left - right);
  outcome.windowStartAt = new Date(times[0]).toISOString();
  outcome.windowEndAt = new Date(times[times.length - 1]).toISOString();
  const peaks = yes
    .map((check) => check.uplift)
    .filter((peak): peak is number => peak != null && peak >= MIN_STRENGTH_UPLIFT);
  const strength = peaks.length > 0 ? strengthBand(Math.max(...peaks)) : null;
  if (strength) outcome.strength = strength;
  return outcome;
}

/*
 * Post-event checks only. A Readings row counts when its phase is Post.
 * A Check-ins row counts when its phase is Post. Pre and Fixed do not.
 * Fare and wait cells used to judge a row are not returned.
 */
export function postEventOutcomes(readings: unknown[][], checkIns: unknown[][]): Map<string, OutcomeSnapshot> {
  const byKey = new Map<string, Check>();
  for (const check of checksFrom(readings, "readings")) addCheck(byKey, check);
  for (const check of checksFrom(checkIns, "checkins")) addCheck(byKey, check);
  const grouped = new Map<string, Check[]>();
  for (const check of byKey.values()) {
    const list = grouped.get(check.eventId) ?? [];
    list.push(check);
    grouped.set(check.eventId, list);
  }
  const outcomes = new Map<string, OutcomeSnapshot>();
  for (const [eventId, checks] of grouped) outcomes.set(eventId, outcomeFromChecks(checks));
  return outcomes;
}

function sheetBounds(data: Record<string, unknown>): {startMs: number; endMs: number} | null {
  const events = asRecord(data.events);
  const startMs = readInstant(data.window_start);
  const endMs = events ? readInstant(events.end_time) : null;
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  return {startMs, endMs};
}

function fieldBounds(data: Record<string, unknown>): {startMs: number; endMs: number} | null {
  const events = asRecord(data.events);
  const startMs = oneInstant([data.starting_time, events?.starting_time, events?.start_time]);
  const endMs = oneInstant([data.ending_time, events?.ending_time, events?.end_time]);
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  return {startMs, endMs};
}

function stationWindow(id: string): {startMs: number; endMs: number} | null {
  const match = STOP_ID.exec(id.trim().toUpperCase());
  if (!match) return null;
  const key = normVenueName(match[1].slice("910G".length));
  const hour = Number(match[3]);
  if (!key || hour > 23) return null;
  const parts = match[2].split("-").map(Number);
  const startMs = londonLocalToUtcMs(parts[0], parts[1], parts[2], hour, 0);
  if (startMs == null) return null;
  return {startMs, endMs: startMs + HOUR_MS};
}

function boundsFor(pin: HistoryPin): {startMs: number; endMs: number} | null {
  if (pin.id.startsWith("sheet_")) return sheetBounds(pin.data);
  const fromFields = fieldBounds(pin.data);
  const fromId = stationWindow(pin.id);
  if (fromFields && fromId) {
    if (fromFields.startMs !== fromId.startMs || fromFields.endMs !== fromId.endMs) return null;
    return fromFields;
  }
  return fromFields ?? fromId;
}

function snapshotFromForecast(forecast: unknown, snapshotAtMs: number): PreEventSnapshot | null {
  const record = asRecord(forecast);
  if (!record) return null;
  const snapshotAt = new Date(snapshotAtMs).toISOString();
  if (record.state === "no_prediction") return {snapshotAt, state: "no_prediction"};
  if (record.state !== "available") return null;
  const startMs = readInstant(record.startAt);
  const endMs = readInstant(record.endAt);
  if (startMs == null || endMs == null || !isBand(record.strength)) return null;
  if (typeof record.basedOnEvents !== "number" || !Number.isFinite(record.basedOnEvents)) return null;
  const snapshot: PreEventSnapshot = {
    snapshotAt,
    state: "available",
    strength: record.strength,
    basedOnEvents: record.basedOnEvents,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
  };
  /* A null percent is left off. The YES share is not filled in. */
  if (typeof record.confidencePercent === "number" && Number.isFinite(record.confidencePercent)) {
    snapshot.confidencePercent = record.confidencePercent;
  } else if (record.confidencePercent != null) {
    return null;
  }
  return snapshot;
}

function sheetEventIdOf(pin: HistoryPin): string | null {
  const raw = text(pin.data.sheetEventId) || pin.id.slice("sheet_".length);
  return sheetEventKey(raw);
}

/*
 * Sheet pins are event records. Any other pin is included only when it already
 * has a forecast. The snapshot is that forecast, taken in the four hours before
 * the event starts. After the finish, the outcome is the post-event checks for
 * that sheet event id, or unknown when there are none. Category pins are not
 * matched to a sheet row by venue or by name.
 */
export function proposeForecastHistory(
  pin: HistoryPin,
  nowMs: number,
  outcomes: Map<string, OutcomeSnapshot>,
): HistoryProposal | null {
  if (!pin.id || pin.id.includes("/")) return null;
  const sheet = pin.id.startsWith("sheet_");
  const forecast = asRecord(pin.data.forecast);
  if (!sheet && !forecast) return null;
  const bounds = boundsFor(pin);
  if (!bounds) return null;
  const proposal: HistoryProposal = {id: pin.id};
  let any = false;
  if (forecast && nowMs >= bounds.startMs - PRE_EVENT_LEAD_MS && nowMs < bounds.startMs) {
    const preEvent = snapshotFromForecast(forecast, nowMs);
    if (preEvent) {
      proposal.preEvent = preEvent;
      any = true;
    }
  }
  if (nowMs >= bounds.endMs) {
    const key = sheet ? sheetEventIdOf(pin) : null;
    const found = key ? outcomes.get(key) : undefined;
    proposal.outcome = found ?? {surged: "unknown", readingCount: 0, readingTimes: []};
    any = true;
  }
  return any ? proposal : null;
}

function readStoredPre(value: unknown): PreEventSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const snapshotAt = instantIso(record.snapshotAt);
  if (!snapshotAt) return null;
  if (record.state === "no_prediction") return {snapshotAt, state: "no_prediction"};
  if (record.state !== "available") return null;
  const startAt = instantIso(record.startAt);
  const endAt = instantIso(record.endAt);
  if (!startAt || !endAt || !isBand(record.strength)) return null;
  if (typeof record.basedOnEvents !== "number") return null;
  if (record.confidencePercent != null && typeof record.confidencePercent !== "number") return null;
  const snapshot: PreEventSnapshot = {
    snapshotAt,
    state: "available",
    strength: record.strength,
    basedOnEvents: record.basedOnEvents,
    startAt,
    endAt,
  };
  if (typeof record.confidencePercent === "number") snapshot.confidencePercent = record.confidencePercent;
  return snapshot;
}

function readStoredOutcome(value: unknown): OutcomeSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const surged = record.surged;
  if (surged !== "yes" && surged !== "no" && surged !== "unknown") return null;
  if (typeof record.readingCount !== "number" || !Number.isFinite(record.readingCount)) return null;
  if (!Array.isArray(record.readingTimes)) return null;
  const readingTimes: string[] = [];
  for (const item of record.readingTimes) {
    const iso = instantIso(item);
    if (!iso) return null;
    readingTimes.push(iso);
  }
  const outcome: OutcomeSnapshot = {surged, readingCount: record.readingCount, readingTimes};
  const windowStartAt = instantIso(record.windowStartAt);
  const windowEndAt = instantIso(record.windowEndAt);
  if (windowStartAt) outcome.windowStartAt = windowStartAt;
  if (windowEndAt) outcome.windowEndAt = windowEndAt;
  if (isBand(record.strength)) outcome.strength = record.strength;
  return outcome;
}

export function readStoredHistory(value: unknown): ForecastHistory | null {
  const record = asRecord(value);
  if (!record) return null;
  const history: ForecastHistory = {};
  const preEvent = readStoredPre(record.preEvent);
  const outcome = readStoredOutcome(record.outcome);
  if (preEvent) history.preEvent = preEvent;
  if (outcome) history.outcome = outcome;
  if (!history.preEvent && !history.outcome) return null;
  return history;
}

export function storedPreEventPresent(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || record.preEvent == null || typeof record.preEvent !== "object") return false;
  return !Array.isArray(record.preEvent);
}

function copyOutcome(outcome: OutcomeSnapshot): OutcomeSnapshot {
  const copy: OutcomeSnapshot = {
    surged: outcome.surged,
    readingCount: outcome.readingCount,
    readingTimes: [...outcome.readingTimes],
  };
  if (outcome.windowStartAt) copy.windowStartAt = outcome.windowStartAt;
  if (outcome.windowEndAt) copy.windowEndAt = outcome.windowEndAt;
  if (outcome.strength) copy.strength = outcome.strength;
  return copy;
}

function normalize(history: ForecastHistory | null): ForecastHistory | null {
  if (!history) return null;
  const next: ForecastHistory = {};
  if (history.preEvent) {
    const pre = history.preEvent;
    const available: PreEventSnapshot = {
      snapshotAt: pre.snapshotAt,
      state: "available",
      strength: pre.strength,
      basedOnEvents: pre.basedOnEvents,
      startAt: pre.startAt,
      endAt: pre.endAt,
    };
    if (typeof pre.confidencePercent === "number") available.confidencePercent = pre.confidencePercent;
    next.preEvent = pre.state === "available" ? available : {snapshotAt: pre.snapshotAt, state: "no_prediction"};
  }
  if (history.outcome) next.outcome = copyOutcome(history.outcome);
  return next;
}

export function sameForecastHistory(left: ForecastHistory | null, right: ForecastHistory | null): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/*
 * The first pre-event snapshot stays. A later run can fill an unknown outcome
 * from readings, and can extend a yes or no as more checks arrive. It does not
 * wipe a yes or no when a later read finds no checks.
 */
export function mergeForecastHistory(
  existing: ForecastHistory | null,
  proposed: HistoryProposal,
): ForecastHistory | null {
  const preEvent = existing?.preEvent ?? proposed.preEvent;
  let outcome = existing?.outcome;
  if (proposed.outcome) {
    const keep = proposed.outcome.surged === "unknown" && outcome != null && outcome.surged !== "unknown";
    if (!keep) outcome = proposed.outcome;
  }
  if (!preEvent && !outcome) return null;
  const next: ForecastHistory = {};
  if (preEvent) next.preEvent = preEvent;
  if (outcome) next.outcome = outcome;
  return next;
}

/* Bottom of the band. Used only while forecasting. It is not written anywhere. */
function peakForRecordedStrength(strength: Band | null): number | null {
  if (strength === "low") return MIN_STRENGTH_UPLIFT;
  if (strength === "medium") return STRENGTH_MEDIUM_AT;
  if (strength === "high") return STRENGTH_HIGH_AT;
  return null;
}

/*
 * Same event id only. A sheet yes or no is left alone, including its peak.
 * The Events row itself is not edited. A pending row takes a yes or no that
 * was read from Firestore or from Check-ins. When the sheet has no peak, the
 * recorded strength band stands in for it so a later forecast can still choose
 * a band. The stand-in is the bottom of that band and is never stored.
 */
export function applyRecordedOutcomes(events: ParsedEvent[], recorded: RecordedSurge[]): ParsedEvent[] {
  if (recorded.length === 0) return events;
  const byId = new Map<string, RecordedSurge>();
  for (const item of recorded) {
    if (item.surged !== "yes" && item.surged !== "no") continue;
    const key = sheetEventKey(item.sheetEventId);
    if (key) byId.set(key, item);
  }
  if (byId.size === 0) return events;
  return events.map((event) => {
    if (event.outcome === "yes" || event.outcome === "no") return event;
    const found = byId.get(event.sheetEventId);
    if (!found) return event;
    const peak = event.peakUplift != null ? event.peakUplift : peakForRecordedStrength(found.strength);
    return {...event, outcome: found.surged, peakUplift: peak};
  });
}

export function recordedSurgesFromPins(pins: HistoryPin[]): RecordedSurge[] {
  const found: RecordedSurge[] = [];
  for (const pin of pins) {
    if (!pin.id.startsWith("sheet_")) continue;
    const outcome = readStoredHistory(pin.data.forecastHistory)?.outcome;
    if (!outcome || (outcome.surged !== "yes" && outcome.surged !== "no")) continue;
    const sheetEventId = sheetEventIdOf(pin);
    if (!sheetEventId) continue;
    found.push({sheetEventId, surged: outcome.surged, strength: outcome.strength ?? null});
  }
  return found;
}

/* Post rows on Check-ins only. Pre and Fixed do not complete an event. */
export function recordedSurgesFromCheckIns(checkIns: unknown[][]): RecordedSurge[] {
  const found: RecordedSurge[] = [];
  for (const [eventId, outcome] of postEventOutcomes([], checkIns)) {
    if (outcome.surged !== "yes" && outcome.surged !== "no") continue;
    found.push({sheetEventId: eventId, surged: outcome.surged, strength: outcome.strength ?? null});
  }
  return found;
}

/*
 * One answer per event. A Check-ins yes or no is the reading, so it wins.
 * Firestore fills an event the tab did not decide. Nothing here writes a tab.
 */
export function mergeRecordedSurges(fromTab: RecordedSurge[], fromStore: RecordedSurge[]): RecordedSurge[] {
  const byId = new Map<string, RecordedSurge>();
  for (const item of fromStore) {
    const key = sheetEventKey(item.sheetEventId);
    if (!key || (item.surged !== "yes" && item.surged !== "no")) continue;
    byId.set(key, {sheetEventId: key, surged: item.surged, strength: item.strength});
  }
  for (const item of fromTab) {
    const key = sheetEventKey(item.sheetEventId);
    if (!key || (item.surged !== "yes" && item.surged !== "no")) continue;
    byId.set(key, {sheetEventId: key, surged: item.surged, strength: item.strength});
  }
  return [...byId.values()];
}
