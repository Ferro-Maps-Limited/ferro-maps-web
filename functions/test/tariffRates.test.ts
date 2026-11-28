import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  FMPP_LOCATION_HEADERS,
  FMPP_TARIFF_HEADERS,
  buildFmppPlaces,
  type FmppSource,
  type FmppTariffBand,
} from "../src/parking/privateSheet/fmpp.js";
import {
  chargingContexts,
  incrementBands,
  notesContexts,
  parseContext,
  parseFmppRates,
  parseIncrement,
  parseLength,
} from "../src/parking/privateSheet/tariffRates.js";
import {canonicalPlace} from "../src/parking/privateSheet/towns.js";
import {BANK_HOLIDAYS_COVER_TO, bankHolidaysAhead, ukNation} from "../src/parking/privateSheet/ukBankHolidays.js";
import {sheetPayable, sheetRates} from "../src/parking/sheetPricing.js";
import type {PrivatePlace} from "../src/parking/privateSheet/types.js";

const NOW = new Date("2026-11-27T12:00:00.000Z");

function band(duration: string, pounds: number | undefined, extra: Partial<FmppTariffBand> = {}): FmppTariffBand {
  return {duration, pricePence: pounds === undefined ? undefined : Math.round(pounds * 100), confidence: "Verified", notes: "", ...extra};
}

describe("stepped prices: reading the wording", () => {
  it("reads days and times in the forms the workbooks use", () => {
    assert.deepEqual(parseContext("Monday to Saturday 8:00am - 6:00pm"), {d: 63, bh: false, range: [480, 1080]});
    assert.deepEqual(parseContext("Sundays (Midnight - 6:00pm)"), {d: 64, bh: false, range: [0, 1080]});
    assert.deepEqual(parseContext("Sundays; Midnight - 6:00pm"), {d: 64, bh: false, range: [0, 1080]});
    assert.deepEqual(parseContext("Monday to Friday 8:00am - Midnight (8:00am - 6:00pm)"), {d: 31, bh: false, range: [480, 1080]});
    assert.deepEqual(parseContext("Monday to Saturday 8:00am - 6:00pm; 8:00am - 6:00pm"), {d: 63, bh: false, range: [480, 1080]});
    assert.deepEqual(parseContext("mon–fri 8:00–18:00"), {d: 31, bh: false, range: [480, 1080]});
    assert.deepEqual(parseContext("Saturday and Sunday"), {d: 96, bh: false});
    assert.deepEqual(parseContext("All Week, inc. bank holidays"), {d: 127, bh: true});
    assert.deepEqual(parseContext("Bank Holiday"), {d: 0, bh: true});
    assert.deepEqual(parseContext("Monday to Saturday 24 hours"), {d: 63, bh: false, range: [0, 1440]});
  });

  it("refuses times it can't be sure of", () => {
    assert.equal(parseContext("Monday to Friday 6:00pm - 8:00am"), null); // overnight
    assert.equal(parseContext("Sunday; RingGo window 8:00am–4:00pm start"), null);
    assert.equal(parseContext("Event day"), null);
    assert.equal(parseContext("Monday to Friday 8 - 6"), null); // no am/pm
    assert.equal(parseContext("Monday to Friday 8:00am - 6:00pm (7:00am - 8:00pm)"), null); // inner not inside
  });

  it("reads stay lengths", () => {
    assert.deepEqual(parseLength("up to 2 hours"), {minutes: 120});
    assert.deepEqual(parseLength("90 minutes"), {minutes: 90});
    assert.deepEqual(parseLength("0–30 minutes"), {minutes: 30});
    assert.deepEqual(parseLength("24hrs"), {minutes: 1440});
    assert.deepEqual(parseLength("1.5 hours"), {minutes: 90});
    assert.deepEqual(parseLength("All Day (until 6pm)"), {minutes: 1440, until: 1080});
    assert.equal(parseLength("7 days"), "long");
    assert.equal(parseLength("1 month"), "long");
    assert.equal(parseLength("each extra 30 minutes thereafter"), null);
  });

  it("reads a charge-times statement into one context per part", () => {
    const got = chargingContexts("Charge times (RingGo): Monday to Saturday 8:00am - 6:00pm; Sundays; Bank Holiday. Car park opening hours not published.");
    assert.deepEqual(got, [{d: 63, bh: false, range: [480, 1080]}, {d: 64, bh: false}, {d: 0, bh: true}]);
  });
});

