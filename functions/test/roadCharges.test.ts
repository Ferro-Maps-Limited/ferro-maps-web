import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {ATTRIBUTION_LINES, containsForbiddenPricing, parseRoadChargeConfig, payByInstant} from "../src/roadCharges/config.js";
import {exampleRoadChargeDocuments} from "../src/roadCharges/exampleConfig.js";
import {
  alreadyProcessed,
  buildReminderMessage,
  classifyDue,
  historyDocId,
  isGoldAt,
  planZoneEntry,
  resolveTokens,
  type ClientZoneEntry,
  type DeviceToken,
  type DueZoneEntry,
  type ReminderMessage,
  type VehicleInput,
} from "../src/roadCharges/plan.js";
import {londonWallTime} from "../src/admin/london.js";
import {bankHolidaysFromGovUk} from "../src/roadCharges/bankHolidays.js";
import {runReminders, type ReminderDeps, type SendOutcome} from "../src/roadCharges/runReminders.js";
import {logRoadChargeTripRun} from "../src/roadCharges/logRoadChargeTrip.js";
import {runSeedCli} from "../src/roadCharges/seedCli.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const AFTER_FIRST = new Date("2026-11-02T17:44:00.000Z");
const AFTER_SECOND = new Date("2026-11-05T20:05:00.000Z");
const DOCS = exampleRoadChargeDocuments();

function entry(over: Partial<ClientZoneEntry> = {}): ClientZoneEntry {
  return {
    uid: "driver",
    entryId: "cc_2026-11-02",
    type: "cc",
    travelDate: "2026-11-02",
    activeVehicleId: "veh1",
    zoneVersion: "client-version",
    createdAt: NOW,
    ...over,
  };
}

function vehicle(over: Partial<VehicleInput> = {}): VehicleInput {
  return {exists: true, ulezCompliant: false, paymentMethod: "manual", ...over};
}

function due(over: Partial<DueZoneEntry> = {}): DueZoneEntry {
  const reminder1At = new Date("2026-11-02T17:30:00.000Z");
  const reminder2At = new Date("2026-11-05T20:00:00.000Z");
  return {
    uid: "driver",
    entryId: "cc_2026-11-02",
    type: "cc",
    travelDate: "2026-11-02",
    activeVehicleId: "veh1",
    chargePence: 2100,
    payByAt: new Date("2026-11-06T00:00:00.000Z"),
    reminder1At,
    reminder2At,
    nextReminderSlot: 1,
    nextReminderAt: reminder1At,
    expireAt: new Date("2026-11-12T12:00:00.000Z"),
    zoneVersion: "cc-2018-05-20",
    sendAttempts: 0,
    ...over,
  };
}

class Mem {
  now = AFTER_FIRST;
  rows = new Map<string, {
    entry: DueZoneEntry;
    state: string;
    reason: string;
    attempts: number;
    eligible: boolean;
  }>();
  devices: DeviceToken[] = [];
  legacy: string | null = null;
  gold: number | null = AFTER_SECOND.getTime() + 86_400_000;
  deleted: string[] = [];
  cleared: string[] = [];
  sent: ReminderMessage[] = [];
  warnings: string[] = [];
  loadCalls = 0;
  failSend = false;
  outcomes: SendOutcome[] | null = null;
  holidays: {cc: unknown; ulez: unknown} = {cc: ["2026-12-25"], ulez: ["2026-12-25"]};
  paidAtMs: number | null = null;
  historyMethod: string | null = "manual";

  add(row: DueZoneEntry, eligible = true): void {
    this.rows.set(`${row.uid}/${row.entryId}`, {
      entry: row,
      state: eligible ? "due" : "skip",
      reason: "",
      attempts: row.sendAttempts,
      eligible,
    });
  }

  row(entryId: string) {
    const found = [...this.rows.values()].find((item) => item.entry.entryId === entryId);
    if (!found) throw new Error(`missing ${entryId}`);
    return found;
  }

