import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {EVENT_HEADERS} from "../src/surge/importSheet.js";
import {parsePence} from "../src/surge/money.js";
import {parseUkSheetTime} from "../src/surge/londonTime.js";
import {handleSurgeSync} from "../src/surge/syncOnce.js";
import {
  baseEvent,
  baseReading,
  FIXTURE_READER,
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
    assert.equal(result.outcome, "written");
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
});