describe("stepped prices: a car park's price list", () => {
  it("turns a ladder with days and times into one set, and a free bank holiday into another", () => {
    const got = parseFmppRates([
      band("Monday to Saturday 8:00am - 6:00pm: up to 1 Hour [rover permit]", 1.9),
      band("Monday to Saturday 8:00am - 6:00pm: up to 2 Hours [rover permit]", 3.1),
      band("Bank Holiday: 24 Hours", 0),
    ], "Charge times: Monday to Saturday 8:00am - 6:00pm; Bank Holiday.");
    assert.ok(got.ok);
    assert.deepEqual(got.sets, [
      {d: 63, f: 480, t: 1080, b: [60, 190, 120, 310]},
      {d: 0, bh: 1, f: 0, t: 1440, b: [1440, 0]},
    ]);
    assert.equal(got.unclear, 0);
  });

  it("takes days and times from the band's notes, including the band's own window", () => {
    const notes = "Monday to Friday 8:00am - Midnight (8:00am - 6:00pm). Last tariff update on RingGo: 05 May 2026.";
    const got = parseFmppRates([
      band("up to 1 hour", 3.7, {notes}),
      band("3 hours", 5.7, {notes}),
      band("All Day (until 6pm)", 11, {notes}),
      band("8 hours (free)", 0, {notes: "Monday to Friday 8:00am - Midnight (6:00pm - Midnight). Last tariff update."}),
    ], "Charge times (RingGo): Monday to Friday 8:00am - Midnight.");
    assert.ok(got.ok);
    assert.deepEqual(got.sets, [
      {d: 31, f: 480, t: 1080, b: [60, 370, 180, 570, 1440, 1100]},
      {d: 31, f: 1080, t: 1440, b: [480, 0]},
    ]);
  });

  it("gives an all-week band all day, and a bare band the car park's one charge time", () => {
    const allWeek = parseFmppRates([band("All Week: up to 1 hour", 1), band("All Week: 24 hours", 4.5)], "Charge times (RingGo): All Week.");
    assert.ok(allWeek.ok);
    assert.deepEqual(allWeek.sets, [{d: 127, f: 0, t: 1440, b: [60, 100, 1440, 450]}]);
    const bare = parseFmppRates([band("1 hour", 1.6), band("2 hours", 2.9)], "Charge times (RingGo): All Week 8:00am - 10:00pm.");
    assert.ok(bare.ok);
    assert.deepEqual(bare.sets, [{d: 127, f: 480, t: 1320, b: [60, 160, 120, 290]}]);
  });

  it("fills a band's missing times only from a charge time for the same days", () => {
    const got = parseFmppRates([
      band("Up to 2 hours (Monday to Saturday)", 1.5),
      band("Up to 2 hours (Sunday 8:00am–6:00pm)", 1.4),
    ], "Monday to Saturday 24 hours; Sunday 8:00am–6:00pm; free on Christmas Day and bank holidays.");
    assert.ok(got.ok);
    assert.deepEqual(got.sets.map((s) => [s.d, s.f, s.t]), [[63, 0, 1440], [64, 480, 1080]]);
    // No charge time for Monday to Saturday anywhere: unclear, never all day by guesswork.
    const unsure = parseFmppRates([band("Monday to Saturday: up to 2 hours", 2)], "not published");
    assert.deepEqual(unsure, {ok: false, reason: "unreadable"});
  });

  it("skips quotes, pre-booking, season tickets, permits and other vehicles, and keeps car bands", () => {
    const quotes = parseFmppRates([
      band("2 hours (JustPark live quote from Thu 26 Nov 2026 10:00)", 4),
      band("3 hours (pre-book, start Thu 26 Nov 2026 10:00)", 5),
      band("1 calendar month (season ticket)", 90),
    ], "");
    assert.deepEqual(quotes, {ok: false, reason: "quotes-only"});
    const vehicles = parseFmppRates([
      band("All Week: up to 4 hours [car, lgv]", 3),
      band("All Week: up to 4 hours [motorcycle]", 1),
    ], "All week");
    assert.ok(vehicles.ok);
    assert.deepEqual(vehicles.sets, [{d: 127, f: 0, t: 1440, b: [240, 300]}]);
  });

  it("leaves out unchecked, unclear and too-long bands but keeps the rest", () => {
    const got = parseFmppRates([
      band("All Week: up to 1 hour", 1),
      band("All Week: up to 2 hours", 2, {confidence: "Unverified"}),
      band("Event day: 4 hours", 5),
      band("24hrs: 7 days", 20),
    ], "All week");
    assert.ok(got.ok);
    assert.deepEqual(got.sets, [{d: 127, f: 0, t: 1440, b: [60, 100]}]);
    assert.equal(got.unclear, 1);
  });

  it("drops a ladder whose price falls as the stay gets longer, or that gives one length two prices", () => {
    assert.deepEqual(parseFmppRates([band("All Week: up to 1 hour", 3), band("All Week: up to 2 hours", 2)], "All week"),
      {ok: false, reason: "not-rising"});
    assert.deepEqual(parseFmppRates([band("All Week: up to 1 hour", 1), band("All Week: up to 1 hour", 2)], "All week"),
      {ok: false, reason: "unreadable"});
  });

  it("publishes nothing when every band is free", () => {
    assert.deepEqual(parseFmppRates([band("All Week: up to 2 hours (free)", 0)], "All week"), {ok: false, reason: "free-only"});
  });
});