  deps(limit = 40): ReminderDeps {
    return {
      now: this.now,
      limit,
      newClaimId: () => "claim-1",
      loadHolidayLists: async () => this.holidays,
      warn: (message) => {
        this.warnings.push(message);
      },
      loadDue: async (page) => {
        this.loadCalls += 1;
        return [...this.rows.values()]
          .filter((item) => item.eligible && item.entry.nextReminderAt.getTime() <= this.now.getTime())
          .sort((a, b) => a.entry.nextReminderAt.getTime() - b.entry.nextReminderAt.getTime())
          .slice(0, page)
          .map((item) => ({...item.entry, sendAttempts: item.attempts}));
      },
      claim: async (item) => {
        const found = this.rows.get(`${item.uid}/${item.entryId}`);
        if (!found || !found.eligible) return false;
        if (found.entry.nextReminderAt.getTime() > this.now.getTime()) return false;
        found.eligible = false;
        return true;
      },
      loadHistory: async () => ({paidAtMs: this.paidAtMs, method: this.historyMethod}),
      loadUser: async () => ({subscriptionExpiresAtMs: this.gold, legacyFcmToken: this.legacy}),
      loadTokens: async () => this.devices,
      send: async (messages) => {
        this.sent.push(...messages);
        if (this.failSend) throw new Error("down");
        if (this.outcomes) return this.outcomes;
        return messages.map(() => ({ok: true}));
      },
      writeEntry: async (_uid, entryId, patch) => {
        const found = this.row(entryId);
        found.state = patch.reminderState;
        found.reason = patch.reminderReason;
        found.attempts = patch.sendAttempts;
        found.eligible = patch.reminderEligible;
        found.entry.sendAttempts = patch.sendAttempts;
        if (patch.nextReminderSlot) found.entry.nextReminderSlot = patch.nextReminderSlot;
        if (patch.nextReminderAt) found.entry.nextReminderAt = patch.nextReminderAt;
      },
      deleteToken: async (_uid, deviceId) => {
        this.deleted.push(deviceId);
      },
      clearLegacyToken: async (_uid, token) => {
        if (this.legacy === token) {
          this.cleared.push(token);
          this.legacy = null;
        }
      },
    };
  }
}

describe("road charge config and deadlines", () => {
  it("pins the three TfL attribution lines and parses the example docs", () => {
    assert.deepEqual(ATTRIBUTION_LINES, [
      "Powered by TfL Open Data",
      "Contains OS data © Crown copyright and database rights 2016",
      "Geomni UK Map data © and database rights 2019",
    ]);
    assert.equal(ATTRIBUTION_LINES[0].startsWith("Powered by TfL"), true);
    const cc = parseRoadChargeConfig("cc", DOCS.cc);
    const ulez = parseRoadChargeConfig("ulez", DOCS.ulez);
    assert.equal(cc.ok, true);
    assert.equal(ulez.ok, true);
    if (!cc.ok || !ulez.ok) return;
    assert.equal(cc.config.ccRegion?.radiusM, 8000);
    assert.equal(ulez.config.ccRegion, undefined);
    assert.equal(cc.config.boundaryUrl.includes(cc.config.zoneVersion), true);
    assert.equal(ulez.config.boundaryUrl.includes(ulez.config.zoneVersion), true);
    assert.equal(containsForbiddenPricing(DOCS), false);
  });

  it("rejects a config that could overwrite a boundary file or invent a price", () => {
    const brokenUrl = {...DOCS.cc, boundaryUrl: "https://example.com/cc/latest.geojson"};
    const queried = {...DOCS.cc, boundaryUrl: `${DOCS.cc.boundaryUrl}?v=2`};
    const http = {...DOCS.cc, boundaryUrl: DOCS.cc.boundaryUrl.replace("https", "http")};
    const priced = {...DOCS.cc, chargePence: "1800"};
    const region = {...DOCS.ulez, ccRegion: DOCS.cc.ccRegion};
    const bare = {...DOCS.cc, ccRegion: undefined};
    const attribution = {...DOCS.cc, attribution: ["Powered by TfL Open Data", "no", "no"]};
    assert.equal(parseRoadChargeConfig("cc", brokenUrl).ok, false);
    assert.equal(parseRoadChargeConfig("cc", queried).ok, false);
    assert.equal(parseRoadChargeConfig("cc", http).ok, false);
    assert.equal(parseRoadChargeConfig("cc", priced).ok, false);
    assert.equal(parseRoadChargeConfig("ulez", region).ok, false);
    assert.equal(parseRoadChargeConfig("cc", bare).ok, false);
    assert.equal(parseRoadChargeConfig("cc", attribution).ok, false);
    assert.equal(parseRoadChargeConfig("cc", null).ok, false);
  });

  it("puts the pay-by instant at London midnight after the third day, including BST", () => {
    assert.equal(payByInstant("2026-11-02", 3).toISOString(), "2026-11-06T00:00:00.000Z");
    assert.equal(payByInstant("2026-07-06", 3).toISOString(), "2026-07-09T23:00:00.000Z");
    assert.equal(londonWallTime("2026-11-02", 17, 30).toISOString(), "2026-11-02T17:30:00.000Z");
    assert.equal(londonWallTime("2026-11-05", 20, 0).toISOString(), "2026-11-05T20:00:00.000Z");
    assert.equal(londonWallTime("2026-07-06", 17, 30).toISOString(), "2026-07-06T16:30:00.000Z");
    assert.equal(londonWallTime("2026-07-09", 20, 0).toISOString(), "2026-07-09T19:00:00.000Z");
    assert.equal(londonWallTime("2026-03-29", 17, 30).toISOString(), "2026-03-29T16:30:00.000Z");
    assert.equal(londonWallTime("2026-10-25", 17, 30).toISOString(), "2026-10-25T17:30:00.000Z");
  });
});

