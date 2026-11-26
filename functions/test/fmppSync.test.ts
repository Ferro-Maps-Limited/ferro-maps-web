import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {CELL_TTL_MS} from "../src/parking/privateSheet/build.js";
import {
  FMPP_LOCATION_HEADERS,
  FMPP_TARIFF_HEADERS,
  fmppHeaderProblem,
  indexFmppTariffs,
  isFmReadyTick,
  mapFmppLocations,
  parseFmppSources,
  parseMaxStayMinutes,
  placeOwner,
  providerSlug,
  readFmppCountMap,
  tariffFee,
  type FmppSource,
} from "../src/parking/privateSheet/fmpp.js";
import {placeId} from "../src/parking/privateSheet/mapping.js";
import {rowsFromMatrix} from "../src/parking/privateSheet/rows.js";
import {
  syncPrivateParkingOnce,
  type ExistingCellDoc,
} from "../src/parking/privateSheet/syncPlan.js";

/* Spec order, 26 Nov 2026, identical on Birmingham, London, Manchester, Liverpool, and Leeds. */
const SPEC_LOCATION_HEADERS = [
  "Location ID", "Provider", "Provider Location Code", "Primary Provider", "Merged Location ID",
  "Location Name", "Type", "Street/Address", "Postcode", "Area", "Borough/Operator",
  "Latitude", "Longitude", "Hours of Operation", "Max Stay", "Tariff / Prices (GBP)",
  "Restrictions & Rules", "Free Period (Y/N)", "Free Minutes", "Free Time Window",
  "No-Return Period (mins)", "Free Parking Notes", "Payment Options", "Also payable via",
  "Convenience fee", "Ferro Autopay", "Ferro Charge", "Example Ferro charge on a £5 session",
  "Source URL", "Last Checked", "Notes", "", "Parking Charge (£)", "Tariff Bands",
  "Charging Days/Hours", "Min Stay / Max Stay", "Provider Convenience/Service Fee (£)",
  "Emissions/Diesel Surcharge", "Tariff Source URL", "Tariff Last Checked", "Tariff Confidence",
  "Ferro total for 1h", "FM Ready Missing", "FM Ready",
];

const SPEC_TARIFF_HEADERS = [
  "Location ID", "Provider", "Provider Location Code", "Duration / Band", "Price (£)",
  "Confidence", "Source URL", "Last Checked", "Notes",
];

const NOW = new Date("2026-11-26T12:00:00.000Z");
const LATER = new Date(NOW.getTime() + 60 * 60 * 1000);
const LONDON_HEAD = [
  "Location Name", "Postcode", "Latitude", "Longitude", "Location Status",
  "Evidence Type", "Who Can Park", "Verification Result",
];
const YARD = ["Yard", "W1 1AA", "51.50", "-0.12", "Open", "Official site: partial info", "Customers only", "Confirmed"];
const OTHER = ["Other", "W1 1AB", "51.51", "-0.13", "Open", "Google Maps only", "Anyone", ""];

const BHM_SHEET = "1Dv3zifuEWuo5X2Lzfjm0pS8tze6Oe_ipASWfzrR-T-o";
const LDS_SHEET = "15M9ET9wMUGDJyibSjVGwMprSWls37PB-kXlIn3mF1Ho";
const FNM_SHEET = "1YWEuu0zCa54KSZbllwS9NfDnuYFV3vQJBQCRXTYddcU";
const MKN_SHEET = "1q4Bhhw66amvVXFZw-dUwK5peCZ50fc9HVapDeF27Ydk";
const BRS_SHEET = "1GsIdZF_iBiEVCJCXwp9gNV_yWQMdjrIbNTlAZpxJglg";
const MAN_SHEET = "1_Ue20vHPuBWhzBKZGXn5Ks1LccjPr_-Udpe2g2D910Q";
const LPL_SHEET = "1NzRvgrFwr6pMtE9hCpGt0toJJ6b8WHy20gaBWgkAyt4";
const GLW_SHEET = "10WSGqfBDCoglgDcOPZ3huclpHmWv_W3Ob4cp-wki9Ns";

function grid(headers: readonly string[], rows: Array<Record<string, unknown>>): unknown[][] {
  return [headers.slice(), ...rows.map((row) => headers.map((name) => (name ? row[name] ?? null : null)))];
}

