import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {GeoPoint, Timestamp} from "firebase-admin/firestore";
import {commitStadiumEvents, HOTSPOTS_COLLECTION} from "../src/surge/commit";
import {
  AWAY_TEAM,
  BACK_TO_BASELINE,
  BASELINE_FARE,
  COMPETITION,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
  FARE_SHOWN,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  PHASE,
  PICKUP_POINT,
  PICKUP_POINTS,
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
    assert.deepEqual(Object.keys(pin.get("forecast")), ["state"]);
    assert.equal(pin.get("startTimeSource"), "sheet_exact");
    assert.equal(pin.get("positionSource"), "pickup_centroid");
    assert.equal(pin.get("forecast").confidencePercent, undefined);
    assert.ok(pin.get("location") instanceof GeoPoint);
    const raw = JSON.stringify(pin.data());
    for (const token of [...SYNTHETIC_PRICE_TOKENS, "22.08"]) {
      assert.equal(raw.includes(token), false, token);
    }
  });
});
