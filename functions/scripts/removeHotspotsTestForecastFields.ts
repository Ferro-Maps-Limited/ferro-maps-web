import {pathToFileURL} from "node:url";
import {FieldValue, type Firestore} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "../src/surge/collections.js";

/*
 * One-time removal of forecast fields from hotspots_test.
 * Dry run unless --apply is passed. Counts only. No prices. No document deletes.
 *
 * The pin keeps window_start, window_end, expire_at, removeBy, and surgeEnded.
 * Those are how the map shows and drops a pin. The forecast itself lives on
 * hotspot_forecasts.
 */
export const HOTSPOTS_TEST_FORECAST_FIELDS = [
  "forecast",
  "forecastHistory",
  "forecastSource",
  "forecastUpdatedAt",
] as const;

export interface ForecastFieldRemoval {
  scanned: number;
  changed: number;
  apply: boolean;
}

function hasForecastField(data: Record<string, unknown>): boolean {
  return HOTSPOTS_TEST_FORECAST_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(data, key));
}

export async function removeHotspotsTestForecastFields(
  db: Firestore,
  apply: boolean,
): Promise<ForecastFieldRemoval> {
  const snap = await db.collection(HOTSPOTS_COLLECTION).get();
  const patch: Record<string, FirebaseFirestore.FieldValue> = {};
  for (const key of HOTSPOTS_TEST_FORECAST_FIELDS) patch[key] = FieldValue.delete();
  let changed = 0;
  let batch = db.batch();
  let pending = 0;
  for (const doc of snap.docs) {
    if (!hasForecastField(doc.data())) continue;
    changed += 1;
    if (!apply) continue;
    batch.update(doc.ref, patch);
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (apply && pending > 0) await batch.commit();
  return {scanned: snap.size, changed, apply};
}

async function main(): Promise<void> {
  const {initializeApp} = await import("firebase-admin/app");
  const {getFirestore} = await import("firebase-admin/firestore");
  initializeApp();
  const apply = process.argv.includes("--apply");
  const result = await removeHotspotsTestForecastFields(getFirestore(), apply);
  console.log(JSON.stringify({
    apply: result.apply,
    scanned: result.scanned,
    changed: result.changed,
  }));
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((err: unknown) => {
    const name = err instanceof Error ? err.name : "Error";
    console.error(name);
    process.exitCode = 1;
  });
}