function ready(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Location ID": "FERRO-BHM-LDW-0001",
    "Provider": "RingGo",
    "Provider Location Code": "3501650",
    "Primary Provider": "RingGo",
    "Location Name": "Barwick Street, Central",
    "Type": "On-street",
    "Street/Address": "Barwick Street",
    "Postcode": "B3 2HJ",
    "Latitude": 52.48171,
    "Longitude": -1.90099,
    "Hours of Operation": "RingGo charge times: All Week 8:00am - 7:30pm; Bank Holiday",
    "Max Stay": "4 Hours",
    "Free Period (Y/N)": "Y",
    "Ferro Autopay": "✅",
    "Source URL": "https://myringgo.co.uk/whereitworks/3501650?style=d",
    "Last Checked": "25/11/2026",
    "Parking Charge (£)": 4.6,
    "Tariff Confidence": "Verified",
    "FM Ready": "✅",
    ...over,
  };
}

function band(id: string, duration: string, price: unknown, over: Record<string, unknown> = {}) {
  return {
    "Location ID": id,
    "Provider": "RingGo",
    "Provider Location Code": "3501650",
    "Duration / Band": duration,
    "Price (£)": price,
    "Confidence": "Verified",
    "Source URL": "https://myringgo.co.uk/whereitworks/3501650?style=d",
    "Last Checked": "25/11/2026",
    ...over,
  };
}

function mapped(locations: Array<Record<string, unknown>>, tariffs: Array<Record<string, unknown>> = [], code = "BHM") {
  return mapFmppLocations(
    rowsFromMatrix(grid(SPEC_LOCATION_HEADERS, locations)),
    indexFmppTariffs(rowsFromMatrix(grid(SPEC_TARIFF_HEADERS, tariffs))),
    code,
  );
}

function londonSheet(rows: unknown[][] = [YARD, OTHER]): unknown[][] {
  return [LONDON_HEAD, ...rows];
}

function source(code: string, city: string, sheetId: string): FmppSource {
  const parsed = parseFmppSources(`${code}|${city}|${sheetId}`);
  if (!parsed.ok) throw new Error(parsed.detail);
  const found = parsed.sources[0];
  if (!found) throw new Error("missing source");
  return found;
}

describe("FM-PP headers", () => {
  it("requires the 44 location headers and the 9 tariff headers in spec order", () => {
    assert.equal(SPEC_LOCATION_HEADERS.length, 44);
    assert.equal(SPEC_TARIFF_HEADERS.length, 9);
    assert.equal(SPEC_LOCATION_HEADERS[31], "");
    assert.equal(SPEC_LOCATION_HEADERS[43], "FM Ready");
    assert.equal(SPEC_TARIFF_HEADERS[4], "Price (£)");
    assert.deepEqual([...FMPP_LOCATION_HEADERS], SPEC_LOCATION_HEADERS);
    assert.deepEqual([...FMPP_TARIFF_HEADERS], SPEC_TARIFF_HEADERS);
    assert.equal(fmppHeaderProblem([SPEC_LOCATION_HEADERS], "locations"), null);
    assert.equal(fmppHeaderProblem([SPEC_TARIFF_HEADERS], "tariffs"), null);
    assert.equal(fmppHeaderProblem([[...SPEC_LOCATION_HEADERS, "", null]], "locations"), null);
    assert.equal(fmppHeaderProblem([], "locations"), "header-missing");
    assert.equal(fmppHeaderProblem([[]], "locations"), "header-missing");
    assert.equal(fmppHeaderProblem([[""]], "tariffs"), "header-missing");
    const swapped = SPEC_LOCATION_HEADERS.slice();
    swapped[7] = "Postcode";
    swapped[8] = "Street/Address";
    assert.equal(fmppHeaderProblem([swapped], "locations"), "header-unexpected");
    const noSpacer = SPEC_LOCATION_HEADERS.filter((_, index) => index !== 31);
    assert.equal(fmppHeaderProblem([noSpacer], "locations"), "header-unexpected");
    assert.equal(fmppHeaderProblem([[...SPEC_LOCATION_HEADERS, "Extra"]], "locations"), "header-unexpected");
    assert.equal(fmppHeaderProblem([SPEC_LOCATION_HEADERS], "tariffs"), "header-unexpected");
    const renamed = SPEC_TARIFF_HEADERS.slice();
    renamed[4] = "Price";
    assert.equal(fmppHeaderProblem([renamed], "tariffs"), "header-unexpected");
  });
});

