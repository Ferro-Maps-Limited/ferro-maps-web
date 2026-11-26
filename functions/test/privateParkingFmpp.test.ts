import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";
import {join} from "node:path";
import {placeId} from "../src/parking/privateSheet/mapping.js";
import {
  FMPP_LOCATION_HEADERS,
  FMPP_TARIFF_HEADERS,
  buildFmppPlaces,
  cityLocationId,
  fmppHeaderProblem,
  parseFmppSources,
  type FmppSource,
} from "../src/parking/privateSheet/fmpp.js";
import {sheetPayable} from "../src/parking/sheetPricing.js";
import {
  CELL_TTL_MS,
  mergePrivateParkingPlaces,
  placeIdsCollide,
  syncPrivateParkingOnce,
  type ExistingCellDoc,
  type SheetLoader,
  type SyncOnceResult,
} from "../src/parking/privateSheet/syncPlan.js";
import {type PrivatePlace} from "../src/parking/privateSheet/types.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const BHM_SHEET = "example-bhm-sheet-id";
const LDS_SHEET = "test-lds-sheet-id";
const BHM = `BHM|Birmingham|${BHM_SHEET}`;
const HEAD = [
  "Location Name", "Postcode", "Latitude", "Longitude", "Location Status",
  "Evidence Type", "Who Can Park", "Verification Result",
];
const YARD = ["Yard", "W1 1AA", "51.50", "-0.12", "Open", "Official site: clear answer", "Customers only", "Confirmed"];
const OTHER = ["Other", "W1 1AB", "51.51", "-0.13", "Open", "Google Maps only", "Anyone", ""];

function londonSheet(rows: unknown[][]): unknown[][] {
  return [HEAD, ...rows];
}

function locationRow(overrides: Record<string, unknown>): unknown[] {
  return FMPP_LOCATION_HEADERS.map((name) => {
    if (!name) return "";
    return Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : "";
  });
}

function ready(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Location ID": "FERRO-BHM-TST-0001",
    "Provider": "RingGo",
    "Provider Location Code": "684268",
    "Location Name": "Fox and Goose",
    "Type": "car park",
    "Street/Address": "not published",
    "Postcode": "B8 2NB",
    "Latitude": 52.49391,
    "Longitude": -1.81929,
    "Hours of Operation": "Charge times: All Week.",
    "Max Stay": "72 hours",
    "Free Period (Y/N)": "Y",
    "Free Minutes": 120,
    "Ferro Autopay": "✅",
    "FM Ready": "✅",
    "Parking Charge (£)": 0,
    "Last Checked": "2026-11-25",
    "Source URL": "https://example.com/ringgo/684268",
    ...overrides,
  };
}

function locationMatrix(rows: Record<string, unknown>[]): unknown[][] {
  return [[...FMPP_LOCATION_HEADERS], ...rows.map((row) => locationRow(row))];
}

function tariffMatrix(rows: Record<string, unknown>[]): unknown[][] {
  return [[...FMPP_TARIFF_HEADERS], ...rows.map((row) => {
    return FMPP_TARIFF_HEADERS.map((name) => row[name] ?? "");
  })];
}

function hourlyBand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Location ID": "FERRO-BHM-TST-0001",
    "Provider": "RingGo",
    "Provider Location Code": "684268",
    "Duration / Band": "For every 1 Hour — All Week",
    "Price (£)": 1,
    "Confidence": "Verified",
    "Source URL": "https://example.com/ringgo/684268",
    "Last Checked": "2026-11-25",
    "Notes": "",
    ...overrides,
  };
}

const BHM_SOURCE: FmppSource = {
  code: "BHM",
  city: "Birmingham",
  sheetId: BHM_SHEET,
  locationsTab: "Locations - Birmingham",
  tariffsTab: "Tariffs - Birmingham",
};

function payable(place: PrivatePlace): boolean {
  const record: Record<string, unknown> = {...place};
  return sheetPayable(record);
}

function placesOf(matrixLocations: unknown[][], matrixTariffs: unknown[][]): PrivatePlace[] {
  const built = buildFmppPlaces(BHM_SOURCE, matrixLocations, matrixTariffs);
  if (!built.ok) assert.fail(built.reason);
  return built.places;
}

function livePlaces(result: SyncOnceResult): PrivatePlace[] {
  return result.writes.filter((write) => write.action !== "expire").flatMap((write) => write.data.places);
}

function existingFrom(result: SyncOnceResult): ExistingCellDoc[] {
  return result.writes.map((write) => ({
    id: write.id,
    cell: write.data.cell,
    contentHash: write.data.contentHash,
    expiresAtMs: NOW.getTime() + CELL_TTL_MS,
  }));
}

