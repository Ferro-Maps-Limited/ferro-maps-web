import type {Firestore} from "firebase-admin/firestore";
import {canonicalOperator, httpsUrl, ParkingPaymentError, type ParkingErrorCode} from "./contract";
import type {PlaceRates, RateSet} from "./privateSheet/types.js";
import {priceExtension, priceStay, type PriceRefusal} from "./tariffNow";

/*
 * Ferro takes the payment at every payable car park, not only places marked
 * in-app (product decision, 24 Nov). Ferro then pays the operator by hand from the
 * authority desk. Off until config/payments.ferroCollectsAll is exactly true.
 *
 * The price comes from the private parking sheet, as published to
 * privateParkingCells/{geohash6} (and shards {geohash6}_1..8). The phone sends
 * the place's cell, because place ids are hashes and say nothing about where
 * a place is.
 */

export const PRIVATE_PARKING_CELLS = "privateParkingCells";
const MAX_SHARDS = 8;
const CELL_PATTERN = /^[0-9b-hjkmnp-z]{6}(?:_[1-8])?$/;

export const SHEET_MIN_DURATION_MINUTES = 15;
export const SHEET_MAX_DURATION_MINUTES = 1440;

export async function ferroCollectsAll(db: Firestore): Promise<boolean> {
  return (await db.doc("config/payments").get()).get("ferroCollectsAll") === true;
}

/*
 * Stepped prices by day and time (`rates` on FM-PP town car parks). Off until
 * config/payments.steppedTariffs is exactly true. While off, only a single
 * `fee` can be paid, as before.
 */
export async function steppedTariffsOn(db: Firestore): Promise<boolean> {
  return (await db.doc("config/payments").get()).get("steppedTariffs") === true;
}

/* "gcpvj0" or a shard id "gcpvj0_3" -> "gcpvj0". Anything else -> null. */
export function baseCell(value: unknown): string | null {
  if (typeof value !== "string" || !CELL_PATTERN.test(value)) return null;
  return value.slice(0, 6);
}

function placeIn(data: Record<string, unknown> | undefined, placeId: string): Record<string, unknown> | null {
  const places = data?.places;
  if (!Array.isArray(places)) return null;
  for (const item of places) {
    if (item && typeof item === "object" && !Array.isArray(item) && (item as {id?: unknown}).id === placeId) {
      return item as Record<string, unknown>;
    }
  }
  return null;
}

/* The published sheet place in that cell or one of its shards, or null. */
export async function findSheetPlace(
  db: Firestore,
  cell: string,
  placeId: string,
): Promise<Record<string, unknown> | null> {
  const cells = db.collection(PRIVATE_PARKING_CELLS);
  const base = await cells.doc(cell).get();
  if (!base.exists) return null;
  const found = placeIn(base.data(), placeId);
  if (found) return found;
  const shards = base.get("shards");
  const count = typeof shards === "number" && Number.isSafeInteger(shards) ?
    Math.min(Math.max(shards, 0), MAX_SHARDS) : 0;
  if (count === 0) return null;
  const refs = Array.from({length: count}, (_, i) => cells.doc(`${cell}_${i + 1}`));
  for (const snap of await db.getAll(...refs)) {
    const hit = snap.exists ? placeIn(snap.data(), placeId) : null;
    if (hit) return hit;
  }
  return null;
}

function wholeNumber(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;
}

function rateSet(value: unknown): RateSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const set = value as Record<string, unknown>;
  const d = wholeNumber(set.d, 0);
  const f = wholeNumber(set.f, 0);
  const t = wholeNumber(set.t, 1);
  if (d === null || d > 127 || f === null || t === null || f >= t || t > 1440) return null;
  if (set.bh !== undefined && set.bh !== 1) return null;
  if (d === 0 && set.bh !== 1) return null;
  const b = set.b;
  if (!Array.isArray(b) || b.length < 2 || b.length % 2 !== 0) return null;
  for (let i = 0; i < b.length; i += 2) {
    const upTo = wholeNumber(b[i], 1);
    const pence = wholeNumber(b[i + 1], 0);
    if (upTo === null || pence === null || upTo > 1440) return null;
    if (i > 0 && (upTo <= (b[i - 2] as number) || pence < (b[i - 1] as number))) return null;
  }
  return {d, ...(set.bh === 1 ? {bh: 1 as const} : {}), f, t, b: b as number[]};
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/* The published price list, or null when it is missing or not well formed. */
export function sheetRates(p: Record<string, unknown>): PlaceRates | null {
  const value = p.rates;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rates = value as Record<string, unknown>;
  if (rates.v !== 1 || !Array.isArray(rates.s) || rates.s.length === 0 || rates.s.length > 12) return null;
  if (typeof rates.ht !== "string" || !DAY_KEY.test(rates.ht) || !Array.isArray(rates.h)) return null;
  if (!rates.h.every((day) => typeof day === "string" && DAY_KEY.test(day))) return null;
  const sets: RateSet[] = [];
  for (const item of rates.s) {
    const set = rateSet(item);
    if (!set) return null;
    sets.push(set);
  }
  return {v: 1, s: sets, h: rates.h as string[], ht: rates.ht};
}

/*
 * The apps' "Pay or Ignore" rule: verified Yes, autopay ticked, a published
 * fee, never permit-only, and a confidence that isn't low. With stepped
 * prices on, a price list counts as a published fee.
 */
