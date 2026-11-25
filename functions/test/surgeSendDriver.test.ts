import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {toFirestoreData} from "../src/surge/commit";
import {
  AWAY_TEAM,
  COMPETITION,
  EVENT_ID,
  EVENTS_HEADERS,
  EXPECTED_FULL_TIME,
  GROUND,
  HARD_STOP,
  HOME_TEAM,
  KICKOFF,
  PICKUP_POINTS,
  PREDICTED_SURGE_CONFIDENCE,
  SEND_DRIVER,
  SURGE_END,
  SURGE_START,
  VERIFIER_STATUS,
} from "../src/surge/headers";
import {parseSendDriver} from "../src/surge/parse";
import {planStadiumEvents} from "../src/surge/plan";
import {assertNoPrices} from "../src/surge/priceGuard";
import {matrix} from "../src/surge/syntheticSheet";

/* The Events-tab SEND DRIVER call decides the window-open push (25 Nov 2026). */
describe("SEND DRIVER", () => {
  it("keeps the pickup address and the in-position times of a send, and nothing else", () => {
    assert.deepEqual(
      parseSendDriver("SEND: Village Way, Falmer, Brighton, BN1 9PH | In position 19:25-20:40 GMT | 70% conf, evening", ""),
      {decision: "send", pickup: "Village Way, Falmer, Brighton, BN1 9PH", inPositionFrom: "19:25", inPositionTo: "20:40"});
    assert.deepEqual(
      parseSendDriver("SEND: 268 Whitehorse Lane, South Norwood, London, SE25 6UW", "APPROVED"),
      {decision: "send", pickup: "268 Whitehorse Lane, South Norwood, London, SE25 6UW", inPositionFrom: null, inPositionTo: null});
    assert.equal(parseSendDriver("send: Gate A | in position 9:05 – 10:00", "")?.inPositionFrom, "09:05");
    assert.equal(parseSendDriver("send: Gate A | in position 9:05 – 10:00", "")?.inPositionTo, "10:00");
  });

  it("reads a hold without its reason", () => {
    assert.deepEqual(parseSendDriver("HOLD - do not send: daytime finish 16:55, nothing boosting it", ""),
      {decision: "hold", pickup: null, inPositionFrom: null, inPositionTo: null});
  });

  it("lets a reviewer's DROP override a send", () => {
    assert.equal(parseSendDriver("SEND: Gate A | In position 19:25-20:40", "DROP")?.decision, "hold");
    assert.equal(parseSendDriver("SEND: Gate A", " drop ")?.decision, "hold");
    assert.equal(parseSendDriver("SEND: Gate A", "WATCH")?.decision, "send");
  });

  it("is no decision when the cell is blank or something else", () => {
    assert.equal(parseSendDriver("", ""), null);
    assert.equal(parseSendDriver(undefined, "APPROVED"), null);
    assert.equal(parseSendDriver("maybe later", ""), null);
    assert.equal(parseSendDriver("Sendai Arena", ""), null, "a word that starts with send is not a send");
  });

  it("drops an address that would publish a price word, or is missing or too long, but keeps the send", () => {
    assert.deepEqual(parseSendDriver("SEND: Fares desk, Gate B | In position 19:25-20:40", ""),
      {decision: "send", pickup: null, inPositionFrom: "19:25", inPositionTo: "20:40"});
    assert.equal(parseSendDriver("SEND: £5 drop-off bay", "")?.pickup, null);
    assert.equal(parseSendDriver("SEND: In position 21:40-22:55", "")?.pickup, null);
    assert.equal(parseSendDriver(`SEND: ${"x".repeat(81)}`, "")?.pickup, null);
  });
});

describe("SEND DRIVER on the event document", () => {
  const headers = [...EVENTS_HEADERS, VERIFIER_STATUS];
  const row = (id: string, send: string, verifier = "") => ({
    [EVENT_ID]: id,
    [COMPETITION]: "Synthetic Cup",
    [HOME_TEAM]: "Home Side",
    [AWAY_TEAM]: "Away Side",
    [GROUND]: "Synthetic Park",
    [KICKOFF]: "2099-01-01 19:45",
    [EXPECTED_FULL_TIME]: "2099-01-01 21:40",
    [SURGE_START]: "2099-01-01 21:40",
    [SURGE_END]: "2099-01-01 22:55",
    [HARD_STOP]: "2099-01-02 00:40",
    [PICKUP_POINTS]: "Gate A | 51.4022,-0.0835",
    [PREDICTED_SURGE_CONFIDENCE]: "70%",
    [SEND_DRIVER]: send,
    [VERIFIER_STATUS]: verifier,
  });

  it("writes the call, and null when there is none so an old call is cleared", () => {
    const plan = planStadiumEvents({
      now: new Date("2098-12-31T12:00:00Z"),
      events: matrix(headers, [
        row("2099-01-01-SYN-SND", "SEND: Synthetic Lane, London, SE25 6UW | In position 21:40-22:55 GMT | 70% conf"),
        row("2099-01-01-SYN-HLD", "HOLD - do not send: small ground"),
        row("2099-01-01-SYN-DRP", "SEND: Synthetic Lane", "DROP"),
        row("2099-01-01-SYN-BLK", ""),
      ]),
      readings: matrix([], []),
    });
    const byId = new Map(plan.records.map((record) => [record.sheetEventId, record]));
    const doc = (id: string) => {
      const record = byId.get(id);
      assert.ok(record, id);
      return toFirestoreData(record);
    };
    assert.equal(plan.records.length, 4, "a call never drops the event");
    const send = doc("2099-01-01-SYN-SND");
    assert.deepEqual(send.sendDriver,
      {decision: "send", pickup: "Synthetic Lane, London, SE25 6UW", inPositionFrom: "21:40", inPositionTo: "22:55"});
    assert.doesNotThrow(() => assertNoPrices(send));
    assert.equal((doc("2099-01-01-SYN-HLD").sendDriver as {decision: string}).decision, "hold");
    assert.equal((doc("2099-01-01-SYN-DRP").sendDriver as {decision: string}).decision, "hold");
    const blank = doc("2099-01-01-SYN-BLK");
    assert.ok("sendDriver" in blank);
    assert.equal(blank.sendDriver, null);
  });
});
