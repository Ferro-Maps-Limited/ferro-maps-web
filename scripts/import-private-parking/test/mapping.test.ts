import assert from "node:assert/strict";
import test from "node:test";
import {buildImport, notImportedRows, packCell, summarise} from "../../../functions/src/parking/privateSheet/build.ts";
import {geohash} from "../../../functions/src/parking/privateSheet/geohash.ts";
import {
  formatCoord,
  mapAud,
  mapFeeUnit,
  mapPlace,
  mapSrcType,
  parseCoord,
  parseDate,
  parseLocationCode,
  placeId,
  skipReason,
} from "../../../functions/src/parking/privateSheet/mapping.ts";
import {SRC_TYPES, type SourceRow, isSrcType} from "../../../functions/src/parking/privateSheet/types.ts";
import {run} from "../import.ts";

test("srcType is exactly official, gmaps, onsite, none", () => {
  assert.deepEqual([...SRC_TYPES], ["official", "gmaps", "onsite", "none"]);
  assert.equal(mapSrcType("Official site: clear answer"), "official");
  assert.equal(mapSrcType("Official site: partial info"), "official");
  assert.equal(mapSrcType("Google Maps only"), "gmaps");
  assert.equal(mapSrcType("On-site visit"), "onsite");
  assert.equal(mapSrcType("Visited 12 Oct"), "onsite");
  assert.equal(mapSrcType("No info found"), "none");
  assert.equal(mapSrcType("official_partial"), "none");
  assert.equal(mapSrcType("something else"), "none");
  assert.equal(mapSrcType(""), undefined);
  assert.equal(mapSrcType(null), undefined);
  for (const value of ["Official site: partial info", "official_partial", "No info found", "Google Maps only"]) {
    const mapped = mapSrcType(value);
    if (mapped !== undefined) assert.equal(isSrcType(mapped), true);
    assert.notEqual(mapped, "official_partial");
  }
});

test("aud codes and a missing audience is omitted", () => {
  assert.equal(mapAud("Customers only"), "c");
  assert.equal(mapAud("Guests only"), "g");
  assert.equal(mapAud("Patients and visitors"), "g");
  assert.equal(mapAud("Permit holders"), "p");
  assert.equal(mapAud("Anyone"), "a");
  assert.equal(mapAud("Anyone (paid)"), "a");
  assert.equal(mapAud("Unknown"), undefined);
  assert.equal(mapAud("Not applicable"), undefined);
  assert.equal(mapAud(""), undefined);
  assert.equal(mapAud("public"), undefined);
});

test("coordinates accept numbers and numeric strings and reject UNCLEAR", () => {
  assert.equal(parseCoord(51.505716), 51.505716);
  assert.equal(parseCoord("51.505716"), 51.505716);
  assert.equal(parseCoord("-0.267111"), -0.267111);
  assert.equal(parseCoord("  -0.078673 "), -0.078673);
  assert.equal(parseCoord("UNCLEAR"), null);
  assert.equal(parseCoord("unclear"), null);
  assert.equal(parseCoord(""), null);
  assert.equal(parseCoord(null), null);
  assert.equal(parseCoord("51.5N"), null);
  const fromNumber = placeId("Yard", "W3 8NW", 51.505716, -0.267111);
  const fromString = placeId("Yard", "W3 8NW", parseCoord("51.505716") ?? 0, parseCoord("-0.267111") ?? 0);
  assert.equal(fromNumber, fromString);
  assert.equal(formatCoord(-0.267111), "-0.2671");
  assert.equal(formatCoord(51.505716), "51.5057");
});

test("dates parse ISO, dd/mm/yyyy, and dd/mm/yy", () => {
  assert.equal(parseDate("2026-10-30"), "2026-10-30T00:00:00.000Z");
  assert.equal(parseDate("30/10/2026"), "2026-10-30T00:00:00.000Z");
  assert.equal(parseDate("30/10/26"), "2026-10-30T00:00:00.000Z");
  assert.equal(parseDate("1/2/26"), "2026-02-01T00:00:00.000Z");
  assert.equal(parseDate("31/02/26"), undefined);
  assert.equal(parseDate(""), undefined);
  assert.equal(parseDate(new Date("2026-10-31T00:00:00.000Z")), "2026-10-31T00:00:00.000Z");
});

