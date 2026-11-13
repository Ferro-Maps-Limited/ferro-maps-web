import assert from "node:assert/strict";
import {before, describe, it} from "node:test";
import {
  DID_IT_SURGE,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
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
import {SURGE_ALERTS, dispatchLiveSurgeAlerts, type SurgeActiveMessage} from "../src/surge/liveSurge";
import {matrix} from "../src/surge/syntheticSheet";
import {clearDb, testDb} from "./support";

const db = testDb("demo-ferromaps-stadium-surge");
const NOW = new Date("2026-07-15T16:30:00.000Z");
const DAY = "2026-07-15";

function sheet() {
  return {
    events: matrix(EVENTS_HEADERS, [{
      [EVENT_ID]: "2026-07-15-LIVE-EMU",
      [HOME_TEAM]: "Home Side",
      [GROUND]: "Synthetic Park",
      [KICKOFF]: `${DAY} 15:00`,
      [EXPECTED_FULL_TIME]: `${DAY} 16:55`,
      [SURGE_START]: `${DAY} 16:55`,
      [SURGE_END]: `${DAY} 18:30`,
      [HARD_STOP]: `${DAY} 19:55`,
      [PICKUP_POINTS]: "North Gate | 51.701001, -0.301001",
    }]),
    readings: matrix(READINGS_HEADERS, [{
      [TIME_UK]: `${DAY} 15:30`,
      [EVENT_ID]: "2026-07-15-LIVE-EMU",
      [PHASE]: "During",
      [PICKUP_POINT]: "North Gate",
      [DID_IT_SURGE]: "YES",
    }]),
    watchlist: [] as unknown[][],
    pins: [{
      id: "sheet_2026-07-15-LIVE-EMU",
      data: {
        name: "Synthetic Park",
        pickupPoints: [{name: "North Gate", lat: 51.701001, lng: -0.301001}],
      },
    }],
  };
}

describe("surge active alert ledger", () => {
  before(async () => {
    await clearDb(db);
  });

  it("sends one message, then dedupes, and stays quiet when the flag is missing", async () => {
    const sent: SurgeActiveMessage[] = [];
    const input = {
      ...sheet(),
      db,
      now: NOW,
      send: async (message: SurgeActiveMessage) => {
        sent.push(message);
      },
    };
    assert.equal(await dispatchLiveSurgeAlerts(input), 0);
    await db.doc("config/flags").set({surgeActiveNotifications: true});
    assert.equal(await dispatchLiveSurgeAlerts(input), 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].apns.payload.aps.alert, "Surge now at Synthetic Park");
    assert.equal(sent[0].apns.payload.aps.mutableContent, true);
    assert.equal(sent[0].android.priority, "high");
    assert.equal("notification" in sent[0], false);
    const stored = await db.collection(SURGE_ALERTS).get();
    assert.equal(stored.size, 1);
    assert.equal(stored.docs[0].get("hotspotId"), "sheet_2026-07-15-LIVE-EMU");
    assert.equal(stored.docs[0].get("pickupLat"), undefined);
    assert.equal(await dispatchLiveSurgeAlerts(input), 0);
    assert.equal(sent.length, 1);
  });

  it("creates the episode before sending and does not retry a failed send", async () => {
    await db.doc("config/flags").set({surgeActiveNotifications: true});
    const failing = sheet();
    failing.events = matrix(EVENTS_HEADERS, [{
      [EVENT_ID]: "2026-07-15-LIVE-FAIL",
      [HOME_TEAM]: "Home Side",
      [GROUND]: "Synthetic Park",
      [KICKOFF]: `${DAY} 15:00`,
      [EXPECTED_FULL_TIME]: `${DAY} 16:55`,
      [SURGE_START]: `${DAY} 16:55`,
      [SURGE_END]: `${DAY} 18:30`,
      [HARD_STOP]: `${DAY} 19:55`,
      [PICKUP_POINTS]: "North Gate | 51.701001, -0.301001",
    }]);
    failing.readings = matrix(READINGS_HEADERS, [{
      [TIME_UK]: `${DAY} 15:30`,
      [EVENT_ID]: "2026-07-15-LIVE-FAIL",
      [PHASE]: "During",
      [PICKUP_POINT]: "North Gate",
      [DID_IT_SURGE]: "YES",
    }]);
    failing.pins = [{
      id: "sheet_2026-07-15-LIVE-FAIL",
      data: {
        name: "Synthetic Park",
        pickupPoints: [{name: "North Gate", lat: 51.701001, lng: -0.301001}],
      },
    }];
    let sends = 0;
    const before = new Set((await db.collection(SURGE_ALERTS).get()).docs.map((item) => item.id));
    assert.equal(await dispatchLiveSurgeAlerts({
      ...failing,
      db,
      now: NOW,
      send: async () => {
        sends += 1;
        const created = (await db.collection(SURGE_ALERTS).get()).docs.filter((item) => !before.has(item.id));
        assert.equal(created.length, 1);
        assert.equal(created[0].get("hotspotId"), "sheet_2026-07-15-LIVE-FAIL");
        throw new Error("fcm down");
      },
    }), 0);
    assert.equal(sends, 1);
    assert.equal(await dispatchLiveSurgeAlerts({
      ...failing,
      db,
      now: NOW,
      send: async () => {
        sends += 1;
      },
    }), 0);
    assert.equal(sends, 1);
  });
});
