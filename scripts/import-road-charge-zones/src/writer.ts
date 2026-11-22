import {assertNoMoney, assertZone, type RoadChargeZone} from "./types.ts";

export const COLLECTION = "road_charge_zones";

/** Separate switch for the optional OpenStreetMap gates. Off unless passed. */
export const OSM_GATES_FLAG = "--include-osm-gates";

export interface WriteTarget {
  emulatorHost: string;
  projectId: string;
}

/**
 * A write is allowed only when FIRESTORE_EMULATOR_HOST is set and the
 * project id starts with demo-. The emulator accepts that prefix, and a
 * real Firebase project cannot use it.
 */
export function assertEmulatorOnly(target: WriteTarget): void {
  if (!target.emulatorHost.trim()) {
    throw new Error("refusing to write: FIRESTORE_EMULATOR_HOST is not set. Nothing was written.");
  }
  if (!target.projectId.startsWith("demo-")) {
    throw new Error("refusing to write: project id must start with demo- when writing to the emulator. Nothing was written.");
  }
}

export interface ZoneDocument {
  id: string;
  data: {
    id: string;
    name: string;
    kind: string;
    geometry: string;
    sourceUrl: string;
    licence: string;
    attribution: string;
    fetchedAt: string;
  };
}

/**
 * Firestore cannot store a nested array, and a GeoJSON polygon is one.
 * geometry is the GeoJSON geometry as a string. Every other field is a
 * string too, so a charge amount has nowhere to go.
 */
export function zoneDocuments(zones: RoadChargeZone[]): ZoneDocument[] {
  return zones.map((zone) => {
    assertZone(zone);
    const geometry = JSON.stringify(zone.geometry);
    const parsed = JSON.parse(geometry) as {type?: string};
    if (parsed.type !== zone.geometry.type) throw new Error(`geometry for ${zone.id} did not round-trip`);
    const data: ZoneDocument["data"] = {
      id: zone.id,
      name: zone.name,
      kind: zone.kind,
      geometry,
      sourceUrl: zone.sourceUrl,
      licence: zone.licence,
      attribution: zone.attribution,
      fetchedAt: zone.fetchedAt,
    };
    const keys = Object.keys(data).sort().join();
    if (keys !== "attribution,fetchedAt,geometry,id,kind,licence,name,sourceUrl") {
      throw new Error(`document ${zone.id} has unexpected fields`);
    }
    for (const value of Object.values(data)) {
      if (typeof value !== "string") throw new Error(`document ${zone.id} is not all strings`);
    }
    assertNoMoney(data);
    return {id: zone.id, data};
  });
}

interface FirestoreBatch {
  set: (ref: unknown, data: ZoneDocument["data"]) => void;
  commit: () => Promise<void>;
}

interface FirestoreDb {
  batch: () => FirestoreBatch;
  collection: (name: string) => {doc: (id: string) => unknown};
}

async function loadSdk(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

/**
 * Write zone documents. Calls assertEmulatorOnly before loading the SDK,
 * so a refused run does not open a client. firebase-admin is imported only
 * here, and only after the check passes.
 */
export async function writeToEmulator(
  projectId: string,
  zones: RoadChargeZone[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  assertEmulatorOnly({
    emulatorHost: env.FIRESTORE_EMULATOR_HOST ?? "",
    projectId,
  });
  const docs = zoneDocuments(zones);
  const app = await loadSdk("firebase-admin/app") as {
    getApps: () => unknown[];
    initializeApp: (options: {projectId: string}) => unknown;
  };
  const firestore = await loadSdk("firebase-admin/firestore") as {
    getFirestore: (application: unknown) => FirestoreDb;
  };
  const application = app.getApps()[0] ?? app.initializeApp({projectId});
  const db = firestore.getFirestore(application);
  let batch = db.batch();
  let pending = 0;
  for (const doc of docs) {
    batch.set(db.collection(COLLECTION).doc(doc.id), doc.data);
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
}
