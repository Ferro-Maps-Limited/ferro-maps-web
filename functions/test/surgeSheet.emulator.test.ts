import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {GeoPoint, Timestamp} from "firebase-admin/firestore";
import {commitStadiumEvents, HOTSPOTS_COLLECTION} from "../src/surge/commit";
import {
  AWAY_TEAM,
  BACK_TO_BASELINE,
  BASELINE_FARE,
  COMPETITION,
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
  FARE_SHOWN,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  PEAK_UPLIFT,
  PHASE,
  PICKUP_POINT,
  PICKUP_POINTS,
  PREDICTED_SURGE_CONFIDENCE,
  READINGS_HEADERS,
  SURGE_END,
  SURGE_START,
  TIME_UK,
} from "../src/surge/headers";
import {planStadiumEvents} from "../src/surge/plan";
import {matrix, SYNTHETIC_PRICE_TOKENS} from "../src/surge/syntheticSheet";
import {clearDb, testDb} from "./support";

const PROJECT = "demo-ferromaps-stadium-surge";
const NOW = new Date("2099-07-04T10:00:00.000Z");
const HEADERS = [...EVENTS_HEADERS, "Venue type"];

function hospitalRow(): Record<string, unknown> {
  return {
    [EVENT_ID]: "2099-07-04-HOSP-01",
    [COMPETITION]: "Visiting hours",
    [HOME_TEAM]: "",
    [AWAY_TEAM]: "",
    [GROUND]: "Synthetic General Hospital",
    [KICKOFF]: "2099-07-04 18:00",
    [EXPECTED_FULL_TIME]: "2099-07-04 20:00",
    [SURGE_START]: "2099-07-04 20:00",
    [SURGE_END]: "2099-07-04 22:00",
    [HARD_STOP]: "2099-07-04 23:00",
    [PICKUP_POINTS]: "Main entrance | 51.501001, -0.101001",
    "Did it surge?": "PENDING",
    "Venue type": "Hospital",
  };
}

function backReadings(): Record<string, unknown>[] {
  return [
    {
      [TIME_UK]: "2099-07-04 21:00",
      [EVENT_ID]: "2099-07-04-HOSP-01",
      [PHASE]: "During",
      [PICKUP_POINT]: "Main entrance",
      [BACK_TO_BASELINE]: "Yes",
      [FARE_SHOWN]: "18.4",
      [BASELINE_FARE]: "19.5",
    },
    {
      [TIME_UK]: "2099-07-04 21:05",
      [EVENT_ID]: "2099-07-04-HOSP-01",
      [PHASE]: "During",
      [PICKUP_POINT]: "Main entrance",
      [BACK_TO_BASELINE]: "Yes",
      [FARE_SHOWN]: "22.08",
      [BASELINE_FARE]: "19.5",
    },
  ];
}

