import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {DISRUPTION_HEADERS, EVENT_HEADERS} from "../src/surge/importSheet.js";
import {parsePence} from "../src/surge/money.js";
import {parseUkSheetTime} from "../src/surge/londonTime.js";
import {handleSurgeSync} from "../src/surge/syncOnce.js";
import {
  baseEvent,
  baseReading,
  FIXTURE_READER,
  proposedMap,
  syntheticMap,
  workbook,
} from "./fixtures/surge/synthetic.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");

async function run(tabs: Record<string, unknown[][]>, existingHashes?: ReadonlyMap<string, string>) {
  let calls = 0;
  const result = await handleSurgeSync({
    enabled: true,
    columnMap: syntheticMap(),
    tabs,
    now: NOW,
    existingHashes,
    loadTab: async () => {
      calls += 1;
      return [["1999"]];
    },
  });
  return {result, calls};
}

function written(tabs: Record<string, unknown[][]>) {
  return run(tabs);
}

describe("offline surge import", () => {
  it("parses money and rejects the ambiguous London hour", () => {
    assert.equal(parsePence("£12.96").pence, 1296);
    assert.equal(parsePence("12.96").pence, 1296);
    assert.deepEqual(parsePence("23.935"), {pence: 2394, fare3dp: true, noFare: false, reject: false});
    assert.equal(parsePence("n/a (verification prompt blocked fare)").noFare, true);
    assert.equal(parseUkSheetTime("2026-10-25 01:30").ok, false);
    assert.equal(parseUkSheetTime("2026-07-15 18:10").ok, true);
  });

  it("keeps the switch and a missing map from loading or writing", async () => {
    let calls = 0;
    const loadTab = async () => {
      calls += 1;
      return [] as unknown[][];
    };
    const tabs = workbook([baseEvent()], [baseReading()]);
    for (const enabled of [undefined, false, "true"]) {
      const result = await handleSurgeSync({enabled, columnMap: syntheticMap(), loadTab, tabs});
      assert.equal(result.outcome, "switchOff");
      assert.deepEqual(result.writes, []);
      assert.equal(calls, 0);
    }
    const missing = await handleSurgeSync({
      enabled: true,
      columnMap: null,
      loadTab,
      tabs: workbook([baseEvent()], [baseReading()]),
    });
    assert.equal(missing.status, "column-map-missing");
    assert.equal(calls, 0);
    assert.deepEqual(missing.writes, []);
  });

  it("rejects a renamed column before writing", async () => {
    const tabs = workbook([baseEvent()], [baseReading()]);
    const headers = [...(tabs.Events[0] as string[])];
    headers[0] = "Event identifier";
    tabs.Events[0] = headers;
    const {result, calls} = await run(tabs);
    assert.equal(calls, 0);
    assert.equal(result.outcome, "headerFail");
    assert.deepEqual(result.writes, []);
  });

  it("imports a synthetic sheet without people, raw rows, or peak-uplift text", async () => {
    const tabs = workbook([
      baseEvent(),
      baseEvent({
        "Event ID": "2026-07-15-DOORS",
        "Kick-off (UK)": "Doors 18:30",
      }),
      baseEvent({"Event ID": "BAD"}),
      baseEvent({
        "Event ID": "2026-07-15-CLASH",
        "Pickup points (name | lat,lng)": "North Gate | 51.50,-0.12; North-Gate | 51.51,-0.12",
      }),
      [],
    ], [
      baseReading(),
      baseReading({
        "Fare shown (£)": "23.935",
        "Time (UK)": "2026-07-15 18:12",
        "Time (UTC)": "2026-07-15 17:12",
      }),
      baseReading({
        "Fare shown (£)": "n/a (blocked)",
        "Time (UK)": "2026-07-15 18:20",
        "Time (UTC)": "2026-07-15 17:20",
      }),
      baseReading({"Time (UK)": "2026-10-25 01:30"}),
      baseReading({"Event ID": "2026-07-15-MISSING", "Time (UK)": "2026-07-15 18:40"}),
    ]);
    const {result, calls} = await run(tabs);
    assert.equal(calls, 0);
    assert.equal(result.outcome, "planned");
    const body = JSON.stringify(result.writes);
    assert.equal(body.includes(FIXTURE_READER), false);
    assert.equal(body.includes("Screenshot"), false);
    assert.equal(body.includes("50%"), false);
    assert.equal(body.includes("Peak uplift"), false);
    assert.equal(body.includes("\"raw\""), false);
    const doors = result.writes.find((write) => write.path === "surgeEvents/2026-07-15-DOORS");
    assert.equal(doors?.data.startAt, null);
    assert.equal(doors?.data.startText, "Doors 18:30");
    assert.equal(result.writes.some((write) => write.path.includes("BAD")), false);
    assert.equal(result.writes.some((write) => write.path.includes("CLASH")), false);
    assert.ok(result.rejects.some((reject) => reject.reason === "pickup-id-collision"));
    assert.ok(result.rejects.some((reject) => reject.reason === "ambiguous-time"));
    assert.ok(result.rejects.some((reject) => reject.reason === "unknown-event"));
    const priced = result.writes.find((write) => write.path.startsWith("surgeReadings/") && write.data.pricePence === 2394);
    assert.equal(priced?.data.pricePence, 2394);
    assert.ok((priced?.data.flags as string[]).includes("fare3dp"));
    const gate = result.writes.find((write) => write.path.endsWith("/north-gate"));
    assert.equal(gate?.data.kind, "entrance");
    assert.equal(JSON.stringify(result.writes).includes("ignore this note"), false);
    const na = result.writes.find((write) => Array.isArray(write.data.flags) && (write.data.flags as string[]).includes("noFare"));
    assert.equal(na?.data.pricePence, null);
    assert.equal(EVENT_HEADERS.includes("Peak uplift %"), true);
  });

  it("writes one identical reading and holds a conflicting duplicate", async () => {
    const same = await run(workbook([baseEvent()], [baseReading(), baseReading()]));
    const readingWrites = same.result.writes.filter((write) => write.path.startsWith("surgeReadings/"));
    assert.equal(readingWrites.length, 1);
    const clash = await run(workbook([baseEvent()], [
      baseReading(),
      baseReading({"Fare shown (£)": "£20.00"}),
    ]));
    assert.equal(clash.result.writes.some((write) => write.path.startsWith("surgeReadings/")), false);
    assert.ok(clash.result.rejects.some((reject) => reject.reason === "payload-differs"));
  });

  it("repeats and reorders an accepted fixture without changing ids", async () => {
    const firstReading = baseReading();
    const secondReading = baseReading({
      "Time (UK)": "2026-07-15 18:30",
      "Time (UTC)": "2026-07-15 17:30",
      "Fare shown (£)": "£11.00",
    });
    const forward = await written(workbook([baseEvent()], [firstReading, secondReading]));
    const backward = await written(workbook([baseEvent()], [secondReading, firstReading]));
    const ids = (writes: {path: string; data: Record<string, unknown>}[]) => {
      return writes.map((write) => {
        return `${write.path}:${String(write.data.pricePence ?? "")}:${String(write.data.takenAt ?? "")}`;
      }).sort();
    };
    assert.deepEqual(ids(forward.result.writes), ids(backward.result.writes));
    const existing = new Map(forward.result.writes.map((write) => [write.path, write.hash]));
    const again = await run(workbook([baseEvent()], [firstReading, secondReading]), existing);
    assert.equal(again.result.outcome, "noChange");
    assert.deepEqual(again.result.writes, []);
    assert.equal(again.calls, 0);
  });

  it("keeps one identical event id and rejects every conflicting copy", async () => {
    const same = await run(workbook([baseEvent(), baseEvent()], [baseReading()]));
    const events = same.result.writes.filter((write) => write.path === "surgeEvents/2026-07-15-ALPHA-BETA");
    assert.equal(events.length, 1);
    assert.equal(same.result.rejects.some((reject) => reject.reason === "event-id-collision"), false);
    const reversed = await run(workbook([baseEvent(), baseEvent()].reverse(), [baseReading()]));
    assert.equal(reversed.result.writes.find((write) => write.path.startsWith("surgeEvents/"))?.hash, events[0].hash);

    const conflict = {"Ground": "Other Ground", "Home team": "Gamma", "Away team": "Delta"};
    for (const rows of [
      [baseEvent(), baseEvent(), baseEvent(conflict)],
      [baseEvent(conflict), baseEvent(), baseEvent()],
    ]) {
      const {result} = await run(workbook(rows, [baseReading()]));
      assert.equal(result.outcome, "rejected");
      assert.equal(result.writes.some((write) => write.path.startsWith("surgeEvents/")), false);
      assert.equal(result.writes.some((write) => write.path.startsWith("surgeReadings/")), false);
      assert.equal(result.rejects.filter((reject) => reject.reason === "event-id-collision").length, 3);
      assert.ok(result.rejects.some((reject) => reject.reason === "unknown-event"));
    }
  });

  it("rejects the same id on the disruption tab and quarantines an ambiguous kick-off", async () => {
    const tabs = workbook([baseEvent()], [baseReading()]);
    const disruption: Record<string, unknown> = {
      "Disruption ID": "2026-07-15-ALPHA-BETA",
      "Type": "closure",
      "Location/Station/Airport": "Other Place",
      "Mode": "rail",
      "Ground": "Other Ground",
      "Kick-off (UK)": "2026-07-15 19:00",
      "Expected full time (UK)": "2026-07-15 21:00",
      "Surge window starts (UK)": "2026-07-15 18:00",
      "Surge window ends (UK, est.)": "2026-07-15 22:00",
      "Baseline price check (UK, 4h before window)": "2026-07-15 14:00",
      "Hard stop (UK, FT + 3h)": "2026-07-15 23:00",
      "Surge Expected? (YES/NO)": "NO",
      "Status": "Scheduled",
      "Did it surge?": "NO",
    };
    tabs["TPC Disruption Log"].push(DISRUPTION_HEADERS.map((header) => disruption[header] ?? ""));
    const crossed = await run(tabs);
    assert.equal(crossed.result.writes.some((write) => write.path.startsWith("surgeEvents/")), false);
    assert.equal(crossed.result.writes.some((write) => write.path.startsWith("surgeReadings/")), false);
    assert.ok(crossed.result.rejects.some((reject) => reject.tab === "TPC Disruption Log"));

    const ambiguous = await run(workbook([
      baseEvent({"Kick-off (UK)": "2026-10-25 01:30"}),
      baseEvent({"Event ID": "2026-07-15-DOORS", "Kick-off (UK)": "Doors 18:30"}),
    ], []));
    assert.equal(ambiguous.result.outcome, "planned");
    assert.equal(ambiguous.result.writes.some((write) => write.path.includes("ALPHA-BETA")), false);
    assert.ok(ambiguous.result.rejects.some((reject) => reject.reason === "ambiguous-time"));
    const doors = ambiguous.result.writes.find((write) => write.path === "surgeEvents/2026-07-15-DOORS");
    assert.equal(doors?.data.startAt, null);
    assert.equal(doors?.data.startText, "Doors 18:30");
  });

  it("quarantines a changed pickup name or coordinate and keeps an order-only duplicate", async () => {
    const north = "1) North Gate | 51.50,-0.12";
    const south = "1) South Gate | 51.40,-0.20";
    const moved = "1) North Gate | 51.40,-0.20";
    const both = "1) North Gate | 51.50,-0.12; 2) South Gate | 51.40,-0.20";
    const bothReversed = "1) South Gate | 51.40,-0.20; 2) North Gate | 51.50,-0.12";
    for (const pickup of [south, moved]) {
      const {result} = await run(workbook([
        baseEvent({"Pickup points (name | lat,lng)": north}),
        baseEvent({"Pickup points (name | lat,lng)": pickup}),
      ], [baseReading()]));
      assert.equal(result.outcome, "rejected");
      assert.deepEqual(result.writes, []);
      assert.equal(result.rejects.filter((reject) => reject.reason === "event-id-collision").length, 2);
      assert.ok(result.rejects.some((reject) => reject.reason === "unknown-event"));
    }
    const pickupSet = (writes: {path: string; data: Record<string, unknown>}[]) => {
      return writes.filter((write) => write.path.includes("/pickups/")).map((write) => {
        const point = write.data.p as {lat: number; lng: number} | null;
        return `${write.path}:${String(write.data.name)}:${String(write.data.kind)}:${point?.lat}:${point?.lng}`;
      }).sort();
    };
    const forward = await run(workbook([
      baseEvent({"Pickup points (name | lat,lng)": both}),
      baseEvent({"Pickup points (name | lat,lng)": bothReversed}),
    ], [baseReading()]));
    const backward = await run(workbook([
      baseEvent({"Pickup points (name | lat,lng)": bothReversed}),
      baseEvent({"Pickup points (name | lat,lng)": both}),
    ], [baseReading()]));
    assert.equal(forward.result.rejects.some((reject) => reject.reason === "event-id-collision"), false);
    assert.equal(backward.result.rejects.some((reject) => reject.reason === "event-id-collision"), false);
    assert.deepEqual(pickupSet(forward.result.writes), pickupSet(backward.result.writes));
    const eventPath = "surgeEvents/2026-07-15-ALPHA-BETA";
    assert.equal(forward.result.writes.filter((write) => write.path === eventPath).length, 1);
    assert.equal(backward.result.writes.filter((write) => write.path === eventPath).length, 1);
    const mixed = await run(workbook([
      baseEvent({"Event ID": "2026-07-15-DOORS", "Kick-off (UK)": "Doors 18:30"}),
      baseEvent({"Pickup points (name | lat,lng)": north}),
      baseEvent({"Pickup points (name | lat,lng)": south}),
    ], []));
    assert.equal(mixed.result.outcome, "planned");
    assert.equal(mixed.result.writes.some((write) => write.path === "surgeEvents/2026-07-15-DOORS"), true);
    assert.equal(mixed.result.writes.some((write) => write.path.includes("ALPHA-BETA")), false);
    assert.ok(mixed.result.rejects.some((reject) => reject.reason === "event-id-collision"));
  });

  it("uses the proposed map, ignores extra columns, and fills only a missing point", async () => {
    let calls = 0;
    const loadTab = async () => {
      calls += 1;
      return [] as unknown[][];
    };
    const unknown = await handleSurgeSync({
      enabled: true,
      columnMap: {id: "not-reviewed"},
      tabs: workbook([baseEvent()], [baseReading()]),
      loadTab,
    });
    assert.equal(unknown.outcome, "error");
    assert.equal(unknown.loadCalls, 0);
    assert.deepEqual(unknown.writes, []);
    assert.equal(calls, 0);

    const tabs = workbook([], []);
    const disruptionHeaders = [
      ...DISRUPTION_HEADERS,
      "Competition",
      "Home team",
      "Away team",
      "Fixed destination for price checks",
      "Source",
    ];
    const disruptionValues: Record<string, unknown> = {
      "Disruption ID": "2026-07-16-NAME-ONLY",
      "Type": "closure",
      "Location/Station/Airport": "North Halt",
      "Mode": "rail",
      "Ground": "North Halt",
      "Kick-off (UK)": "2026-07-16 18:00",
      "Expected full time (UK)": "2026-07-16 20:00",
      "Surge window starts (UK)": "2026-07-16 17:00",
      "Surge window ends (UK, est.)": "2026-07-16 21:00",
      "Baseline price check (UK, 4h before window)": "2026-07-16 13:00",
      "Hard stop (UK, FT + 3h)": "2026-07-16 23:00",
      "Surge Expected? (YES/NO)": "NO",
      "Status": "Scheduled",
      "Did it surge?": "NO",
      "Pickup points (name | lat,lng)": "North Halt station",
      "Competition": "PLAN-SENTINEL",
      "Home team": "PLAN-SENTINEL",
      "Away team": "PLAN-SENTINEL",
      "Fixed destination for price checks": "PLAN-SENTINEL",
      "Source": "PERSON-SENTINEL",
    };
    tabs["TPC Disruption Log"][0] = disruptionHeaders;
    tabs["TPC Disruption Log"].push(disruptionHeaders.map((header) => disruptionValues[header] ?? ""));
    const readingHeader = tabs["TPC Readings"][0] as string[];
    tabs["TPC Readings"][0] = [...readingHeader, "Source", "Distance to disrupted station (m)"];
    const reading = baseReading({
      "Event ID": "2026-07-16-NAME-ONLY",
      "Time (UK)": "2026-07-16 18:10",
      "Time (UTC)": "2026-07-16 17:10",
      "Pickup point": "North Halt station",
      "Latitude": 51.5,
      "Longitude": -0.12,
      "Fare shown (£)": "10.00",
    });
    tabs["TPC Readings"].push([...reading, "PERSON-SENTINEL", "DISTANCE-SENTINEL"]);
    const filled = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs, now: NOW, loadTab,
    });
    assert.equal(calls, 0);
    assert.equal(filled.outcome, "planned");
    const body = JSON.stringify(filled.writes);
    assert.equal(body.includes("PERSON-SENTINEL"), false);
    assert.equal(body.includes("PLAN-SENTINEL"), false);
    assert.equal(body.includes("DISTANCE-SENTINEL"), false);
    const pickup = filled.writes.find((write) => write.path.endsWith("/north-halt-station"));
    assert.deepEqual(pickup?.data.p, {lat: 51.5, lng: -0.12});
    assert.equal(pickup?.data.pSource, "reading");

    const listed = workbook([baseEvent()], [baseReading({"Latitude": 53, "Longitude": -1.5})]);
    const kept = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs: listed, now: NOW, loadTab,
    });
    const listedPickup = kept.writes.find((write) => write.path.endsWith("/north-gate"));
    assert.deepEqual(listedPickup?.data.p, {lat: 51.5, lng: -0.12});
    assert.equal(listedPickup?.data.pSource, "eventList");

    const tieTabs = workbook([], []);
    tieTabs["TPC Disruption Log"][0] = disruptionHeaders;
    tieTabs["TPC Disruption Log"].push(disruptionHeaders.map((header) => disruptionValues[header] ?? ""));
    const other = baseReading({
      "Event ID": "2026-07-16-NAME-ONLY",
      "Time (UK)": "2026-07-16 18:20",
      "Time (UTC)": "2026-07-16 17:20",
      "Pickup point": "North Halt station",
      "Latitude": 53,
      "Longitude": -1.5,
      "Fare shown (£)": "10.00",
    });
    tieTabs["TPC Readings"].push(reading, other);
    const tied = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs: tieTabs, now: NOW, loadTab,
    });
    const tiedPickup = tied.writes.find((write) => write.path.endsWith("/north-halt-station"));
    assert.equal(tiedPickup?.data.p, null);
    assert.ok((tiedPickup?.data.flags as string[]).includes("point-tie"));

    const badTabs = workbook([], []);
    badTabs["TPC Disruption Log"][0] = disruptionHeaders;
    badTabs["TPC Disruption Log"].push(disruptionHeaders.map((header) => disruptionValues[header] ?? ""));
    badTabs["TPC Readings"].push(baseReading({
      "Event ID": "2026-07-16-NAME-ONLY",
      "Time (UK)": "2026-07-16 18:10",
      "Time (UTC)": "2026-07-16 17:10",
      "Pickup point": "North Halt station",
      "Latitude": 10,
      "Longitude": 0,
      "Fare shown (£)": "10.00",
    }));
    const invalid = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs: badTabs, now: NOW, loadTab,
    });
    const invalidPickup = invalid.writes.find((write) => write.path.endsWith("/north-halt-station"));
    assert.equal(invalidPickup?.data.p, null);
    assert.ok((invalidPickup?.data.flags as string[]).includes("no-usable-point"));

    const renamed = workbook([baseEvent()], [baseReading()]);
    const headers = [...(renamed.Events[0] as string[])];
    headers[0] = "Event identifier";
    renamed.Events[0] = headers;
    const broken = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs: renamed, now: NOW, loadTab,
    });
    assert.equal(broken.outcome, "headerFail");
    assert.deepEqual(broken.writes, []);

    const duplicated = workbook([baseEvent()], [baseReading()]);
    duplicated.Events[0] = [...(duplicated.Events[0] as string[]), "Event ID"];
    const ambiguous = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs: duplicated, now: NOW, loadTab,
    });
    assert.equal(ambiguous.outcome, "headerFail");
    assert.deepEqual(ambiguous.writes, []);
    assert.equal(calls, 0);
  });

  it("does not fill a missing point from a tie, another event, or a conflicting reading", async () => {
    const headers = [
      ...DISRUPTION_HEADERS,
      "Competition",
      "Source",
    ];
    const disruption = {
      "Disruption ID": "2026-07-16-NAME-ONLY",
      "Type": "closure",
      "Location/Station/Airport": "North Halt",
      "Mode": "rail",
      "Ground": "North Halt",
      "Kick-off (UK)": "2026-07-16 18:00",
      "Expected full time (UK)": "2026-07-16 20:00",
      "Surge window starts (UK)": "2026-07-16 17:00",
      "Surge window ends (UK, est.)": "2026-07-16 21:00",
      "Baseline price check (UK, 4h before window)": "2026-07-16 13:00",
      "Hard stop (UK, FT + 3h)": "2026-07-16 23:00",
      "Surge Expected? (YES/NO)": "NO",
      "Status": "Scheduled",
      "Did it surge?": "NO",
      "Pickup points (name | lat,lng)": "North Halt station",
    };
    const sheet = () => {
      const tabs = workbook([baseEvent()], []);
      tabs["TPC Disruption Log"][0] = headers;
      tabs["TPC Disruption Log"].push(headers.map((header) => disruption[header as keyof typeof disruption] ?? ""));
      return tabs;
    };
    const cross = sheet();
    cross.Readings.push(baseReading());
    const crossResult = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs: cross, now: NOW,
      loadTab: async () => [],
    });
    const crossPickup = crossResult.writes.find((write) => write.path.endsWith("/north-halt-station"));
    assert.equal(crossPickup?.data.p, null);
    assert.ok((crossPickup?.data.flags as string[]).includes("no-usable-point"));

    const clash = sheet();
    const first = baseReading({
      "Event ID": "2026-07-16-NAME-ONLY",
      "Time (UK)": "2026-07-16 18:10",
      "Time (UTC)": "2026-07-16 17:10",
      "Pickup point": "North Halt station",
      "Latitude": 51.5,
      "Longitude": -0.12,
      "Fare shown (£)": "10.00",
    });
    const second = baseReading({
      "Event ID": "2026-07-16-NAME-ONLY",
      "Time (UK)": "2026-07-16 18:10",
      "Time (UTC)": "2026-07-16 17:10",
      "Pickup point": "North Halt station",
      "Latitude": 53,
      "Longitude": -1.5,
      "Fare shown (£)": "12.00",
    });
    clash["TPC Readings"].push(first, second);
    const clashResult = await handleSurgeSync({
      enabled: true, columnMap: proposedMap(), tabs: clash, now: NOW,
      loadTab: async () => [],
    });
    const clashPickup = clashResult.writes.find((write) => write.path.endsWith("/north-halt-station"));
    assert.equal(clashPickup?.data.p, null);
    assert.ok((clashPickup?.data.flags as string[]).includes("no-usable-point"));
    assert.ok(clashResult.rejects.some((reject) => reject.reason === "payload-differs"));
    assert.equal(clashResult.writes.some((write) => write.path.startsWith("surgeReadings/") &&
      String(write.data.eventId) === "2026-07-16-NAME-ONLY"), false);
  });
});
