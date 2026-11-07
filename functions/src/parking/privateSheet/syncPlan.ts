import {createHash} from "node:crypto";
import {buildImport, CELL_TTL_MS} from "./build.js";
import {coordinateSkip} from "./mapping.js";
import {desiredPlaceIndex, type DesiredPlaceIndex} from "./placeIndex.js";
import {stampCells} from "./payMode.js";
import {rowsFromMatrix} from "./rows.js";
import {type PrivatePlace} from "./types.js";

export {CELL_TTL_MS};
/* Rewrite a live cell once fewer than 7 days remain before expiresAt. */
export const MIN_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;
/* Abort when the usable count is strictly more than 10% under the last good run. */
export const MASS_DROP_RATIO = 0.9;
export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export const REQUIRED_HEADERS = [
  "Location Name",
  "Latitude",
  "Longitude",
  "Postcode",
  "Location Status",
  "Evidence Type",
] as const;

export interface ExistingCellDoc {
  id: string;
  cell?: string;
  contentHash?: string;
  expiresAtMs?: number;
}

export interface PlannedCellWrite {
  id: string;
  action: "upsert" | "refresh" | "expire";
  data: {
    v: 1;
    cell: string;
    places: PrivatePlace[];
    generatedAt: string;
    expiresAt: string;
    contentHash: string;
    shards?: number;
  };
}

