import {createHash} from "node:crypto";
import {CELL_TTL_MS} from "./build.js";
import {buildFmppPlaces, fmppHeaderProblem, type FmppSource} from "./fmpp.js";
import {text} from "./mapping.js";
import {rowsFromMatrix} from "./rows.js";
import {type PrivatePlace} from "./types.js";

/*
 * FM-PP town workbooks found in one Drive folder.
 *
 * Every spreadsheet in the folder is one town. Its name is `FM-PP <Town>`
 * (any dash) or `Ferro Parking Locations - <Town>`, and its tabs are
 * `Locations - <Town>` and `Tariffs - <Town>`, with the FM-PP headers.
 * London is skipped: the London workbook already publishes it.
 *
 * The town code is the one most rows use in `FERRO-<CODE>-...`. Each town's
 * last good places are kept in privateParkingTowns/{key}. A town that fails
 * to read, changes its headers, or drops by more than 10% keeps its last good
 * places, and London and the other towns still update. A drop that is still
 * there after TOWN_DROP_GRACE_MS is accepted. The key is a hash of the
 * spreadsheet id. Spreadsheet ids are never stored or logged.
 */

export const TOWN_NAME_PATTERNS = [
  /^FM\s*[-‐‑–—]\s*PP\s+(.+)$/i,
  /^Ferro Parking Locations\s*[-‐‑–—]\s*(.+)$/i,
];
/* Towns another workbook already publishes. Compared case-insensitively. */
export const SKIPPED_TOWNS = new Set(["london"]);
/* Sheets allows 60 reads a minute for the sync account. One town is one read. */
export const TOWN_READS_PER_RUN = 150;
export const TOWN_DROP_RATIO = 0.9;
export const TOWN_DROP_GRACE_MS = 6 * 60 * 60 * 1000;
/* Copies of one Location ID closer than this are the same car park. */
export const TOWN_SAME_SPOT_METRES = 100;
/* A Firestore document is at most 1 MiB. */
export const TOWN_SNAPSHOT_MAX_BYTES = 900_000;
/* Fewer listed workbooks than this share of the last listing is a bad listing. */
export const TOWN_LIST_DROP_RATIO = 0.9;

export interface DriveFile {
  id: string;
  name: string;
}

export interface TownSource {
  key: string;
  sheetId: string;
  town: string;
  locationsTab: string;
  tariffsTab: string;
}

export interface TownSnapshot {
  key: string;
  town: string;
  code?: string;
  places: PrivatePlace[];
  count: number;
  readAtMs?: number;
  goodAtMs?: number;
  error?: string;
  dropCount?: number;
  dropSinceMs?: number;
}

/* `stop` ends this run's reads, for example when Sheets says slow down. */
export type TownRead =
  | {ok: true; locations: unknown[][]; tariffs: unknown[][]}
  | {ok: false; reason: string; stop?: boolean};

export type TownLoader = (source: TownSource) => Promise<TownRead>;

export interface TownRunInput {
  nowMs: number;
  /* null when the folder could not be listed. */
  sources: TownSource[] | null;
  /* Keys from the last good listing. null before the first one. */
  lastListedKeys: string[] | null;
  snapshots: TownSnapshot[];
  loadTown: TownLoader;
  maxReads?: number;
  /* Checked before each read. False ends this run's reads. */
  keepReading?: () => boolean;
}

export interface TownRunResult {
  /* Snapshots to store, only those that changed. */
  changed: TownSnapshot[];
  places: PrivatePlace[];
  listedKeys: string[] | null;
  summary: TownSummary;
}

export interface TownSummary {
  listed: number | null;
  listProblem?: string;
  read: number;
  failed: Array<{town: string; reason: string}>;
  stopped?: string;
  towns: number;
  places: number;
  duplicateCopies: number;
  /* Published places with one price, and with a stepped price list. */
  withFee?: number;
  withRates?: number;
  collisions: string[];
}

export function townFromWorkbookName(name: string): string | null {
  const trimmed = name.trim();
  for (const pattern of TOWN_NAME_PATTERNS) {
    const match = pattern.exec(trimmed);
    const town = match?.[1]?.trim();
    if (town) return town.length > 80 ? null : town;
  }
  return null;
}

export function townKey(sheetId: string): string {
  return createHash("sha256").update(sheetId).digest("hex").slice(0, 24);
}

