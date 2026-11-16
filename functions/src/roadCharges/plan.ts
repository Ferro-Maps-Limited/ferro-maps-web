import {createHash} from "node:crypto";
import {type ChildRecord, type ChargeRecord, type RoadChargeDataset} from "./parseWorkbook.js";

export interface ExistingRoadDoc {
  path: string;
  contentHash?: string;
}

export interface RoadChargeSet {
  path: string;
  data: Record<string, unknown>;
}

export interface RoadChargePlan {
  sets: RoadChargeSet[];
  deletes: string[];
  unchanged: number;
}

export const MASS_DROP_RATIO = 0.9;

/* Stable hash of the published fields. `contentHash` itself is not an input. */
export function contentHash(fields: Record<string, unknown>): string {
  return createHash("sha256").update(stable(fields)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function countAbort(count: number, lastGood: number | null, label: string): string | null {
  if (lastGood == null) return null;
  if (count < lastGood * MASS_DROP_RATIO) return `${label}-count-dropped`;
  return null;
}

function hashed(path: string, fields: Record<string, unknown>): RoadChargeSet {
  return {path, data: {...fields, contentHash: contentHash(fields)}};
}

function chargePath(id: string): string {
  return `roadCharges/${id}`;
}

function pointPath(parentId: string, id: string): string {
  return `roadCharges/${parentId}/charge_points/${id}`;
}

function ratePath(parentId: string, id: string): string {
  return `roadCharges/${parentId}/rates/${id}`;
}

function desiredDocs(dataset: RoadChargeDataset): RoadChargeSet[] {
  const docs: RoadChargeSet[] = [];
  const addCharge = (charge: ChargeRecord) => docs.push(hashed(chargePath(charge.id), charge.fields));
  const addChild = (child: ChildRecord, path: string) => docs.push(hashed(path, child.fields));
  dataset.charges.forEach(addCharge);
  dataset.points.forEach((point) => addChild(point, pointPath(point.parentId, point.id)));
  dataset.rates.forEach((rate) => addChild(rate, ratePath(rate.parentId, rate.id)));
  return docs;
}

/*
 * Idempotent diff. A matching contentHash is left alone. Documents that are
 * no longer in the dataset are deleted, children before parents.
 */
export function planRoadChargeWrites(dataset: RoadChargeDataset, existing: ExistingRoadDoc[]): RoadChargePlan {
  const desired = desiredDocs(dataset);
  const previous = new Map(existing.map((doc) => [doc.path, doc.contentHash]));
  const sets: RoadChargeSet[] = [];
  let unchanged = 0;
  const keep = new Set<string>();
  for (const doc of desired) {
    keep.add(doc.path);
    if (previous.get(doc.path) === doc.data.contentHash) {
      unchanged += 1;
      continue;
    }
    sets.push(doc);
  }
  const deletes = existing
    .map((doc) => doc.path)
    .filter((path) => !keep.has(path))
    .sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  return {sets, deletes, unchanged};
}