describe("FM-PP config", () => {
  it("stays empty until a city is configured, and accepts later cities with no code list", () => {
    assert.deepEqual(parseFmppSources(""), {ok: true, sources: []});
    assert.deepEqual(parseFmppSources("  \n"), {ok: true, sources: []});
    const parsed = parseFmppSources([
      `bhm|Birmingham|${BHM_SHEET}`,
      `LDS|Leeds|${LDS_SHEET}`,
      `FNM|Farnham|${FNM_SHEET}`,
      `MKN|Milton Keynes|${MKN_SHEET}`,
      `BRS|Bristol|${BRS_SHEET}`,
      `MAN|Manchester|${MAN_SHEET}`,
      `LPL|Liverpool|${LPL_SHEET}`,
      `GLW|Glasgow|${GLW_SHEET}`,
    ].join(";"));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.sources.map((item) => item.code), ["BHM", "LDS", "FNM", "MKN", "BRS", "MAN", "LPL", "GLW"]);
    const birmingham = parsed.sources[0];
    assert.equal(birmingham.city, "Birmingham");
    assert.equal(birmingham.sheetId, BHM_SHEET);
    assert.equal(birmingham.locationsTab, "Locations - Birmingham");
    assert.equal(birmingham.tariffsTab, "Tariffs - Birmingham");
    assert.equal(parsed.sources[3].locationsTab, "Locations - Milton Keynes");
    assert.equal(parsed.sources[3].tariffsTab, "Tariffs - Milton Keynes");
    const london = parseFmppSources("LDN|London|1N5jRjO7IIwm179DvcxnoensgWtIMqbGSt7nG-JVI4tY");
    assert.equal(london.ok, true);
    if (!london.ok) return;
    assert.equal(london.sources[0].locationsTab, "Locations - London");
    assert.equal(london.sources[0].tariffsTab, "Tariffs");
    const explicit = parseFmppSources(`BHM|Birmingham|${BHM_SHEET}|Locations - Birmingham|Tariffs - Birmingham`);
    assert.equal(explicit.ok, true);
    if (!explicit.ok) return;
    assert.equal(explicit.sources[0].tariffsTab, "Tariffs - Birmingham");
    const newline = parseFmppSources(`BHM|Birmingham|${BHM_SHEET}\nLDS|Leeds|${LDS_SHEET}`);
    assert.equal(newline.ok, true);
    if (!newline.ok) return;
    assert.equal(newline.sources.length, 2);
  });

  it("rejects a broken city list instead of guessing", () => {
    assert.equal(parseFmppSources("BHM|Birmingham").ok, false);
    assert.equal(parseFmppSources(`BHM|Birmingham|${BHM_SHEET}|only-one-tab`).ok, false);
    assert.equal(parseFmppSources(`BHM|Birmingham|${BHM_SHEET};BHM|Birmingham 2|${LDS_SHEET}`).ok, false);
    assert.equal(parseFmppSources(`BHM|Birmingham|${BHM_SHEET};LDS|Leeds|${BHM_SHEET}`).ok, false);
    assert.equal(parseFmppSources("NO|Birmingham|short").ok, false);
    assert.equal(parseFmppSources(`|Birmingham|${BHM_SHEET}`).ok, false);
    const many = Array.from({length: 33}, (_, index) => {
      return `C${index}|City ${index}|${"a".repeat(20)}${index}`;
    }).join(";");
    assert.equal(parseFmppSources(many).ok, false);
    assert.deepEqual(readFmppCountMap({BHM: 428, LDS: 10, nope: "x"}), {BHM: 428, LDS: 10});
    assert.deepEqual(readFmppCountMap(null), {});
  });
});

describe("FM-PP place ids", () => {
  it("keeps FERRO city ids, London hashes, and PP-###### in separate namespaces", () => {
    const hash = placeId("Yard", "W1 1AA", 51.5, -0.12);
    assert.equal(placeOwner(hash)?.kind, "london");
    assert.equal(placeOwner("PP-000123")?.kind, "london");
    assert.equal(placeOwner("PP-42")?.kind, "london");
    assert.deepEqual(placeOwner("FERRO-BHM-AIR-0001"), {kind: "fmpp", code: "BHM"});
    assert.deepEqual(placeOwner("FERRO-BHM-LDW-0001"), {kind: "fmpp", code: "BHM"});
    assert.deepEqual(placeOwner("FERRO-LDS-ABC-0002"), {kind: "fmpp", code: "LDS"});
    assert.equal(placeOwner("FERRO-BHM-LDW-0001")?.kind === placeOwner("PP-000123")?.kind, false);
    assert.notEqual(hash, "FERRO-BHM-LDW-0001");
    assert.equal(hash.includes("FERRO"), false);
    assert.equal("PP-000123".startsWith("FERRO"), false);
  });
});

