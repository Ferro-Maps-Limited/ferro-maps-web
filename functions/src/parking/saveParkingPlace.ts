import * as logger from "firebase-functions/logger";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {FieldValue, getFirestore, type Firestore} from "firebase-admin/firestore";

/* Documented in the backend contract. The callable and the tests both use these. */
export const SAVED_PARKING_NAME_MAX = 120;
export const SAVED_PARKING_CELL_ID_MAX = 64;
export const SAVED_PARKING_LIMIT = 200;
export const SAVED_PLACES_LIMIT = "SAVED_PLACES_LIMIT";
const PLACE_ID_MAX = 128;

export interface SaveParkingInput {
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  cellId: string;
}

export interface SaveParkingResult {
  ok: true;
  alreadySaved: boolean;
}

export interface UnsaveParkingResult {
  ok: true;
}

function invalid(message: string): HttpsError {
  return new HttpsError("invalid-argument", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* The place id from privateParkingCells places[].id. A Firestore doc id, not a path. */
export function parsePlaceId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > PLACE_ID_MAX) {
    throw invalid("placeId must be a non-empty place id.");
  }
  if (value.includes("/") || value === "." || value === "..") {
    throw invalid("placeId must be a non-empty place id.");
  }
  return value;
}

export function parseSaveParkingInput(data: unknown): SaveParkingInput {
  if (!isRecord(data)) throw invalid("Save a place with placeId, name, lat, lng, and cellId.");
  const placeId = parsePlaceId(data.placeId);
  if (typeof data.name !== "string" || data.name.length > SAVED_PARKING_NAME_MAX) {
    throw invalid(`name must be a string of at most ${SAVED_PARKING_NAME_MAX} characters.`);
  }
  if (typeof data.lat !== "number" || !Number.isFinite(data.lat) || data.lat < -90 || data.lat > 90) {
    throw invalid("lat must be a number from -90 to 90.");
  }
  if (typeof data.lng !== "number" || !Number.isFinite(data.lng) || data.lng < -180 || data.lng > 180) {
    throw invalid("lng must be a number from -180 to 180.");
  }
  if (typeof data.cellId !== "string" || data.cellId.length > SAVED_PARKING_CELL_ID_MAX) {
    throw invalid(`cellId must be a string of at most ${SAVED_PARKING_CELL_ID_MAX} characters.`);
  }
  return {placeId, name: data.name, lat: data.lat, lng: data.lng, cellId: data.cellId};
}

function parseUnsaveInput(data: unknown): string {
  if (!isRecord(data)) throw invalid("Remove a place with placeId.");
  return parsePlaceId(data.placeId);
}

function storedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function placesOf(db: Firestore, uid: string) {
  return db.collection("users").doc(uid).collection("saved_parking");
}

function counterOf(db: Firestore, uid: string) {
  return db.collection("users").doc(uid).collection("meta").doc("savedParking");
}

function limitError(): HttpsError {
  return new HttpsError("resource-exhausted", "Saved places limit reached", {
    reason: SAVED_PLACES_LIMIT,
    limit: SAVED_PARKING_LIMIT,
  });
}

/*
 * Reads happen before writes. A missing counter is rebuilt with count() in
 * this same transaction, then the cap is applied. HttpsError is thrown only
 * after the transaction commits, so a limit rejection is not retried as a
 * transaction failure.
 */
export async function saveParkingPlaceForUser(
  db: Firestore,
  uid: string,
  input: SaveParkingInput,
): Promise<SaveParkingResult> {
  const places = placesOf(db, uid);
  const placeRef = places.doc(input.placeId);
  const counterRef = counterOf(db, uid);
  const outcome = await db.runTransaction(async (tx) => {
    const placeSnap = await tx.get(placeRef);
    if (placeSnap.exists) return "already" as const;
    const counterSnap = await tx.get(counterRef);
    const stored = counterSnap.exists ? storedCount(counterSnap.get("count")) : null;
    let count: number;
    let rebuilt = false;
    if (stored === null) {
      const aggregate = await tx.get(places.count());
      count = aggregate.data().count;
      rebuilt = true;
    } else {
      count = stored;
    }
    if (count >= SAVED_PARKING_LIMIT) {
      if (rebuilt) tx.set(counterRef, {count});
      return "limit" as const;
    }
    tx.set(placeRef, {
      savedAt: FieldValue.serverTimestamp(),
      name: input.name,
      lat: input.lat,
      lng: input.lng,
      cellId: input.cellId,
    });
    tx.set(counterRef, {count: count + 1});
    return "saved" as const;
  });
  if (outcome === "limit") {
    logger.info("saveParkingPlace limit", {uid, limit: SAVED_PARKING_LIMIT});
    throw limitError();
  }
  return {ok: true, alreadySaved: outcome === "already"};
}

export async function unsaveParkingPlaceForUser(
  db: Firestore,
  uid: string,
  placeId: string,
): Promise<UnsaveParkingResult> {
  const places = placesOf(db, uid);
  const placeRef = places.doc(placeId);
  const counterRef = counterOf(db, uid);
  await db.runTransaction(async (tx) => {
    const placeSnap = await tx.get(placeRef);
    if (!placeSnap.exists) return;
    const counterSnap = await tx.get(counterRef);
    const stored = counterSnap.exists ? storedCount(counterSnap.get("count")) : null;
    const count = stored === null ? (await tx.get(places.count())).data().count : stored;
    tx.delete(placeRef);
    tx.set(counterRef, {count: Math.max(0, count - 1)});
  });
  return {ok: true};
}

export async function handleSaveParkingPlace(
  db: Firestore,
  uid: string | undefined,
  data: unknown,
): Promise<SaveParkingResult> {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to save a place.");
  return saveParkingPlaceForUser(db, uid, parseSaveParkingInput(data));
}

export async function handleUnsaveParkingPlace(
  db: Firestore,
  uid: string | undefined,
  data: unknown,
): Promise<UnsaveParkingResult> {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to remove a saved place.");
  return unsaveParkingPlaceForUser(db, uid, parseUnsaveInput(data));
}

const callableOptions = {region: "europe-west2" as const, timeoutSeconds: 60, memory: "256MiB" as const};

export const saveParkingPlace = onCall(callableOptions, async (request) => {
  return handleSaveParkingPlace(getFirestore(), request.auth?.uid, request.data);
});

export const unsaveParkingPlace = onCall(callableOptions, async (request) => {
  return handleUnsaveParkingPlace(getFirestore(), request.auth?.uid, request.data);
});