export function sheetPayable(p: Record<string, unknown>, opts: {stepped?: boolean} = {}): boolean {
  const conf = p.conf;
  if (conf !== undefined && (typeof conf !== "number" || conf < 0.5)) return false;
  // Ferro Pay Mode "off" in the sheet: no online way to pay this operator.
  if (typeof p.payMode === "string" && p.payMode.toLowerCase() === "off") return false;
  const priced = wholeNumber(p.fee, 1) !== null || (opts.stepped === true && sheetRates(p) !== null);
  return p.q === "known" &&
    p.s === 1 &&
    p.auto === true &&
    priced &&
    typeof p.aud === "string" && p.aud !== "p";
}

/*
 * Who Ferro pays: a brand-named operator wins, then a brand-named location
 * provider, then the operator (or location provider) as the sheet names it.
 * Staff pay any operator that takes payment online (product decision, 24 Nov).
 */
export function sheetOperator(p: Record<string, unknown>): string | null {
  return canonicalOperator(p.operator) ?? canonicalOperator(p.locationProvider) ??
    payeeText(p.operator) ?? payeeText(p.locationProvider);
}

/* Whitespace collapsed, at most 40 characters (the apps cut it the same way). */
export function payeeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.split(/\s+/).filter(Boolean).join(" ");
  return s ? s.slice(0, 40) : null;
}

function operatorKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* The phone's operator against the place's: same letters and digits, ignoring case and punctuation. */
export function sameOperator(placeOperator: string, requested: string): boolean {
  const a = operatorKey(placeOperator);
  const b = operatorKey(requested);
  return a.length > 0 && a === b;
}

/* Where staff pay: the brand's site, else the car park's own source page, else a search for it. */
export function sheetPaymentUrl(
  p: Record<string, unknown>,
  operator: string,
  brandUrl: (op: string) => string,
): string {
  if (canonicalOperator(operator)) return brandUrl(operator);
  return httpsUrl(p.src) ??
    `https://www.google.com/search?q=${encodeURIComponent(`${operator} ${String(p.n ?? "")} pay for parking online`.trim())}`;
}

export interface SheetStay {
  parkingPence: number;
  /* Set only when the price depends on it (an hourly tariff or a price list). */
  durationMinutes: number | null;
  /* A price list's band, which staff buy at the operator. */
  tariffBand?: string;
}

/* The clock price lists are read on. Tests set it to a fixed time of day. */
export const pricingClock = {nowMs: (): number => Date.now()};

const REFUSAL_CODES: Record<PriceRefusal["code"], ParkingErrorCode> = {
  "no-charge-now": "no-charge-now",
  "price-unknown": "failed-precondition",
  "duration-invalid": "duration-invalid",
  "nothing-to-pay": "duration-invalid",
  "new-stay-needed": "stay-ended",
};

/*
 * A price list: the band for the stay from now, cut at the end of charging
 * time. Added time pays the band for the whole stay less what it has paid.
 * The phone sends the minutes it shows on the option (1 to 1440).
 */
export function sheetRatesStay(
  rates: PlaceRates,
  durationMinutes: unknown,
  maxMinutes: number | null,
  opts: {nowMs?: number; extension?: {startMs: number; paidUntilMs: number; paidPence: number}} = {},
): SheetStay {
  if (durationMinutes === undefined || durationMinutes === null) {
    throw new ParkingPaymentError("duration-required", "Say how many minutes you are staying.");
  }
  const minutes = wholeNumber(durationMinutes, 1);
  if (minutes === null || minutes > SHEET_MAX_DURATION_MINUTES) {
    throw new ParkingPaymentError("duration-invalid", "That stay length isn't one we can price.");
  }
  const nowMs = opts.nowMs ?? pricingClock.nowMs();
  const priced = opts.extension ?
    priceExtension(rates, nowMs, opts.extension, minutes, maxMinutes) :
    priceStay(rates, nowMs, minutes, maxMinutes);
  if (!priced.ok) throw new ParkingPaymentError(REFUSAL_CODES[priced.code], priced.message);
  return {parkingPence: priced.pence, durationMinutes: priced.minutes, tariffBand: priced.label};
}

/*
 * Per visit, per day or no unit: the fee, whatever the stay. No length needed.
 * Per hour: each started hour after the free time costs the fee, so the stay
 * length is required and must fit the car park's maximum stay.
 */
export function sheetStayPence(
  p: Record<string, unknown>,
  durationMinutes: unknown,
  opts: {extension?: boolean} = {},
): SheetStay {
  const fee = wholeNumber(p.fee, 1);
  if (fee === null) {
    throw new ParkingPaymentError("failed-precondition", "This place doesn't have a price set.");
  }
  if (p.feeUnit !== "hour") return {parkingPence: fee, durationMinutes: null};
  if (durationMinutes === undefined || durationMinutes === null) {
    throw new ParkingPaymentError("duration-required", "Say how many minutes you are staying.");
  }
  const minutes = wholeNumber(durationMinutes, SHEET_MIN_DURATION_MINUTES);
  if (minutes === null || minutes > SHEET_MAX_DURATION_MINUTES) {
    throw new ParkingPaymentError("duration-invalid", "That stay length isn't one we can price.");
  }
  const max = wholeNumber(p.max, 1);
  if (max !== null && minutes > max) {
    throw new ParkingPaymentError("duration-invalid", "That's longer than this car park's maximum stay.");
  }
  // Added time comes after the stay already paid for, so the free time is used up.
  const free = opts.extension ? 0 : wholeNumber(p.free, 0) ?? 0;
  const chargeable = minutes - free;
  if (chargeable <= 0) {
    throw new ParkingPaymentError("duration-invalid", "That stay is inside the free time, so there's nothing to pay.");
  }
  return {parkingPence: fee * Math.ceil(chargeable / 60), durationMinutes: minutes};
}

export function sheetLocationCode(p: Record<string, unknown>): string | null {
  const code = p.locationCode;
  return typeof code === "string" && code.trim() ? code.trim().slice(0, 32) : null;
}
