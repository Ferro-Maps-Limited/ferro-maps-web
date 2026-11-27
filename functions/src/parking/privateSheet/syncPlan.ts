import {createHash} from "node:crypto";
import {buildImport, CELL_TTL_MS, packCell} from "./build.js";
import {
  buildFmppPlaces,
  fmppHeaderProblem,
  parseFmppSources,
  type FmppSource,
} from "./fmpp.js";
import {geohash} from "./geohash.js";
import {coordinateSkip} from "./mapping.js";
import {rowsFromMatrix} from "./rows.js";
import {canonicalPlace, runTowns, type TownRunInput, type TownSnapshot, type TownSummary} from "./towns.js";
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

/* Hash of v, cell, shards, and the full place objects. Optional payMode is included when it is set. */
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
  /* City code to the last publishable FM-PP count. Absent on a London-only run. */
  fmppLastGoodCounts?: Record<string, number>;
  /* Snapshot keys from the last good town folder listing. */
  townsListedKeys?: string[];
  townsLastRun?: TownSummary;
}

export interface SyncOnceResult {
  status: "disabled" | "missing-params" | "aborted" | "ok";
  abortReason?: string;
  usableRows: number;
  writes: PlannedCellWrite[];
  unchanged: number;
  expired: number;
  imported: number;
  config: SyncConfigPatch | null;
  /* Town snapshots to store. Present only on a town folder run. */
  townSnapshots?: TownSnapshot[];
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

/* London ids are a sha256 hex or `PP-######`. City ids are `FERRO-<CODE>-...`. */
export function londonPlaceId(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id) || /^PP-\d{4,}$/i.test(id);
}

export function cityPlaceId(id: string): boolean {
  return /^FERRO-[A-Z0-9]+(?:-[A-Z0-9]+)+$/i.test(id);
}

/* True when two sources share an id, or either id sits in the other namespace. */
export function placeIdsCollide(groups: readonly (readonly string[])[]): boolean {
  const seen = new Map<string, number>();
  for (let group = 0; group < groups.length; group += 1) {
    const local = new Set<string>();
    for (const id of groups[group] ?? []) {
      if (group === 0) {
        if (cityPlaceId(id)) return true;
      } else if (londonPlaceId(id) || !cityPlaceId(id)) {
        return true;
      }
      const previous = seen.get(id);
      if ((previous != null && previous !== group) || local.has(id)) return true;
      local.add(id);
      seen.set(id, group);
    }
  }
  return false;
}

/* A live cell as stored: its places and when it stops showing. */
export interface StoredCell {
  places?: unknown;
  expiresAtMs?: number;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value != null && typeof (value as {toDate?: unknown}).toDate === "function") {
    return (value as {toDate: () => Date}).toDate().toISOString();
  }
  return undefined;
}

/*
 * London's places as the live cells hold them now, for a run that doesn't read
 * the London sheet (config/privateParking.londonPaused). Town places stay out.
 * Firestore timestamps go back to the ISO strings the cells are built from, and
 * fields go in name order, so an unchanged place keeps its cell hash.
 */