describe("stepped prices: published on town car parks", () => {
  const SOURCE: FmppSource = {code: "EDI", city: "Edinburgh", sheetId: "example-edi-sheet-id",
    locationsTab: "Locations - Edinburgh", tariffsTab: "Tariffs - Edinburgh"};

  function locations(rows: Record<string, unknown>[]): unknown[][] {
    return [[...FMPP_LOCATION_HEADERS], ...rows.map((row) => FMPP_LOCATION_HEADERS.map((name) => name ? row[name] ?? "" : ""))];
  }

  function tariffs(rows: Record<string, unknown>[]): unknown[][] {
    return [[...FMPP_TARIFF_HEADERS], ...rows.map((row) => FMPP_TARIFF_HEADERS.map((name) => row[name] ?? ""))];
  }

  function ready(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {"Location ID": id, "Provider": "RingGo", "Provider Location Code": "12345", "Location Name": `Car park ${id.slice(-1)}`,
      "Postcode": "EH1 1AA", "Latitude": 55.95, "Longitude": -3.19, "FM Ready": "✅",
      "Charging Days/Hours": "Charge times: Monday to Saturday 8:00am - 6:00pm.", ...extra};
  }

  function tariff(id: string, duration: string, price: number): Record<string, unknown> {
    return {"Location ID": id, "Duration / Band": duration, "Price (£)": price, "Confidence": "Verified"};
  }

  it("adds a price list with the car park's own bank holidays, and leaves single-price car parks alone", () => {
    const built = buildFmppPlaces(SOURCE, locations([
      ready("FERRO-EDI-TST-0001"),
      ready("FERRO-EDI-TST-0002", {"Postcode": "", "Latitude": 55.96}),
      ready("FERRO-EDI-TST-0003", {"Latitude": 55.97}),
    ]), tariffs([
      tariff("FERRO-EDI-TST-0001", "Monday to Saturday 8:00am - 6:00pm: up to 1 hour", 2),
      tariff("FERRO-EDI-TST-0001", "Monday to Saturday 8:00am - 6:00pm: up to 2 hours", 3.5),
      tariff("FERRO-EDI-TST-0002", "up to 1 hour", 2),
      tariff("FERRO-EDI-TST-0002", "up to 3 hours", 5),
      tariff("FERRO-EDI-TST-0003", "per hour", 2.5),
    ]), NOW);
    assert.ok(built.ok);
    const [first, second, third] = built.places;
    assert.deepEqual(first.rates?.s, [{d: 63, f: 480, t: 1080, b: [60, 200, 120, 350]}]);
    // Scottish dates: St Andrew's Day, and 4 Jan 2027 rather than England's dates only.
    assert.deepEqual(first.rates?.h.slice(0, 4), ["2026-11-30", "2026-12-25", "2026-12-28", "2027-01-01"]);
    assert.ok(first.rates?.h.includes("2027-01-04"));
    assert.equal(first.rates?.ht, "2027-12-31");
    assert.equal(first.fee, undefined);
    // No postcode: the town decides the nation.
    assert.ok(second.rates?.h.includes("2026-11-30"));
    assert.deepEqual(second.rates?.s, [{d: 63, f: 480, t: 1080, b: [60, 200, 180, 500]}]);
    assert.equal(third.fee, 250);
    assert.equal(third.rates, undefined);
  });

  it("isn't payable while stepped prices are off, and is when they're on", () => {
    const built = buildFmppPlaces(SOURCE, locations([ready("FERRO-EDI-TST-0001")]), tariffs([
      tariff("FERRO-EDI-TST-0001", "Monday to Saturday 8:00am - 6:00pm: up to 1 hour", 2),
    ]), NOW);
    assert.ok(built.ok);
    const place = {...built.places[0]} as Record<string, unknown>;
    assert.equal(sheetPayable(place), false);
    assert.equal(sheetPayable(place, {stepped: true}), true);
    assert.equal(sheetPayable({...place, payMode: "off"}, {stepped: true}), false);
    assert.equal(sheetPayable({...place, rates: {...(place.rates as object), v: 2}}, {stepped: true}), false);
  });

  it("checks a stored price list before trusting it", () => {
    const good = {v: 1, s: [{d: 63, f: 480, t: 1080, b: [60, 200, 120, 350]}], h: ["2026-12-25"], ht: "2027-12-31"};
    assert.deepEqual(sheetRates({rates: good}), good);
    const bad = (s: unknown[]) => sheetRates({rates: {...good, s}});
    assert.equal(bad([{d: 63, f: 480, t: 1080, b: [60, 200, 120, 150]}]), null); // price falls
    assert.equal(bad([{d: 63, f: 480, t: 1080, b: [120, 200, 60, 350]}]), null); // lengths out of order
    assert.equal(bad([{d: 63, f: 1080, t: 480, b: [60, 200]}]), null); // ends before it starts
    assert.equal(bad([{d: 0, f: 0, t: 1440, b: [60, 200]}]), null); // no days and not bank holidays
    assert.equal(bad([{d: 63, f: 480, t: 1080, b: [60]}]), null); // half a pair
    assert.equal(sheetRates({rates: {...good, ht: "soon"}}), null);
  });

  it("keeps a place's nested fields in name order, so cells don't change every run", () => {
    const place = {id: "x", n: "X", p: [1, 2], s: 1,
      rates: {v: 1, ht: "2027-12-31", h: [], s: [{t: 1080, f: 480, d: 63, b: [60, 100]}]}} as unknown as PrivatePlace;
    assert.equal(JSON.stringify(canonicalPlace(place)),
      "{\"id\":\"x\",\"n\":\"X\",\"p\":[1,2],\"rates\":{\"h\":[],\"ht\":\"2027-12-31\",\"s\":[{\"b\":[60,100],\"d\":63,\"f\":480,\"t\":1080}],\"v\":1},\"s\":1}");
  });
});