describe("zone entry planning", () => {
  it("records a manual CC entry as unpaid and due at the late amount", () => {
    const plan = planZoneEntry(entry(), vehicle(), DOCS.cc, NOW);
    assert.equal(plan.historyId, "cc_veh1_2026-11-02");
    assert.equal(historyDocId("cc", "veh1", "2026-11-02"), plan.historyId);
    assert.equal(plan.patch.reminderState, "due");
    assert.equal(plan.patch.method, "manual");
    assert.equal(plan.patch.chargePence, 2100);
    assert.equal(plan.history?.status, "unpaid");
    assert.equal(plan.history?.zoneVersion, "cc-2018-05-20");
    assert.equal(plan.patch.payByAt?.toISOString(), "2026-11-06T00:00:00.000Z");
    assert.equal(plan.patch.reminder1At?.toISOString(), "2026-11-02T17:30:00.000Z");
    assert.equal(plan.patch.reminder2At?.toISOString(), "2026-11-05T20:00:00.000Z");
    assert.equal(plan.patch.reminderEligible, true);
    assert.equal(plan.patch.nextReminderSlot, 1);
    assert.equal(plan.history?.activeVehicleId, "veh1");
    assert.equal(plan.history?.source, "zone-entry");
    assert.equal(plan.patch.expireAt.toISOString(), "2026-11-09T12:00:00.000Z");
    assert.equal(containsForbiddenPricing(plan.history), false);
    assert.equal(containsForbiddenPricing(plan.patch), false);
  });

  it("writes autopay history and does not schedule a reminder", () => {
    const plan = planZoneEntry(entry(), vehicle({paymentMethod: "autopay"}), DOCS.cc, NOW);
    assert.equal(plan.patch.reminderState, "skip");
    assert.equal(plan.patch.reminderReason, "autopay");
    assert.equal(plan.patch.reminderEligible, false);
    assert.equal(plan.history?.method, "autopay");
    assert.equal(plan.history?.status, "autopay");
    assert.equal(plan.history?.chargePence, 1800);
  });

  it("does not charge a ULEZ-compliant vehicle", () => {
    const plan = planZoneEntry(entry({
      entryId: "ulez_2026-11-02",
      type: "ulez",
    }), vehicle({ulezCompliant: true, paymentMethod: "autopay"}), DOCS.ulez, NOW);
    assert.equal(plan.patch.reminderState, "skip");
    assert.equal(plan.patch.reminderReason, "ulez-compliant");
    assert.equal(plan.history?.method, "autopay");
    assert.equal(plan.history?.chargePence, 0);
    assert.equal(plan.history?.status, "not_charged");
  });

  it("does not remind when the vehicle is missing, so Auto Pay is not guessed", () => {
    const plan = planZoneEntry(entry(), {exists: false}, DOCS.cc, NOW);
    assert.equal(plan.patch.reminderState, "skip");
    assert.equal(plan.patch.reminderReason, "vehicle-unknown");
    assert.equal(plan.history?.method, "unknown");
    assert.equal(plan.history?.chargePence, 0);
  });

  it("skips a closed day and a deadline that has already passed", () => {
    const christmas = new Date("2026-12-25T12:00:00.000Z");
    const closed = planZoneEntry(entry({
      entryId: "cc_2026-12-25",
      travelDate: "2026-12-25",
      createdAt: christmas,
    }), vehicle(), DOCS.cc, christmas);
    assert.equal(closed.patch.reminderReason, "closed");
    assert.equal(closed.history?.chargePence, 0);

    const lateNow = new Date("2026-11-06T00:00:00.000Z");
    const late = planZoneEntry(entry(), vehicle(), DOCS.cc, lateNow);
    assert.equal(late.patch.reminderState, "expired");
    assert.equal(late.history?.status, "unpaid");
    assert.equal(late.history?.chargePence, 2100);
  });

  it("does not write a charge for a future date, a bad id, or a missing config", () => {
    const future = planZoneEntry(entry({
      entryId: "cc_2026-11-03",
      travelDate: "2026-11-03",
    }), vehicle(), DOCS.cc, NOW);
    assert.equal(future.history, null);
    assert.equal(future.patch.reminderReason, "future-date");

    const bad = planZoneEntry(entry({entryId: "cc_2026-13-40", travelDate: "2026-13-40"}), vehicle(), DOCS.cc, NOW);
    assert.equal(bad.history, null);
    assert.equal(bad.patch.reminderReason, "bad-entry");

    const missing = planZoneEntry(entry(), vehicle(), null, NOW);
    assert.equal(missing.history, null);
    assert.equal(missing.patch.chargePence, undefined);
    assert.equal(missing.patch.reminderReason, "config-invalid");
    assert.equal(alreadyProcessed({reminderState: "due"}), true);
    assert.equal(alreadyProcessed({}), false);
  });
});

