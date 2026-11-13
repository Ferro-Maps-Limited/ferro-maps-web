import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  BASELINE_FARE,
  DID_IT_SURGE,
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
  UPLIFT_PERCENT,
} from "../src/surge/headers";
import {
  findLiveSurges,
  flagIsOn,
  maxAlertsPerDay,
  runLiveSurgeAlerts,
  surgeActiveMessage,
  type LiveHit,
  type LivePin,
} from "../src/surge/liveSurge";
import {type Firestore} from "firebase-admin/firestore";
import {matrix} from "../src/surge/syntheticSheet";
import {
  LIVE_WATCHLIST_HEADERS,
  WATCHLIST_BASELINE_FARE,
  WATCHLIST_DID_IT_SURGE,
  WATCHLIST_DISRUPTION_ID,
  WATCHLIST_FARE_SHOWN,
  WATCHLIST_PHASE,
  WATCHLIST_PICKUP_LIVE,
  WATCHLIST_PLACE_ID,
  WATCHLIST_PLACE_SOURCE,
  WATCHLIST_TIME_UK,
} from "../src/surge/watchlist";

const NOW = new Date("2026-07-15T16:30:00.000Z");
const SURGE_CHANNEL = "surge_active";
const DAY = "2026-07-15";

function eventRow(): Record<string, unknown> {
  return {
    [EVENT_ID]: "2026-07-15-LIVE-ONE",
    [HOME_TEAM]: "Home Side",
    [GROUND]: "Synthetic Park",
    [KICKOFF]: `${DAY} 15:00`,
    [EXPECTED_FULL_TIME]: `${DAY} 16:55`,
    [SURGE_START]: `${DAY} 16:55`,
    [SURGE_END]: `${DAY} 18:30`,
    [HARD_STOP]: `${DAY} 19:55`,
    [PICKUP_POINTS]: "North Gate | 51.701001, -0.301001",
  };
}

function reading(time: string, phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [TIME_UK]: `${DAY} ${time}`,
    [EVENT_ID]: "2026-07-15-LIVE-ONE",
    [PHASE]: phase,
    [PICKUP_POINT]: "North Gate",
    [DID_IT_SURGE]: "YES",
    ...extra,
  };
}

function pin(extra: Record<string, unknown> = {}): LivePin {
  return {
    id: "sheet_2026-07-15-LIVE-ONE",
    data: {
      name: "Home Side v -",
      location: {latitude: 51.5, longitude: -0.1},
      events: {venue_name: "The O2"},
      forecast: {state: "available", strength: "high", confidencePercent: 80},
      pickupPoints: [{name: "North Gate", lat: 51.701001, lng: -0.301001}],
      ...extra,
    },
  };
}

function hits(readings: Record<string, unknown>[], pins: LivePin[] = [pin()], watchlist: unknown[][] = []): LiveHit[] {
  return findLiveSurges({
    now: NOW,
    events: matrix(EVENTS_HEADERS, [eventRow()]),
    readings: matrix(READINGS_HEADERS, readings),
    watchlist,
    pins,
  });
}

