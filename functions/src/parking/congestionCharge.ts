import {createHash} from "crypto";
import type {Firestore} from "firebase-admin/firestore";
import {ParkingPaymentError} from "./contract";
import {UK_BANK_HOLIDAYS} from "./privateSheet/ukBankHolidays.js";
import {addDays, londonInstant, londonMoment} from "./tariffNow";

/*
 * The London Congestion Charge, paid through Ferro (web contract 14.1d).
 *
 * The driver names the car and the day. The server prices it from
 * roadCharges/uk-lon-congestion-charge/rates: the standard price when paid on
 * the day (or before), the late price up to midnight on the 3rd charging day
 * after, and nothing after that (TfL sends a penalty). Ferro then pays TfL by
 * hand from the desk before that deadline. Off until
 * config/payments.congestionCharges is exactly true.
 */

export const CONGESTION_ROAD_CHARGE_ID = "uk-lon-congestion-charge";
export const CONGESTION_ZONE_NAME = "London Congestion Charge";
export const CONGESTION_PAY_URL = "https://tfl.gov.uk/modes/driving/congestion-charge/paying-the-congestion-charge";
const LATE_CHARGING_DAYS = 3;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export type CongestionBand = "standard" | "late";

export async function congestionChargesOn(db: Firestore): Promise<boolean> {
  return (await db.doc("config/payments").get()).get("congestionCharges") === true;
}

/*
 * TfL charges every day except from Christmas Day to the New Year's Day bank
 * holiday, inclusive. Null for an early-January day in a year the bank
 * holiday table doesn't cover.
 */
export function isCongestionChargingDay(day: string): boolean | null {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (month === 12 && date >= 25) return false;
  if (month === 1 && date <= 3) {
    const newYear = UK_BANK_HOLIDAYS.ew.find((holiday) => holiday.startsWith(`${day.slice(0, 4)}-01-`));
    if (!newYear) return null;
    return day > newYear;
  }
  return true;
}

/* The last day a late payment is taken: the 3rd charging day after travel. Null when unknown. */
export function lateDeadlineDay(travelDay: string): string | null {
  let day = travelDay;
  let counted = 0;
  for (let i = 0; i < 20 && counted < LATE_CHARGING_DAYS; i += 1) {
    day = addDays(day, 1);
    const charging = isCongestionChargingDay(day);
    if (charging === null) return null;
    if (charging) counted += 1;
  }
  return counted === LATE_CHARGING_DAYS ? day : null;
}

export interface CongestionDay {
  band: CongestionBand;
  /* The last day TfL takes payment, and the instant it ends (midnight, London). */
  deadlineDay: string;
  deadlineAtMs: number;
}

/* Which price applies to paying for `travelDay` now, or why it can't be paid. */
export function congestionDay(nowMs: number, travelDay: string): CongestionDay {
  if (!DAY_KEY.test(travelDay) || addDays(travelDay, 0) !== travelDay) {
    throw new ParkingPaymentError("invalid-argument", "This payment request isn't valid.");
  }
  const today = londonMoment(nowMs).day;
  if (travelDay > today) {
    throw new ParkingPaymentError("invalid-argument", "You can pay for today or the last 3 charging days.");
  }
  const charging = isCongestionChargingDay(travelDay);
  if (charging === false) {
    throw new ParkingPaymentError("no-charge-now", "There's no Congestion Charge on that day.");
  }
  const deadlineDay = charging === null ? null : lateDeadlineDay(travelDay);
  if (deadlineDay === null) {
    throw new ParkingPaymentError("failed-precondition", "We can't price the Congestion Charge for that day.");
  }
  if (today > deadlineDay) {
    throw new ParkingPaymentError("past-deadline",
      "It's too late to pay this charge. If TfL sends a penalty notice, pay it on TfL's site.");
  }
  return {
    band: today === travelDay ? "standard" : "late",
    deadlineDay,
    deadlineAtMs: londonInstant(addDays(deadlineDay, 1), 0),
  };
}

/* The car price for this band from the published rates, in pence. */
export async function congestionRatePence(db: Firestore, band: CongestionBand): Promise<number> {
  const doc = db.collection("roadCharges").doc(CONGESTION_ROAD_CHARGE_ID);
  const [zone, rates] = await Promise.all([doc.get(), doc.collection("rates").get()]);
  const unavailable = new ParkingPaymentError("failed-precondition", "Congestion Charge payments aren't available right now.");
  if (!zone.exists || (zone.get("status") !== undefined && zone.get("status") !== "active")) throw unavailable;
  for (const rate of rates.docs) {
    if (rate.get("vehicle_class") !== "car" || rate.get("payment_method") !== band) continue;
    if (rate.get("unit") !== undefined && rate.get("unit") !== "per_day") continue;
    const pounds = rate.get("amount_gbp");
    if (typeof pounds !== "number" || !Number.isFinite(pounds)) continue;
    const pence = Math.round(pounds * 100);
    if (pence >= 100 && pence <= 10_000) return pence;
  }
  throw unavailable;
}

/*
 * One car and one day is one charge, whoever pays it. The id hides the
 * registration: the plate never lives on parkingPayments.
 */
export function congestionVisitId(travelDay: string, plate: string): string {
  const digest = createHash("sha256").update(`${CONGESTION_ROAD_CHARGE_ID}:${travelDay}:${plate}`).digest("hex");
  return `cc_${digest.slice(0, 32)}`;
}