describe("reminder sends", () => {
  it("sends the 17:30 reminder on or just after that time, then the 20:00 one once", async () => {
    const mem = new Mem();
    mem.devices = [{deviceId: "install-1", token: "tok-a", platform: "ios", updatedAtMs: 2}];
    mem.legacy = "legacy-tok";
    mem.add(due());
    const early = new Mem();
    early.now = new Date("2026-11-02T17:29:00.000Z");
    early.devices = mem.devices;
    early.add(due());
    const tooSoon = await runReminders(early.deps());
    assert.equal(tooSoon.considered, 0);
    assert.equal(early.sent.length, 0);

    const first = await runReminders(mem.deps());
    assert.equal(first.sent, 1);
    assert.equal(mem.sent.length, 1);
    assert.equal(mem.sent[0].data.slot, "1");
    assert.equal(mem.sent[0].data.chargePence, "2100");
    assert.equal(mem.sent[0].notification.body.includes("£21.00"), true);
    assert.equal(containsForbiddenPricing(mem.sent[0]), false);
    assert.equal(mem.row("cc_2026-11-02").entry.nextReminderSlot, 2);
    const again = await runReminders(mem.deps());
    assert.equal(again.considered, 0);
    assert.equal(mem.sent.length, 1);

    mem.now = AFTER_SECOND;
    const second = await runReminders(mem.deps());
    assert.equal(second.sent, 1);
    assert.equal(mem.sent[1].data.slot, "2");
    assert.equal(mem.row("cc_2026-11-02").state, "sent");
    assert.equal(mem.row("cc_2026-11-02").eligible, false);
    const third = await runReminders(mem.deps());
    assert.equal(third.considered, 0);
    assert.equal(mem.sent.length, 2);
  });

  it("sends neither reminder once the history is paid or Auto Pay", async () => {
    const paid = new Mem();
    paid.paidAtMs = AFTER_FIRST.getTime();
    paid.devices = [{deviceId: "install-1", token: "tok-a", platform: "ios", updatedAtMs: 1}];
    paid.add(due());
    const paidRun = await runReminders(paid.deps());
    assert.equal(paidRun.sent, 0);
    assert.equal(paid.sent.length, 0);
    assert.equal(paid.row("cc_2026-11-02").reason, "paid");

    const auto = new Mem();
    auto.historyMethod = "autopay";
    auto.devices = paid.devices;
    auto.add(due({entryId: "ulez_2026-11-02", type: "ulez", chargePence: 1250}));
    auto.now = AFTER_SECOND;
    const autoRun = await runReminders(auto.deps());
    assert.equal(autoRun.sent, 0);
    assert.equal(auto.row("ulez_2026-11-02").reason, "autopay");
  });

  it("skips the run when bankHolidays is empty or missing", async () => {
    const mem = new Mem();
    mem.holidays = {cc: [], ulez: ["2026-12-25"]};
    mem.devices = [{deviceId: "install-1", token: "tok-a", platform: "ios", updatedAtMs: 1}];
    mem.add(due());
    const summary = await runReminders(mem.deps());
    assert.equal(summary.skippedRun, true);
    assert.equal(summary.sent, 0);
    assert.equal(mem.loadCalls, 0);
    assert.equal(mem.warnings.length, 1);
    assert.match(mem.warnings[0], /bankHolidays/);

    const missing = new Mem();
    missing.holidays = {cc: ["2026-12-25"], ulez: undefined};
    missing.add(due());
    const second = await runReminders(missing.deps());
    assert.equal(second.skippedRun, true);
    assert.equal(missing.loadCalls, 0);
  });

  it("stops at the page size and does not loop", async () => {
    const mem = new Mem();
    mem.devices = [{deviceId: "install-1", token: "tok-a", platform: "android", updatedAtMs: 1}];
    for (let index = 0; index < 50; index += 1) {
      mem.add(due({entryId: `cc_2026-11-${String(index).padStart(2, "0")}`}));
    }
    const summary = await runReminders(mem.deps(40));
    assert.equal(mem.loadCalls, 1);
    assert.equal(summary.considered, 40);
    assert.equal(mem.sent.length, 40);
  });

  it("skips a lapsed Gold user and a stuck claim", async () => {
    const mem = new Mem();
    mem.gold = AFTER_FIRST.getTime();
    mem.devices = [{deviceId: "install-1", token: "tok-a", platform: "ios", updatedAtMs: 1}];
    mem.add(due());
    const summary = await runReminders(mem.deps());
    assert.equal(summary.sent, 0);
    assert.equal(mem.sent.length, 0);
    assert.equal(mem.row("cc_2026-11-02").reason, "not-gold");
    assert.equal(isGoldAt(AFTER_FIRST.getTime(), AFTER_FIRST), false);
    assert.equal(isGoldAt(null, AFTER_FIRST), false);

    const stuck = new Mem();
    stuck.devices = mem.devices;
    stuck.add(due({entryId: "ulez_2026-11-02", type: "ulez", chargePence: 1250}), false);
    const again = await runReminders(stuck.deps());
    assert.equal(again.considered, 0);
    assert.equal(stuck.sent.length, 0);
  });

  it("falls back to the legacy token only when the subcollection is empty", async () => {
    const legacy = new Mem();
    legacy.legacy = "legacy-tok";
    legacy.add(due());
    await runReminders(legacy.deps());
    assert.deepEqual(legacy.sent.map((message) => message.token), ["legacy-tok"]);

    const both = new Mem();
    both.legacy = "legacy-tok";
    both.devices = [
      {deviceId: "old", token: "tok-old", platform: "ios", updatedAtMs: 1},
      {deviceId: "new", token: "tok-new", platform: "android", updatedAtMs: 5},
      {deviceId: "dup", token: "tok-new", platform: "android", updatedAtMs: 4},
      {deviceId: "bad", token: "tok-web", platform: "web", updatedAtMs: 9},
    ];
    both.add(due());
    await runReminders(both.deps());
    assert.deepEqual(both.sent.map((message) => message.token), ["tok-new", "tok-old"]);
  });

  it("caps tokens at ten and deletes an unregistered one", async () => {
    const mem = new Mem();
    mem.legacy = "tok-0";
    mem.devices = Array.from({length: 12}, (_, index) => ({
      deviceId: `d${index}`,
      token: `tok-${index}`,
      platform: "ios" as const,
      updatedAtMs: index,
    }));
    mem.outcomes = [
      {ok: false, errorCode: "messaging/registration-token-not-registered"},
      ...Array.from({length: 9}, () => ({ok: true})),
    ];
    mem.add(due());
    const summary = await runReminders(mem.deps());
    assert.equal(mem.sent.length, 10);
    assert.equal(mem.sent[0].token, "tok-11");
    assert.equal(summary.sent, 1);
    assert.deepEqual(mem.deleted, ["d11"]);
    assert.deepEqual(mem.cleared, []);
    assert.equal(mem.row("cc_2026-11-02").state, "due");
    assert.equal(mem.row("cc_2026-11-02").entry.nextReminderSlot, 2);
  });

  it("clears the legacy field when that token is unregistered, and retries a transient failure", async () => {
    const dead = new Mem();
    dead.legacy = "legacy-tok";
    dead.outcomes = [{ok: false, errorCode: "messaging/invalid-registration-token"}];
    dead.add(due());
    await runReminders(dead.deps());
    assert.deepEqual(dead.cleared, ["legacy-tok"]);
    assert.equal(dead.row("cc_2026-11-02").reason, "no-token");

    const retry = new Mem();
    retry.devices = [{deviceId: "d", token: "tok", platform: "ios", updatedAtMs: 1}];
    retry.failSend = true;
    retry.add(due());
    await runReminders(retry.deps());
    await runReminders(retry.deps());
    await runReminders(retry.deps());
    assert.equal(retry.row("cc_2026-11-02").state, "failed");
    assert.equal(retry.row("cc_2026-11-02").reason, "send-failed");
    assert.equal(retry.row("cc_2026-11-02").attempts, 3);
  });

  it("does not send after the deadline or for a zero charge", () => {
    assert.equal(classifyDue(due({payByAt: new Date("2026-11-02T17:00:00.000Z")}), AFTER_FIRST), "expired");
    assert.equal(classifyDue(due({chargePence: 0}), AFTER_FIRST), "bad");
    assert.equal(classifyDue(due(), new Date("2026-11-02T17:29:00.000Z")), "wait");
    const message = buildReminderMessage(due(), "tok");
    assert.equal(Object.values(message.data).every((value) => typeof value === "string"), true);
    assert.equal(message.collapseKey, "cc_2026-11-02_1");
    assert.equal(message.data.slot, "1");
  });

  it("keeps ten newest tokens and ignores blanks", () => {
    const tokens = resolveTokens([
      {deviceId: "a", token: " ", platform: "ios", updatedAtMs: 5},
      {deviceId: "b", token: "same", platform: "ios", updatedAtMs: 1},
      {deviceId: "c", token: "same", platform: "android", updatedAtMs: 2},
    ], "legacy", 10);
    assert.deepEqual(tokens, [{token: "same", deviceId: "c"}]);
    assert.deepEqual(resolveTokens([], " legacy ", 10), [{token: "legacy", deviceId: null}]);
  });
});

