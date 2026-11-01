import assert from "node:assert/strict";
import {describe, it, before, beforeEach} from "node:test";
import {HttpsError} from "firebase-functions/v2/https";
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {
  SAVED_PARKING_CELL_ID_MAX,
  SAVED_PARKING_LIMIT,
  SAVED_PARKING_NAME_MAX,
  SAVED_PLACES_LIMIT,
  handleSaveParkingPlace,
  handleUnsaveParkingPlace,
  parseSaveParkingInput,
} from "../src/parking/saveParkingPlace.js";
import {testDb} from "./support.js";

const UID = "ada";

function input(over: Record<string, unknown> = {}) {
  return {
    placeId: "a".repeat(64),
    name: "Yard",
    lat: 51.5,
    lng: -0.12,
    cellId: "gcpvj0",
    ...over,
  };
}

async function expectHttps(
  run: () => Promise<unknown>,
  code: string,
  details?: unknown,
): Promise<HttpsError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof HttpsError, err instanceof Error ? err.message : String(err));
    assert.equal(err.code, code);
    if (details !== undefined) assert.deepEqual(err.details, details);
    else assert.notEqual((err.details as {reason?: string} | undefined)?.reason, SAVED_PLACES_LIMIT);
    return err;
  }
  assert.fail(`expected HttpsError ${code}`);
}

describe("saved parking validation", () => {
  const db = undefined as unknown as Firestore;

  it("pins the documented limits", () => {
    assert.equal(SAVED_PARKING_NAME_MAX, 120);
    assert.equal(SAVED_PARKING_CELL_ID_MAX, 64);
    assert.equal(SAVED_PARKING_LIMIT, 200);
    assert.equal(SAVED_PLACES_LIMIT, "SAVED_PLACES_LIMIT");
  });

  it("accepts the inclusive lat, lng, name, and cellId bounds", () => {
    const parsed = parseSaveParkingInput(input({
      name: "n".repeat(SAVED_PARKING_NAME_MAX),
      lat: -90,
      lng: 180,
      cellId: "c".repeat(SAVED_PARKING_CELL_ID_MAX),
    }));
    assert.equal(parsed.name.length, 120);
    assert.equal(parsed.lat, -90);
    assert.equal(parsed.lng, 180);
    assert.equal(parsed.cellId.length, 64);
    assert.deepEqual(parseSaveParkingInput(input({lat: 90, lng: -180})), {
      ...input(),
      lat: 90,
      lng: -180,
    });
  });

  it("rejects every limit and a bad type", async () => {
    await expectHttps(
      () => handleSaveParkingPlace(db, UID, input({name: "n".repeat(SAVED_PARKING_NAME_MAX + 1)})),
      "invalid-argument",
    );
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({lat: -90.0001})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({lat: 90.0001})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({lng: -180.0001})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({lng: 180.0001})), "invalid-argument");
    await expectHttps(
      () => handleSaveParkingPlace(db, UID, input({cellId: "c".repeat(SAVED_PARKING_CELL_ID_MAX + 1)})),
      "invalid-argument",
    );
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({lat: "51.5"})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({lng: null})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({name: 12})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({cellId: 6})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({placeId: ""})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, input({placeId: "a/b"})), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, UID, null), "invalid-argument");
    await expectHttps(() => handleSaveParkingPlace(db, undefined, input()), "unauthenticated");
    await expectHttps(() => handleUnsaveParkingPlace(db, undefined, {placeId: "a".repeat(64)}), "unauthenticated");
    await expectHttps(() => handleUnsaveParkingPlace(db, UID, {}), "invalid-argument");
  });
});