describe("stepped prices: bank holidays", () => {
  it("knows the nation from the postcode, with the English corners of TD", () => {
    assert.equal(ukNation("EH1 1AA", "Somewhere"), "sc");
    assert.equal(ukNation("G2 3AB", ""), "sc");
    assert.equal(ukNation("BT1 5GS", ""), "ni");
    assert.equal(ukNation("TD15 1AA", ""), "ew");
    assert.equal(ukNation("TD12 4AA", ""), "ew");
    assert.equal(ukNation("TD12 5AA", ""), "sc");
    assert.equal(ukNation("B8 2NB", "Glasgow"), "ew");
    assert.equal(ukNation(undefined, "Glasgow"), "sc");
    assert.equal(ukNation(undefined, "Belfast"), "ni");
    assert.equal(ukNation(undefined, "Bristol"), "ew");
  });

  it("lists this year's remaining dates and next year's, and never past the table", () => {
    const ew = bankHolidaysAhead("ew", "2026-11-27");
    assert.deepEqual(ew.dates.slice(0, 3), ["2026-12-25", "2026-12-28", "2027-01-01"]);
    assert.equal(ew.coverTo, "2027-12-31");
    assert.equal(bankHolidaysAhead("ew", "2028-06-01").coverTo, BANK_HOLIDAYS_COVER_TO);
    assert.deepEqual(bankHolidaysAhead("ew", "2029-01-02").dates, []);
  });
});