describe("FM-PP headers and source list", () => {
  it("requires the 44 location headers and the 9 tariff headers, in order", () => {
    assert.equal(FMPP_LOCATION_HEADERS.length, 44);
    assert.equal(FMPP_LOCATION_HEADERS[0], "Location ID");
    assert.equal(FMPP_LOCATION_HEADERS[7], "Street/Address");
    assert.equal(FMPP_LOCATION_HEADERS[31], "");
    assert.equal(FMPP_LOCATION_HEADERS[32], "Parking Charge (£)");
    assert.equal(FMPP_LOCATION_HEADERS[43], "FM Ready");
    assert.equal(FMPP_TARIFF_HEADERS.length, 9);
    assert.deepEqual(FMPP_TARIFF_HEADERS, [
      "Location ID", "Provider", "Provider Location Code", "Duration / Band", "Price (£)",
      "Confidence", "Source URL", "Last Checked", "Notes",
    ]);
    assert.equal(fmppHeaderProblem("locations", [...FMPP_LOCATION_HEADERS]), null);
    assert.equal(fmppHeaderProblem("locations", [...FMPP_LOCATION_HEADERS, "", ""]), null);
    assert.equal(fmppHeaderProblem("tariffs", [...FMPP_TARIFF_HEADERS, ""]), null);
    const shifted: string[] = [...FMPP_LOCATION_HEADERS];
    shifted[43] = "Ready";
    assert.equal(fmppHeaderProblem("locations", shifted), "header-unexpected");
    const spacer: string[] = [...FMPP_LOCATION_HEADERS];
    spacer[31] = "Spacer";
    assert.equal(fmppHeaderProblem("locations", spacer), "header-unexpected");
    assert.equal(fmppHeaderProblem("locations", [...FMPP_LOCATION_HEADERS, "Extra"]), "header-unexpected");
    assert.equal(fmppHeaderProblem("tariffs", []), "header-missing");
    const tariff: string[] = [...FMPP_TARIFF_HEADERS];
    tariff[4] = "Price";
    assert.equal(fmppHeaderProblem("tariffs", tariff), "header-unexpected");
  });

  it("parses one or more cities and rejects a bad list without echoing the spreadsheet id", () => {
    const one = parseFmppSources(`  bhm|Birmingham|${BHM_SHEET}  `);
    assert.equal(one.ok, true);
    if (!one.ok) return;
    assert.deepEqual(one.sources, [BHM_SOURCE]);
    const placeholder = parseFmppSources("BHM|Birmingham|<birmingham-sheet-id>");
    assert.equal(placeholder.ok, true);
    if (!placeholder.ok) return;
    assert.equal(placeholder.sources[0]?.locationsTab, "Locations - Birmingham");
    assert.equal(placeholder.sources[0]?.tariffsTab, "Tariffs - Birmingham");
    const custom = parseFmppSources(
      "MKN|Milton Keynes|example-mkn-sheet-id|Locations - Milton Keynes|Tariffs",
    );
    assert.equal(custom.ok, true);
    if (!custom.ok) return;
    assert.equal(custom.sources[0]?.code, "MKN");
    assert.equal(custom.sources[0]?.tariffsTab, "Tariffs");
    const many = parseFmppSources(`${BHM}\nLDS|Leeds|${LDS_SHEET}`);
    assert.equal(many.ok, true);
    if (!many.ok) return;
    assert.deepEqual(many.sources.map((source) => source.code), ["BHM", "LDS"]);
    assert.equal(many.sources[1]?.locationsTab, "Locations - Leeds");
    for (const raw of [
      "",
      "   ",
      "BHM|Birmingham",
      `BHM|Birmingham|${BHM_SHEET}|Locations - Birmingham`,
      `BHM|Birmingham|https://docs.google.com/spreadsheets/d/${BHM_SHEET}`,
      `${BHM};BHM|Leeds|${LDS_SHEET}`,
      `${BHM};LDS|Leeds|${BHM_SHEET}`,
      "BHM|Birmingham|short",
    ]) {
      const parsed = parseFmppSources(raw);
      if (raw.trim() === "") {
        assert.equal(parsed.ok, true);
        continue;
      }
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.equal(parsed.reason, "fmpp-sources-invalid");
        assert.equal(parsed.reason.includes(BHM_SHEET), false);
        assert.equal(parsed.reason.includes("docs.google"), false);
      }
    }
  });

  it("keeps the param default empty in the scheduler source", () => {
    const source = readFileSync(join(__dirname, "../src/parking/syncPrivateParkingSheet.ts"), "utf8");
    const needle = [
      "defineString(\"PRIVATE_PARKING_FMPP_SOURCES\", {",
      "  default: \"\",",
      "})",
    ].join("\n");
    assert.equal(source.includes(needle), true);
    assert.match(source, /fmppSources,/);
    const added = readFileSync(join(__dirname, "../src/parking/privateSheet/fmpp.ts"), "utf8");
    assert.equal(added.includes("docs.google.com"), false);
    assert.equal(added.includes("spreadsheets/d/"), false);
  });
});