test("location codes parse provider and code and ignore a clock time", () => {
  const pay = parseLocationCode("pay via PayByPhone location 37208; charges apply 8am–6pm");
  assert.deepEqual(pay && {locationCode: pay.locationCode, locationProvider: pay.locationProvider}, {
    locationCode: "37208",
    locationProvider: "paybyphone",
  });
  assert.equal(pay?.ambiguous, false);
  const ring = parseLocationCode("Pay by cash or RingGo 5002.");
  assert.equal(ring?.locationCode, "5002");
  assert.equal(ring?.locationProvider, "ringgo");
  const pair = parseLocationCode("long stay (RingGo 16412) and short stay (RingGo 19899)");
  assert.equal(pair?.locationCode, "16412");
  assert.equal(pair?.ambiguous, true);
  const clock = parseLocationCode(
    "RingGo Code 77530 Hourly rate available from 1200 Monday to Friday and RingGo ONLY.",
  );
  assert.equal(clock?.locationCode, "77530");
  assert.equal(clock?.ambiguous, false);
  assert.equal(parseLocationCode("No machines on site"), undefined);
  const justpark = parseLocationCode("Pay via JustPark (location 80629, 07520 634455) or at the gate");
  assert.equal(justpark?.locationCode, "80629");
  assert.equal(justpark?.locationProvider, "justpark");
  assert.equal(justpark?.ambiguous, false);
  const spaces = parseLocationCode(
    "operated by APCOA; open 24 hrs; 1787 spaces. Pay by card or APCOA Connect (codes 2222, 2223, 2224).",
  );
  assert.equal(spaces?.locationCode, "2222");
  assert.equal(spaces?.locationProvider, "apcoa");
  assert.equal(spaces?.ambiguous, true);
  assert.notEqual(spaces?.locationCode, "1787");
  const zone = parseLocationCode("Pay via PayByPhone or PayPoint (zone 84561).");
  assert.equal(zone?.locationCode, "84561");
  assert.equal(zone?.locationProvider, "paybyphone");
  const locationId = parseLocationCode("PayByPhone (Location ID 59794, 0300 400 7275)");
  assert.equal(locationId?.locationCode, "59794");
  assert.equal(locationId?.ambiguous, false);
  assert.equal(parseLocationCode("PayByPhone (app or 0330 400 7275)"), undefined);
});

test("feeUnit stays inside hour, visit, and day", () => {
  assert.equal(mapFeeUnit("Hourly rate", "£1.30 per hour"), "hour");
  assert.equal(mapFeeUnit("Flat rate per 24 hours", "£12.50 per 24 hours"), "day");
  assert.equal(mapFeeUnit("Free period, then hourly", "Free for 30 mins, then £1.00 per hour"), "hour");
  assert.equal(mapFeeUnit("Hourly rate", "£20.00 per hour; £80.00 per day"), undefined);
  assert.equal(mapFeeUnit("Flat rate per night", "£10.50 per night"), undefined);
  assert.equal(mapFeeUnit("Banded by stay length", "1 hr £5.50; 2 hrs £7.50"), undefined);
  assert.equal(mapFeeUnit("", "£4 per visit"), "visit");
  assert.equal(mapFeeUnit("Not published", "Not published"), undefined);
});

test("a mapped place keeps string coordinates and does not invent srcType or radius", () => {
  const place = mapPlace({
    "Location Name": "Salisbury Street Car Park",
    Postcode: "W3 8NW",
    Latitude: "51.505716",
    Longitude: "-0.267111",
    "Can Park? (Yes/No/Conditional)": "Yes",
    "Who Can Park": "Anyone (paid)",
    "Verification Result": "Corrected",
    "Verified Date": "31/10/26",
    "Confidence (1-5)": "4",
    "Geo Precision": "Postcode centroid",
    "Price Status": "Published",
    "Parking Charge (£)": "1.30",
    "Tariff Type": "Hourly rate",
    "Tariff Detail": "£1.30 per hour",
    "Evidence Type": "Official site: partial info",
    "Rules Summary": "PayByPhone location 37208",
    "Date Captured": "2026-10-30",
    "Free Stay Countdown (mins)": "20",
    "Max Stay (mins)": "120",
    "Ferro Autopay": "✅",
    Operator: "Ealing Council",
    "Source URLs (primary first)": "https://example.com/a ; https://example.com/b",
    "Street Address": "Salisbury Street, Acton, London",
    "Hours (OpenStreetMap opening_hours format)": "24/7",
    "Total incl. Ferro Fee (£)": 2.9,
  });
  assert.equal(place.s, 1);
  assert.equal(place.q, "known");
  assert.equal(place.aud, "a");
  assert.equal(place.conf, 0.8);
  assert.equal(place.approx, true);
  assert.equal(place.fee, 130);
  assert.equal(place.feeUnit, "hour");
  assert.equal(place.srcType, "official");
  assert.equal(place.locationCode, "37208");
  assert.equal(place.locationProvider, "paybyphone");
  assert.equal(place.capturedAt, "2026-10-30T00:00:00.000Z");
  assert.equal(place.verifiedAt, "2026-10-31T00:00:00.000Z");
  assert.equal(place.free, 20);
  assert.equal(place.max, 120);
  assert.equal(place.auto, true);
  assert.equal(place.src, "https://example.com/a");
  assert.equal(place.addr, "Salisbury Street, Acton, London, W3 8NW");
  assert.deepEqual(place.p, [51.505716, -0.267111]);
  assert.equal("r" in place, false);
  assert.equal("payMode" in place, false);
  assert.equal("tl" in place, false);
  assert.equal(JSON.stringify(place).includes("official_partial"), false);
  assert.equal(JSON.stringify(place).includes("Total incl"), false);
});