describe("live surge detection", () => {
  it("alerts from a During yes inside the event, outside the forecast window", () => {
    const found = hits([reading("15:30", "During")]);
    assert.equal(found.length, 1);
    assert.equal(found[0].venueName, "The O2");
    assert.equal(found[0].pickupLat, 51.701001);
    assert.equal(found[0].pickupLng, -0.301001);
    assert.notEqual(found[0].pickupLat, 51.5);
    const message = surgeActiveMessage(found[0]);
    assert.equal(message.apns.payload.aps.alert, "Surge now at The O2");
    assert.equal(message.apns.payload.aps.mutableContent, true);
    assert.equal(message.android.priority, "high");
    assert.equal("notification" in message, false);
    assert.equal("notification" in message.android, false);
    assert.deepEqual(Object.keys(message.data).sort(), [
      "activeSince",
      "hotspotId",
      "pickupLat",
      "pickupLng",
      "venueName",
    ]);
    assert.equal(message.topic.startsWith("surge_active_"), true);
    assert.equal(message.topic, message.topic.toLowerCase());
    assert.equal(JSON.stringify(message.data).includes("high"), false);
    assert.equal(JSON.stringify(message.data).includes("80"), false);
    assert.equal(JSON.stringify(message.data).includes("fare"), false);
  });

  it("counts an in-window Post yes and ignores pre, baseline, and a forecast with no reading", () => {
    assert.equal(hits([reading("17:10", "Post")]).length, 1);
    assert.equal(hits([reading("14:00", "Post")]).length, 0);
    assert.equal(hits([reading("15:30", "Pre")]).length, 0);
    assert.equal(hits([reading("15:30", "Baseline")]).length, 0);
    assert.equal(hits([]).length, 0);
    assert.equal(hits([reading("14:30", "During")]).length, 0);
  });

  it("uses classify: an explicit no wins, and a blank cell follows the 20 percent uplift", () => {
    assert.equal(hits([reading("15:30", "During", {
      [DID_IT_SURGE]: "NO",
      [UPLIFT_PERCENT]: "50%",
    })]).length, 0);
    assert.equal(hits([reading("15:30", "During", {
      [DID_IT_SURGE]: "",
      [FARE_SHOWN]: "24",
      [BASELINE_FARE]: "19",
    })]).length, 1);
    assert.equal(hits([reading("15:30", "During", {
      [DID_IT_SURGE]: "",
      [FARE_SHOWN]: "20",
      [BASELINE_FARE]: "19",
    })]).length, 0);
  });

  it("does not alert once surgeHasEnded is true", () => {
    const found = hits([
      reading("17:00", "During", {"Back to baseline? (within 5%)": "Yes"}),
      reading("17:10", "During", {"Back to baseline? (within 5%)": "Yes"}),
    ]);
    assert.equal(found.length, 0);
  });

  it("drops a venue name that carries a fare or a brand", () => {
    assert.equal(hits([reading("15:30", "During")], [pin({
      events: {venue_name: "Uber fare"},
    })]).length, 0);
  });

  it("includes a TPC Watchlist During yes and uses the pin pickup", () => {
    const standing: LivePin = {
      id: "pin_o2",
      data: {
        name: "The O2",
        location: {latitude: 51.5, longitude: 0.0},
        pickupPoints: [{name: "Peninsula Square", lat: 51.502, lng: 0.004}],
      },
    };
    const row: Record<string, unknown> = {
      [WATCHLIST_TIME_UK]: `${DAY} 16:20`,
      [WATCHLIST_PLACE_ID]: "pin_o2",
      [WATCHLIST_PLACE_SOURCE]: "Hotspot Test Pins",
      [WATCHLIST_PHASE]: "During",
      [WATCHLIST_PICKUP_LIVE]: "Peninsula Square",
      [WATCHLIST_DID_IT_SURGE]: "YES",
      [WATCHLIST_FARE_SHOWN]: "",
      [WATCHLIST_BASELINE_FARE]: "",
      [WATCHLIST_DISRUPTION_ID]: "disp-1",
    };
    const found = findLiveSurges({
      now: NOW,
      events: matrix(EVENTS_HEADERS, []),
      readings: matrix(READINGS_HEADERS, []),
      watchlist: matrix(LIVE_WATCHLIST_HEADERS, [row]),
      pins: [standing],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].hotspotId, "pin_o2");
    assert.equal(found[0].episodeKey, "pin_o2|disp-1");
    assert.equal(found[0].pickupLat, 51.502);
    assert.equal(found[0].venueName, "The O2");
  });
});

