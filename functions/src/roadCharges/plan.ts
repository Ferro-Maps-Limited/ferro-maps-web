import {
  containsForbiddenPricing,
  ENTRY_TTL_MS,
  isClosedDay,
  isFutureTravelDate,
  isLondonDayKey,
  isZoneType,
  parseRoadChargeConfig,
  payByInstant,
  reminderInstant,
  type PaymentMethod,
  type RoadChargeConfig,
  type ZoneType,
} from "./config.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ClientZoneEntry {
  uid: string;
  entryId: string;
  type: string;
  travelDate: string;
  vehicleId: string;
  zoneVersion: string;
  createdAt: Date;
}

export interface VehicleInput {
  exists: boolean;
  ulezCompliant?: boolean;
  paymentMethod?: string;
}

export type HistoryStatus = "autopay" | "unpaid" | "not_charged";

export interface HistoryWrite {
  v: 1;
  uid: string;
  type: ZoneType;
  vehicleId: string;
  travelDate: string;
  method: PaymentMethod;
  chargePence: number;
  zoneVersion: string;
  zoneEntryId: string;
  status: HistoryStatus;
  createdAt: Date;
}

export interface EntryPatch {
  uid: string;
  reminderState: "due" | "skip" | "failed" | "expired";
  reminderReason: string;
  expireAt: Date;
  processedAt: Date;
  sendAttempts: number;
  method?: PaymentMethod;
  chargePence?: number;
  payByAt?: Date;
  reminderDueAt?: Date;
  configZoneVersion?: string;
}

export interface ZoneEntryPlan {
  historyId: string | null;
  history: HistoryWrite | null;
  patch: EntryPatch;
}

export interface DueZoneEntry {
  uid: string;
  entryId: string;
  type: ZoneType;
  travelDate: string;
  chargePence: number;
  payByAt: Date;
  reminderDueAt: Date;
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
    zoneVersion: string;
    entryId: string;
  };
}

export type DueClass = "send" | "expired" | "bad" | "wait";

export function historyDocId(type: string, vehicleId: string, travelDate: string): string {
  return `${type}_${vehicleId}_${travelDate}`;
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
  zoneVersion: string,
  status: HistoryStatus,
): HistoryWrite {
  return {
    v: 1,
    uid: entry.uid,
    type,
    vehicleId: entry.vehicleId,
    travelDate: entry.travelDate,
    method,
    chargePence,
    zoneVersion,
    zoneEntryId: entry.entryId,
    status,
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
): ZoneEntryPlan {
  const failed = (reason: string): ZoneEntryPlan => ({
    historyId: null,
    history: null,
    patch: basePatch(entry, now, "failed", reason),
  });

  if (!isZoneType(entry.type) || entry.entryId !== `${entry.type}_${entry.travelDate}`) return failed("bad-entry");
  if (!isLondonDayKey(entry.travelDate)) return failed("bad-entry");
  if (!/^([A-Za-z0-9_-]{1,64})$/.test(entry.vehicleId)) return failed("bad-entry");
  if (Number.isNaN(entry.createdAt.getTime())) return failed("bad-entry");
  if (isFutureTravelDate(entry.travelDate, now)) return failed("future-date");

  const parsed = parseRoadChargeConfig(entry.type, configRaw);
  if (!parsed.ok) return failed(parsed.reason);
  const config = parsed.config;

  const method = vehicleMethod(vehicle);
  const payByAt = payByInstant(entry.travelDate, config.payByDaysAfter);
  const reminderDueAt = reminderInstant(payByAt, config.reminderLeadMinutes);
  const compliant = entry.type === "ulez" && vehicle.ulezCompliant === true;
  const closed = isClosedDay(config, entry.travelDate);
  const deadlinePassed = now.getTime() >= payByAt.getTime();

  let reminderState: EntryPatch["reminderState"] = "due";
  let reminderReason = "unpaid";
  let status: HistoryStatus = "unpaid";
  let chargePence = config.lateChargePence;
  let recordedMethod: PaymentMethod = method ?? "unknown";

  if (!method) {
    reminderState = "skip";
    reminderReason = "vehicle-unknown";
    status = "not_charged";
    chargePence = 0;
    recordedMethod = "unknown";
  } else if (closed) {
    reminderState = "skip";
    reminderReason = "closed";
    status = "not_charged";
    chargePence = 0;
  } else if (compliant) {
    reminderState = "skip";
    reminderReason = "ulez-compliant";
    status = "not_charged";
    chargePence = 0;
  } else if (method === "autopay") {
    reminderState = "skip";
    reminderReason = "autopay";
    status = "autopay";
    chargePence = config.chargePence;
  } else if (config.lateChargePence <= 0) {
    reminderState = "skip";
    reminderReason = "no-charge";
    status = "not_charged";
    chargePence = 0;
  } else if (deadlinePassed) {
    reminderState = "expired";
    reminderReason = "deadline-passed";
    status = "unpaid";
    chargePence = config.lateChargePence;
  }

  const history = historyFor(entry, entry.type, recordedMethod, chargePence, config.zoneVersion, status);
  const patch: EntryPatch = {
    ...basePatch(entry, now, reminderState, reminderReason),
    method: recordedMethod,
    chargePence,
    payByAt,
    reminderDueAt,
    configZoneVersion: config.zoneVersion,
  };
  if (containsForbiddenPricing(history) || containsForbiddenPricing(patch)) return failed("bad-entry");
  return {
    historyId: historyDocId(entry.type, entry.vehicleId, entry.travelDate),
    history,
    patch,
  };
}

export function classifyDue(entry: DueZoneEntry, now: Date): DueClass {
  if (!isZoneType(entry.type)) return "bad";
  if (!Number.isInteger(entry.chargePence) || entry.chargePence <= 0) return "bad";
  if (Number.isNaN(entry.payByAt.getTime()) || Number.isNaN(entry.expireAt.getTime())) return "bad";
  if (now.getTime() >= entry.payByAt.getTime()) return "expired";
  if (now.getTime() >= entry.expireAt.getTime()) return "expired";
  if (now.getTime() < entry.reminderDueAt.getTime()) return "wait";
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
  const body =
    `Pay TfL for ${formatTravelDate(entry.travelDate)} by midnight. ` +
    `The daily charge is ${formatGbp(entry.chargePence)}.`;
  return {
    token,
    collapseKey: `${entry.type}_${entry.travelDate}`,
    notification: {title, body},
    data: {
      type: "road_charge_reminder",
      v: "1",
      zone: entry.type,
      travelDate: entry.travelDate,
      payByAt: String(entry.payByAt.getTime()),
      chargePence: String(entry.chargePence),
      zoneVersion: entry.zoneVersion,
      entryId: entry.entryId,
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