test("closed rows and bad coordinates are skipped, and duplicate name+postcode pairs merge", () => {
  assert.equal(skipReason({"Location Status": "Closed", Latitude: 51, Longitude: -0.1, "Location Name": "A"}), "closed");
  assert.equal(skipReason({"Location Status": "Temporarily closed", Latitude: 51, Longitude: -0.1, "Location Name": "A"}), "temporarily_closed");
  assert.equal(skipReason({"Location Status": "Open", Latitude: "UNCLEAR", Longitude: "UNCLEAR", "Location Name": "A"}), "bad_coordinates");
  const rows: SourceRow[] = [
    row(2, {"Location Name": "Yard", Postcode: "W1 1AA", Latitude: "51.5", Longitude: "-0.1", "Location Status": "Open", "Verification Result": "Needs on-site check", "Confidence (1-5)": 1, "Date Captured": "2026-10-30"}),
    row(3, {"Location Name": "Yard", Postcode: "W11AA", Latitude: 51.5, Longitude: -0.12, "Location Status": "Open", "Verification Result": "Confirmed", "Confidence (1-5)": 5, "Date Captured": "30/10/26", "Evidence Type": "Google Maps only", "Who Can Park": "Customers only"}),
    row(4, {"Location Name": "Shut", Postcode: "E1 1AA", Latitude: 51.51, Longitude: -0.11, "Location Status": "Closed"}),
    row(5, {}),
  ];
  const build = buildImport(rows, new Date("2026-11-01T00:00:00.000Z"));
  assert.equal(build.skipped.blank_row, 1);
  assert.equal(build.skipped.closed, 1);
  assert.equal(build.imported.length, 1);
  assert.equal(build.duplicates.groupsMerged, 1);
  assert.equal(build.duplicates.rowsDropped, 1);
  assert.equal(build.imported[0].place.q, "known");
  assert.equal(build.imported[0].place.aud, "c");
  assert.equal(build.imported[0].place.srcType, "gmaps");
  assert.equal(build.imported[0].place.conf, 1);
  assert.equal(build.cells[0].data.v, 1);
  assert.equal(build.cells[0].data.expiresAt, "2026-11-15T00:00:00.000Z");
  assert.equal(build.cells[0].data.shards, undefined);
  assert.equal(build.verifiedSourceRows, 1);
  const summary = summarise(build, "ALL LONDON (clean)");
  assert.equal(summary.wroteToFirestore, false);
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.srcType.gmaps, 1);
  assert.equal(summary.sample.length, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.sample[0].payMode, "handoff");
  assert.deepEqual(summary.payMode, {inapp: 0, handoff: 1});
  assert.equal(summary.notes.some((note) => note.includes("every place is handoff")), true);
});

test("mappable rows that are not imported are closed or merged duplicates", () => {
  const rows: SourceRow[] = [
    row(2, {"Location Name": "Kept", Postcode: "W1 1AA", Latitude: 51.5, Longitude: -0.1, "Location Status": "Open"}),
    row(3, {"Location Name": "Kept", Postcode: "W11AA", Latitude: 51.5, Longitude: -0.11, "Location Status": "Open"}),
    row(4, {"Location Name": "Shut", Postcode: "E1 1AA", Latitude: 51.51, Longitude: -0.12, "Location Status": "Closed"}),
    row(5, {"Location Name": "Pause", Postcode: "E1 2AA", Latitude: "51.52", Longitude: "-0.13", "Location Status": "Temporarily closed"}),
    row(6, {"Location Name": "Unclear", Postcode: "N1 1AA", Latitude: "UNCLEAR", Longitude: "UNCLEAR", "Location Status": "Open"}),
  ];
  const build = buildImport(rows, new Date("2026-11-01T00:00:00.000Z"));
  const missing = notImportedRows(rows, build);
  assert.deepEqual(missing.map((item) => [item.sheetRow, item.reason]), [
    [2, "merged duplicate of row 3"],
    [4, "closed"],
    [5, "temporarily closed"],
  ]);
  assert.equal(missing[0].name, "Kept");
  assert.equal(missing[1].postcode, "E1 1AA");
  assert.equal(missing[2].postcode, "E1 2AA");
  assert.equal(build.imported.length, 1);
});

