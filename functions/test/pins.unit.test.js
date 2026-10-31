const test = require("node:test");
const assert = require("node:assert/strict");
const {geohash5, geohash} = require("../lib/pins/geohash");
const {staticWireKey, normalizeLabel} = require("../lib/pins/categories");
const {nextOpenWindow, excludedWindow} = require("../lib/pins/openWindow");
const {splitTiles, TILE_CAP} = require("../lib/pins/splitTile");
const {planStaticSeed, parseSeedArgs, assertCanWrite, loadRows} = require("../lib/pins/seedStatic");
const {liveDraftFromHotspot} = require("../lib/pins/drafts");

test("geohash5 matches the known u4pruydqqvj vector", () => {
  assert.equal(geohash(57.64911, 10.40744, 11), "u4pruydqqvj");
  assert.equal(geohash5(57.64911, 10.40744), "u4pru");
});

test("display labels map to the five wire keys", () => {
  assert.equal(normalizeLabel("Boosted Trains"), "boostedtrains");
  assert.equal(staticWireKey("Hospital"), "hospital");
  assert.equal(staticWireKey("University"), "university");
  assert.equal(staticWireKey("Pubs"), "pub");
  assert.equal(staticWireKey("Boosted Trains"), "boosted_train");
  assert.equal(staticWireKey("Shopping"), "shopping");
  assert.equal(staticWireKey("Event"), null);
});

test("opening hours cover only the next 24 hours", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const open = nextOpenWindow({opening_time: "11:00", closing_time: "23:00"}, now);
  assert.ok(open);
  assert.equal(open.start.toISOString(), now.toISOString());
  assert.ok(open.end.getTime() - open.start.getTime() < 24 * 60 * 60 * 1000);
  assert.ok(open.end.getTime() > now.getTime());
  assert.equal(nextOpenWindow({sunday: {opening_time: "10:00", closing_time: "12:00"}}, now), null);
  const closed = excludedWindow(now);
  assert.equal(closed.end.getTime(), now.getTime());
});

test("a tile over 500 is split and a tile that cannot fit stays over", () => {
  const many = Array.from({length: TILE_CAP + 1}, (_, i) => ({
    id: `s${i}`,
    g5: "u4pru",
    staticPin: i === TILE_CAP,
    windowEndMs: 1_000 + i,
  }));
  const split = splitTiles(many);
  assert.deepEqual(split.rawOver, ["u4pru"]);
  assert.equal(split.tilesFit, true);
  assert.equal(split.groups[0].members[0].id, `s${TILE_CAP}`);
  assert.equal(split.groups[0].members.length, TILE_CAP);
  assert.equal(split.groups[1].members.length, 1);

  const overflow = Array.from({length: TILE_CAP * 9 + 1}, (_, i) => ({
    id: `o${i}`,
    g5: "gcpvj",
    staticPin: false,
    windowEndMs: i,
  }));
  const tight = splitTiles(overflow);
  assert.equal(tight.tilesFit, false);
  assert.equal(tight.unassigned.length, 1);
});

test("the static plan keeps ids and excludes a pin with no open window", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const plan = planStaticSeed([
    {
      id: "pub_london_example",
      name: "Example Pub",
      category: "Pubs",
      city: "London",
      country: "UK",
      location: {latitude: 51.5074, longitude: -0.1278},
      events: {opening_time: "11:00", closing_time: "23:00"},
    },
    {
      id: "hospital_closed",
      name: "Night Hospital",
      category: "Hospital",
      location: {latitude: 51.52, longitude: -0.1},
      events: {},
    },
  ], now, null);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.drafts[0].id, "pub_london_example");
  assert.equal(plan.drafts[0].category, "pub");
  assert.equal(plan.drafts[0].g5, geohash5(51.5074, -0.1278));
  assert.ok(plan.drafts[0].windowEndMs > now.getTime());
  assert.equal(plan.drafts[1].windowEndMs, now.getTime());
  assert.match(plan.report, /tilesOver500: 0/);
  assert.match(plan.report, /Live counts were not read/);
});

test("dry-run parsing never writes, and a real project is refused", () => {
  assert.equal(parseSeedArgs(["--project", "demo-ferromaps-pins", "--input", "x.json"]).write, false);
  const prev = process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  assert.throws(() => assertCanWrite("ferro-maps-staging-v2"), /real project/);
  assert.throws(() => assertCanWrite("demo-ferromaps-pins"), /real project/);
  if (prev === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
  else process.env.FIRESTORE_EMULATOR_HOST = prev;
  assert.equal(loadRows([{id: "a"}]).length, 1);
  assert.equal(loadRows({pins: [{id: "a"}]}).length, 1);
});

test("legacy hotspot categories stay put in the live draft and parking gets 24h", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const event = liveDraftFromHotspot("evt1", {
    name: "Match",
    category: "events",
    country: "UK",
    location: {latitude: 51.5, longitude: -0.12},
    window_start: new Date("2026-06-15T18:00:00.000Z"),
    window_end: new Date("2026-06-15T21:00:00.000Z"),
    jobs_accepted: 2,
    jobsAccepted: 2,
  }, now);
  assert.equal(event.category, "event");
  assert.equal(event.country, "UK");
  assert.equal(event.hotspotSrc, "live");
  const parking = liveDraftFromHotspot("park1", {
    name: "Bay",
    category: "parking",
    location: {latitude: 51.5, longitude: -0.12},
    expire_at: new Date("2026-07-01T00:00:00.000Z"),
    window_end: new Date("2020-01-01T00:00:00.000Z"),
  }, now);
  assert.equal(parking.windowEndMs - now.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(liveDraftFromHotspot("old", {
    name: "Old",
    category: "venues",
    location: {latitude: 51.5, longitude: -0.12},
  }, now), null);
});