describe("dry-run seed", () => {
  const feed = {
    "england-and-wales": {
      events: [
        {date: "2026-12-25", title: "Christmas Day"},
        {date: "2026-01-01", title: "New Year’s Day"},
        {date: "not-a-date"},
      ],
    },
    "scotland": {events: [{date: "2026-01-02"}]},
  };

  function fetchFeed(): typeof fetch {
    return (async () => new Response(JSON.stringify(feed), {status: 200})) as typeof fetch;
  }

  it("prints bank holidays and does not write unless --write is passed", async () => {
    let writes = 0;
    const printed = await runSeedCli([], {fetch: fetchFeed()});
    assert.equal(printed.exitCode, 0);
    const payload = JSON.parse(printed.stdout) as {
      dryRun: boolean;
      wrote: boolean;
      documents: Record<string, {attribution: string[]; bankHolidays: string[]}>;
    };
    assert.equal(payload.dryRun, true);
    assert.equal(payload.wrote, false);
    assert.deepEqual(payload.documents["roadCharges/cc"].attribution, [...ATTRIBUTION_LINES]);
    assert.deepEqual(payload.documents["roadCharges/cc"].bankHolidays, ["2026-01-01", "2026-12-25"]);
    assert.deepEqual(payload.documents["roadCharges/ulez"].bankHolidays, ["2026-01-01", "2026-12-25"]);
    assert.deepEqual(bankHolidaysFromGovUk(feed), ["2026-01-01", "2026-12-25"]);

    const refused = await runSeedCli(["--write"], {fetch: fetchFeed()});
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /Nothing was written/);

    const saved = await runSeedCli(["--write", "--project", "demo-ferromaps-road-charges"], {
      fetch: fetchFeed(),
      write: async (docs) => {
        writes += 1;
        assert.deepEqual(docs.cc.bankHolidays, ["2026-01-01", "2026-12-25"]);
      },
    });
    assert.equal(saved.stderr, "");
    assert.equal(saved.exitCode, 0);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(saved.stdout).wrote, true);
    const exampleSource = readFileSync(join(process.cwd(), "src/roadCharges/exampleConfig.ts"), "utf8");
    assert.equal(exampleSource.includes("firebase"), false);
  });
});

