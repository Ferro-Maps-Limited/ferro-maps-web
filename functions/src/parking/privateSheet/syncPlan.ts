import {createHash} from "node:crypto";
import {buildImport} from "./build.js";
import {rowsFromMatrix} from "./rows.js";
import {type PrivatePlace} from "./types.js";

export const CELL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/* Refresh a stable cell only when its contract lifetime is about to lapse. */
export const EXPIRY_REFRESH_WITHIN_MS = 2 * 60 * 60 * 1000;
export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

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
    const stillLive = prev?.expiresAtMs != null && prev.expiresAtMs - nowMs > EXPIRY_REFRESH_WITHIN_MS;
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

export interface SyncOnceResult {
  status: "disabled" | "missing-params" | "ok";
  writes: PlannedCellWrite[];
  unchanged: number;
  expired: number;
  imported: number;
}

/*
 * Map the sheet and decide writes. Does not touch Firestore or the network.
 * `loadSheet` is called only when the job is enabled and both params are set.
 */
export async function syncPrivateParkingOnce(input: {
  now: Date;
  enabled: boolean;
  sheetId: string;
  tab: string;
  existing: ExistingCellDoc[];
  loadSheet: SheetLoader;
}): Promise<SyncOnceResult> {
  if (!input.enabled) {
    return {status: "disabled", writes: [], unchanged: 0, expired: 0, imported: 0};
  }
  if (input.sheetId.trim() === "" || input.tab.trim() === "") {
    return {status: "missing-params", writes: [], unchanged: 0, expired: 0, imported: 0};
  }
  const matrix = await input.loadSheet(input.sheetId, input.tab);
  const build = buildImport(rowsFromMatrix(matrix), input.now);
  const desired = build.cells.map((doc) => ({
    id: doc.id,
    cell: doc.data.cell,
    places: doc.data.places,
    shards: doc.data.shards,
  }));
  const plan = planPrivateParkingWrites({now: input.now, desired, existing: input.existing});
  return {
    status: "ok",
    writes: plan.writes,
    unchanged: plan.unchanged,
    expired: plan.expired,
    imported: build.imported.length,
  };
}
