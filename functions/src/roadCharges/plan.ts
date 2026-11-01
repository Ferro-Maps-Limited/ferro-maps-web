import {addDays, londonWallTime} from "../admin/london.js";
import {
  containsForbiddenPricing,
  ENTRY_TTL_MS,
  isClosedDay,
  isFutureTravelDate,
  isLondonDayKey,
  isZoneType,
  parseRoadChargeConfig,
  payByInstant,
  type PaymentMethod,
  type RoadChargeConfig,
  type ZoneType,
} from "./config.js";
import {manualCcIsLate, priceRoadCharge} from "./price.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ClientZoneEntry {
  uid: string;
  entryId: string;
  type: string;
  travelDate: string;
  activeVehicleId: string;
  zoneVersion: string;
  createdAt: Date;
}

export interface VehicleInput {
  exists: boolean;
  ulezCompliant?: boolean;
  paymentMethod?: string;
  type?: string;
  fuel?: string;
  isPHV?: boolean;
  isWAV?: boolean;
}

export type HistoryStatus = "autopay" | "unpaid" | "not_charged";
export type TripSource = "zone-entry" | "manual";

export interface HistoryWrite {
  v: 1;
  uid: string;
  type: ZoneType;
  activeVehicleId: string;
  travelDate: string;
  method: PaymentMethod;
  chargePence: number;
  ruleId: string;
  bookingCondition: boolean;
  zoneVersion: string;
  zoneEntryId: string;
  status: HistoryStatus;
  source: TripSource;
  createdAt: Date;
}

export interface EntryPatch {
  uid: string;
  reminderState: "due" | "skip" | "failed" | "expired";
  reminderReason: string;
  expireAt: Date;
  processedAt: Date;
  sendAttempts: number;
  reminderEligible: boolean;
  method?: PaymentMethod;
  chargePence?: number;
  ruleId?: string;
  bookingCondition?: boolean;
  latePence?: number;
  lateRuleId?: string;
  payByAt?: Date;
  reminder1At?: Date;
  reminder2At?: Date;
  nextReminderSlot?: 1 | 2;
  nextReminderAt?: Date;
  configZoneVersion?: string;
}

export interface ZoneEntryPlan {
  historyId: string | null;
  history: HistoryWrite | null;
  patch: EntryPatch;
}

export type ReminderSlot = 1 | 2;

export interface DueZoneEntry {
  uid: string;
  entryId: string;
  type: ZoneType;
  travelDate: string;
  activeVehicleId: string;
  chargePence: number;
  ruleId: string;
  bookingCondition: boolean;
  latePence?: number;
  lateRuleId?: string;
  payByAt: Date;
  reminder1At: Date;
  reminder2At: Date;
  nextReminderSlot: ReminderSlot;
  nextReminderAt: Date;
  expireAt: Date;
  zoneVersion: string;
  sendAttempts: number;
}

export interface DeviceToken {
  deviceId: string;
  token: string;
  platform: string;
  updatedAtMs: number;
}

export interface ResolvedToken {
  token: string;
  /** Null when the token came from the legacy user field. */
  deviceId: string | null;
}

export interface ReminderMessage {
  token: string;
  collapseKey: string;
  notification: {title: string; body: string};
    data: {
      type: "road_charge_reminder";
      v: "1";
      zone: ZoneType;
      travelDate: string;
      payByAt: string;
      chargePence: string;
      ruleId: string;
      bookingCondition: string;
      zoneVersion: string;
      entryId: string;
      slot: "1" | "2";
    };
}

export type DueClass = "send" | "expired" | "bad" | "wait";

export function historyDocId(type: string, activeVehicleId: string, travelDate: string): string {
  return `${type}_${activeVehicleId}_${travelDate}`;
}

export function reminderTimes(travelDate: string, payByDaysAfter: number): {
  reminder1At: Date;
  reminder2At: Date;
  payByAt: Date;
} {
  return {
    reminder1At: londonWallTime(travelDate, 17, 30),
    reminder2At: londonWallTime(addDays(travelDate, payByDaysAfter), 20, 0),
    payByAt: payByInstant(travelDate, payByDaysAfter),
  };
}

export function alreadyProcessed(data: Record<string, unknown> | undefined): boolean {
  return typeof data?.reminderState === "string";
}

function expireAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + ENTRY_TTL_MS);
}