describe("FM-PP mapping", () => {
  it("imports only an exact FM Ready tick", () => {
    assert.equal(isFmReadyTick("✅"), true);
    assert.equal(isFmReadyTick(" ✅ "), true);
    assert.equal(isFmReadyTick("Yes"), false);
    assert.equal(isFmReadyTick("✓"), false);
    assert.equal(isFmReadyTick(true), false);
    const blank = mapped([ready({"FM Ready": ""})]);
    assert.equal(blank.readyRows, 0);
    assert.equal(blank.places.length, 0);
    const word = mapped([ready({"FM Ready": "Yes"})]);
    assert.equal(word.places.length, 0);
  });

  it("maps the Birmingham samples and joins tariffs without inventing a stepped price", () => {
    assert.equal(parseMaxStayMinutes("4 Hours"), 240);
    assert.equal(parseMaxStayMinutes("72 hours"), 4320);
    assert.equal(parseMaxStayMinutes("not published (tariff continues in 15-minute increments after 60 minutes)"), undefined);
    assert.equal(providerSlug("NCP (for Birmingham Airport)"), "ncp");
    assert.equal(providerSlug("JustPark"), "justpark");
    assert.equal(providerSlug("RingGo"), "ringgo");

    const result = mapped([
      ready({
        "Location ID": "FERRO-BHM-AIR-0001",
        "Provider": "NCP (for Birmingham Airport)",
        "Primary Provider": "NCP (for Birmingham Airport)",
        "Provider Location Code": "BHX-PSD",
        "Location Name": "Birmingham Airport Premium Set Down (turn-up / on-the-day)",
        "Street/Address": "Premium Set Down, Concorde Road, Birmingham Airport",
        "Postcode": "B26 3QJ",
        "Latitude": 52.451299,
        "Longitude": -1.731056,
        "Hours of Operation": "24 hours, every day",
        "Max Stay": "not published (tariff continues in 15-minute increments after 60 minutes)",
        "Free Period (Y/N)": "N",
        "Source URL": "https://www.birminghamairport.co.uk/parking/premium-set-down/",
        "Parking Charge (£)": 61,
      }),
      ready({
        "Location ID": "FERRO-BHM-HHL-0004",
        "Provider Location Code": "684268",
        "Location Name": "ECP - Fox & Goose Shopping Car Park - Birmingham",
        "Street/Address": "not published",
        "Postcode": "B8 2NB",
        "Latitude": 52.49391,
        "Longitude": -1.81929,
        "Hours of Operation": "Charge times (RingGo): All Week.",
        "Max Stay": "72 hours",
        "Free Period (Y/N)": "Y",
        "Free Minutes": 120,
        "Parking Charge (£)": 0,
        "Source URL": "https://myringgo.co.uk/whereitworks/684268?style=d",
      }),
      ready({
        "Location ID": "FERRO-BHM-EDG-0026",
        "Provider": "JustPark",
        "Primary Provider": "JustPark",
        "Provider Location Code": "811110",
        "Location Name": "Asda Barnes Hill Car Park (ASDA)",
        "Street/Address": "Barnes Hill Road",
        "Postcode": "B29 5UP",
        "Latitude": 52.443168,
        "Longitude": -1.97897,
        "Hours of Operation": "not published on the public JustPark listing (driver books a start and end time)",
        "Max Stay": "not published",
        "Free Period (Y/N)": "N",
        "Parking Charge (£)": 1.19,
        "Source URL": "https://www.justpark.com/uk/parking/birmingham/s/barnes-hill-road-birmingham-b29-5up/",
      }),
      ready({
        "Location ID": "FERRO-BHM-LDW-0001",
        "Also payable via": "JustPark 3501650; APCOA Connect 3501650",
      }),
      ready({
        "Location ID": "FERRO-BHM-LDW-0134",
        "Provider": "NCP",
        "Primary Provider": "NCP",
        "Provider Location Code": "NCP-HIGH-STREET",
        "Location Name": "NCP Birmingham High Street",
        "Ferro Autopay": "No (pay-on-the-day is NCP App / on-site; not on Pay Later; FM Ready = No)",
        "FM Ready": "",
        "Parking Charge (£)": 2,
      }),
    ], [
      band("FERRO-BHM-AIR-0001", "0–15 minutes", 8),
      band("FERRO-BHM-AIR-0001", "15–20 minutes", 13),
      band("FERRO-BHM-AIR-0001", "Each extra 15 minutes thereafter", 8),
      band("FERRO-BHM-HHL-0004", "For every 1 Hour — All Week", "£1.00"),
      band("FERRO-BHM-EDG-0026", "1 hour", 1.19),
      band("FERRO-BHM-EDG-0026", "2 hours", 1.69),
      band("FERRO-BHM-LDW-0001", "up to 1 hour (All Week 8:00am - 7:30pm)", 4.6),
      band("FERRO-BHM-LDW-0001", "up to 2 hours (All Week 8:00am - 7:30pm)", 7.6),
      band("FERRO-BHM-LDW-0001", "up to 24 hours (Bank Holiday)", 0),
      band("FERRO-BHM-LDW-0134", "1 hour (pay on the day / NCP App)", 2),
    ]);

    assert.equal(result.readyRows, 4);
    assert.deepEqual(result.places.map((place) => place.id), [
      "FERRO-BHM-AIR-0001",
      "FERRO-BHM-HHL-0004",
      "FERRO-BHM-EDG-0026",
      "FERRO-BHM-LDW-0001",
    ]);
    const air = result.places[0];
    assert.equal(air.n, "Birmingham Airport Premium Set Down (turn-up / on-the-day)");
    assert.equal(air.operator, "NCP (for Birmingham Airport)");
    assert.equal(air.locationProvider, "ncp");
    assert.equal(air.locationCode, "BHX-PSD");
    assert.equal(air.hours, "24 hours, every day");
    assert.equal("fee" in air, false);
    assert.equal("max" in air, false);
    assert.equal(air.auto, true);
    assert.equal(air.payMode, "inapp");
    assert.equal(air.q, "known");
    assert.equal(air.aud, "a");
    assert.equal(air.s, 1);
    assert.equal(air.srcType, "official");
    assert.equal(air.conf, 1);
    assert.equal(air.verifiedAt, "2026-11-25T00:00:00.000Z");

    const fox = result.places[1];
    assert.equal(fox.fee, 100);
    assert.equal(fox.feeUnit, "hour");
    assert.equal(fox.free, 120);
    assert.equal(fox.max, 4320);
    assert.equal(fox.addr, "B8 2NB");
    assert.equal(fox.locationCode, "684268");
    assert.equal(fox.locationProvider, "ringgo");

    const asda = result.places[2];
    assert.equal("fee" in asda, false);
    assert.equal("hours" in asda, false);
    assert.equal("max" in asda, false);
    assert.equal(asda.operator, "JustPark");
    assert.equal(asda.locationProvider, "justpark");
    assert.equal(asda.addr, "Barnes Hill Road, B29 5UP");

    const street = result.places[3];
    assert.equal("fee" in street, false);
    assert.equal("free" in street, false);
    assert.equal(street.max, 240);
    assert.equal(street.locationCode, "3501650");
    assert.equal(street.hours?.includes("Bank Holiday"), true);
    assert.equal(street.id.startsWith("PP-"), false);
  });

  it("drops ids that would collide with London, and keeps the first duplicate", () => {
    const hash = placeId("Yard", "W1 1AA", 51.5, -0.12);
    const result = mapped([
      ready({"Location ID": "PP-000123", "Location Name": "London style"}),
      ready({"Location ID": hash, "Location Name": "Hash style"}),
      ready({"Location ID": "FERRO-LDS-CTY-0001", "Location Name": "Leeds row"}),
      ready({"Location ID": "FERRO-BH-LDW-0001", "Location Name": "Short code"}),
      ready({"Location ID": "ferro-bhm-sot-0002", "Location Name": "First"}),
      ready({"Location ID": "FERRO-BHM-SOT-0002", "Location Name": "Second"}),
      ready({"Ferro Autopay": "No", "Location Name": "Ticked but not autopay", "Location ID": "FERRO-BHM-SOT-0003"}),
    ]);
    assert.deepEqual(result.places.map((place) => place.id), ["FERRO-BHM-SOT-0002"]);
    assert.equal(result.places[0].n, "First");
    assert.equal(result.skipped.bad_id, 4);
    assert.equal(result.skipped.duplicate_id, 1);
    assert.equal(result.skipped.not_autopay, 1);
    assert.equal(result.readyRows, 7);
  });

  it("prices one hourly, day, or visit band and leaves mixed bands unpriced", () => {
    assert.deepEqual(tariffFee([{
      locationId: "FERRO-BHM-HHL-0004",
      duration: "For every 1 Hour — All Week",
      pricePence: 100,
      confidence: "Partial",
    }]), {fee: 100, feeUnit: "hour"});
    assert.deepEqual(tariffFee([{
      locationId: "X",
      duration: "24 hours",
      pricePence: 1200,
      confidence: "Verified",
    }]), {fee: 1200, feeUnit: "day"});
    assert.deepEqual(tariffFee([{
      locationId: "X",
      duration: "per stay",
      pricePence: 500,
      confidence: "Verified",
    }]), {fee: 500, feeUnit: "visit"});
    assert.deepEqual(tariffFee([
      {locationId: "X", duration: "for every 1 hour", pricePence: 100, confidence: "Verified"},
      {locationId: "X", duration: "for every 1 hour", pricePence: 200, confidence: "Verified"},
    ]), {});
    assert.deepEqual(tariffFee([
      {locationId: "X", duration: "for every 1 hour", pricePence: 100, confidence: "Verified"},
      {locationId: "X", duration: "up to 3 hours", pricePence: 250, confidence: "Verified"},
    ]), {});
    const partial = mapped([ready({"Tariff Confidence": "Partial"})], [
      band("FERRO-BHM-LDW-0001", "For every 1 hour", 2),
    ]);
    assert.equal(partial.places[0].conf, 0.6);
    assert.equal(partial.places[0].fee, 200);
    const dated = mapped([ready({"Last Checked": "25 Nov 2026"})]);
    assert.equal(dated.places[0].verifiedAt, "2026-11-25T00:00:00.000Z");
    const bareCharge = mapped([ready()]);
    assert.equal("fee" in bareCharge.places[0], false);
  });
});