describe("live surge sending", () => {
  const hit: LiveHit = {
    hotspotId: "sheet_a",
    episodeKey: "sheet_a|1",
    venueName: "The O2",
    pickupLat: 51.701,
    pickupLng: -0.301,
    activeSinceMs: Date.parse("2026-07-15T14:30:00.000Z"),
  };

  function claimOnce(held = new Set<string>()) {
    return async (item: LiveHit) => {
      if (held.has(item.episodeKey)) return false;
      held.add(item.episodeKey);
      return true;
    };
  }

  it("claims an episode before sending, then does not send it again", async () => {
    const order: string[] = [];
    const held = new Set<string>();
    const first = await runLiveSurgeAlerts({
      enabled: true,
      maxPerDay: null,
      sentToday: 0,
      hits: [hit, {...hit, hotspotId: "sheet_b", episodeKey: "sheet_b|1"}],
      claim: async (item) => {
        order.push(`claim:${item.hotspotId}`);
        return claimOnce(held)(item);
      },
      send: async (message) => {
        order.push(`send:${message.data.hotspotId}`);
      },
    });
    assert.equal(first, 2);
    assert.deepEqual(order, ["claim:sheet_a", "send:sheet_a", "claim:sheet_b", "send:sheet_b"]);
    const again = await runLiveSurgeAlerts({
      enabled: true,
      maxPerDay: null,
      sentToday: 0,
      hits: [hit],
      claim: claimOnce(held),
      send: async () => {
        throw new Error("sent twice");
      },
    });
    assert.equal(again, 0);
  });

  it("keeps a claimed episode when the send fails", async () => {
    const held = new Set<string>();
    const failed = await runLiveSurgeAlerts({
      enabled: true,
      maxPerDay: null,
      sentToday: 0,
      hits: [hit],
      claim: claimOnce(held),
      send: async () => {
        throw new Error("fcm down");
      },
    });
    assert.equal(failed, 0);
    assert.equal(held.has(hit.episodeKey), true);
    let resent = 0;
    const retry = await runLiveSurgeAlerts({
      enabled: true,
      maxPerDay: null,
      sentToday: 0,
      hits: [hit],
      claim: claimOnce(held),
      send: async () => {
        resent += 1;
      },
    });
    assert.equal(retry, 0);
    assert.equal(resent, 0);
  });

  it("stops at a configured cap and sends without one when the cap is missing", async () => {
    const sent: string[] = [];
    const capped = await runLiveSurgeAlerts({
      enabled: true,
      maxPerDay: 1,
      sentToday: 0,
      hits: [hit, {...hit, hotspotId: "sheet_b", episodeKey: "sheet_b|1"}],
      claim: claimOnce(),
      send: async (message) => {
        sent.push(message.data.hotspotId);
      },
    });
    assert.equal(capped, 1);
    assert.deepEqual(sent, ["sheet_a"]);
    const open = await runLiveSurgeAlerts({
      enabled: true,
      maxPerDay: null,
      sentToday: 99,
      hits: [hit, {...hit, hotspotId: "sheet_b", episodeKey: "sheet_b|1"}],
      claim: claimOnce(),
      send: async (message) => {
        sent.push(`open:${message.data.hotspotId}`);
      },
    });
    assert.equal(open, 2);
  });

  it("sends nothing when the flag is off, the cap is 0, or the day is already full", async () => {
    const send = async () => {
      throw new Error("should not send");
    };
    const claim = async () => {
      throw new Error("should not claim");
    };
    assert.equal(await runLiveSurgeAlerts({
      enabled: false, maxPerDay: 5, sentToday: 0, hits: [hit], claim, send,
    }), 0);
    assert.equal(await runLiveSurgeAlerts({
      enabled: true, maxPerDay: 0, sentToday: 0, hits: [hit], claim, send,
    }), 0);
    assert.equal(await runLiveSurgeAlerts({
      enabled: true, maxPerDay: 5, sentToday: 5, hits: [hit], claim, send,
    }), 0);
    assert.equal(flagIsOn(undefined), false);
    assert.equal(flagIsOn(false), false);
    assert.equal(flagIsOn(true), true);
    const missing = {
      doc() {
        return {async get() {
          return {get: () => undefined};
        }};
      },
    } as unknown as Firestore;
    assert.equal(await maxAlertsPerDay(missing), null);
    const zero = {
      doc() {
        return {async get() {
          return {get: () => 0};
        }};
      },
    } as unknown as Firestore;
    assert.equal(await maxAlertsPerDay(zero), 0);
  });

  it("does not use forecasts, density, driver locations, or the forecast push type", () => {
    const source = readFileSync(join(__dirname, "../src/surge/liveSurge.ts"), "utf8");
    assert.equal(source.includes("computeLiveSurge"), false);
    assert.equal(source.includes("surge_forecast"), false);
    assert.equal(source.includes("driverLocations"), false);
    assert.equal(source.includes("classifySurgeCheck"), true);
    assert.equal(source.includes("notifPrefs.surgeActive"), true);
    assert.equal(source.includes(SURGE_CHANNEL), true);
    assert.equal(source.includes("TODO(PLAN-3c)"), true);
    assert.equal(source.includes("Quiet hours"), false);
    assert.equal(source.includes("return 5"), false);
    const schedule = readFileSync(join(__dirname, "../src/surge/syncStadiumSurgeSheet.ts"), "utf8");
    assert.equal(schedule.includes("notifyLiveSurge"), true);
  });
});
