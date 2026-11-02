import {isLondonDayKey} from "./config.js";

export const BANK_HOLIDAYS_URL = "https://www.gov.uk/bank-holidays.json";

// Dates from the england-and-wales division of the GOV.UK bank holiday feed.
export function bankHolidaysFromGovUk(payload: unknown): string[] {
  if (payload == null || typeof payload !== "object") {
    throw new Error("bank holidays payload is not an object");
  }
  const division = (payload as Record<string, unknown>)["england-and-wales"];
  if (division == null || typeof division !== "object") {
    throw new Error("england-and-wales is missing from the bank holiday feed");
  }
  const events = (division as Record<string, unknown>).events;
  if (!Array.isArray(events)) throw new Error("england-and-wales events is missing");
  const dates: string[] = [];
  for (const event of events) {
    if (event == null || typeof event !== "object") continue;
    const date = (event as Record<string, unknown>).date;
    if (typeof date === "string" && isLondonDayKey(date) && !dates.includes(date)) dates.push(date);
  }
  dates.sort();
  if (dates.length === 0) throw new Error("england-and-wales has no bank holiday dates");
  return dates;
}
