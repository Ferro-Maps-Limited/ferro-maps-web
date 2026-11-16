import {countAbort, planRoadChargeWrites, type ExistingRoadDoc, type RoadChargePlan} from "./plan.js";
import {parseRoadChargesWorkbook, sourceSha256} from "./parseWorkbook.js";

export interface RoadChargeConfigPatch {
  lastGoodDocCount?: number;
  lastGoodPointCount?: number;
  lastGoodRateCount?: number;
  lastGoodRunAt?: string;
  lastSourceSha256?: string;
  datasetVersion?: string | null;
  sourceFileId?: string;
  /* null clears lastAbortReason after a successful run. */
  lastAbortReason?: string | null;
}

export interface ImportOnceResult {
  status: "disabled" | "missing-params" | "aborted" | "ok";
  abortReason?: string;
  charges: number;
  points: number;
  rates: number;
  plan: RoadChargePlan;
  sourceSha256?: string;
  datasetVersion?: string | null;
  config: RoadChargeConfigPatch | null;
}

export interface RoadChargeRunInput {
  now: Date;
  enabled: boolean;
  fileId: string;
  lastGoodDocCount: number | null;
  lastGoodPointCount: number | null;
  lastGoodRateCount: number | null;
  existing: ExistingRoadDoc[];
  loadFile: (fileId: string) => Promise<Buffer>;
}

function emptyPlan(): RoadChargePlan {
  return {sets: [], deletes: [], unchanged: 0};
}

function idle(status: "disabled" | "missing-params"): ImportOnceResult {
  return {
    status,
    charges: 0,
    points: 0,
    rates: 0,
    plan: emptyPlan(),
    config: null,
  };
}

function aborted(reason: string, counts: {charges?: number; points?: number; rates?: number} = {}): ImportOnceResult {
  return {
    status: "aborted",
    abortReason: reason,
    charges: counts.charges ?? 0,
    points: counts.points ?? 0,
    rates: counts.rates ?? 0,
    plan: emptyPlan(),
    config: {lastAbortReason: reason},
  };
}

/*
 * Download and diff. Does not touch Firestore.
 * A short file aborts and returns no deletes, so a bad download cannot wipe
 * roadCharges. The first successful run has no previous counts.
 */
export async function importRoadChargesOnce(input: RoadChargeRunInput): Promise<ImportOnceResult> {
  if (!input.enabled) return idle("disabled");
  if (input.fileId.trim() === "") return idle("missing-params");
  let bytes: Buffer;
  try {
    bytes = await input.loadFile(input.fileId.trim());
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return aborted(`drive-read-error:${name}`);
  }
  const parsed = await parseRoadChargesWorkbook(bytes);
  if (!parsed.ok) return aborted(parsed.reason);
  const charges = parsed.dataset.charges.length;
  const points = parsed.dataset.points.length;
  const rates = parsed.dataset.rates.length;
  if (charges === 0) return aborted("charge-count-zero");
  const drop = countAbort(charges, input.lastGoodDocCount, "charge") ??
    countAbort(points, input.lastGoodPointCount, "point") ??
    countAbort(rates, input.lastGoodRateCount, "rate");
  if (drop) return aborted(drop, {charges, points, rates});
  const sha = sourceSha256(bytes);
  const plan = planRoadChargeWrites(parsed.dataset, input.existing);
  return {
    status: "ok",
    charges,
    points,
    rates,
    plan,
    sourceSha256: sha,
    datasetVersion: parsed.dataset.version,
    config: {
      lastGoodDocCount: charges,
      lastGoodPointCount: points,
      lastGoodRateCount: rates,
      lastGoodRunAt: input.now.toISOString(),
      lastSourceSha256: sha,
      datasetVersion: parsed.dataset.version,
      sourceFileId: input.fileId.trim(),
      lastAbortReason: null,
    },
  };
}
