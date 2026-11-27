import {createHash} from "node:crypto";
import {buildFmppPlaces, FMPP_LOCATION_HEADERS, FMPP_TARIFF_HEADERS, type FmppHeaderKind} from "./fmpp.js";
import {text} from "./mapping.js";
import {
  townFromWorkbookName,
  townKey,
  type DriveFile,
  type TownSnapshot,
  type TownSource,
} from "./towns.js";
import {type PrivatePlace} from "./types.js";

/*
 * The London list in the town folder (`FM—PP London`), published in place of
 * the old London sheet when config/privateParking.londonFromFolder is exactly
 * true.
 *
 * It has the FM-PP columns and then more, its Location IDs use one code per
 * borough (`FERRO-WSM-0001`, `FERRO-CRY-0001`…), and its prices may be on a
 * tab called just `Tariffs`. It is far bigger than a town, so it is read in
 * pages and its last good places are kept in privateParkingLondon as a meta
 * document plus parts, not in one privateParkingTowns document.
 */

export const LONDON_TOWN = "London";
export const LONDON_CODE = "LON";
export const LONDON_LOCATIONS_TAB = "Locations - London";
/* The first tab of these that exists holds the prices. */
export const LONDON_TARIFF_TABS = ["Tariffs - London", "Tariffs"] as const;
/* One part stays well under the 1 MiB Firestore document limit. */
export const LONDON_PART_MAX_BYTES = 800_000;

function headerName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/* The London workbook in a folder listing. Two London workbooks is a problem, not a guess. */
export function londonSource(files: DriveFile[]):
  {ok: true; source: TownSource} | {ok: false; reason: "london-not-found" | "london-ambiguous"} {
  const ids = new Set<string>();
  for (const file of files) {
    if (townFromWorkbookName(file.name)?.toLowerCase() === "london") ids.add(file.id);
  }
  if (ids.size === 0) return {ok: false, reason: "london-not-found"};
  if (ids.size > 1) return {ok: false, reason: "london-ambiguous"};
  const sheetId = [...ids][0] as string;
  return {
    ok: true,
    source: {
      key: townKey(sheetId),
      sheetId,
      town: LONDON_TOWN,
      locationsTab: LONDON_LOCATIONS_TAB,
      tariffsTab: LONDON_TARIFF_TABS[0],
    },
  };
}

/* The FM-PP columns, in order, first. Named columns after them are allowed here. */
export function londonHeaderProblem(kind: FmppHeaderKind, header: unknown[] | undefined): string | null {
  const expected: readonly string[] = kind === "locations" ? FMPP_LOCATION_HEADERS : FMPP_TARIFF_HEADERS;
  if (!header || header.length === 0) return "header-missing";
  const names = header.map(headerName);
  if (names.length < expected.length) return "header-unexpected";
  for (let index = 0; index < expected.length; index += 1) {
    if (names[index] !== expected[index]) return "header-unexpected";
  }
  return null;
}

/* Header plus the rows of each `FERRO-<CODE>-` Location ID. Other rows are left out. */
function splitByCode(matrix: unknown[][]): Map<string, unknown[][]> {
  const header = matrix[0] ?? [];
  const idColumn = header.map(headerName).indexOf("Location ID");
  const byCode = new Map<string, unknown[][]>();
  for (let index = 1; index < matrix.length; index += 1) {
    const row = matrix[index] ?? [];
    const match = /^FERRO-([A-Z0-9]{2,8})-/.exec(text(row[idColumn]).toUpperCase());
    if (!match?.[1]) continue;
    const rows = byCode.get(match[1]) ?? [header];
    rows.push(row);
    byCode.set(match[1], rows);
  }
  return byCode;
}

/* The London list's places, built one borough code at a time. */
export function buildLondonPlaces(
  read: {locations: unknown[][]; tariffs: unknown[][]},
  nowMs: number = Date.now(),
): {ok: true; code: string; places: PrivatePlace[]} | {ok: false; reason: string} {
  if (londonHeaderProblem("locations", read.locations[0])) return {ok: false, reason: "header-unexpected:locations"};
  if (londonHeaderProblem("tariffs", read.tariffs[0])) return {ok: false, reason: "header-unexpected:tariffs"};
  const header = read.locations[0] as unknown[];
  const byCode = splitByCode(read.locations);
  // Prices split the same way once, so each borough reads only its own rows.
  const tariffsByCode = splitByCode(read.tariffs);
  const places: PrivatePlace[] = [];
  for (const code of [...byCode.keys()].sort()) {
    const built = buildFmppPlaces(
      {code, city: LONDON_TOWN, sheetId: "", locationsTab: LONDON_LOCATIONS_TAB, tariffsTab: LONDON_TARIFF_TABS[0]},
      byCode.get(code) ?? [header],
      tariffsByCode.get(code) ?? [read.tariffs[0] ?? []],
      new Date(nowMs),
    );
    if (!built.ok) return {ok: false, reason: built.reason.replace(/^fmpp-/, "")};
    places.push(...built.places);
  }
  places.sort((a, b) => a.id.localeCompare(b.id));
  return {ok: true, code: LONDON_CODE, places};
}

/* What privateParkingLondon/meta holds. `gen` names the parts that go with it. */
export interface LondonMeta extends Omit<TownSnapshot, "places"> {
  gen: string;
  parts: number;
}

export interface LondonPart {
  gen: string;
  index: number;
  places: PrivatePlace[];
}

/* A hash of the places, so a run that keeps the same places rewrites only the meta. */
export function londonGen(places: PrivatePlace[]): string {
  return createHash("sha256").update(JSON.stringify(places)).digest("hex").slice(0, 16);
}

/* The snapshot as a meta document and parts of at most LONDON_PART_MAX_BYTES each. */
export function splitLondonSnapshot(snapshot: TownSnapshot): {meta: LondonMeta; parts: LondonPart[]} {
  const gen = londonGen(snapshot.places);
  const parts: LondonPart[] = [];
  let current: PrivatePlace[] = [];
  let bytes = 0;
  for (const place of snapshot.places) {
    const size = Buffer.byteLength(JSON.stringify(place)) + 1;
    if (current.length > 0 && bytes + size > LONDON_PART_MAX_BYTES) {
      parts.push({gen, index: parts.length, places: current});
      current = [];
      bytes = 0;
    }
    current.push(place);
    bytes += size;
  }
  if (current.length > 0) parts.push({gen, index: parts.length, places: current});
  const {places: _places, ...rest} = snapshot;
  void _places;
  return {meta: {...rest, gen, parts: parts.length}, parts};
}

/* Back to one snapshot. Null when a part is missing or from another write. */
export function joinLondonSnapshot(meta: LondonMeta | null, parts: LondonPart[]): TownSnapshot | null {
  if (!meta) return null;
  const mine = parts.filter((part) => part.gen === meta.gen).sort((a, b) => a.index - b.index);
  if (mine.length !== meta.parts || mine.some((part, index) => part.index !== index)) return null;
  const {gen: _gen, parts: _parts, ...rest} = meta;
  void _gen;
  void _parts;
  return {...rest, places: mine.flatMap((part) => part.places)};
}

/* Parts of one write never overwrite the parts the stored meta points at. */
export function londonPartId(gen: string, index: number): string {
  return `${gen}-${String(index).padStart(3, "0")}`;
}