export function londonPlacesFromCells(cells: readonly StoredCell[], nowMs: number): PrivatePlace[] {
  const byId = new Map<string, PrivatePlace>();
  for (const cell of cells) {
    if (cell.expiresAtMs == null || cell.expiresAtMs <= nowMs || !Array.isArray(cell.places)) continue;
    for (const raw of cell.places) {
      if (raw == null || typeof raw !== "object") continue;
      const record = {...(raw as Record<string, unknown>)};
      if (typeof record.id !== "string" || !londonPlaceId(record.id) || byId.has(record.id)) continue;
      for (const key of ["capturedAt", "verifiedAt"]) {
        if (record[key] === undefined) continue;
        const iso = isoTime(record[key]);
        if (iso === undefined) delete record[key];
        else record[key] = iso;
      }
      byId.set(record.id, canonicalPlace(record as unknown as PrivatePlace));
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface DesiredPrivateCell {
  id: string;
  cell: string;
  places: PrivatePlace[];
  shards?: number;
}

/* Pack London and every city into the same geohash cells. Does not drop either side. */
export function mergePrivateParkingPlaces(input: {
  now: Date;
  london: PrivatePlace[];
  cities: Array<{code: string; places: PrivatePlace[]}>;
}): {ok: true; desired: DesiredPrivateCell[]} | {ok: false; reason: string} {
  const groups = [
    input.london.map((place) => place.id),
    ...input.cities.map((city) => city.places.map((place) => place.id)),
  ];
  if (placeIdsCollide(groups)) return {ok: false, reason: "fmpp-id-collision"};
  const generatedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + CELL_TTL_MS).toISOString();
  const byCell = new Map<string, PrivatePlace[]>();
  const places = [...input.london, ...input.cities.flatMap((city) => city.places)];
  for (const place of places) {
    const cell = geohash(place.p[0], place.p[1], 6);
    const list = byCell.get(cell) ?? [];
    list.push(place);
    byCell.set(cell, list);
  }
  const desired: DesiredPrivateCell[] = [];
  for (const cellId of [...byCell.keys()].sort()) {
    const packed = packCell(cellId, byCell.get(cellId) ?? [], generatedAt, expiresAt);
    for (const doc of packed.docs) {
      desired.push({
        id: doc.id,
        cell: doc.data.cell,
        places: doc.data.places,
        shards: doc.data.shards,
      });
    }
  }
  return {ok: true, desired};
}

function errorName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "Error";
}

async function loadFmppCity(
  source: FmppSource,
  loadSheet: SheetLoader,
  lastGood: number | null,
): Promise<{ok: true; places: PrivatePlace[]; count: number} | {ok: false; reason: string}> {
  let locations: unknown[][];
  try {
    locations = await loadSheet(source.sheetId, source.locationsTab);
  } catch (err) {
    return {ok: false, reason: `fmpp-sheets-read-error:${source.code}:locations:${errorName(err)}`};
  }
  if (fmppHeaderProblem("locations", locations[0])) {
    return {ok: false, reason: `fmpp-header-unexpected:${source.code}:locations`};
  }
  let tariffs: unknown[][];
  try {
    tariffs = await loadSheet(source.sheetId, source.tariffsTab);
  } catch (err) {
    return {ok: false, reason: `fmpp-sheets-read-error:${source.code}:tariffs:${errorName(err)}`};
  }
  if (fmppHeaderProblem("tariffs", tariffs[0])) {
    return {ok: false, reason: `fmpp-header-unexpected:${source.code}:tariffs`};
  }
  const built = buildFmppPlaces(source, locations, tariffs);
  if (!built.ok) return built;
  const drop = rowCountAbortReason(built.places.length, lastGood);
  if (drop === "usable-row-count-zero") return {ok: false, reason: `fmpp-publishable-zero:${source.code}`};
  if (drop === "usable-row-count-dropped") {
    return {ok: false, reason: `fmpp-publishable-dropped:${source.code}`};
  }
  return {ok: true, places: built.places, count: built.places.length};
}

/*
 * Map the sheet and decide writes. Does not touch Firestore or the network.
 * `loadSheet` is called only when the job is enabled and both London params are set.
 * An empty `fmppSources` keeps the London-only path.
 */
function idle(status: "disabled" | "missing-params"): SyncOnceResult {
  return {
    status,
    usableRows: 0,
    writes: [],
    unchanged: 0,
    expired: 0,
    imported: 0,
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
  /* Empty or omitted: London only, same writes as before city workbooks. */
  fmppSources?: string;
  fmppLastGoodCounts?: Record<string, number> | null;
  /* Town folder workbooks. When present, fmppSources is not read. */
  towns?: Omit<TownRunInput, "nowMs">;
  /*
   * London paused: these are London's places as the live cells hold them
   * (londonPlacesFromCells). The London sheet isn't read, and London is
   * republished exactly as it is. Towns still sync.
   */
  pausedLondon?: PrivatePlace[];
}): Promise<SyncOnceResult> {
  if (!input.enabled) return idle("disabled");
  if (input.sheetId.trim() === "" || input.tab.trim() === "") return idle("missing-params");
  const parsed = input.towns ? {ok: true as const, sources: []} : parseFmppSources(input.fmppSources ?? "");
  if (!parsed.ok) return aborted(parsed.reason);
  if (input.pausedLondon) return syncPausedLondon(input, input.pausedLondon);
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
  const build = buildImport(rowsFromMatrix(matrix), input.now);
  if (input.towns) {
    const london = build.imported.map((row) => row.place);
    return syncWithTowns(input.now, input.existing, input.towns, london, usableRows);
  }
  if (parsed.sources.length === 0) {
    const desired = build.cells.map((doc) => ({
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
      config: {
        lastGoodRowCount: usableRows,
        lastGoodRunAt: input.now.toISOString(),
        lastAbortReason: null,
      },
    };
  }
  const cities: Array<{code: string; places: PrivatePlace[]}> = [];
  const counts: Record<string, number> = {...(input.fmppLastGoodCounts ?? {})};
  for (const source of parsed.sources) {
    const previous = input.fmppLastGoodCounts?.[source.code];
    const lastGood = typeof previous === "number" ? previous : null;
    const loaded = await loadFmppCity(source, input.loadSheet, lastGood);
    if (!loaded.ok) return aborted(loaded.reason, usableRows);
    cities.push({code: source.code, places: loaded.places});
    counts[source.code] = loaded.count;
  }
  const merged = mergePrivateParkingPlaces({
    now: input.now,
    london: build.imported.map((row) => row.place),
    cities,
  });
  if (!merged.ok) return aborted(merged.reason, usableRows);
  const plan = planPrivateParkingWrites({
    now: input.now,
    desired: merged.desired,
    existing: input.existing,
  });
  const imported = build.imported.length + cities.reduce((sum, city) => sum + city.places.length, 0);
  return {
    status: "ok",
    usableRows,
    writes: plan.writes,
    unchanged: plan.unchanged,
    expired: plan.expired,
    imported,
    config: {
      lastGoodRowCount: usableRows,
      lastGoodRunAt: input.now.toISOString(),
      lastAbortReason: null,
      fmppLastGoodCounts: counts,
    },
  };
}

/*
 * London paused. Nothing is read from the London sheet and its last good row
 * count is kept for when it is unpaused. With no London places in the cells
 * the run stops, so a pause never empties London.
 */
async function syncPausedLondon(
  input: Parameters<typeof syncPrivateParkingOnce>[0],
  london: PrivatePlace[],
): Promise<SyncOnceResult> {
  if (london.length === 0) return aborted("london-paused-no-places");
  if (input.towns) return syncWithTowns(input.now, input.existing, input.towns, london, 0, true);
  const merged = mergePrivateParkingPlaces({now: input.now, london, cities: []});
  if (!merged.ok) return aborted(merged.reason);
  const plan = planPrivateParkingWrites({now: input.now, desired: merged.desired, existing: input.existing});
  return {
    status: "ok",
    usableRows: 0,
    writes: plan.writes,
    unchanged: plan.unchanged,
    expired: plan.expired,
    imported: london.length,
    config: {lastGoodRunAt: input.now.toISOString(), lastAbortReason: null},
  };
}

/*
 * London plus every town in the folder. A town problem never aborts the run.
 * London's checks have already passed when this runs, or London is paused.
 */
async function syncWithTowns(
  now: Date,
  existing: ExistingCellDoc[],
  towns: Omit<TownRunInput, "nowMs">,
  london: PrivatePlace[],
  usableRows: number,
  londonPaused = false,
): Promise<SyncOnceResult> {
  const run = await runTowns({...towns, nowMs: now.getTime()});
  // Name order, like the towns, so a paused run (places read back from the
  // cells) and a sheet run give the same cell hash for an unchanged place.
  const ordered = london.map(canonicalPlace);
  const merged = mergePrivateParkingPlaces({now, london: ordered, cities: [{code: "TOWNS", places: run.places}]});
  if (!merged.ok) return {...aborted(merged.reason, usableRows), townSnapshots: run.changed};
  const plan = planPrivateParkingWrites({now, desired: merged.desired, existing});
  return {
    status: "ok",
    usableRows,
    writes: plan.writes,
    unchanged: plan.unchanged,
    expired: plan.expired,
    imported: ordered.length + run.places.length,
    config: {
      ...(londonPaused ? {} : {lastGoodRowCount: usableRows}),
      lastGoodRunAt: now.toISOString(),
      lastAbortReason: null,
      ...(run.listedKeys ? {townsListedKeys: run.listedKeys} : {}),
      townsLastRun: run.summary,
    },
    townSnapshots: run.changed,
  };
}