export function cellContentHash(input: {cell: string; shards?: number; places: PrivatePlace[]}): string {
  const body = {
    v: 1,
    cell: input.cell,
    shards: input.shards ?? null,
    places: [...input.places].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function baseCellId(id: string, cell: string | undefined): string {
  if (cell && cell.length > 0) return cell;
  const shard = /^(.*)_\d+$/.exec(id);
  return shard?.[1] ?? id;
}

export function planPrivateParkingWrites(input: {
  now: Date;
  desired: Array<{id: string; cell: string; places: PrivatePlace[]; shards?: number}>;
  existing: ExistingCellDoc[];
}): {writes: PlannedCellWrite[]; unchanged: number; expired: number} {
  const nowMs = input.now.getTime();
  const generatedAt = input.now.toISOString();
  const expiresAt = new Date(nowMs + CELL_TTL_MS).toISOString();
  const past = new Date(nowMs - 1000).toISOString();
  const desiredIds = new Set(input.desired.map((doc) => doc.id));
  const writes: PlannedCellWrite[] = [];
  let unchanged = 0;

  for (const doc of input.desired) {
    const contentHash = cellContentHash(doc);
    const prev = input.existing.find((item) => item.id === doc.id);
    const remaining = prev?.expiresAtMs == null ? -1 : prev.expiresAtMs - nowMs;
    const stillLive = remaining >= MIN_REMAINING_MS;
    if (prev?.contentHash === contentHash && stillLive) {
      unchanged += 1;
      continue;
    }
    writes.push({
      id: doc.id,
      action: prev?.contentHash === contentHash ? "refresh" : "upsert",
      data: {
        v: 1,
        cell: doc.cell,
        places: doc.places,
        generatedAt,
        expiresAt,
        contentHash,
        ...(doc.shards != null ? {shards: doc.shards} : {}),
      },
    });
  }

  let expired = 0;
  for (const prev of input.existing) {
    if (desiredIds.has(prev.id)) continue;
    const cell = baseCellId(prev.id, prev.cell);
    const contentHash = cellContentHash({cell, places: []});
    const alreadyHidden = prev.contentHash === contentHash &&
      prev.expiresAtMs != null &&
      prev.expiresAtMs <= nowMs;
    if (alreadyHidden) continue;
    expired += 1;
    writes.push({
      id: prev.id,
      action: "expire",
      data: {
        v: 1,
        cell,
        places: [],
        generatedAt,
        expiresAt: past,
        contentHash,
      },
    });
  }

  return {writes, unchanged, expired};
}

export interface SheetLoader {
  (sheetId: string, tab: string): Promise<unknown[][]>;
}

export interface SyncConfigPatch {
  lastGoodRowCount?: number;
  lastGoodRunAt?: string;
  /* null clears lastAbortReason after a successful run. */
  lastAbortReason?: string | null;
}

export interface SyncOnceResult {
  status: "disabled" | "missing-params" | "aborted" | "ok";
  abortReason?: string;
  usableRows: number;
  writes: PlannedCellWrite[];
  unchanged: number;
  expired: number;
  imported: number;
  /* Live places after a successful sheet. Empty unless status is ok. */
  indexedPlaces: DesiredPlaceIndex[];
  config: SyncConfigPatch | null;
}

function headerName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function headerAbortReason(matrix: unknown[][]): string | null {
  const headerRow = matrix[0];
  if (!headerRow || headerRow.length === 0) return "header-missing";
  const names = headerRow.map(headerName);
  if (names.every((name) => name === "")) return "header-missing";
  const missing = REQUIRED_HEADERS.filter((name) => !names.includes(name));
  return missing.length > 0 ? "header-unexpected" : null;
}

export function usableRowCount(matrix: unknown[][]): number {
  return rowsFromMatrix(matrix).filter((row) => {
    return !row.blank && !coordinateSkip(row.values.Latitude, row.values.Longitude);
  }).length;
}

export function rowCountAbortReason(usableRows: number, lastGoodRowCount: number | null): string | null {
  if (usableRows === 0) return "usable-row-count-zero";
  if (lastGoodRowCount == null) return null;
  if (usableRows < lastGoodRowCount * MASS_DROP_RATIO) return "usable-row-count-dropped";
  return null;
}

/*
 * Map the sheet and decide writes. Does not touch Firestore or the network.
 * `loadSheet` is called only when the job is enabled and both params are set.
 */
function idle(status: "disabled" | "missing-params"): SyncOnceResult {
  return {
    status,
    usableRows: 0,
    writes: [],
    unchanged: 0,
    expired: 0,
    imported: 0,
    indexedPlaces: [],
    config: null,
  };
}

function aborted(reason: string, usableRows = 0): SyncOnceResult {
  return {
    status: "aborted",
    abortReason: reason,
    usableRows,
    writes: [],
    unchanged: 0,
    expired: 0,
    imported: 0,
    indexedPlaces: [],
    config: {lastAbortReason: reason},
  };
}

export async function syncPrivateParkingOnce(input: {
  now: Date;
  enabled: boolean;
  sheetId: string;
  tab: string;
  lastGoodRowCount: number | null;
  existing: ExistingCellDoc[];
  loadSheet: SheetLoader;
  /* Called only after the sheet is accepted. Omitted means every place is handoff. */
  loadInAppPlaceIds?: () => Promise<ReadonlySet<string>>;
}): Promise<SyncOnceResult> {
  if (!input.enabled) return idle("disabled");
  if (input.sheetId.trim() === "" || input.tab.trim() === "") return idle("missing-params");
  let matrix: unknown[][];
  try {
    matrix = await input.loadSheet(input.sheetId, input.tab);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return aborted(`sheets-read-error:${name}`);
  }
  const header = headerAbortReason(matrix);
  if (header) return aborted(header);
  const usableRows = usableRowCount(matrix);
  const drop = rowCountAbortReason(usableRows, input.lastGoodRowCount);
  if (drop) return aborted(drop, usableRows);
  const inAppPlaceIds = input.loadInAppPlaceIds ? await input.loadInAppPlaceIds() : new Set<string>();
  const build = buildImport(rowsFromMatrix(matrix), input.now);
  const cells = stampCells(build.cells, inAppPlaceIds);
  const desired = cells.map((doc) => ({
    id: doc.id,
    cell: doc.data.cell,
    places: doc.data.places,
    shards: doc.data.shards,
  }));
  const plan = planPrivateParkingWrites({now: input.now, desired, existing: input.existing});
  return {
    status: "ok",
    usableRows,
    writes: plan.writes,
    unchanged: plan.unchanged,
    expired: plan.expired,
    imported: build.imported.length,
    indexedPlaces: desiredPlaceIndex(cells),
    config: {
      lastGoodRowCount: usableRows,
      lastGoodRunAt: input.now.toISOString(),
      lastAbortReason: null,
    },
  };
}
