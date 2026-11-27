/*
 * UK bank holidays, from https://www.gov.uk/bank-holidays.json (read 27 Nov 2026).
 * England and Wales share one list. Scotland and Northern Ireland have their own.
 *
 * A car park's price list carries its own nation's dates (`rates.h`), so the
 * apps and the payment step need no other source. Past BANK_HOLIDAYS_COVER_TO
 * every day counts as unknown and nobody can pay at a stepped-price car park,
 * so add the next year from the same gov.uk file before then.
 */

export type UkNation = "ew" | "sc" | "ni";

export const BANK_HOLIDAYS_COVER_TO = "2028-12-31";

export const UK_BANK_HOLIDAYS: Record<UkNation, readonly string[]> = {
  ew: [
    "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28",
    "2028-01-03", "2028-04-14", "2028-04-17", "2028-05-01", "2028-05-29", "2028-08-28", "2028-12-25", "2028-12-26",
  ],
  sc: [
    "2026-01-01", "2026-01-02", "2026-04-03", "2026-05-04", "2026-05-25", "2026-06-15", "2026-08-03", "2026-11-30",
    "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-01-04", "2027-03-26", "2027-05-03", "2027-05-31", "2027-08-02", "2027-11-30", "2027-12-27",
    "2027-12-28",
    "2028-01-03", "2028-01-04", "2028-04-14", "2028-05-01", "2028-05-29", "2028-08-07", "2028-11-30", "2028-12-25",
    "2028-12-26",
  ],
  ni: [
    "2026-01-01", "2026-03-17", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-07-13", "2026-08-31",
    "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-17", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-07-12", "2027-08-30",
    "2027-12-27", "2027-12-28",
    "2028-01-03", "2028-03-17", "2028-04-14", "2028-04-17", "2028-05-01", "2028-05-29", "2028-07-12", "2028-08-28",
    "2028-12-25", "2028-12-26",
  ],
};

/* Postcode areas in Scotland. TD15 (Berwick) and TD12 4 (Cornhill) are in England. */
const SCOTTISH_AREAS = new Set([
  "AB", "DD", "DG", "EH", "FK", "G", "HS", "IV", "KA", "KW", "KY", "ML", "PA", "PH", "TD", "ZE",
]);

const SCOTTISH_TOWNS = new Set([
  "aberdeen", "ayr", "cumbernauld", "dundee", "dunfermline", "east kilbride", "edinburgh", "falkirk",
  "glasgow", "hamilton", "inverness", "kilmarnock", "kirkcaldy", "livingston", "motherwell", "paisley",
  "perth", "stirling",
]);

const NI_TOWNS = new Set(["armagh", "bangor", "belfast", "derry", "lisburn", "londonderry", "newry"]);

/* The nation from the postcode, else from the town's name, else England and Wales. */
export function ukNation(postcode: string | undefined, town: string): UkNation {
  const pc = (postcode ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const match = /^([A-Z]{1,2})(\d[A-Z\d]?)(?: (\d))?/.exec(pc);
  if (match) {
    const area = match[1] ?? "";
    if (area === "BT") return "ni";
    if (SCOTTISH_AREAS.has(area)) {
      if (area === "TD" && (match[2] === "15" || (match[2] === "12" && match[3] === "4"))) return "ew";
      return "sc";
    }
    return "ew";
  }
  const name = town.trim().toLowerCase();
  if (SCOTTISH_TOWNS.has(name)) return "sc";
  if (NI_TOWNS.has(name)) return "ni";
  return "ew";
}

/*
 * The nation's bank holidays from `fromKey` (a YYYY-MM-DD London day) to the
 * end of the next calendar year, and the last day that list answers for.
 * The list only changes when a holiday passes, so cells don't churn.
 */
export function bankHolidaysAhead(nation: UkNation, fromKey: string): {dates: string[]; coverTo: string} {
  const nextYearEnd = `${Number(fromKey.slice(0, 4)) + 1}-12-31`;
  const coverTo = nextYearEnd < BANK_HOLIDAYS_COVER_TO ? nextYearEnd : BANK_HOLIDAYS_COVER_TO;
  const dates = UK_BANK_HOLIDAYS[nation].filter((day) => day >= fromKey && day <= coverTo);
  return {dates, coverTo};
}