describe("stepped prices: London's wording", () => {
  const MON_FRI = 31;
  const SAT = 32;
  const b = (...pairs: number[]) => pairs;

  it("reads repeating prices and sells them as 15-minute stays, then hours", () => {
    assert.deepEqual(parseIncrement("every 15 Minutes"), {minutes: 15, every: {proRata: false}});
    assert.deepEqual(parseIncrement("For every 1 Hour"), {minutes: 60, every: {proRata: false}});
    assert.deepEqual(parseIncrement("per 1 minute (pro rata)"), {minutes: 1, every: {proRata: true}});
    assert.equal(parseIncrement("1 hour"), null);
    assert.deepEqual(incrementBands(15, 210, false, 120), b(15, 210, 30, 420, 45, 630, 60, 840, 120, 1680));
    assert.deepEqual(incrementBands(60, 630, true, 240),
      b(15, 158, 30, 315, 45, 473, 60, 630, 120, 1260, 180, 1890, 240, 2520));
    assert.deepEqual(incrementBands(1, 12, true, 90), b(15, 180, 30, 360, 45, 540, 60, 720));
    assert.deepEqual(incrementBands(5, 40, false, 60), b(15, 120, 30, 240, 45, 360, 60, 480));
    assert.deepEqual(incrementBands(45, 300, false, 135), b(45, 300, 90, 600, 135, 900));
    assert.deepEqual(incrementBands(60, 500, false, 30), []);
  });

  it("prices Burton Street, Camden, as RingGo shows it", () => {
    const got = parseFmppRates([
      band("Monday to Friday 8:30am - 6:30pm: every 15 Minutes", 2.1),
      band("Monday to Friday 8:30am - 6:30pm: every 1 Hour", 8.41),
      band("Monday to Friday 8:30am - 6:30pm (6:30pm - 7:30am): 13 Hours", 0),
      band("Saturdays 8:30am - 1:30pm: every 15 Minutes", 2.1),
      band("Saturdays 8:30am - 1:30pm: every 1 Hour", 8.41),
      band("1 hour (diesel vehicles)", 12.5),
    ], "Charge times: Monday to Friday 8:30am - 6:30pm; Saturdays 8:30am - 1:30pm; Sundays; Bank Holiday.", 120);
    assert.equal(got.ok, true);
    // The hour is the higher of four 15-minute steps and the hourly price, so a stay is never sold for less.
    const ladder = b(15, 210, 30, 420, 45, 630, 60, 841, 120, 1682);
    assert.deepEqual(got.ok && got.sets, [
      {d: MON_FRI, f: 510, t: 1110, b: ladder},
      {d: SAT, f: 510, t: 810, b: ladder},
    ]);
  });

  it("keeps Islington's peak and off-peak prices in their own times, and skips event days and other vehicles", () => {
    const offPeak = "Monday to Friday 8:30am - Midnight (8:30am - 10:00am); Monday to Friday 8:30am - Midnight " +
      "(1:00pm - 6:30pm); Saturdays 8:30am - Midnight (8:30am - 1:30pm); Car, LGV. Last tariff update on RingGo: 24 August 2026.";
    const peak = "Monday to Friday 8:30am - Midnight (10:00am - 1:00pm); Car, LGV. Last tariff update on RingGo: 24 August 2026.";
    assert.equal(notesContexts(offPeak).contexts.length, 3);
    assert.deepEqual(notesContexts("Event Day; Car, LGV. Last tariff update."), {contexts: [], skip: true});
    assert.equal(notesContexts("Monday to Friday 8:30am - 6:30pm; Motorcycle.").skip, true);
    const got = parseFmppRates([
      band("per 1 minute (pro rata)", 0.12, {notes: offPeak}),
      band("1 hour", 7.3, {notes: offPeak}),
      band("per 1 minute (pro rata)", 0.13, {notes: peak}),
      band("1 hour", 7.82, {notes: peak}),
      band("per 1 minute (pro rata)", 0.23, {notes: "Event Day; Car, LGV. Last tariff update on RingGo: 24 August 2026."}),
      band("6 hours (free)", 0, {notes: "Monday to Friday 8:30am - Midnight (6:30pm - Midnight); Car, LGV."}),
    ], "Charge times (RingGo): Monday to Friday 8:30am - Midnight; Saturdays 8:30am - Midnight; Sundays; Bank Holiday.", 120);
    assert.equal(got.ok, true);
    const sets = got.ok ? got.sets : [];
    assert.deepEqual(sets.find((set) => set.d === MON_FRI && set.f === 510), {d: MON_FRI, f: 510, t: 600,
      b: b(15, 180, 30, 360, 45, 540, 60, 730)});
    assert.deepEqual(sets.find((set) => set.d === MON_FRI && set.f === 600), {d: MON_FRI, f: 600, t: 780,
      b: b(15, 195, 30, 390, 45, 585, 60, 782, 120, 1560)});
    assert.deepEqual(sets.find((set) => set.d === SAT)?.b, b(15, 180, 30, 360, 45, 540, 60, 730, 120, 1440));
    assert.deepEqual(sets.find((set) => set.d === MON_FRI && set.f === 1110)?.b, b(360, 0));
  });

  it("sells a band with no days in each timed charge time, and drops free time that belongs elsewhere", () => {
    const got = parseFmppRates([
      band("30 Minutes", 1.1),
      band("1 Hour", 2.1),
      band("2 Hours", 4.2),
      band("16 Hours", 0),
      band("24 Hours", 0),
    ], "Chargeable Monday to Saturday 9:00am - 5:30pm; Sundays; Bank Holiday. Car park opening hours not published.");
    assert.deepEqual(got.ok && got.sets, [{d: 63, f: 540, t: 1050, b: b(30, 110, 60, 210, 120, 420)}]);
    const firstFree = parseFmppRates([band("up to 30 minutes (free)", 0), band("1 hour", 1)], "Charge times: all week.");
    assert.deepEqual(firstFree.ok && firstFree.sets, [{d: 127, f: 0, t: 1440, b: b(30, 0, 60, 100)}]);
  });

  it("reads a provider's label in the charge times, two names for one stay, and Rover Only", () => {
    assert.deepEqual(chargingContexts("Charge times: all week (RingGo). Car park opening hours are not published."),
      [{d: 127, bh: false}]);
    assert.deepEqual(parseLength("24 hours / 1 day"), {minutes: 1440});
    assert.equal(parseLength("2 hours / 1 day"), null);
    const rover = parseFmppRates([
      band("Up to 1 Hour — All Week 7:30am - 5:30pm; Rover Only", 2.2),
      band("2 Hours — All Week 7:30am - 5:30pm; Rover Only", 3.85),
      band("2 Hours — All Week 7:30am - 5:30pm; Motorcycle", 1),
    ], "Charge times (RingGo): All Week 7:30am - 5:30pm; Bank Holiday.");
    assert.deepEqual(rover.ok && rover.sets, [{d: 127, f: 450, t: 1050, b: b(60, 220, 120, 385)}]);
  });

  it("keeps the shortest 15 stays and the longest when there are more than 16", () => {
    const hours = Array.from({length: 20}, (_, i) => band(`${i + 1} hours`, i + 1));
    const got = parseFmppRates([...hours, band("24 hours", 30)], "Charge times: all week.");
    const ladder = got.ok ? got.sets[0]?.b ?? [] : [];
    assert.equal(ladder.length, 32);
    assert.deepEqual(ladder.slice(-4), [900, 1500, 1440, 3000]);
  });
});