function basePatch(entry: ClientZoneEntry, now: Date, state: EntryPatch["reminderState"], reason: string): EntryPatch {
  return {
    uid: entry.uid,
    reminderState: state,
    reminderReason: reason,
    expireAt: expireAt(entry.createdAt),
    processedAt: now,
    sendAttempts: 0,
    reminderEligible: false,
  };
}

function vehicleMethod(vehicle: VehicleInput): PaymentMethod | null {
  if (!vehicle.exists) return null;
  if (vehicle.paymentMethod === "autopay" || vehicle.paymentMethod === "manual") {
    return vehicle.paymentMethod;
  }
  return null;
}

function historyFor(
  entry: ClientZoneEntry,
  type: ZoneType,
  method: PaymentMethod,
  chargePence: number,
  ruleId: string,
  bookingCondition: boolean,
  zoneVersion: string,
  status: HistoryStatus,
  source: TripSource,
): HistoryWrite {
  return {
    v: 1,
    uid: entry.uid,
    type,
    activeVehicleId: entry.activeVehicleId,
    travelDate: entry.travelDate,
    method,
    chargePence,
    ruleId,
    bookingCondition,
    zoneVersion,
    zoneEntryId: entry.entryId,
    status,
    source,
    createdAt: entry.createdAt,
  };
}

// History row and server fields for one new zone entry. The clock inside the
// operating window, and the point against the boundary, stay on the client.
export function planZoneEntry(
  entry: ClientZoneEntry,
  vehicle: VehicleInput,
  configRaw: unknown,
  now: Date,
  source: TripSource = "zone-entry",
): ZoneEntryPlan {
  const failed = (reason: string): ZoneEntryPlan => ({
    historyId: null,
    history: null,
    patch: basePatch(entry, now, "failed", reason),
  });

  if (!isZoneType(entry.type) || entry.entryId !== `${entry.type}_${entry.travelDate}`) return failed("bad-entry");
  if (!isLondonDayKey(entry.travelDate)) return failed("bad-entry");
  if (!/^([A-Za-z0-9_-]{1,64})$/.test(entry.activeVehicleId)) return failed("bad-entry");
  if (Number.isNaN(entry.createdAt.getTime())) return failed("bad-entry");
  if (isFutureTravelDate(entry.travelDate, now)) return failed("future-date");

  const parsed = parseRoadChargeConfig(entry.type, configRaw);
  if (!parsed.ok) return failed(parsed.reason);
  const config = parsed.config;

  const method = vehicleMethod(vehicle);
  const times = reminderTimes(entry.travelDate, config.payByDaysAfter);
  const payByAt = times.payByAt;
  const closed = isClosedDay(config, entry.travelDate);
  const deadlinePassed = now.getTime() >= payByAt.getTime();
  const late = manualCcIsLate(entry.travelDate, now);
  const quote = priceRoadCharge(entry.type, vehicle, config, late);
  const lateQuote = priceRoadCharge(entry.type, vehicle, config, true);

  let reminderState: EntryPatch["reminderState"] = "due";
  let reminderReason = "unpaid";
  let status: HistoryStatus = "unpaid";
  let chargePence = quote.pence;
  let ruleId = quote.ruleId;
  let recordedMethod: PaymentMethod = method ?? "unknown";

  if (!method) {
    reminderState = "skip";
    reminderReason = "vehicle-unknown";
    status = "not_charged";
    chargePence = 0;
    ruleId = "vehicle-unknown";
    recordedMethod = "unknown";
  } else if (closed) {
    reminderState = "skip";
    reminderReason = "closed";
    status = "not_charged";
    chargePence = 0;
    ruleId = "closed";
  } else if (chargePence <= 0) {
    reminderState = "skip";
    reminderReason = ruleId === "ulez-compliant" ? "ulez-compliant" : "no-charge";
    status = "not_charged";
  } else if (method === "autopay") {
    reminderState = "skip";
    reminderReason = "autopay";
    status = "autopay";
  } else if (deadlinePassed) {
    reminderState = "expired";
    reminderReason = "deadline-passed";
    status = "unpaid";
  }

  const history = historyFor(
    entry, entry.type, recordedMethod, chargePence, ruleId, quote.bookingCondition,
    config.zoneVersion, status, source,
  );
  const due = reminderState === "due";
  const patch: EntryPatch = {
    ...basePatch(entry, now, reminderState, reminderReason),
    reminderEligible: due,
    method: recordedMethod,
    chargePence,
    ruleId,
    bookingCondition: quote.bookingCondition,
    ...(lateQuote.pence !== chargePence ? {latePence: lateQuote.pence, lateRuleId: lateQuote.ruleId} : {}),
    payByAt,
    reminder1At: times.reminder1At,
    reminder2At: times.reminder2At,
    ...(due ? {nextReminderSlot: 1 as const, nextReminderAt: times.reminder1At} : {}),
    configZoneVersion: config.zoneVersion,
  };
  if (containsForbiddenPricing(history) || containsForbiddenPricing(patch)) return failed("bad-entry");
  return {
    historyId: historyDocId(entry.type, entry.activeVehicleId, entry.travelDate),
    history,
    patch,
  };
}

