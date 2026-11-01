import {ATTRIBUTION_LINES, type RoadChargeConfig} from "./config.js";

// Example documents. The seed fills bankHolidays from GOV.UK before it prints.
// Amounts are the TfL figures published on tfl.gov.uk when this was written
// (CC £18 in advance or on Auto Pay, £21 by the third-day deadline, ULEZ
// £12.50). The circle is not a survey. Default invocation does not write.

const ATTRIBUTION: [string, string, string] = [...ATTRIBUTION_LINES];

export function exampleRoadChargeDocuments(): {cc: RoadChargeConfig; ulez: RoadChargeConfig} {
  const cc: RoadChargeConfig = {
    v: 1,
    zoneVersion: "cc-2018-05-20",
    boundaryUrl: "https://storage.googleapis.com/ferro-maps-road-charges/boundaries/cc/cc-2018-05-20.geojson",
    attribution: ATTRIBUTION,
    chargePence: 1800,
    lateChargePence: 2100,
    payByDaysAfter: 3,
    windows: [
      {weekdays: [1, 2, 3, 4, 5], start: "07:00", end: "18:00"},
      {weekdays: [6, 7], start: "12:00", end: "18:00"},
    ],
    closedDates: [],
    closedRanges: [{start: "2026-12-25", end: "2027-01-01"}],
    bankHolidays: [],
    ccRegion: {lat: 51.5074, lng: -0.1278, radiusM: 8000},
  };
  const ulez: RoadChargeConfig = {
    v: 1,
    zoneVersion: "ulez-2023-08-29",
    boundaryUrl: "https://storage.googleapis.com/ferro-maps-road-charges/boundaries/ulez/ulez-2023-08-29.geojson",
    attribution: ATTRIBUTION,
    chargePence: 1250,
    lateChargePence: 1250,
    payByDaysAfter: 3,
    windows: [
      {weekdays: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "24:00"},
    ],
    closedDates: ["2026-12-25"],
    closedRanges: [],
    bankHolidays: [],
  };
  return {cc, ulez};
}

export function exampleSeedPayload(
  bankHolidays: string[],
  wrote: boolean,
): Record<string, unknown> {
  const docs = exampleRoadChargeDocuments();
  docs.cc.bankHolidays = bankHolidays;
  docs.ulez.bankHolidays = bankHolidays;
  return {
    dryRun: !wrote,
    wrote,
    project: null,
    warning: wrote ?
      "Wrote roadCharges/cc and roadCharges/ulez." :
      "Dry run. Nothing was written. Run with --write before a staging deploy.",
    documents: {
      "roadCharges/cc": docs.cc,
      "roadCharges/ulez": docs.ulez,
    },
  };
}