test("geohash6 matches the standard algorithm and cells shard past the size budget", () => {
  assert.equal(geohash(42.6, -5.6, 5), "ezs42");
  assert.equal(geohash(51.5074, -0.1278, 6).length, 6);
  const places = Array.from({length: 6}, (_, index) => ({
    id: `p${index}`,
    n: `Place ${index}`,
    p: [51.5, -0.1] as [number, number],
    s: 1 as const,
    hours: "x".repeat(80),
  }));
  const packed = packCell("gcpvj0", places, "2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z", 280);
  assert.ok(packed.docs.length > 1);
  assert.equal(packed.docs[0].id, "gcpvj0");
  assert.equal(packed.docs[0].data.shards, packed.docs.length - 1);
  assert.equal(packed.docs[1].id, "gcpvj0_1");
  assert.equal(packed.docs[1].data.shards, undefined);
  assert.equal(packed.docs[1].data.v, 1);
  assert.equal(packed.docs[1].data.expiresAt, "2026-11-08T00:00:00.000Z");
});

test("dry run reports handoff and does not read places", async () => {
  let loads = 0;
  let summary: {payMode?: {inapp: number; handoff: number}; sample: Array<{payMode?: string}>} | undefined;
  const code = await run(["--input", "sheet.xlsx", "--now", "2026-11-01T00:00:00.000Z"], {
    stdout: () => undefined,
    stderr: () => undefined,
    read: async () => [row(2, {
      "Location Name": "Yard",
      Postcode: "W1 1AA",
      Latitude: "51.5",
      Longitude: "-0.12",
      "Location Status": "Open",
    })],
    writeSummary: async (_file, value) => {
      summary = value;
    },
    writeNotImported: async () => undefined,
    loadInAppPlaceIds: async () => {
      loads += 1;
      return new Set(["unused"]);
    },
    loadPlaceIndex: async () => {
      loads += 1;
      return [];
    },
    writeCells: async () => {
      throw new Error("dry run must not write");
    },
  });
  assert.equal(code, 0);
  assert.equal(loads, 0);
  assert.deepEqual(summary?.payMode, {inapp: 0, handoff: 1});
  assert.equal(summary?.sample[0].payMode, "handoff");
});

test("write copies inapp only for a matching places id", async () => {
  const yard = {
    "Location Name": "Yard",
    Postcode: "W1 1AA",
    Latitude: "51.50",
    Longitude: "-0.12",
  };
  const other = {
    "Location Name": "Other",
    Postcode: "W1 1AB",
    Latitude: "51.51",
    Longitude: "-0.13",
  };
  const yardId = placeId(yard["Location Name"], yard.Postcode, 51.5, -0.12);
  let written: Array<{data: {places: Array<{id: string; payMode?: string}>}}> | undefined;
  let projectSeen = "";
  const code = await run(["--write", "--project", "demo-ferromaps", "--input", "sheet.xlsx"], {
    stdout: () => undefined,
    stderr: () => undefined,
    read: async () => [
      row(2, {...yard, "Location Status": "Open"}),
      row(3, {...other, "Location Status": "Open"}),
    ],
    loadInAppPlaceIds: async (projectId) => {
      projectSeen = projectId;
      return new Set([yardId]);
    },
    loadPlaceIndex: async () => [],
    writePlaceIndex: async () => undefined,
    writeCells: async (_project, docs) => {
      written = docs;
    },
  });
  assert.equal(code, 0);
  assert.equal(projectSeen, "demo-ferromaps");
  const places = written?.flatMap((doc) => doc.data.places) ?? [];
  assert.equal(places.find((place) => place.id === yardId)?.payMode, "inapp");
  assert.equal(places.filter((place) => place.payMode === "handoff").length, 1);
  assert.equal(places.length, 2);
});

test("the importer refuses to write without --write and --project", async () => {
  let writes = 0;
  const refused = await run(["--write", "--input", "missing.xlsx"], {
    stderr: () => undefined,
    writeCells: async () => {
      writes += 1;
    },
    read: async () => [],
  });
  assert.equal(refused, 2);
  assert.equal(writes, 0);
  const ignored = await run(["--project", "demo-ferromaps", "--input", "missing.xlsx"], {
    stderr: () => undefined,
    stdout: () => undefined,
    writeCells: async () => {
      writes += 1;
    },
    read: async () => [],
    writeSummary: async () => undefined,
    writeNotImported: async () => undefined,
  });
  assert.equal(ignored, 0);
  assert.equal(writes, 0);
});

function row(sheetRow: number, values: Record<string, unknown>): SourceRow {
  const blank = Object.values(values).every((value) => value == null || value === "");
  return {sheetRow, blank, values: blank ? {} : values};
}