export function classifyDue(entry: DueZoneEntry, now: Date): DueClass {
  if (!isZoneType(entry.type)) return "bad";
  if (!Number.isInteger(entry.chargePence) || entry.chargePence <= 0) return "bad";
  if (Number.isNaN(entry.payByAt.getTime()) || Number.isNaN(entry.expireAt.getTime())) return "bad";
  if (entry.nextReminderSlot !== 1 && entry.nextReminderSlot !== 2) return "bad";
  if (now.getTime() >= entry.payByAt.getTime()) return "expired";
  if (now.getTime() >= entry.expireAt.getTime()) return "expired";
  const slotAt = entry.nextReminderSlot === 1 ? entry.reminder1At : entry.reminder2At;
  if (now.getTime() < slotAt.getTime()) return "wait";
  return "send";
}

export function formatGbp(pence: number): string {
  const pounds = Math.trunc(pence / 100);
  const rest = Math.abs(pence % 100);
  return `£${pounds}.${String(rest).padStart(2, "0")}`;
}

export function formatTravelDate(travelDate: string): string {
  const [year, month, day] = travelDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export function buildReminderMessage(entry: DueZoneEntry, token: string): ReminderMessage {
  const title = entry.type === "cc" ? "Congestion Charge" : "ULEZ";
  const useLate = entry.nextReminderSlot === 2 && entry.latePence != null && entry.lateRuleId != null;
  const pence = useLate ? entry.latePence ?? entry.chargePence : entry.chargePence;
  const ruleId = useLate ? entry.lateRuleId ?? entry.ruleId : entry.ruleId;
  const body =
    `Pay TfL for ${formatTravelDate(entry.travelDate)} by midnight. ` +
    `The daily charge is ${formatGbp(pence)}.`;
  return {
    token,
    collapseKey: `${entry.type}_${entry.travelDate}_${entry.nextReminderSlot}`,
    notification: {title, body},
    data: {
      type: "road_charge_reminder",
      v: "1",
      zone: entry.type,
      travelDate: entry.travelDate,
      payByAt: String(entry.payByAt.getTime()),
      chargePence: String(pence),
      ruleId,
      bookingCondition: entry.bookingCondition ? "1" : "0",
      zoneVersion: entry.zoneVersion,
      entryId: entry.entryId,
      slot: entry.nextReminderSlot === 1 ? "1" : "2",
    },
  };
}

// Subcollection tokens win. The legacy fcmToken field is used only when that
// subcollection has nothing sendable. Duplicate token strings collapse.
export function resolveTokens(devices: DeviceToken[], legacy: string | null, limit: number): ResolvedToken[] {
  const sorted = devices
    .filter((device) =>
      device.token.trim().length > 0 &&
      (device.platform === "ios" || device.platform === "android"))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  const seen = new Set<string>();
  const chosen: ResolvedToken[] = [];
  for (const device of sorted) {
    const token = device.token.trim();
    if (seen.has(token)) continue;
    seen.add(token);
    chosen.push({token, deviceId: device.deviceId});
    if (chosen.length >= limit) break;
  }
  if (chosen.length > 0) return chosen;
  const fallback = legacy?.trim() ?? "";
  if (!fallback) return [];
  return [{token: fallback, deviceId: null}];
}

export function isGoldAt(subscriptionExpiresAtMs: number | null, now: Date): boolean {
  return subscriptionExpiresAtMs != null && subscriptionExpiresAtMs > now.getTime();
}

/** The config type is re-exported for callers that only need the plan. */
export type {RoadChargeConfig};