describe("FM-PP sync", () => {
  const birmingham = source("BHM", "Birmingham", BHM_SHEET);
  const manchester = source("MAN", "Manchester", MAN_SHEET);

  function tables(input: {
    london?: unknown[][];
    bhm?: Array<Record<string, unknown>>;
    bhmTariffs?: Array<Record<string, unknown>>;
    man?: Array<Record<string, unknown>>;
    manTariffs?: Array<Record<string, unknown>>;
  }): Record<string, unknown[][]> {
    return {
      ["london-sheet\nALL LONDON (clean)"]: input.london ?? londonSheet(),
      [`${BHM_SHEET}\nLocations - Birmingham`]: grid(SPEC_LOCATION_HEADERS, input.bhm ?? []),
      [`${BHM_SHEET}\nTariffs - Birmingham`]: grid(SPEC_TARIFF_HEADERS, input.bhmTariffs ?? []),
      [`${MAN_SHEET}\nLocations - Manchester`]: grid(SPEC_LOCATION_HEADERS, input.man ?? []),
      [`${MAN_SHEET}\nTariffs - Manchester`]: grid(SPEC_TARIFF_HEADERS, input.manTariffs ?? []),
    };
  }

  function loader(book: Record<string, unknown[][]>, fail: string[] = []) {
    const calls: string[] = [];
    return {
      calls,
      loadSheet: async (sheetId: string, tab: string) => {
        calls.push(`${sheetId} ${tab}`);
        const key = `${sheetId}\n${tab}`;
        if (fail.includes(key)) {
          const err = new Error("tab-not-found");
          err.name = "tab-not-found";
          throw err;
        }
        if (!(key in book)) {
          const err = new Error("missing-test-tab");
          err.name = "missing-test-tab";
          throw err;
        }
        return book[key];
      },
    };
  }

  function stored(writes: Array<{id: string; data: {cell: string; contentHash: string}}>): ExistingCellDoc[] {
    return writes.map((write) => ({
      id: write.id,
      cell: write.data.cell,
      contentHash: write.data.contentHash,
      expiresAtMs: NOW.getTime() + CELL_TTL_MS,
    }));
  }

  const shared = ready({
    "Location ID": "FERRO-BHM-LDW-0099",
    "Location Name": "Shared with London",
    "Latitude": "51.50",
    "Longitude": "-0.12",
  });
  const cityOnly = ready({
    "Location ID": "FERRO-BHM-HHL-0004",
    "Location Name": "Fox and Goose",
    "Latitude": 52.49391,
    "Longitude": -1.81929,
    "Free Minutes": 120,
    "Max Stay": "72 hours",
    "Street/Address": "not published",
    "Postcode": "B8 2NB",
  });
  const fillers = Array.from({length: 8}, (_, index) => ready({
    "Location ID": `FERRO-BHM-FIL-${String(index + 1).padStart(4, "0")}`,
    "Location Name": `Filler ${index}`,
    "Latitude": 52.1 + index * 0.02,
    "Longitude": -1.7,
  }));
  const manchesterRow = ready({
    "Location ID": "FERRO-MAN-CTY-0001",
    "Location Name": "Manchester Piccadilly",
    "Latitude": 53.4808,
    "Longitude": -2.2426,
    "Postcode": "M1 1AA",
  });

  it("publishes London exactly as before when no city source is configured", async () => {
    let calls = 0;
    const result = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [{id: "u10j3a", cell: "u10j3a", contentHash: "old", expiresAtMs: NOW.getTime() + CELL_TTL_MS}],
      loadSheet: async () => {
        calls += 1;
        return londonSheet([YARD]);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "ok");
    assert.equal(result.config?.fmppLastGoodCounts, undefined);
    assert.equal(result.writes.some((write) => write.id === "u10j3a" && write.action === "expire"), true);
    const place = result.writes.find((write) => write.action === "upsert")?.data.places[0];
    assert.equal(place?.id, placeId("Yard", "W1 1AA", 51.5, -0.12));
    assert.equal(place?.id.startsWith("FERRO-"), false);
    assert.equal(place?.id.startsWith("PP-"), false);

    const emptySources = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [],
      fmppSources: [],
      loadSheet: async () => londonSheet([YARD]),
    });
    assert.equal(emptySources.config?.fmppLastGoodCounts, undefined);
    assert.equal(emptySources.writes[0].data.places[0].id, place?.id);
  });

  it("merges city places beside London and does not expire the other source", async () => {
    const book = tables({
      bhm: [...fillers, shared, cityOnly],
      bhmTariffs: [band("FERRO-BHM-HHL-0004", "For every 1 Hour — All Week", 1)],
      man: [manchesterRow],
    });
    const firstLoad = loader(book);
    const first = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: firstLoad.loadSheet,
      fmppSources: [birmingham, manchester],
    });
    assert.equal(first.status, "ok");
    assert.deepEqual(first.config?.fmppLastGoodCounts, {BHM: 10, MAN: 1});
    assert.deepEqual(firstLoad.calls, [
      "london-sheet ALL LONDON (clean)",
      `${BHM_SHEET} Locations - Birmingham`,
      `${BHM_SHEET} Tariffs - Birmingham`,
      `${MAN_SHEET} Locations - Manchester`,
      `${MAN_SHEET} Tariffs - Manchester`,
    ]);
    const londonOnly = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [],
      loadSheet: async () => londonSheet(),
    });
    const yardAlone = londonOnly.writes.find((write) => write.data.places.some((place) => place.n === "Yard"));
    const otherAlone = londonOnly.writes.find((write) => write.data.places.some((place) => place.n === "Other"));
    const yardMerged = first.writes.find((write) => write.data.places.some((place) => place.n === "Yard"));
    const otherMerged = first.writes.find((write) => write.data.places.some((place) => place.n === "Other"));
    assert.ok(yardAlone && yardMerged && otherAlone && otherMerged);
    assert.deepEqual(yardMerged.data.places.map((place) => place.id).sort(), [
      placeId("Yard", "W1 1AA", 51.5, -0.12),
      "FERRO-BHM-LDW-0099",
    ].sort());
    assert.notEqual(yardMerged.data.contentHash, yardAlone.data.contentHash);
    assert.equal(otherMerged.data.contentHash, otherAlone.data.contentHash);
    assert.deepEqual(otherMerged.data.places, otherAlone.data.places);
    const fox = first.writes.find((write) => write.data.places.some((place) => place.id === "FERRO-BHM-HHL-0004"));
    assert.equal(fox?.data.places[0].fee, 100);
    assert.equal(fox?.data.places.length, 1);

    const existing = stored(first.writes);
    const dropped = await syncPrivateParkingOnce({
      now: LATER,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: 2,
      existing,
      loadSheet: loader(tables({
        bhm: [...fillers, shared],
        man: [ready({...manchesterRow, "Location Name": "Manchester Piccadilly updated"})],
      })).loadSheet,
      fmppSources: [birmingham, manchester],
      fmppLastGoodCounts: {BHM: 10, MAN: 1},
    });
    assert.equal(dropped.status, "ok");
    assert.equal(dropped.expired, 1);
    assert.equal(dropped.writes.find((write) => write.id === fox?.id)?.action, "expire");
    assert.equal(dropped.writes.some((write) => write.id === yardMerged.id), false);
    assert.equal(dropped.writes.some((write) => write.id === otherMerged.id), false);
    const manchesterWrite = dropped.writes.find((write) => (
      write.data.places.some((place) => place.id === "FERRO-MAN-CTY-0001")
    ));
    assert.equal(manchesterWrite?.action, "upsert");
    assert.equal(manchesterWrite?.data.places[0].n, "Manchester Piccadilly updated");
    assert.equal(manchesterWrite?.data.places.some((place) => place.id.startsWith("PP-")), false);
  });

  it("leaves every live cell alone when any configured workbook fails", async () => {
    const book = tables({bhm: [cityOnly], man: [manchesterRow]});
    const existing: ExistingCellDoc[] = [
      {id: "gcpvj0", cell: "gcpvj0", contentHash: "london", expiresAtMs: NOW.getTime() + CELL_TTL_MS},
      {id: "gcw5y1", cell: "gcw5y1", contentHash: "bhm", expiresAtMs: NOW.getTime() + CELL_TTL_MS},
    ];
    const base = {
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: 2,
      existing,
      fmppSources: [birmingham, manchester],
      fmppLastGoodCounts: {BHM: 1, MAN: 1},
    };
    const missing = await syncPrivateParkingOnce({
      ...base,
      loadSheet: loader(book, [`${MAN_SHEET}\nLocations - Manchester`]).loadSheet,
    });
    assert.equal(missing.status, "aborted");
    assert.equal(missing.abortReason, "fmpp-sheets-read-error:MAN:locations:tab-not-found");
    assert.equal(missing.writes.length, 0);
    assert.equal(missing.config?.lastGoodRowCount, undefined);
    assert.equal(missing.config?.fmppLastGoodCounts, undefined);

    const badTariffs = await syncPrivateParkingOnce({
      ...base,
      loadSheet: loader(book, [`${BHM_SHEET}\nTariffs - Birmingham`]).loadSheet,
    });
    assert.equal(badTariffs.abortReason, "fmpp-sheets-read-error:BHM:tariffs:tab-not-found");
    assert.equal(badTariffs.writes.length, 0);

    const badHeader = tables({bhm: [cityOnly]});
    badHeader[`${BHM_SHEET}\nLocations - Birmingham`] = [["Location ID", "Name"]];
    const headers = await syncPrivateParkingOnce({
      ...base,
      fmppSources: [birmingham],
      loadSheet: loader(badHeader).loadSheet,
    });
    assert.equal(headers.abortReason, "fmpp-header-unexpected:BHM:locations");
    assert.equal(headers.writes.length, 0);

    const badTariffHeader = tables({bhm: [cityOnly]});
    badTariffHeader[`${BHM_SHEET}\nTariffs - Birmingham`] = [["Location ID", "Price"]];
    const tariffHeaders = await syncPrivateParkingOnce({
      ...base,
      fmppSources: [birmingham],
      loadSheet: loader(badTariffHeader).loadSheet,
    });
    assert.equal(tariffHeaders.abortReason, "fmpp-header-unexpected:BHM:tariffs");
    assert.equal(tariffHeaders.writes.length, 0);

    let calls = 0;
    const londonDown = await syncPrivateParkingOnce({
      ...base,
      loadSheet: async () => {
        calls += 1;
        throw new Error("sheets down");
      },
    });
    assert.equal(calls, 1);
    assert.equal(londonDown.abortReason, "sheets-read-error:Error");
    assert.equal(londonDown.writes.length, 0);

    const londonHeaders = loader(tables({bhm: [cityOnly]}));
    const unexpected = await syncPrivateParkingOnce({
      ...base,
      fmppSources: [birmingham],
      loadSheet: async (sheetId, tab) => {
        if (sheetId === "london-sheet") return [["Location Name"]];
        return londonHeaders.loadSheet(sheetId, tab);
      },
    });
    assert.equal(unexpected.abortReason, "header-unexpected");
    assert.equal(londonHeaders.calls.length, 0);
    assert.equal(unexpected.writes.length, 0);
  });

  it("aborts a city more than 10% under its last good count, and still publishes 9 of 10", async () => {
    const rows = (count: number) => Array.from({length: count}, (_, index) => ready({
      "Location ID": `FERRO-BHM-LDW-${String(index + 1).padStart(4, "0")}`,
      "Location Name": `Place ${index}`,
      "Latitude": 52.4 + index * 0.01,
      "Longitude": -1.9,
    }));
    const dropped = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: 2,
      existing: [{id: "gcpvj0", cell: "gcpvj0", contentHash: "london", expiresAtMs: NOW.getTime() + CELL_TTL_MS}],
      fmppSources: [birmingham],
      fmppLastGoodCounts: {BHM: 10},
      loadSheet: loader(tables({bhm: rows(8)})).loadSheet,
    });
    assert.equal(dropped.status, "aborted");
    assert.equal(dropped.abortReason, "fmpp-usable-row-count-dropped:BHM");
    assert.equal(dropped.writes.length, 0);

    const kept = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: 2,
      existing: [],
      fmppSources: [birmingham],
      fmppLastGoodCounts: {BHM: 10},
      loadSheet: loader(tables({bhm: rows(9)})).loadSheet,
    });
    assert.equal(kept.status, "ok");
    assert.equal(kept.config?.fmppLastGoodCounts?.BHM, 9);
    assert.equal(kept.config?.lastGoodRowCount, 2);
    assert.ok(kept.writes.some((write) => write.data.places.some((place) => place.n === "Yard")));

    const emptyCity = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: 2,
      existing: [],
      fmppSources: [birmingham],
      loadSheet: loader(tables({bhm: [ready({"FM Ready": ""})]})).loadSheet,
    });
    assert.equal(emptyCity.abortReason, "fmpp-usable-row-count-zero:BHM");
    assert.equal(emptyCity.writes.length, 0);
  });

  it("aborts when two cities emit the same Location ID", async () => {
    const twin: FmppSource = {...manchester, code: "BHM", city: "Birmingham copy"};
    const result = await syncPrivateParkingOnce({
      now: NOW,
      enabled: true,
      sheetId: "london-sheet",
      tab: "ALL LONDON (clean)",
      lastGoodRowCount: null,
      existing: [],
      fmppSources: [birmingham, twin],
      loadSheet: loader(tables({
        bhm: [cityOnly],
        man: [ready({...cityOnly, "Location Name": "Same id elsewhere"})],
      })).loadSheet,
    });
    assert.equal(result.status, "aborted");
    assert.equal(result.abortReason, "fmpp-id-collision:FERRO-BHM-HHL-0004");
    assert.equal(result.writes.length, 0);
  });
});