describe("surge sheet emulator upsert", () => {
  const db = testDb(PROJECT);

  before(async () => {
    await clearDb(db);
    const snap = await db.collection(HOTSPOTS_COLLECTION).get();
    if (!snap.empty) {
      const batch = db.batch();
      for (const doc of snap.docs) batch.delete(doc.ref);
      await batch.commit();
    }
  });

  it("upserts the sheet id and does not merge into a pin that only matches name and coordinates", async () => {
    await db.collection(HOTSPOTS_COLLECTION).doc("fixed_local_hospital").set({
      name: "Synthetic General Hospital",
      category: "hospital",
      location: new GeoPoint(51.501001, -0.101001),
      note: "keep",
    });
    const first = planStadiumEvents({
      now: NOW,
      events: matrix(HEADERS, [hospitalRow()]),
      readings: matrix(READINGS_HEADERS, []),
    });
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0].category, "hospital");
    assert.equal(first.records[0].surgeEnded, false);
    await commitStadiumEvents(db, first.records);
    await db.collection(HOTSPOTS_COLLECTION).doc(first.records[0].id).set({jobs_accepted: 4}, {merge: true});

    const second = planStadiumEvents({
      now: NOW,
      events: matrix(HEADERS, [hospitalRow()]),
      readings: matrix(READINGS_HEADERS, backReadings()),
    });
    assert.equal(second.records[0].id, first.records[0].id);
    assert.equal(second.records[0].surgeEnded, true);
    await commitStadiumEvents(db, second.records);

    const all = await db.collection(HOTSPOTS_COLLECTION).get();
    assert.equal(all.size, 2);
    const kept = await db.collection(HOTSPOTS_COLLECTION).doc("fixed_local_hospital").get();
    assert.equal(kept.get("note"), "keep");
    assert.equal(kept.get("idSource"), undefined);
    assert.equal(kept.get("forecast"), undefined);
    const pin = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-07-04-HOSP-01").get();
    assert.equal(pin.exists, true);
    assert.equal(pin.get("idSource"), "sheet_event");
    assert.equal(pin.get("category"), "hospital");
    assert.equal(pin.get("surgeEnded"), true);
    assert.equal(pin.get("jobs_accepted"), 4);
    assert.equal(pin.get("expiresAt"), undefined);
    assert.ok(pin.get("removeBy") instanceof Timestamp);
    assert.ok(pin.get("window_end") instanceof Timestamp);
    assert.equal(pin.get("removeBy").toMillis(), pin.get("window_end").toMillis());
    assert.equal(pin.get("forecast").state, "no_prediction");
    assert.equal(pin.get("forecast").confidencePercent, null);
    assert.equal(pin.get("forecast").confidenceSource, "none");
    assert.deepEqual(Object.keys(pin.get("forecast")).sort(), [
      "confidencePercent",
      "confidenceSource",
      "state",
    ]);
    assert.equal(pin.get("startTimeSource"), "sheet_exact");
    assert.equal(pin.get("positionSource"), "pickup_centroid");
    assert.ok(pin.get("location") instanceof GeoPoint);
    const raw = JSON.stringify(pin.data());
    for (const token of [...SYNTHETIC_PRICE_TOKENS, "22.08"]) {
      assert.equal(raw.includes(token), false, token);
    }
  });

  it("writes the Events-tab confidence figure onto the sheet pin", async () => {
    const confidenceFirst = [
      PREDICTED_SURGE_CONFIDENCE,
      ...EVENTS_HEADERS.filter((header) => header !== PREDICTED_SURGE_CONFIDENCE),
    ];
    assert.equal(confidenceFirst[0], PREDICTED_SURGE_CONFIDENCE);
    assert.notEqual(EVENTS_HEADERS[0], PREDICTED_SURGE_CONFIDENCE);

    function row(id: string, day: string, outcome: string, confidence: unknown): Record<string, unknown> {
      return {
        [EVENT_ID]: id,
        [COMPETITION]: "Synthetic Cup",
        [HOME_TEAM]: "Home Side",
        [AWAY_TEAM]: "Away Side",
        [GROUND]: "Synthetic Park",
        [KICKOFF]: `${day} 15:00`,
        [EXPECTED_FULL_TIME]: `${day} 16:55`,
        [SURGE_START]: `${day} 16:55`,
        [SURGE_END]: `${day} 19:00`,
        [HARD_STOP]: `${day} 19:55`,
        [PICKUP_POINTS]: "North Gate | 51.701001, -0.301001",
        [DID_IT_SURGE]: outcome,
        [PEAK_UPLIFT]: outcome === "YES" ? "47%" : "",
        [PREDICTED_SURGE_CONFIDENCE]: confidence,
      };
    }

    const planned = planStadiumEvents({
      now: new Date("2099-04-01T00:00:00.000Z"),
      events: matrix(confidenceFirst, [
        row("2099-05-01-SYN-P01", "2099-05-01", "YES", "10%"),
        row("2099-05-08-SYN-P08", "2099-05-08", "YES", "10%"),
        row("2099-05-15-SYN-P15", "2099-05-15", "YES", "10%"),
        row("2099-06-01-SYN-FIG", "2099-06-01", "PENDING", "75%"),
        row("2099-06-08-SYN-NA", "2099-06-08", "PENDING", "n/a"),
        row("2099-06-15-SYN-HI", "2099-06-15", "PENDING", "120%"),
        row("2099-06-22-SYN-SP", "2099-06-22", "PENDING", " 80 % "),
      ]),
      readings: matrix(READINGS_HEADERS, [{
        [TIME_UK]: "2099-06-01 18:00",
        [EVENT_ID]: "2099-06-01-SYN-FIG",
        [PHASE]: "During",
        [PICKUP_POINT]: "North Gate",
        [FARE_SHOWN]: "18.4",
        [BASELINE_FARE]: "19.5",
      }]),
    });
    const figure = planned.records.find((item) => item.sheetEventId === "2099-06-01-SYN-FIG");
    if (!figure || figure.forecast.state !== "available") throw new Error("expected a forecast");
    assert.equal(figure.forecast.confidencePercent, 75);
    assert.equal(figure.forecast.basedOnEvents, 3);
    await commitStadiumEvents(db, planned.records);

    const pin = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-06-01-SYN-FIG").get();
    assert.equal(pin.get("forecast").confidencePercent, 75);
    assert.equal(pin.get("forecast").confidenceSource, "events_tab");
    assert.equal(pin.get("forecast").basedOnEvents, 3);
    assert.equal(pin.get("forecast").strength, "medium");
    assert.equal(pin.get("forecast").confidence, "low");
    assert.equal(pin.get("forecast").state, "available");

    const blank = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-06-08-SYN-NA").get();
    assert.equal(blank.get("forecast").state, "available");
    assert.equal(blank.get("forecast").confidencePercent, null);
    assert.equal(blank.get("forecast").confidenceSource, "none");
    assert.equal(blank.get("forecast").basedOnEvents, 3);

    const tooHigh = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-06-15-SYN-HI").get();
    assert.equal(tooHigh.get("forecast").confidencePercent, null);
    assert.equal(tooHigh.get("forecast").confidenceSource, "none");

    const spaced = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-06-22-SYN-SP").get();
    assert.equal(spaced.get("forecast").confidencePercent, 80);
    assert.equal(spaced.get("forecast").confidenceSource, "events_tab");

    const cleared = planStadiumEvents({
      now: new Date("2099-04-01T00:00:00.000Z"),
      events: matrix(confidenceFirst, [
        row("2099-05-01-SYN-P01", "2099-05-01", "YES", "10%"),
        row("2099-05-08-SYN-P08", "2099-05-08", "YES", "10%"),
        row("2099-05-15-SYN-P15", "2099-05-15", "YES", "10%"),
        row("2099-06-01-SYN-FIG", "2099-06-01", "PENDING", "n/a"),
      ]),
      readings: matrix(READINGS_HEADERS, []),
    });
    await commitStadiumEvents(db, cleared.records);
    const afterClear = await db.collection(HOTSPOTS_COLLECTION).doc("sheet_2099-06-01-SYN-FIG").get();
    assert.equal(afterClear.get("forecast").state, "available");
    assert.equal(afterClear.get("forecast").confidencePercent, null);
    assert.equal(afterClear.get("forecast").confidenceSource, "none");
    assert.equal(afterClear.get("forecast").basedOnEvents, 3);

    const raw = [
      pin.data(),
      blank.data(),
      tooHigh.data(),
      spaced.data(),
      afterClear.data(),
    ].map((data) => JSON.stringify(data)).join("\n");
    for (const token of [...SYNTHETIC_PRICE_TOKENS, "75%", "80%", "120%", "10%"]) {
      assert.equal(raw.includes(token), false, token);
    }
  });
});