describe("logRoadChargeTrip", () => {
  const goldUntil = {toMillis: () => NOW.getTime() + 86_400_000};
  const expired = {toMillis: () => NOW.getTime() - 1000};

  function dbFor(options: {gold?: boolean; vehicle?: boolean; history?: boolean} = {}) {
    const docs = new Map<string, Record<string, unknown> | null>();
    docs.set("users/driver", {
      subscriptionExpiresAt: options.gold === false ? expired : goldUntil,
    });
    if (options.vehicle !== false) {
      docs.set("users/driver/vehicles/veh1", {ulezCompliant: false, paymentMethod: "autopay"});
    }
    docs.set("roadCharges/cc", DOCS.cc as unknown as Record<string, unknown>);
    docs.set("roadCharges/ulez", DOCS.ulez as unknown as Record<string, unknown>);
    if (options.history) {
      docs.set("users/driver/gig_history/cc_veh1_2026-11-02", {chargePence: 1, source: "manual"});
    }
    const writes: string[] = [];
    const db = {
      doc(path: string) {
        return {
          path,
          async get() {
            const data = docs.get(path);
            return {
              exists: data != null,
              data: () => data ?? undefined,
              get(field: string) {
                return data?.[field];
              },
            };
          },
        };
      },
      async runTransaction(fn: (tx: {
        get: (ref: {get: () => Promise<{exists: boolean}>}) => Promise<{exists: boolean}>;
        set: (ref: {path: string}, data: unknown) => void;
      }) => Promise<void>) {
        await fn({
          get: async (ref) => ref.get(),
          set: (ref, data) => {
            writes.push(ref.path);
            docs.set(ref.path, data as Record<string, unknown>);
          },
        });
      },
    };
    return {db, docs, writes};
  }

  it("requires Gold, rejects a missing vehicle and a future date, and creates once", async () => {
    const body = {type: "cc", vehicleId: "veh1", travelDate: "2026-11-02"};
    const signedOut = dbFor();
    const noAuth = await logRoadChargeTripRun(signedOut.db as never, {uid: null, body, now: NOW});
    assert.equal(noAuth.ok, false);
    if (!noAuth.ok) assert.equal(noAuth.code, "unauthenticated");
    assert.equal(signedOut.writes.length, 0);

    const lapsed = dbFor({gold: false});
    const notGold = await logRoadChargeTripRun(lapsed.db as never, {uid: "driver", body, now: NOW});
    assert.equal(notGold.ok, false);
    if (!notGold.ok) assert.equal(notGold.code, "permission-denied");
    assert.equal(lapsed.writes.length, 0);

    const missingCar = dbFor({vehicle: false});
    const noCar = await logRoadChargeTripRun(missingCar.db as never, {uid: "driver", body, now: NOW});
    assert.equal(noCar.ok, false);
    if (!noCar.ok) assert.equal(noCar.code, "not-found");
    assert.equal(missingCar.writes.length, 0);

    const futureDb = dbFor();
    const future = await logRoadChargeTripRun(futureDb.db as never, {
      uid: "driver",
      body: {...body, travelDate: "2026-11-03"},
      now: NOW,
    });
    assert.equal(future.ok, false);
    if (!future.ok) assert.equal(future.code, "invalid-argument");
    assert.equal(futureDb.writes.length, 0);

    const store = dbFor();
    const created = await logRoadChargeTripRun(store.db as never, {uid: "driver", body, now: NOW});
    assert.deepEqual(created, {ok: true, alreadyExists: false});
    const saved = store.docs.get("users/driver/gig_history/cc_veh1_2026-11-02");
    assert.equal(saved?.source, "manual");
    assert.equal(saved?.method, "manual");
    assert.equal(saved?.activeVehicleId, "veh1");
    const again = await logRoadChargeTripRun(store.db as never, {uid: "driver", body, now: NOW});
    assert.deepEqual(again, {ok: true, alreadyExists: true});
    assert.equal(store.writes.length, 1);
    assert.equal(store.docs.get("users/driver/gig_history/cc_veh1_2026-11-02"), saved);
  });
});
