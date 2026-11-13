import {logger} from "firebase-functions/logger";
import {FieldValue, Timestamp, type Firestore} from "firebase-admin/firestore";
import {londonDayKey} from "../admin/london.js";
import {rowsFromMatrix} from "../parking/privateSheet/rows.js";
import {geohash} from "../parking/privateSheet/geohash.js";
import {classifySurgeCheck} from "./forecastHistory.js";
import {removeByMs, surgeHasEnded} from "./forecast.js";
import {
  BASELINE_FARE,
  DID_IT_SURGE,
  EVENT_ID,
  FARE_SHOWN,
  PHASE,
  PICKUP_POINT,
  TIME_UK,
  TIME_UTC,
  UPLIFT_PERCENT,
} from "./headers.js";
import {normLabel, parseSurgeSheet, sheetEventKey, stadiumDocId, type ParsedEvent, type PickupCoord} from "./parse.js";
import {assertNoPrices} from "./priceGuard.js";
import {parseSheetTime} from "./time.js";
import {HOTSPOT_TEST_PINS} from "./watchlist.js";

export const SURGE_ALERTS = "surgeAlerts";
export const SURGE_ACTIVE_CHANNEL = "surge_active";

const BLOCKED_NAME = /[£$€]|\b(fare|fares|earn|earnings|uber|bolt)\b/i;

export interface LivePin {
  id: string;
  data: Record<string, unknown>;
}

export interface LiveHit {
  hotspotId: string;
  episodeKey: string;
  venueName: string;
  pickupLat: number;
  pickupLng: number;
  activeSinceMs: number;
}

export interface SurgeActiveMessage {
  topic: string;
  data: {
    hotspotId: string;
    venueName: string;
    pickupLat: string;
    pickupLng: string;
    activeSince: string;
  };
  apns: {
    payload: {
      aps: {
        alert: string;
        mutableContent: true;
      };
    };
  };
  android: {priority: "high"};
}

/*
 * TODO(PLAN-3c): Who receives a surge-active alert is undecided: all opted-in
 * drivers, Gold only, or Stardust / people who can already see forecasts.
 * Do not choose. One topic message is sent. A phone subscribes only when
 * users/{uid}.notifPrefs.surgeActive is on. This file does not read a token
 * list or stored driver positions to pick recipients.
 *
 * TODO(PLAN-3c): How far an alert reaches is still open. The geohash-5 topic
 * is only a proposal. The server does not apply a radius and does not store
 * driver locations.
 *
 * There are no quiet hours. config/notifications.maxAlertsPerDay is a
 * proposal for a daily cap. A missing value means there is no cap. 0 means
 * none.
 *
 * The phone posts the Android notification on channel surge_active. This
 * payload has no android.notification block, so the server does not set one.
 */

export function flagIsOn(value: unknown): boolean {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as {enabled?: unknown}).enabled === true;
}

export async function surgeActiveEnabled(db: Firestore): Promise<boolean> {
  const flags = await db.doc("config/flags").get();
  return flagIsOn(flags.get("surgeActiveNotifications"));
}

/* A missing or unreadable cap means there is no cap. 0 means send none. */
export async function maxAlertsPerDay(db: Firestore): Promise<number | null> {
  const snap = await db.doc("config/notifications").get();
  const value = snap.get("maxAlertsPerDay");
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return null;
}