describe("FM Ready rows and tariffs", () => {
  it("imports only an exact FM Ready tick and joins a simple hourly price", () => {
    const places = placesOf(
      locationMatrix([
        ready(),
        ready({
          "Location ID": "FERRO-BHM-TST-0002",
          "Location Name": "Not ready",
          "FM Ready": "",
          "Provider Location Code": "111111",
        }),
        ready({
          "Location ID": "FERRO-BHM-TST-0003",
          "Location Name": "Worded yes",
          "FM Ready": "yes",
          "Provider Location Code": "222222",
        }),
        ready({
          "Location ID": "FERRO-BHM-TST-0004",
          "Location Name": "Bare tick",
          "FM Ready": "✓",
          "Provider Location Code": "333333",
        }),
        ready({
          "Location ID": "FERRO-BHM-TST-0005",
          "Location Name": "Padded tick",
          "FM Ready": " ✅ ",
          "Provider Location Code": "444444",
        }),
      ]),
      tariffMatrix([
        hourlyBand(),
        hourlyBand({
          "Location ID": "FERRO-BHM-TST-0005",
          "Duration / Band": "For every 1 Hour — All Week",
          "Price (£)": 2,
        }),
        {
          "Location ID": "FERRO-BHM-OTHER-0001",
          "Duration / Band": "For every 1 Hour — All Week",
          "Price (£)": 9,
          "Confidence": "Verified",
        },
      ]),
    );
    assert.deepEqual(places.map((place) => place.id), ["FERRO-BHM-TST-0001", "FERRO-BHM-TST-0005"]);
    const hourly = places[0];
    assert.ok(hourly);
    assert.equal(hourly.fee, 100);
    assert.equal(hourly.feeUnit, "hour");
    assert.equal(hourly.free, 120);
    assert.equal(hourly.max, 4320);
    assert.equal(hourly.q, "known");
    assert.equal(hourly.s, 1);
    assert.equal(hourly.aud, "a");
    assert.equal(hourly.auto, true);
    assert.equal(hourly.payMode, "inapp");
    assert.equal(hourly.locationCode, "684268");
    assert.equal(hourly.locationProvider, "ringgo");
    assert.equal(hourly.operator, "RingGo");
    assert.equal(hourly.addr, "B8 2NB");
    assert.equal(hourly.hours, "Charge times: All Week.");
    assert.equal(hourly.srcType, "official");
    assert.equal(hourly.verifiedAt, "2026-11-25T00:00:00.000Z");
    assert.equal(payable(hourly), true);
    assert.equal(places[1]?.fee, 200);
  });

  it("does not invent an hourly fee from stepped bands or from another location", () => {
    const stepped = placesOf(
      locationMatrix([ready({"Parking Charge (£)": 1.19, "Free Period (Y/N)": "N", "Free Minutes": ""})]),
      tariffMatrix([
        ["1 hour", 1.19],
        ["2 hours", 1.69],
        ["3 hours", 2.19],
        ["24 hours / 1 day", 5.69],
      ].map(([duration, price]) => hourlyBand({"Duration / Band": duration, "Price (£)": price}))),
    );
    assert.equal(stepped.length, 1);
    assert.equal("fee" in stepped[0], false);
    assert.equal("feeUnit" in stepped[0], false);
    assert.equal(stepped[0].payMode, "inapp");
    assert.equal(stepped[0].locationCode, "684268");
    assert.equal(payable(stepped[0]), false);

    const airport = placesOf(
      locationMatrix([ready({
        "Location ID": "FERRO-BHM-AIR-0001",
        "Provider": "NCP (for Birmingham Airport)",
        "Provider Location Code": "BHX-PSD",
        "Location Name": "Premium Set Down",
        "Parking Charge (£)": 61,
        "Free Period (Y/N)": "N",
        "Notes": "Coordinates are a postcodes.io centroid, not a bay-accurate pin.",
        "Source URL": "",
      })]),
      tariffMatrix([
        ["0–15 minutes", 8],
        ["15–20 minutes", 13],
        ["Each extra 15 minutes thereafter", 8],
        ["Blue Badge: up to 30 minutes (validated)", 0],
      ].map(([duration, price]) => hourlyBand({
        "Location ID": "FERRO-BHM-AIR-0001",
        "Provider": "NCP (for Birmingham Airport)",
        "Provider Location Code": "BHX-PSD",
        "Duration / Band": duration,
        "Price (£)": price,
      }))),
    );
    assert.equal("fee" in airport[0], false);
    assert.equal(airport[0].locationCode, "BHX-PSD");
    assert.equal(airport[0].locationProvider, "ncp");
    assert.equal(airport[0].operator, "NCP (for Birmingham Airport)");
    assert.equal(airport[0].approx, true);
    assert.equal("src" in airport[0], false);
    assert.equal("srcType" in airport[0], false);

    const chargeOnly = placesOf(
      locationMatrix([ready({"Parking Charge (£)": 1.5, "Free Period (Y/N)": "N"})]),
      tariffMatrix([]),
    );
    assert.equal(chargeOnly[0].fee, 150);
    assert.equal(chargeOnly[0].feeUnit, "hour");
    assert.equal(payable(chargeOnly[0]), true);

    const otherLocationsTariff = placesOf(
      locationMatrix([ready({"Parking Charge (£)": 2, "Free Period (Y/N)": "N"})]),
      tariffMatrix([hourlyBand({"Location ID": "FERRO-BHM-OTHER-0009", "Price (£)": 9})]),
    );
    assert.equal(otherLocationsTariff[0].fee, 200);
  });

  it("stores one daily price, one per-visit price, and equal hourly bands", () => {
    const daily = placesOf(
      locationMatrix([ready({"Free Period (Y/N)": "N"})]),
      tariffMatrix([hourlyBand({"Duration / Band": "24 hours / 1 day", "Price (£)": 5.69})]),
    );
    assert.equal(daily[0].fee, 569);
    assert.equal(daily[0].feeUnit, "day");
    const visit = placesOf(
      locationMatrix([ready({"Free Period (Y/N)": "N"})]),
      tariffMatrix([hourlyBand({"Duration / Band": "per visit", "Price (£)": 3})]),
    );
    assert.equal(visit[0].fee, 300);
    assert.equal(visit[0].feeUnit, "visit");
    const same = placesOf(
      locationMatrix([ready({"Free Period (Y/N)": "N"})]),
      tariffMatrix([
        hourlyBand({"Duration / Band": "per hour daytime", "Price (£)": 2}),
        hourlyBand({"Duration / Band": "per hour evening", "Price (£)": 2}),
      ]),
    );
    assert.equal(same[0].fee, 200);
    assert.equal(same[0].feeUnit, "hour");
    const mixed = placesOf(
      locationMatrix([ready({"Free Period (Y/N)": "N", "Parking Charge (£)": 4.6})]),
      tariffMatrix([
        hourlyBand({"Duration / Band": "per hour daytime", "Price (£)": 2}),
        hourlyBand({"Duration / Band": "per hour evening", "Price (£)": 3}),
      ]),
    );
    assert.equal("fee" in mixed[0], false);
  });

  it("skips a ticked row with no provider or location code, and refuses London-shaped ids", () => {
    const skipped = placesOf(
      locationMatrix([
        ready({"Provider": "", "Primary Provider": "", "Location Name": "No provider"}),
        ready({
          "Location ID": "FERRO-BHM-TST-0008",
          "Provider Location Code": "not published",
          "Location Name": "No code",
        }),
        ready({
          "Location ID": "FERRO-ACT-0001",
          "Location Name": "Wrong city prefix",
          "Provider Location Code": "555555",
        }),
      ]),
      tariffMatrix([hourlyBand()]),
    );
    assert.equal(skipped.length, 0);
    const londonHash = placeId("Yard", "W1 1AA", 51.5, -0.12);
    assert.equal(cityLocationId("BHM", londonHash), null);
    assert.equal(cityLocationId("BHM", "PP-000123"), null);
    assert.equal(cityLocationId("BHM", "FERRO-BHM-AIR-0001"), "FERRO-BHM-AIR-0001");
    assert.equal(cityLocationId("BH", "FERRO-BHM-AIR-0001"), null);
  });
});