describe("saved parking transactions", () => {
  let db: Firestore;

  before(() => {
    db = testDb("demo-ferromaps-saved-parking-fn");
  });

  beforeEach(async () => {
    await db.recursiveDelete(db.collection("users"));
  });

  function place(uid: string, placeId: string) {
    return db.collection("users").doc(uid).collection("saved_parking").doc(placeId);
  }

  function counter(uid: string) {
    return db.collection("users").doc(uid).collection("meta").doc("savedParking");
  }

  async function seed(uid: string, count: number, withCounter: boolean): Promise<void> {
    let batch = db.batch();
    let pending = 0;
    for (let i = 0; i < count; i += 1) {
      batch.set(place(uid, `p${i}`), {
        savedAt: Timestamp.fromMillis(i + 1),
        name: "Seed",
        lat: 51.5,
        lng: -0.12,
        cellId: "gcpvj0",
      });
      pending += 1;
      if (pending === 400) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    if (withCounter) {
      batch.set(counter(uid), {count});
      pending += 1;
    }
    if (pending > 0) await batch.commit();
  }

  it("creates the doc, stamps savedAt, and counts one", async () => {
    const body = input({
      name: "n".repeat(SAVED_PARKING_NAME_MAX),
      lat: -90,
      lng: 180,
      cellId: "c".repeat(SAVED_PARKING_CELL_ID_MAX),
    });
    const saved = await handleSaveParkingPlace(db, UID, body);
    assert.deepEqual(saved, {ok: true, alreadySaved: false});
    const snap = await place(UID, body.placeId).get();
    assert.equal(snap.exists, true);
    const data = snap.data() ?? {};
    assert.deepEqual(Object.keys(data).sort(), ["cellId", "lat", "lng", "name", "savedAt"]);
    assert.ok(data.savedAt instanceof Timestamp);
    assert.equal(data.name, body.name);
    assert.equal(data.lat, -90);
    assert.equal(data.lng, 180);
    assert.equal(data.cellId, body.cellId);
    assert.equal((await counter(UID).get()).get("count"), 1);
  });

  it("is idempotent for save and unsave, and does not change a second save", async () => {
    const first = await handleSaveParkingPlace(db, UID, input({name: "First"}));
    const second = await handleSaveParkingPlace(db, UID, input({name: "Second", lat: 1, lng: 2, cellId: "other"}));
    assert.deepEqual(first, {ok: true, alreadySaved: false});
    assert.deepEqual(second, {ok: true, alreadySaved: true});
    assert.equal((await place(UID, input().placeId).get()).get("name"), "First");
    assert.equal((await counter(UID).get()).get("count"), 1);
    assert.deepEqual(await handleUnsaveParkingPlace(db, UID, {placeId: input().placeId}), {ok: true});
    assert.equal((await place(UID, input().placeId).get()).exists, false);
    assert.equal((await counter(UID).get()).get("count"), 0);
    assert.deepEqual(await handleUnsaveParkingPlace(db, UID, {placeId: input().placeId}), {ok: true});
    assert.equal((await counter(UID).get()).get("count"), 0);
    assert.equal((await place(UID, input().placeId).get()).exists, false);
  });

  it("leaves the count alone when the place was not saved, and never goes below 0", async () => {
    await counter(UID).set({count: 4});
    await handleUnsaveParkingPlace(db, UID, {placeId: "missing"});
    assert.equal((await counter(UID).get()).get("count"), 4);
    assert.equal((await db.collection("users").doc(UID).collection("meta").get()).size, 1);

    await place(UID, "orphan").set({
      savedAt: Timestamp.fromMillis(1),
      name: "Orphan",
      lat: 0,
      lng: 0,
      cellId: "gcpvj0",
    });
    await counter(UID).set({count: 0});
    await handleUnsaveParkingPlace(db, UID, {placeId: "orphan"});
    assert.equal((await place(UID, "orphan").get()).exists, false);
    assert.equal((await counter(UID).get()).get("count"), 0);
  });

  it("rebuilds a missing counter from count() and then applies the cap", async () => {
    await seed(UID, 2, false);
    const saved = await handleSaveParkingPlace(db, UID, input({placeId: "new"}));
    assert.deepEqual(saved, {ok: true, alreadySaved: false});
    assert.equal((await counter(UID).get()).get("count"), 3);
    assert.equal((await place(UID, "new").get()).exists, true);

    await db.recursiveDelete(db.collection("users"));
    await seed(UID, SAVED_PARKING_LIMIT, false);
    const err = await expectHttps(
      () => handleSaveParkingPlace(db, UID, input({placeId: "one-more"})),
      "resource-exhausted",
      {reason: SAVED_PLACES_LIMIT, limit: 200},
    );
    assert.equal(err.message, "Saved places limit reached");
    assert.equal((await counter(UID).get()).get("count"), 200);
    assert.equal((await place(UID, "one-more").get()).exists, false);
  });

  it("rejects the 201st save and still accepts an already-saved place at the cap", async () => {
    await seed(UID, SAVED_PARKING_LIMIT, true);
    const err = await expectHttps(
      () => handleSaveParkingPlace(db, UID, input({placeId: "one-more"})),
      "resource-exhausted",
      {reason: "SAVED_PLACES_LIMIT", limit: SAVED_PARKING_LIMIT},
    );
    assert.equal(err.code, "resource-exhausted");
    assert.equal((await place(UID, "one-more").get()).exists, false);
    assert.equal((await counter(UID).get()).get("count"), 200);
    const again = await handleSaveParkingPlace(db, UID, input({placeId: "p0", name: "Changed"}));
    assert.deepEqual(again, {ok: true, alreadySaved: true});
    assert.equal((await place(UID, "p0").get()).get("name"), "Seed");
    assert.equal((await counter(UID).get()).get("count"), 200);
  });

  it("does not write saved_hotspots", async () => {
    await handleSaveParkingPlace(db, UID, input());
    const hotspots = await db.collection("users").doc(UID).collection("saved_hotspots").get();
    assert.equal(hotspots.size, 0);
    await handleUnsaveParkingPlace(db, UID, {placeId: input().placeId});
    assert.equal((await db.collection("users").doc(UID).collection("saved_hotspots").get()).size, 0);
  });
});