export function venueAllowed(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 60 && !BLOCKED_NAME.test(trimmed);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function phaseOf(value: unknown): string {
  const phase = text(value).toLowerCase();
  if (phase === "baseline" || phase === "pre" || phase === "during" || phase === "post") return phase;
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function venueOf(pin: Record<string, unknown> | undefined, fallback: string): string {
  const events = asRecord(pin?.events);
  const named = text(events?.venue_name);
  if (named) return named;
  const name = text(pin?.name);
  return name || fallback;
}

function pickupFromList(points: PickupCoord[], pickupName: string): PickupCoord | null {
  const wanted = normLabel(pickupName);
  if (!wanted) return null;
  return points.find((point) => normLabel(point.name) === wanted) ?? null;
}

function pinPickups(pin: Record<string, unknown> | undefined): PickupCoord[] {
  const raw = pin?.pickupPoints;
  if (!Array.isArray(raw)) return [];
  const points: PickupCoord[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const name = text(record.name);
    const lat = record.lat;
    const lng = record.lng;
    if (!name || typeof lat !== "number" || typeof lng !== "number") continue;
    points.push({name, lat, lng});
  }
  return points;
}

function inEventWindow(timeMs: number, event: ParsedEvent): boolean {
  return timeMs >= event.kickOffMs && timeMs < removeByMs(event);
}

function pushHit(
  hits: LiveHit[],
  pin: LivePin | undefined,
  hotspotId: string,
  episodeKey: string,
  fallbackVenue: string,
  pickupName: string,
  eventPickups: PickupCoord[],
  activeSinceMs: number,
): void {
  const pickup = pickupFromList(pinPickups(pin?.data), pickupName) ?? pickupFromList(eventPickups, pickupName);
  if (!pickup) return;
  const venueName = venueOf(pin?.data, fallbackVenue);
  if (!venueAllowed(venueName)) return;
  hits.push({
    hotspotId,
    episodeKey,
    venueName,
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    activeSinceMs,
  });
}

function sheetHits(events: unknown[][], readings: unknown[][], pins: LivePin[], nowMs: number): LiveHit[] {
  const parsed = parseSurgeSheet(events, readings);
  const byId = new Map(parsed.events.map((event) => [event.sheetEventId, event]));
  const yes = new Map<string, Array<{timeMs: number; pickup: string}>>();
  for (const row of rowsFromMatrix(readings)) {
    if (row.blank) continue;
    const values = row.values;
    const phase = phaseOf(values[PHASE]);
    if (phase !== "during" && phase !== "post") continue;
    const eventId = sheetEventKey(text(values[EVENT_ID]));
    const timeMs = parseSheetTime(values[TIME_UK], "uk") ?? parseSheetTime(values[TIME_UTC], "utc");
    if (!eventId || timeMs == null || timeMs > nowMs) continue;
    const event = byId.get(eventId);
    if (!event || !inEventWindow(timeMs, event)) continue;
    if (classifySurgeCheck(values, BASELINE_FARE) !== "yes") continue;
    const list = yes.get(eventId) ?? [];
    list.push({timeMs, pickup: text(values[PICKUP_POINT])});
    yes.set(eventId, list);
  }
  const hits: LiveHit[] = [];
  for (const [eventId, checks] of yes) {
    const event = byId.get(eventId);
    if (!event) continue;
    const eventReadings = parsed.readings.filter((reading) => reading.eventId === event.sheetEventId);
    if (surgeHasEnded(eventReadings, event, nowMs)) continue;
    const hotspotId = stadiumDocId(event.sheetEventId);
    if (!hotspotId) continue;
    const first = [...checks].sort((left, right) => left.timeMs - right.timeMs)[0];
    const pin = pins.find((item) => item.id === hotspotId);
    pushHit(
      hits,
      pin,
      hotspotId,
      `${hotspotId}|${first.timeMs}`,
      event.ground,
      first.pickup,
      event.pickups,
      first.timeMs,
    );
  }
  return hits;
}

function column(header: string[], names: readonly string[]): number {
  for (const name of names) {
    const index = header.findIndex((cell) => cell === name);
    if (index >= 0) return index;
  }
  return -1;
}

function cell(row: unknown[], index: number): unknown {
  return index < 0 ? "" : row[index];
}

function sourceKind(value: unknown): "hotspot" | "fixed" | "" {
  const key = text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (key === HOTSPOT_TEST_PINS) return "hotspot";
  if (key === "fixed places") return "fixed";
  return "";
}

interface WatchRow {
  placeId: string;
  source: "hotspot" | "fixed";
  phase: string;
  disruptionId: string;
  timeMs: number;
  pickup: string;
  backYes: boolean;
  values: Record<string, unknown>;
}

function watchRows(matrix: unknown[][]): WatchRow[] {
  const header = (matrix[0] ?? []).map((item) => text(item));
  const timeUk = column(header, ["Time (UK)", "Taken at (UK time)"]);
  const timeUtc = column(header, ["Time (UTC)"]);
  const place = column(header, ["Place ID"]);
  const source = column(header, ["Place source"]);
  const phase = column(header, [
    "Phase (Baseline / During / Post)",
    "Phase (Baseline / Pre / During / Post)",
    "Reading type",
  ]);
  const pickup = column(header, ["Pickup point", "Pickup point used"]);
  const did = column(header, ["Did it surge?"]);
  const fare = column(header, ["Fare shown (£)", "Price shown (GBP)"]);
  const baseline = column(header, ["Baseline fare (£)", "Normal price for this trip (GBP)"]);
  const uplift = column(header, ["Uplift %"]);
  const disruption = column(header, ["Disruption ID"]);
  const back = column(header, ["Back to baseline? (within 5%)"]);
  const rows: WatchRow[] = [];
  for (const row of matrix.slice(1)) {
    if (row.every((item) => item == null || item === "" || (typeof item === "string" && item.trim() === ""))) {
      continue;
    }
    const kind = sourceKind(cell(row, source));
    const placeId = text(cell(row, place));
    const phaseName = phaseOf(cell(row, phase));
    const disruptionId = text(cell(row, disruption));
    const timeMs = parseSheetTime(cell(row, timeUk), "uk") ?? parseSheetTime(cell(row, timeUtc), "utc");
    if (!kind || !placeId || !phaseName || !disruptionId || timeMs == null) continue;
    rows.push({
      placeId,
      source: kind,
      phase: phaseName,
      disruptionId,
      timeMs,
      pickup: text(cell(row, pickup)),
      backYes: text(cell(row, back)).toLowerCase() === "yes",
      values: {
        [DID_IT_SURGE]: cell(row, did),
        [FARE_SHOWN]: cell(row, fare),
        [BASELINE_FARE]: cell(row, baseline),
        [UPLIFT_PERCENT]: cell(row, uplift),
      },
    });
  }
  return rows;
}

function watchEnded(rows: WatchRow[]): boolean {
  const groups = new Map<string, WatchRow[]>();
  for (const row of rows) {
    if (row.phase !== "during" && row.phase !== "post") continue;
    const key = normLabel(row.pickup);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => left.timeMs - right.timeMs);
    for (let index = 1; index < list.length; index += 1) {
      if (list[index - 1].backYes && list[index].backYes) return true;
    }
  }
  return false;
}

function matchedPin(row: WatchRow, pins: LivePin[]): LivePin | undefined {
  if (row.source === "hotspot") return pins.find((pin) => pin.id === row.placeId);
  return pins.find((pin) => text(pin.data.fixedPlaceKey) === row.placeId);
}

function watchlistHits(matrix: unknown[][], pins: LivePin[], nowMs: number): LiveHit[] {
  const rows = watchRows(matrix).filter((row) => row.timeMs <= nowMs);
  const groups = new Map<string, WatchRow[]>();
  for (const row of rows) {
    const pin = matchedPin(row, pins);
    if (!pin) continue;
    const key = `${pin.id}\n${row.disruptionId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const hits: LiveHit[] = [];
  for (const [key, group] of groups) {
    if (watchEnded(group)) continue;
    const yes = group
      .filter((row) => row.phase === "during" || row.phase === "post")
      .filter((row) => classifySurgeCheck(row.values, BASELINE_FARE) === "yes")
      .sort((left, right) => left.timeMs - right.timeMs);
    if (yes.length === 0) continue;
    const first = yes[0];
    const pin = matchedPin(first, pins);
    if (!pin) continue;
    const [hotspotId, disruptionId] = key.split("\n");
    pushHit(hits, pin, hotspotId, `${hotspotId}|${disruptionId}`, "", first.pickup, [], first.timeMs);
  }
  return hits;
}

/* Real During and in-window Post checks only. Forecasts are not an input. */
export function findLiveSurges(input: {
  now: Date;
  events: unknown[][];
  readings: unknown[][];
  watchlist: unknown[][];
  pins: LivePin[];
}): LiveHit[] {
  const nowMs = input.now.getTime();
  const hits = [
    ...sheetHits(input.events, input.readings, input.pins, nowMs),
    ...watchlistHits(input.watchlist, input.pins, nowMs),
  ];
  hits.sort((left, right) => left.hotspotId.localeCompare(right.hotspotId) || left.activeSinceMs - right.activeSinceMs);
  return hits;
}

export function surgeActiveMessage(hit: LiveHit): SurgeActiveMessage {
  const data = {
    hotspotId: hit.hotspotId,
    venueName: hit.venueName,
    pickupLat: String(hit.pickupLat),
    pickupLng: String(hit.pickupLng),
    activeSince: new Date(hit.activeSinceMs).toISOString(),
  };
  assertNoPrices(data);
  return {
    topic: `surge_active_${geohash(hit.pickupLat, hit.pickupLng, 5)}`,
    data,
    apns: {
      payload: {
        aps: {
          alert: `Surge now at ${hit.venueName}`,
          mutableContent: true,
        },
      },
    },
    android: {priority: "high"},
  };
}

export async function runLiveSurgeAlerts(input: {
  enabled: boolean;
  /* null means the cap is not configured, so nothing stops the sends. */
  maxPerDay: number | null;
  sentToday: number;
  hits: LiveHit[];
  claim: (hit: LiveHit) => Promise<boolean>;
  send: (message: SurgeActiveMessage) => Promise<void>;
}): Promise<number> {
  if (!input.enabled || input.maxPerDay === 0) return 0;
  let sent = 0;
  for (const hit of input.hits) {
    if (input.maxPerDay != null && input.sentToday + sent >= input.maxPerDay) break;
    const claimed = await input.claim(hit);
    if (!claimed) continue;
    try {
      const message = surgeActiveMessage(hit);
      if ("notification" in message || message.android.priority !== "high") continue;
      await input.send(message);
    } catch (err) {
      logger.error("surge active alert was claimed and then not sent", {hotspotId: hit.hotspotId});
      logger.error("surge active alert send failed", err);
      continue;
    }
    sent += 1;
  }
  return sent;
}

function alreadyExists(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as {code?: unknown}).code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

/* Create the episode first. An existing row means this alert was already claimed. */
export async function claimSurgeAlert(db: Firestore, hit: LiveHit, now: Date): Promise<boolean> {
  try {
    await db.collection(SURGE_ALERTS).doc(hit.episodeKey).create({
      hotspotId: hit.hotspotId,
      activeSince: new Date(hit.activeSinceMs).toISOString(),
      claimedAt: Timestamp.fromDate(now),
    });
    return true;
  } catch (err) {
    if (alreadyExists(err)) return false;
    throw err;
  }
}

function capDoc(day: string): string {
  return `rateLimits/surgeActive_${day}`;
}

export async function dispatchLiveSurgeAlerts(input: {
  db: Firestore;
  now: Date;
  events: unknown[][];
  readings: unknown[][];
  watchlist: unknown[][];
  pins: LivePin[];
  send: (message: SurgeActiveMessage) => Promise<void>;
}): Promise<number> {
  if (!(await surgeActiveEnabled(input.db))) return 0;
  const maxPerDay = await maxAlertsPerDay(input.db);
  if (maxPerDay === 0) return 0;
  const day = londonDayKey(input.now);
  let sentToday = 0;
  if (maxPerDay != null) {
    const cap = await input.db.doc(capDoc(day)).get();
    const count = cap.get("count");
    sentToday = typeof count === "number" && Number.isFinite(count) ? count : 0;
    if (sentToday >= maxPerDay) return 0;
  }
  const hits = findLiveSurges(input);
  const sent = await runLiveSurgeAlerts({
    enabled: true,
    maxPerDay,
    sentToday,
    hits,
    claim: (hit) => claimSurgeAlert(input.db, hit, input.now),
    send: input.send,
  });
  if (sent > 0 && maxPerDay != null) {
    await input.db.doc(capDoc(day)).set({count: FieldValue.increment(sent), day}, {merge: true});
  }
  return sent;
}

export async function notifyLiveSurge(input: {
  db: Firestore;
  now: Date;
  sheetId: string;
  load: () => Promise<{events: unknown[][]; readings: unknown[][]; watchlist: unknown[][]}>;
  listPins: () => Promise<LivePin[]>;
  send: (message: SurgeActiveMessage) => Promise<void>;
}): Promise<number> {
  if (!input.sheetId.trim()) return 0;
  try {
    if (!(await surgeActiveEnabled(input.db))) return 0;
    if ((await maxAlertsPerDay(input.db)) === 0) return 0;
    const [tabs, pins] = await Promise.all([input.load(), input.listPins()]);
    return await dispatchLiveSurgeAlerts({
      db: input.db,
      now: input.now,
      events: tabs.events,
      readings: tabs.readings,
      watchlist: tabs.watchlist,
      pins,
      send: input.send,
    });
  } catch (err) {
    logger.error("surge active alerts failed", err);
    return 0;
  }
}