/* One source per spreadsheet. London and names that are not a town are left out. */
export function townSources(files: DriveFile[]): TownSource[] {
  const byId = new Map<string, TownSource>();
  for (const file of files) {
    const town = townFromWorkbookName(file.name);
    if (!town || SKIPPED_TOWNS.has(town.toLowerCase()) || byId.has(file.id)) continue;
    byId.set(file.id, {
      key: townKey(file.id),
      sheetId: file.id,
      town,
      locationsTab: `Locations - ${town}`,
      tariffsTab: `Tariffs - ${town}`,
    });
  }
  return [...byId.values()].sort((a, b) => a.town.localeCompare(b.town) || a.key.localeCompare(b.key));
}

/* The `FERRO-<CODE>-` prefix most rows use. Ties go to the first code alphabetically. */
export function dominantCode(locations: unknown[][]): string | null {
  const counts = new Map<string, number>();
  for (const row of rowsFromMatrix(locations)) {
    if (row.blank) continue;
    const match = /^FERRO-([A-Z0-9]{2,8})-/.exec(text(row.values["Location ID"]).toUpperCase());
    if (match?.[1]) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [code, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

/* Towns never read go first, then the longest since their last read. */
export function townReadOrder(sources: TownSource[], snapshots: TownSnapshot[], limit: number): TownSource[] {
  const readAt = new Map(snapshots.map((snap) => [snap.key, snap.readAtMs ?? -1]));
  return [...sources]
    .sort((a, b) => {
      const left = readAt.get(a.key) ?? -1;
      const right = readAt.get(b.key) ?? -1;
      return left - right || a.town.localeCompare(b.town) || a.key.localeCompare(b.key);
    })
    .slice(0, Math.max(0, limit));
}

export function buildTownPlaces(
  source: TownSource,
  read: {locations: unknown[][]; tariffs: unknown[][]},
  nowMs: number = Date.now(),
): {ok: true; code?: string; places: PrivatePlace[]} | {ok: false; reason: string} {
  if (fmppHeaderProblem("locations", read.locations[0])) return {ok: false, reason: "header-unexpected:locations"};
  if (fmppHeaderProblem("tariffs", read.tariffs[0])) return {ok: false, reason: "header-unexpected:tariffs"};
  const code = dominantCode(read.locations);
  if (!code) return {ok: true, places: []};
  const fmpp: FmppSource = {
    code,
    city: source.town,
    sheetId: source.sheetId,
    locationsTab: source.locationsTab,
    tariffsTab: source.tariffsTab,
  };
  const built = buildFmppPlaces(fmpp, read.locations, read.tariffs, new Date(nowMs));
  if (!built.ok) return {ok: false, reason: built.reason.replace(/^fmpp-/, "")};
  return {ok: true, code, places: built.places};
}

function withoutUndefined(snap: TownSnapshot): TownSnapshot {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snap)) if (value !== undefined) copy[key] = value;
  return copy as unknown as TownSnapshot;
}

function failed(prev: TownSnapshot | undefined, source: TownSource, nowMs: number, reason: string): TownSnapshot {
  const base: TownSnapshot = prev ?? {key: source.key, town: source.town, places: [], count: 0};
  return withoutUndefined({...base, town: source.town, readAtMs: nowMs, error: reason});
}

/* The snapshot after one read. A failure keeps the last good places. */
export function nextTownSnapshot(
  prev: TownSnapshot | undefined,
  source: TownSource,
  outcome: {ok: true; code?: string; places: PrivatePlace[]} | {ok: false; reason: string},
  nowMs: number,
): TownSnapshot {
  if (!outcome.ok) return failed(prev, source, nowMs, outcome.reason);
  const count = outcome.places.length;
  const lastGood = prev?.goodAtMs != null ? prev.count : null;
  if (prev && lastGood != null && lastGood > 0 && count < lastGood * TOWN_DROP_RATIO) {
    const since = prev.dropCount === count && prev.dropSinceMs != null ? prev.dropSinceMs : nowMs;
    if (nowMs - since < TOWN_DROP_GRACE_MS) {
      return withoutUndefined({...prev, town: source.town, readAtMs: nowMs, error: "dropped", dropCount: count, dropSinceMs: since});
    }
  }
  const next = withoutUndefined({
    key: source.key,
    town: source.town,
    code: outcome.code,
    places: outcome.places,
    count,
    readAtMs: nowMs,
    goodAtMs: nowMs,
  });
  if (Buffer.byteLength(JSON.stringify(next)) > TOWN_SNAPSHOT_MAX_BYTES) return failed(prev, source, nowMs, "too-large");
  return next;
}

function metresApart(a: PrivatePlace, b: PrivatePlace): number {
  const toRad = Math.PI / 180;
  const lat = ((a.p[0] + b.p[0]) / 2) * toRad;
  const dx = (b.p[1] - a.p[1]) * toRad * Math.cos(lat);
  const dy = (b.p[0] - a.p[0]) * toRad;
  return Math.sqrt(dx * dx + dy * dy) * 6_371_000;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) copy[key] = sortedKeys(record[key]);
  return copy;
}

