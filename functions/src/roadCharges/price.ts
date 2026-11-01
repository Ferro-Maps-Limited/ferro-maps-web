import {londonDayKey} from "../admin/london.js";
import type {RoadChargeConfig, ZoneType} from "./config.js";

export const TFL_PAY = "https://tfl.gov.uk/modes/driving/congestion-charge/paying-the-congestion-charge";
export const TFL_CHG = "https://tfl.gov.uk/modes/driving/congestion-charge/congestion-charge-changes";
export const TFL_DE = "https://tfl.gov.uk/modes/driving/congestion-charge/discounts-and-exemptions";
export const TFL_PHV = "https://tfl.gov.uk/info-for/taxis-and-private-hire/phvs-and-the-congestion-charge";
export const TFL_CC = "https://tfl.gov.uk/modes/driving/congestion-charge";
export const TFL_ULEZ = "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone";
export const TFL_UPAY = "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/ulez-payments";
export const TFL_UDE = "https://tfl.gov.uk/modes/driving/ultra-low-emission-zone/discounts-and-exemptions";

// From 4 March 2030 TfL's published step-down is 12.5% for electric cars on Auto Pay
// and 25% for electric vans, HGVs and quadricycles on Auto Pay (TFL_DE).
// That change is a future config update. It is not a code change. Do not hard-code it.

export interface VehicleFacts {
  type?: string;
  fuel?: string;
  isPHV?: boolean;
  isWAV?: boolean;
  ulezCompliant?: boolean;
  paymentMethod?: string;
}

export interface PriceQuote {
  pence: number;
  ruleId: string;
  /** True for a WAV private-hire vehicle. The price is still the normal charge. */
  bookingCondition: boolean;
}

function bookingOnly(vehicle: VehicleFacts): boolean {
  return vehicle.isPHV === true && vehicle.isWAV === true;
}

function fullCc(config: RoadChargeConfig, manualLate: boolean, bookingCondition: boolean): PriceQuote {
  if (manualLate) {
    return {pence: config.ccLate.pence, ruleId: "cc-late", bookingCondition};
  }
  return {pence: config.ccStandard.pence, ruleId: "cc-standard", bookingCondition};
}

// Server price for one zone. Apps display this figure. They do not recompute it.
// manualLate is true when a manual CC is priced after the London travel day.
export function priceRoadCharge(
  zone: ZoneType,
  vehicle: VehicleFacts,
  config: RoadChargeConfig,
  manualLate: boolean,
): PriceQuote {
  const bookingCondition = bookingOnly(vehicle);
  if (zone === "ulez") {
    if (vehicle.type === "taxi") return {pence: 0, ruleId: "ulez-taxi", bookingCondition};
    if (vehicle.ulezCompliant === true) return {pence: 0, ruleId: "ulez-compliant", bookingCondition};
    return {pence: config.ulezDaily.pence, ruleId: "ulez-daily", bookingCondition};
  }
  if (vehicle.type === "taxi") return {pence: 0, ruleId: "cc-taxi", bookingCondition: false};
  if (vehicle.type === "motorcycle") return {pence: 0, ruleId: "cc-motorcycle", bookingCondition: false};
  const autopay = vehicle.paymentMethod === "autopay";
  if (vehicle.fuel === "electric" && autopay && vehicle.type === "car") {
    return {pence: config.ccEvCarAutoPay.pence, ruleId: "cc-ev-car-autopay", bookingCondition};
  }
  if (vehicle.fuel === "electric" && autopay && vehicle.type === "van") {
    return {pence: config.ccEvVanAutoPay.pence, ruleId: "cc-ev-van-autopay", bookingCondition};
  }
  if (autopay) return {pence: config.ccAutoPay.pence, ruleId: "cc-autopay", bookingCondition};
  if (vehicle.fuel === "electric") {
    return manualLate ?
      {pence: config.ccLate.pence, ruleId: "cc-ev-manual-late", bookingCondition} :
      {pence: config.ccStandard.pence, ruleId: "cc-ev-manual", bookingCondition};
  }
  return fullCc(config, manualLate, bookingCondition);
}

export function manualCcIsLate(travelDate: string, now: Date): boolean {
  return londonDayKey(now) > travelDate;
}

// Device-side mask. The server never sees the full plate.
export function maskVrm(raw: string): string {
  const collapsed = raw.toUpperCase().trim().replace(/\s+/g, " ");
  const space = collapsed.indexOf(" ");
  let prefix: string;
  if (space >= 0) prefix = collapsed.slice(0, space).slice(0, 4);
  else if (/^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(collapsed)) prefix = collapsed.slice(0, 4);
  else prefix = collapsed.slice(0, 2);
  return `${prefix} •••`;
}
