import {Firestore, GeoPoint} from "firebase-admin/firestore";
import {PinDraft, staticDraftFromRow, SourceMaps, activeMembers} from "./drafts";
import {splitTiles} from "./splitTile";
import {formatTileReport, tileReport} from "./tileReport";
import {publishPins} from "./publishPins";

export interface SeedPlan {
  drafts: PinDraft[];
  errors: string[];
  report: string;
  tilesOver500: number;
  rawOver: string[];
}

export function planStaticSeed(rows: SourceMaps[], now: Date, live: PinDraft[] | null = null): SeedPlan {
  const drafts: PinDraft[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const built = staticDraftFromRow(row, now);
    if (built.error || !built.draft) {
      errors.push(built.error ?? "skipped");
      continue;
    }
    drafts.push(built.draft);
  }
  const visible = activeMembers([...drafts, ...(live ?? [])], now);
  const split = splitTiles(visible);
  const counted = tileReport(visible, split, live !== null);
  return {
    drafts,
    errors,
    report: formatTileReport(counted.lines, counted.tilesOver500, live !== null),
    tilesOver500: counted.tilesOver500,
    rawOver: split.rawOver,
  };
}

export function loadRows(parsed: unknown): SourceMaps[] {
  if (Array.isArray(parsed)) return parsed as SourceMaps[];
  const row = parsed as {pins?: unknown};
  if (Array.isArray(row?.pins)) return row.pins as SourceMaps[];
  throw new Error("input must be a JSON array or {pins: [...]}");
}

/**
 * Upsert static pins, then run the same publisher as the daily job.
 * @param {Firestore} db emulator database.
 * @param {SourceMaps[]} rows fixed hotspot records.
 * @param {Date} now clock.
 * @return {Promise<SeedPlan>} the dry-run plan that was written.
 */
export async function applyStaticSeed(db: Firestore, rows: SourceMaps[], now: Date): Promise<SeedPlan> {
  const plan = planStaticSeed(rows, now);
  const batchSize = 400;
  for (let i = 0; i < plan.drafts.length; i += batchSize) {
    const batch = db.batch();
    for (const draft of plan.drafts.slice(i, i + batchSize)) {
      batch.set(db.collection("pins").doc(draft.id), {
        v: 1,
        category: draft.category,
        title: draft.title,
        src: "static",
        g5: draft.g5,
        p: new GeoPoint(draft.lat, draft.lng),
        ...(draft.city ? {city: draft.city} : {}),
        ...(draft.country ? {country: draft.country} : {}),
        ...(draft.events ? {events: draft.events} : {}),
      }, {merge: true});
    }
    await batch.commit();
  }
  await publishPins(db, now);
  return plan;
}

export function parseSeedArgs(argv: string[]): {write: boolean, project: string, input: string} {
  const args = {write: false, project: "", input: ""};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--write") args.write = true;
    else if (token === "--project") args.project = argv[i + 1] || "";
    else if (token.startsWith("--project=")) args.project = token.slice("--project=".length);
    else if (token === "--input") args.input = argv[i + 1] || "";
    else if (token.startsWith("--input=")) args.input = token.slice("--input=".length);
  }
  return args;
}

export function canReadLive(project: string): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST) && project.startsWith("demo-");
}

export function assertCanWrite(project: string): void {
  if (!canReadLive(project)) {
    throw new Error(
      "Refusing to write. Set FIRESTORE_EMULATOR_HOST and pass a demo- project. This script does not touch a real project.",
    );
  }
}