/*
 * Fields in name order, nested maps too (`rates`). A place read back from
 * Firestore may not keep the order it was built in, and the cell hash would
 * then change every run.
 */
export function canonicalPlace(place: PrivatePlace): PrivatePlace {
  return sortedKeys(place) as PrivatePlace;
}

/*
 * Places from live snapshots, one per Location ID.
 * Copies of an id at the same spot are one car park, kept once. Copies far
 * apart are two car parks with one id, so neither is published.
 */
export function publishTownPlaces(
  snapshots: TownSnapshot[],
  nowMs: number,
): {places: PrivatePlace[]; towns: number; duplicateCopies: number; collisions: string[]} {
  const live = snapshots
    .filter((snap) => snap.goodAtMs != null && nowMs - snap.goodAtMs <= CELL_TTL_MS && snap.places.length > 0)
    .sort((a, b) => a.town.localeCompare(b.town) || a.key.localeCompare(b.key));
  const byId = new Map<string, PrivatePlace[]>();
  for (const snap of live) {
    for (const place of snap.places) {
      const list = byId.get(place.id) ?? [];
      list.push(place);
      byId.set(place.id, list);
    }
  }
  const places: PrivatePlace[] = [];
  const collisions: string[] = [];
  let duplicateCopies = 0;
  for (const [id, copies] of byId) {
    const first = copies[0];
    if (!first) continue;
    if (copies.some((copy) => metresApart(first, copy) > TOWN_SAME_SPOT_METRES)) {
      collisions.push(id);
      continue;
    }
    duplicateCopies += copies.length - 1;
    places.push(canonicalPlace(first));
  }
  places.sort((a, b) => a.id.localeCompare(b.id));
  collisions.sort();
  return {places, towns: live.length, duplicateCopies, collisions};
}

/* Read up to maxReads towns, update their snapshots, and publish every listed town. */
export async function runTowns(input: TownRunInput): Promise<TownRunResult> {
  const byKey = new Map(input.snapshots.map((snap) => [snap.key, snap]));
  const changed: TownSnapshot[] = [];
  const failures: Array<{town: string; reason: string}> = [];
  let read = 0;
  let stopped: string | undefined;
  let listProblem: string | undefined;
  let listedKeys: string[] | null = null;
  let publishKeys: Set<string>;

  if (input.sources == null) {
    listProblem = "list-failed";
  } else if (input.lastListedKeys != null &&
    input.sources.length < input.lastListedKeys.length * TOWN_LIST_DROP_RATIO) {
    listProblem = "list-dropped";
  }
  if (input.sources != null && listProblem == null) {
    listedKeys = input.sources.map((source) => source.key).sort();
    publishKeys = new Set(listedKeys);
  } else {
    publishKeys = new Set(input.lastListedKeys ?? input.snapshots.map((snap) => snap.key));
  }

  const order = townReadOrder(input.sources ?? [], input.snapshots, input.maxReads ?? TOWN_READS_PER_RUN);
  for (const source of order) {
    if (input.keepReading && !input.keepReading()) {
      stopped = "deadline";
      break;
    }
    let loaded: TownRead;
    try {
      loaded = await input.loadTown(source);
    } catch (err) {
      loaded = {ok: false, reason: `read-error:${err instanceof Error && err.name ? err.name : "Error"}`};
    }
    if (!loaded.ok && loaded.stop) {
      stopped = loaded.reason;
      break;
    }
    read += 1;
    const outcome = loaded.ok ? buildTownPlaces(source, loaded, input.nowMs) : loaded;
    const next = nextTownSnapshot(byKey.get(source.key), source, outcome, input.nowMs);
    if (next.error) failures.push({town: source.town, reason: next.error});
    byKey.set(source.key, next);
    changed.push(next);
  }

  const published = publishTownPlaces(
    [...byKey.values()].filter((snap) => publishKeys.has(snap.key)),
    input.nowMs,
  );
  return {
    changed,
    places: published.places,
    listedKeys,
    summary: {
      listed: input.sources?.length ?? null,
      ...(listProblem ? {listProblem} : {}),
      read,
      failed: failures,
      ...(stopped ? {stopped} : {}),
      towns: published.towns,
      places: published.places.length,
      duplicateCopies: published.duplicateCopies,
      withFee: published.places.filter((place) => place.fee !== undefined).length,
      withRates: published.places.filter((place) => place.rates !== undefined).length,
      collisions: published.collisions,
    },
  };
}