describe("FM-PP sync alongside London", () => {
  function tables(input: {
    london?: unknown[][];
    bhmLocations?: unknown[][];
    bhmTariffs?: unknown[][];
    ldsLocations?: unknown[][];
    ldsTariffs?: unknown[][];
    fail?: string;
  }): {load: SheetLoader; seen: string[]} {
    const seen: string[] = [];
    const load: SheetLoader = async (sheetId, tab) => {
      seen.push(`${sheetId}|${tab}`);
      if (input.fail && `${sheetId}|${tab}` === input.fail) {
        const err = new Error("missing tab");
        err.name = "tab-not-found";
        throw err;
      }
      if (sheetId === "sheet-id") return input.london ?? londonSheet([YARD, OTHER]);
      if (`${sheetId}|${tab}` === `${BHM_SHEET}|Locations - Birmingham`) {
        return input.bhmLocations ?? locationMatrix([ready()]);
      }
      if (`${sheetId}|${tab}` === `${BHM_SHEET}|Tariffs - Birmingham`) {
        return input.bhmTariffs ?? tariffMatrix([hourlyBand()]);
      }
      if (`${sheetId}|${tab}` === `${LDS_SHEET}|Locations - Leeds`) {
        return input.ldsLocations ?? locationMatrix([ready({
          "Location ID": "FERRO-LDS-TST-0001",
          "Location Name": "Leeds station",
          "Latitude": 53.795,
          "Longitude": -1.548,
          "Postcode": "LS1 4DY",
          "Provider Location Code": "900001",
        })]);
      }
      if (`${sheetId}|${tab}` === `${LDS_SHEET}|Tariffs - Leeds`) {
        return input.ldsTariffs ?? tariffMatrix([hourlyBand({
          "Location ID": "FERRO-LDS-TST-0001",
          "Provider Location Code": "900001",
        })]);
      }
      const err = new Error("tab-not-found");
      err.name = "tab-not-found";
      throw err;
    };
    return {load, seen};
  }

  async function run(input: {
    sources?: string;
    london?: unknown[][];
    bhmLocations?: unknown[][];
    bhmTariffs?: unknown[][];
    ldsLocations?: unknown[][];
    lastGoodRowCount?: number | null;
    fmppLastGoodCounts?: Record<string, number> | null;
    existing?: ExistingCellDoc[];
    enabled?: boolean;
    sheetId?: string;
    fail?: string;
  }): Promise<{result: SyncOnceResult; seen: string[]}> {
    const {load, seen} = tables(input);
    const result = await syncPrivateParkingOnce({
      now: NOW,
      enabled: input.enabled ?? true,
      sheetId: input.sheetId ?? "sheet-id",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: input.lastGoodRowCount === undefined ? null : input.lastGoodRowCount,
      existing: input.existing ?? [],
      loadSheet: load,
      fmppSources: input.sources,
      fmppLastGoodCounts: input.fmppLastGoodCounts,
    });
    return {result, seen};
  }

  it("matches a London-only run when the city param is unset or blank", async () => {
    let calls = 0;
    const load: SheetLoader = async () => {
      calls += 1;
      return londonSheet([YARD, OTHER]);
    };
    const base = {
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [] as ExistingCellDoc[],
      loadSheet: load,
    };
    const plain = await syncPrivateParkingOnce(base);
    const empty = await syncPrivateParkingOnce({...base, fmppSources: ""});
    const blank = await syncPrivateParkingOnce({...base, fmppSources: "  \n"});
    assert.deepEqual(empty, plain);
    assert.deepEqual(blank, plain);
    assert.equal(plain.status, "ok");
    assert.equal(calls, 3);
    const plainConfig = plain.config ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(plainConfig, "fmppLastGoodCounts"), false);
    const off = await syncPrivateParkingOnce({...base, enabled: false, fmppSources: BHM});
    assert.equal(off.status, "disabled");
    assert.equal(calls, 3);
    const missing = await syncPrivateParkingOnce({...base, sheetId: "", fmppSources: BHM});
    assert.equal(missing.status, "missing-params");
    assert.equal(calls, 3);
  });

  it("reads the default city tabs and keeps the London cell hash", async () => {
    const londonOnly = await run({sources: ""});
    const combined = await run({sources: BHM});
    assert.equal(combined.result.status, "ok");
    assert.deepEqual(combined.seen, [
      "sheet-id|ALL LONDON (clean)",
      `${BHM_SHEET}|Locations - Birmingham`,
      `${BHM_SHEET}|Tariffs - Birmingham`,
    ]);
    assert.equal(combined.result.imported, 3);
    assert.equal(combined.result.usableRows, 2);
    assert.equal(combined.result.config?.lastGoodRowCount, 2);
    assert.equal(combined.result.config?.fmppLastGoodCounts?.BHM, 1);
    assert.equal(combined.result.expired, 0);
    const londonCell = londonOnly.result.writes[0];
    const sameLondon = combined.result.writes.find((write) => write.id === londonCell?.id);
    assert.ok(londonCell && sameLondon);
    assert.equal(sameLondon.data.contentHash, londonCell.data.contentHash);
    assert.deepEqual(sameLondon.data.places.map((place) => place.id), londonCell.data.places.map((place) => place.id));
    const city = livePlaces(combined.result).find((place) => place.id === "FERRO-BHM-TST-0001");
    assert.equal(city?.fee, 100);
    assert.equal(city?.payMode, "inapp");
    const custom = await run({
      sources: `BHM|Birmingham|${BHM_SHEET}|Locations - Custom|Tariffs - Custom`,
    });
    assert.equal(custom.result.status, "aborted");
    assert.equal(custom.seen.includes(`${BHM_SHEET}|Locations - Custom`), true);
  });

  it("merges several cities into cells without expiring London or each other", async () => {
    const sources = `${BHM};LDS|Leeds|${LDS_SHEET}`;
    const first = await run({sources, fmppLastGoodCounts: {MKN: 12}});
    assert.equal(first.result.status, "ok");
    assert.equal(first.result.expired, 0);
    assert.equal(first.result.writes.every((write) => write.action !== "expire"), true);
    assert.deepEqual(first.result.config?.fmppLastGoodCounts, {MKN: 12, BHM: 1, LDS: 1});
    const ids = livePlaces(first.result).map((place) => place.id);
    assert.equal(ids.includes("FERRO-BHM-TST-0001"), true);
    assert.equal(ids.includes("FERRO-LDS-TST-0001"), true);
    assert.equal(ids.some((id) => /^[0-9a-f]{64}$/.test(id)), true);
    const later = await syncPrivateParkingOnce({
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
      enabled: true,
      sheetId: "sheet-id",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: 2,
      existing: existingFrom(first.result),
      loadSheet: tables({}).load,
      fmppSources: sources,
      fmppLastGoodCounts: first.result.config?.fmppLastGoodCounts,
    });
    assert.equal(later.status, "ok");
    assert.equal(later.writes.length, 0);
    assert.equal(later.expired, 0);
    assert.equal(later.unchanged, first.result.writes.length);
  });

  it("expires a removed city place without expiring London when the drop stays within 10%", async () => {
    const batch = (count: number, skip?: string) => locationMatrix(Array.from({length: count}, (_, index) => {
      const id = `FERRO-BHM-EXP-${String(index + 1).padStart(4, "0")}`;
      return ready({
        "Location ID": id,
        "Location Name": `Batch ${index + 1}`,
        "Provider Location Code": `E${index + 1}`,
        "Latitude": 52.2 + index * 0.05,
        "Longitude": -1.8,
        "Free Period (Y/N)": "N",
        "Parking Charge (£)": 1,
        "FM Ready": id === skip ? "" : "✅",
      });
    }));
    const first = await run({
      sources: BHM,
      bhmLocations: batch(10),
      bhmTariffs: tariffMatrix([]),
    });
    assert.equal(first.result.status, "ok");
    assert.equal(first.result.config?.fmppLastGoodCounts?.BHM, 10);
    const removedId = "FERRO-BHM-EXP-0002";
    const removedCell = first.result.writes.find((write) => write.data.places.some((place) => place.id === removedId));
    assert.ok(removedCell);
    assert.equal(removedCell.data.places.length, 1);
    const second = await run({
      sources: BHM,
      bhmLocations: batch(10, removedId),
      bhmTariffs: tariffMatrix([]),
      lastGoodRowCount: 2,
      fmppLastGoodCounts: {BHM: 10},
      existing: existingFrom(first.result),
    });
    assert.equal(second.result.status, "ok");
    assert.equal(second.result.expired, 1);
    assert.deepEqual(second.result.writes.map((write) => write.id), [removedCell.id]);
    assert.equal(second.result.writes[0]?.action, "expire");
    assert.deepEqual(second.result.writes[0]?.data.places, []);
    const londonIds = livePlaces(first.result)
      .filter((place) => !place.id.startsWith("FERRO-"))
      .map((place) => place.id);
    assert.equal(londonIds.length > 0, true);
    const expiredLondon = second.result.writes.some((write) => {
      return write.data.places.some((place) => londonIds.includes(place.id));
    });
    assert.equal(expiredLondon, false);
  });

  it("updates one city in a shared cell and leaves the London place in place", async () => {
    const shared = ready({
      "Location Name": "Shared Yard",
      "Postcode": "W1 1AA",
      "Latitude": 51.5,
      "Longitude": -0.12,
      "Street/Address": "Shared Yard",
    });
    const first = await run({
      sources: BHM,
      london: londonSheet([
        ["Shared Yard", "W1 1AA", "51.50", "-0.12", "Open", "Official site: clear answer", "Anyone", "Confirmed"],
        ["Elsewhere", "W1 9ZZ", "51.60", "-0.20", "Open", "Google Maps only", "Anyone", ""],
      ]),
      bhmLocations: locationMatrix([shared]),
    });
    assert.equal(first.result.status, "ok");
    const hashed = placeId("Shared Yard", "W1 1AA", 51.5, -0.12);
    const sharedWrite = first.result.writes.find((write) => write.data.places.some((place) => place.id === hashed));
    assert.ok(sharedWrite);
    assert.deepEqual(sharedWrite.data.places.map((place) => place.id).sort(), [hashed, "FERRO-BHM-TST-0001"].sort());
    assert.notEqual("FERRO-BHM-TST-0001", hashed);

    const repriced = await run({
      sources: BHM,
      london: londonSheet([
        ["Shared Yard", "W1 1AA", "51.50", "-0.12", "Open", "Official site: clear answer", "Anyone", "Confirmed"],
        ["Elsewhere", "W1 9ZZ", "51.60", "-0.20", "Open", "Google Maps only", "Anyone", ""],
      ]),
      bhmLocations: locationMatrix([shared]),
      bhmTariffs: tariffMatrix([hourlyBand({"Price (£)": 2})]),
      lastGoodRowCount: 2,
      fmppLastGoodCounts: {BHM: 1},
      existing: existingFrom(first.result),
    });
    assert.equal(repriced.result.status, "ok");
    assert.equal(repriced.result.expired, 0);
    assert.equal(repriced.result.writes.length, 1);
    const updated = repriced.result.writes[0];
    assert.equal(updated?.id, sharedWrite.id);
    assert.equal(updated?.action, "upsert");
    assert.equal(updated?.data.places.find((place) => place.id === "FERRO-BHM-TST-0001")?.fee, 200);
    assert.equal(updated?.data.places.some((place) => place.id === hashed), true);

    const cityGone = await run({
      sources: BHM,
      london: londonSheet([
        ["Shared Yard", "W1 1AA", "51.50", "-0.12", "Open", "Official site: clear answer", "Anyone", "Confirmed"],
        ["Elsewhere", "W1 9ZZ", "51.60", "-0.20", "Open", "Google Maps only", "Anyone", ""],
      ]),
      bhmLocations: locationMatrix([ready({...shared, "FM Ready": ""})]),
      lastGoodRowCount: 2,
      fmppLastGoodCounts: {BHM: 1},
      existing: existingFrom(first.result),
    });
    assert.equal(cityGone.result.status, "aborted");
    assert.equal(cityGone.result.abortReason, "fmpp-publishable-zero:BHM");
    assert.equal(cityGone.result.writes.length, 0);
    assert.equal(cityGone.result.writes.some((write) => write.id === sharedWrite.id), false);
  });

  it("writes nothing when one city fails, the header is wrong, or the count drops", async () => {
    const broken = await run({
      sources: `${BHM};LDS|Leeds|${LDS_SHEET}`,
      fail: `${LDS_SHEET}|Locations - Leeds`,
      existing: [{id: "london-cell", cell: "london-cell", contentHash: "keep", expiresAtMs: NOW.getTime() + CELL_TTL_MS}],
    });
    assert.equal(broken.result.status, "aborted");
    assert.equal(broken.result.abortReason, "fmpp-sheets-read-error:LDS:locations:tab-not-found");
    assert.equal(broken.result.writes.length, 0);
    assert.equal(broken.result.config?.lastGoodRowCount, undefined);
    assert.equal(broken.result.config?.fmppLastGoodCounts, undefined);
    assert.equal(broken.result.abortReason?.includes(LDS_SHEET), false);
    assert.equal(broken.seen.includes(`${BHM_SHEET}|Tariffs - Birmingham`), true);

    const badHeader: string[] = [...FMPP_LOCATION_HEADERS];
    badHeader[43] = "Ready?";
    const header = await run({sources: BHM, bhmLocations: [badHeader, locationRow(ready())]});
    assert.equal(header.result.status, "aborted");
    assert.equal(header.result.abortReason, "fmpp-header-unexpected:BHM:locations");
    assert.equal(header.result.writes.length, 0);
    assert.equal(header.seen.includes(`${BHM_SHEET}|Tariffs - Birmingham`), false);

    const badTariff: string[] = [...FMPP_TARIFF_HEADERS];
    badTariff[3] = "Band";
    const tariff = await run({sources: BHM, bhmTariffs: [badTariff]});
    assert.equal(tariff.result.abortReason, "fmpp-header-unexpected:BHM:tariffs");
    assert.equal(tariff.result.writes.length, 0);

    const empty = await run({sources: BHM, bhmLocations: locationMatrix([])});
    assert.equal(empty.result.abortReason, "fmpp-publishable-zero:BHM");
    assert.equal(empty.result.writes.length, 0);

    const rows = (count: number) => locationMatrix(Array.from({length: count}, (_, index) => ready({
      "Location ID": `FERRO-BHM-TST-${String(index + 1).padStart(4, "0")}`,
      "Location Name": `Place ${index + 1}`,
      "Provider Location Code": `C${index + 1}`,
      "Latitude": 52.4 + (index % 20) * 0.001,
      "Longitude": -1.9,
      "Free Period (Y/N)": "N",
      "Parking Charge (£)": 1,
    })));
    const dropped = await run({
      sources: BHM,
      bhmLocations: rows(89),
      bhmTariffs: tariffMatrix([]),
      fmppLastGoodCounts: {BHM: 100},
    });
    assert.equal(dropped.result.abortReason, "fmpp-publishable-dropped:BHM");
    assert.equal(dropped.result.writes.length, 0);
    const kept = await run({
      sources: BHM,
      bhmLocations: rows(90),
      bhmTariffs: tariffMatrix([]),
      fmppLastGoodCounts: {BHM: 100},
    });
    assert.equal(kept.result.status, "ok");
    assert.equal(kept.result.config?.fmppLastGoodCounts?.BHM, 90);
    assert.ok((kept.result.writes.length) > 0);

    const londonDrop = await run({sources: BHM, london: londonSheet([YARD]), lastGoodRowCount: 100});
    assert.equal(londonDrop.result.abortReason, "usable-row-count-dropped");
    assert.equal(londonDrop.result.writes.length, 0);
    assert.equal(londonDrop.seen.some((call) => call.includes("Locations -")), false);
  });

  it("rejects a bad source list, a duplicate id, and a London id collision before writing", async () => {
    let calls = 0;
    const invalid = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "sheet-id",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [],
      fmppSources: `BHM|Birmingham|${BHM_SHEET}|only-one-tab`,
      loadSheet: async () => {
        calls += 1;
        return londonSheet([YARD]);
      },
    });
    assert.equal(invalid.status, "aborted");
    assert.equal(invalid.abortReason, "fmpp-sources-invalid");
    assert.equal(invalid.writes.length, 0);
    assert.equal(calls, 0);

    const duplicated = await run({
      sources: BHM,
      bhmLocations: locationMatrix([
        ready(),
        ready({"Location Name": "Same id again", "Provider Location Code": "777777"}),
      ]),
    });
    assert.equal(duplicated.result.abortReason, "fmpp-duplicate-id:BHM");
    assert.equal(duplicated.result.writes.length, 0);

    const londonHash = placeId("Yard", "W1 1AA", 51.5, -0.12);
    const onlyHash = await run({
      sources: BHM,
      bhmLocations: locationMatrix([ready({"Location ID": londonHash, "Location Name": "Stolen id"})]),
      existing: [{id: "gcpvj0", cell: "gcpvj0", contentHash: "live", expiresAtMs: NOW.getTime() + CELL_TTL_MS}],
    });
    assert.equal(onlyHash.result.abortReason, "fmpp-publishable-zero:BHM");
    assert.equal(onlyHash.result.writes.length, 0);

    const alongside = await run({
      sources: BHM,
      london: londonSheet([YARD]),
      bhmLocations: locationMatrix([
        ready({"Location ID": londonHash, "Location Name": "Stolen id", "Provider Location Code": "888888"}),
        ready(),
      ]),
    });
    assert.equal(alongside.result.status, "ok");
    const ids = livePlaces(alongside.result).map((place) => place.id);
    assert.equal(ids.filter((id) => id === londonHash).length, 1);
    assert.equal(ids.includes("FERRO-BHM-TST-0001"), true);
    assert.equal(ids.includes(londonHash) && ids.filter((id) => id === "FERRO-BHM-TST-0001").length, 1);

    const invaded = mergePrivateParkingPlaces({
      now: NOW,
      london: [{...livePlaces(alongside.result)[0], id: "FERRO-BHM-AIR-0001"}],
      cities: [],
    });
    assert.equal(invaded.ok, false);
    if (!invaded.ok) assert.equal(invaded.reason, "fmpp-id-collision");
    assert.equal(placeIdsCollide([[londonHash], ["FERRO-BHM-TST-0001"]]), false);
    assert.equal(placeIdsCollide([[londonHash], [londonHash]]), true);
    assert.equal(placeIdsCollide([["PP-000123"], ["PP-000123"]]), true);
    assert.equal(placeIdsCollide([[londonHash], ["FERRO-BHM-TST-0001"], ["FERRO-BHM-TST-0001"]]), true);
    assert.equal(placeIdsCollide([["FERRO-BHM-AIR-0001"], []]), true);
  });
});
