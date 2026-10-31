const test = require("node:test");
const assert = require("node:assert/strict");
const {initializeApp, getApps} = require("firebase-admin/app");
const {getFirestore, GeoPoint, Timestamp} = require("firebase-admin/firestore");
const {publishPins} = require("../lib/pins/publishPins");
const {applyStaticSeed} = require("../lib/pins/seedStatic");
const {geohash5} = require("../lib/pins/geohash");
const {TILE_CAP} = require("../lib/pins/splitTile");

if (getApps().length === 0) {
  initializeApp({projectId: "demo-ferromaps-pins"});
}
const db = getFirestore();

async function clearDb() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const resp = await fetch(
      `http://${host}/emulator/v1/projects/demo-ferromaps-pins/databases/(default)/documents`,
      {method: "DELETE"},
  );
  if (!resp.ok) throw new Error(await resp.text());
}

test.beforeEach(clearDb);

test("a hotspot becomes a pin with g5 and no top-level expiresAt, and protected fields stay", async () => {
  const start = Timestamp.fromDate(new Date("2026-06-15T18:00:00.000Z"));
  const end = Timestamp.fromDate(new Date("2026-06-15T21:00:00.000Z"));
  await db.collection("hotspots_test").doc("evt1").set({
    name: "Match",
    category: "events",
    country: "UK",
    city: "London",
    location: new GeoPoint(51.5, -0.12),
    window_start: start,
    window_end: end,
    jobs_accepted: 3,
    jobsAccepted: 4,
    events: {closing_time: "21:00", end_time: "21:00", venue_name: "Ground"},
    expire_at: end,
  });
  const warnings = [];
  await publishPins(db, new Date("2026-06-15T12:00:00.000Z"), {
    warn(message, fields) {
      warnings.push({message, fields});
    },
    info() {
      return undefined;
    },
  });
  const pin = (await db.collection("pins").doc("evt1").get()).data();
  assert.equal(pin.g5, geohash5(51.5, -0.12));
  assert.equal(pin.category, "event");
  assert.equal(pin.src, "live");
  assert.equal(pin.expiresAt, undefined);
  assert.equal(pin.v, 1);
  const hotspot = (await db.collection("hotspots_test").doc("evt1").get()).data();
  assert.equal(hotspot.category, "events");
  assert.equal(hotspot.country, "UK");
  assert.equal(hotspot.jobs_accepted, 3);
  assert.equal(hotspot.jobsAccepted, 4);
  assert.equal(hotspot.events.venue_name, "Ground");
  assert.equal(hotspot.src, "live");
  assert.equal(hotspot.expiresAt, undefined);
  const tile = (await db.collection("pinTiles").doc(pin.g5).get()).data();
  assert.equal(tile.v, 1);
  assert.ok(tile.pins.evt1);
  assert.equal(warnings.length, 0);
});

test("static seed keeps the city id, rolls a 24h window, and excludes a closed pin", async () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  await applyStaticSeed(db, [
    {
      id: "pub_london_kings_head",
      name: "King's Head",
      category: "Pubs",
      city: "London",
      country: "UK",
      location: {latitude: 51.5074, longitude: -0.1278},
      events: {opening_time: "11:00", closing_time: "23:00"},
    },
    {
      id: "hospital_closed_today",
      name: "Quiet Hospital",
      category: "Hospital",
      location: {latitude: 51.52, longitude: -0.1},
      events: {sunday: {opening_time: "09:00", closing_time: "12:00"}},
    },
  ], now);
  const pub = (await db.collection("pins").doc("pub_london_kings_head").get()).data();
  assert.equal(pub.src, "static");
  assert.equal(pub.category, "pub");
  assert.equal(pub.g5, geohash5(51.5074, -0.1278));
  assert.equal(pub.city, "London");
  assert.ok(pub.window_end.toDate().getTime() > now.getTime());
  assert.ok(pub.window_end.toDate().getTime() - now.getTime() <= 24 * 60 * 60 * 1000);
  assert.equal(pub.expiresAt, undefined);
  const closed = (await db.collection("pins").doc("hospital_closed_today").get()).data();
  assert.equal(closed.window_end.toDate().getTime(), now.getTime());
  const query = await db.collection("pins")
      .where("g5", "==", pub.g5)
      .where("window_end", ">", Timestamp.fromDate(now))
      .orderBy("window_end", "asc")
      .limit(500)
      .get();
  assert.deepEqual(query.docs.map((doc) => doc.id), ["pub_london_kings_head"]);

  await applyStaticSeed(db, [
    {
      id: "pub_london_kings_head",
      name: "King's Head",
      category: "Pubs",
      city: "London",
      country: "UK",
      location: {latitude: 51.5074, longitude: -0.1278},
      events: {opening_time: "11:00", closing_time: "23:00"},
    },
  ], now);
  const again = await db.collection("pins").where("pinId", "==", "pub_london_kings_head").get();
  assert.equal(again.size, 1);
});

test("501 pins in one cell are split so the listener query stays at 500", async () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const rows = Array.from({length: TILE_CAP + 1}, (_, i) => ({
    id: `pub_cell_${String(i).padStart(4, "0")}`,
    name: `Pub ${i}`,
    category: "Pubs",
    location: {latitude: 51.5074, longitude: -0.1278},
    events: {opening_time: "00:00", closing_time: "23:59"},
  }));
  rows.push({
    id: "late_static_kept",
    name: "Late static",
    category: "Shopping",
    location: {latitude: 51.5074, longitude: -0.1278},
    events: {opening_time: "22:00", closing_time: "23:00"},
  });
  await applyStaticSeed(db, rows.slice(0, TILE_CAP + 1), now);
  const g5 = geohash5(51.5074, -0.1278);
  const active = await db.collection("pins")
      .where("g5", "==", g5)
      .where("window_end", ">", Timestamp.fromDate(now))
      .orderBy("window_end")
      .get();
  assert.equal(active.size, TILE_CAP);
  const tile = (await db.collection("pinTiles").doc(g5).get()).data();
  assert.ok(tile.shards >= 1);
  const sibling = await db.collection("pinTiles").doc(`${g5}_1`).get();
  assert.equal(sibling.exists, true);
  assert.equal(sibling.data().v, 1);
});
