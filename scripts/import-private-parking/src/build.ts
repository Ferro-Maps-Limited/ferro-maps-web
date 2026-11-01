import {geohash} from "./geohash.ts";
import {
  closureReason,
  coordinateSkip,
  isKnownVerification,
  mapFeeUnit,
  normaliseName,
  text,
  normalisePostcode,
  parseDate,
  skipReason,
  mapConf,
  isApproxPrecision,
  mapPlace,
  norm,
  parseLocationCode,
} from "./mapping.ts";
import {
  type CellWrite,
  type PrivateCell,
  type PrivatePlace,
  type SourceRow,
  isSrcType,
} from "./types.ts";

export const MAX_DOC_BYTES = 900_000;
export const MAX_SHARDS = 8;
const CELL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface MappedRow {
  sheetRow: number;
  place: PrivatePlace;
  values: Record<string, unknown>;
}

export interface DuplicatePair {
  name: string;
  postcode: string;
  sheetRows: number[];
  keptRow: number;
}

/** A row with usable coordinates that is not in the imported set. */
export interface NotImportedRow {
  sheetRow: number;
  name: string;
  postcode: string;
  reason: string;
}

export interface ImportBuild {
  totalRows: number;
  dataRows: number;
  skipped: Record<string, number>;
  imported: MappedRow[];
  duplicates: {
    sheetGroups: number;
    groupsMerged: number;
    rowsDropped: number;
    pairs: DuplicatePair[];
  };
  cells: CellWrite[];
  shardOverflowPlaces: number;
  verifiedSourceRows: number;
  locationCodeAmbiguous: number;
}

function blankValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function priority(row: SourceRow): [number, number, number, number, number] {
  const verified = isKnownVerification(row.values["Verification Result"]) ? 1 : 0;
  const conf = mapConf(row.values["Confidence (1-5)"]);
  const score = conf == null ? -1 : Math.round(conf * 5);
  const precise = isApproxPrecision(row.values["Geo Precision"]) ? 0 : 1;
  const captured = Date.parse(parseDate(row.values["Date Captured"]) ?? "") || 0;
  return [verified, score, precise, captured, row.sheetRow];
}

function comparePriority(a: SourceRow, b: SourceRow): number {
  const pa = priority(a);
  const pb = priority(b);
  for (let i = 0; i < pa.length; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

export function mergeKey(values: Record<string, unknown>): string {
  return `${normaliseName(values["Location Name"])}|${normalisePostcode(values.Postcode)}`;
}

function mergeGroup(rows: SourceRow[]): {row: SourceRow; dropped: number} {
  const ranked = [...rows].sort(comparePriority);
  const winner = ranked[0];
  const values: Record<string, unknown> = {};
  const keys = new Set(rows.flatMap((row) => Object.keys(row.values)));
  for (const key of keys) {
    for (const row of ranked) {
      const value = row.values[key];
      if (!blankValue(value)) {
        values[key] = value;
        break;
      }
    }
  }
  return {
    row: {sheetRow: winner.sheetRow, blank: false, values},
    dropped: rows.length - 1,
  };
}

function docBytes(cell: string, places: PrivatePlace[], iso: string, shards?: number): number {
  const data: PrivateCell = {
    v: 1,
    cell,
    generatedAt: iso,
    expiresAt: iso,
    places,
  };
  if (shards !== undefined) data.shards = shards;
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

export function packCell(
  cellId: string,
  places: PrivatePlace[],
  generatedAt: string,
  expiresAt: string,
  maxBytes = MAX_DOC_BYTES,
): {docs: CellWrite[]; overflow: number} {
  const sorted = [...places].sort((a, b) => a.id.localeCompare(b.id));
  if (docBytes(cellId, sorted, generatedAt) <= maxBytes) {
    return {
      overflow: 0,
      docs: [{
        id: cellId,
        data: {v: 1, cell: cellId, generatedAt, expiresAt, places: sorted},
      }],
    };
  }
  const buckets: PrivatePlace[][] = [];
  let current: PrivatePlace[] = [];
  let overflow = 0;
  const limit = MAX_SHARDS + 1;
  for (const place of sorted) {
    const next = current.concat(place);
    const over = current.length > 0 && docBytes(cellId, next, generatedAt, MAX_SHARDS) > maxBytes;
    if (!over) {
      current = next;
      continue;
    }
    if (buckets.length + 1 >= limit) {
      current = next;
      overflow += 1;
      continue;
    }
    buckets.push(current);
    current = [place];
  }
  if (current.length > 0) buckets.push(current);
  const siblings = Math.max(0, buckets.length - 1);
  return {
    overflow,
    docs: buckets.map((bucket, index) => {
      const data: PrivateCell = {
        v: 1,
        cell: cellId,
        generatedAt,
        expiresAt,
        places: bucket,
      };
      if (index === 0 && siblings > 0) data.shards = siblings;
      const id = index === 0 ? cellId : `${cellId}_${index}`;
      return {id, data};
    }),
  };
}

export function buildImport(rows: SourceRow[], now: Date, maxBytes = MAX_DOC_BYTES): ImportBuild {
  const skipped: Record<string, number> = {};
  const bump = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const dataRows = rows.filter((row) => !row.blank);
  for (const row of rows) {
    if (row.blank) bump("blank_row");
  }
  const kept: SourceRow[] = [];
  for (const row of dataRows) {
    const reason = skipReason(row.values);
    if (reason) bump(reason);
    else kept.push(row);
  }

  const sheetGroups = new Map<string, SourceRow[]>();
  for (const row of dataRows) {
    const key = mergeKey(row.values);
    const list = sheetGroups.get(key) ?? [];
    list.push(row);
    sheetGroups.set(key, list);
  }
  const sheetDupGroups = [...sheetGroups.values()].filter((group) => group.length > 1).length;

  const groups = new Map<string, SourceRow[]>();
  for (const row of kept) {
    const key = mergeKey(row.values);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const pairs: DuplicatePair[] = [];
  const merged: SourceRow[] = [];
  let rowsDropped = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const result = mergeGroup(group);
    merged.push(result.row);
    rowsDropped += result.dropped;
    pairs.push({
      name: String(result.row.values["Location Name"] ?? ""),
      postcode: String(result.row.values.Postcode ?? ""),
      sheetRows: group.map((row) => row.sheetRow).sort((a, b) => a - b),
      keptRow: result.row.sheetRow,
    });
  }
  pairs.sort((a, b) => a.sheetRows[0] - b.sheetRows[0]);

  const imported: MappedRow[] = merged
    .map((row) => ({sheetRow: row.sheetRow, place: mapPlace(row.values), values: row.values}))
    .sort((a, b) => a.sheetRow - b.sheetRow || a.place.id.localeCompare(b.place.id));

  const verifiedSourceRows = dataRows.filter((row) => isKnownVerification(row.values["Verification Result"])).length;
  const locationCodeAmbiguous = imported.filter((row) => parseLocationCode(row.values["Rules Summary"])?.ambiguous).length;

  const generatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CELL_TTL_MS).toISOString();
  const byCell = new Map<string, PrivatePlace[]>();
  for (const row of imported) {
    const [lat, lng] = row.place.p;
    const cell = geohash(lat, lng, 6);
    const list = byCell.get(cell) ?? [];
    list.push(row.place);
    byCell.set(cell, list);
  }
  const cells: CellWrite[] = [];
  let shardOverflowPlaces = 0;
  for (const cellId of [...byCell.keys()].sort()) {
    const packed = packCell(cellId, byCell.get(cellId) ?? [], generatedAt, expiresAt, maxBytes);
    shardOverflowPlaces += packed.overflow;
    cells.push(...packed.docs);
  }

  return {
    totalRows: rows.length,
    dataRows: dataRows.length,
    skipped,
    imported,
    duplicates: {
      sheetGroups: sheetDupGroups,
      groupsMerged: pairs.length,
      rowsDropped,
      pairs,
    },
    cells,
    shardOverflowPlaces,
    verifiedSourceRows,
    locationCodeAmbiguous,
  };
}

export interface DryRunSummary {
  mode: "dry-run";
  wroteToFirestore: false;
  sheet: string;
  generatedAt: string;
  expiresAt: string;
  totalRows: number;
  dataRows: number;
  skipped: Record<string, number>;
  imported: number;
  verified: number;
  verifiedSourceRows: number;
  approx: number;
  aud: Record<string, number>;
  srcType: Record<string, number>;
  srcTypeUnknownAsNone: number;
  locationCode: number;
  locationCodeAmbiguous: number;
  cells: number;
  shards: number;
  shardOverflowPlaces: number;
  duplicatesMerged: {
    sheetGroups: number;
    groupsMerged: number;
    rowsDropped: number;
  };
  duplicatePairs: DuplicatePair[];
  feeUnit: Record<string, number>;
  feeUnitOmittedByTariffType: Record<string, number>;
  sample: Array<PrivatePlace & {cell: string; sheetRow: number}>;
  notes: string[];
}

/**
 * Usable-coordinate rows that are not imported: closed, temporarily closed,
 * or a duplicate name+postcode row merged into the kept sheet row.
 */
export function notImportedRows(rows: SourceRow[], build: ImportBuild): NotImportedRow[] {
  const keptByDropped = new Map<number, number>();
  for (const pair of build.duplicates.pairs) {
    for (const sheetRow of pair.sheetRows) {
      if (sheetRow !== pair.keptRow) keptByDropped.set(sheetRow, pair.keptRow);
    }
  }
  const listed: NotImportedRow[] = [];
  for (const row of rows) {
    if (row.blank) continue;
    if (coordinateSkip(row.values.Latitude, row.values.Longitude)) continue;
    const closure = closureReason(row.values["Location Status"]);
    const name = text(row.values["Location Name"]);
    const postcode = text(row.values.Postcode);
    if (closure === "closed") {
      listed.push({sheetRow: row.sheetRow, name, postcode, reason: "closed"});
      continue;
    }
    if (closure === "temporarily_closed") {
      listed.push({sheetRow: row.sheetRow, name, postcode, reason: "temporarily closed"});
      continue;
    }
    const kept = keptByDropped.get(row.sheetRow);
    if (kept != null) {
      listed.push({
        sheetRow: row.sheetRow,
        name,
        postcode,
        reason: `merged duplicate of row ${kept}`,
      });
    }
  }
  listed.sort((a, b) => a.sheetRow - b.sheetRow);
  return listed;
}

export function notImportedCsv(rows: NotImportedRow[]): string {
  const lines = ["sheetRow,locationName,postcode,reason"];
  for (const row of rows) {
    lines.push([
      String(row.sheetRow),
      csvField(row.name),
      csvField(row.postcode),
      csvField(row.reason),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

export function summarise(build: ImportBuild, sheet: string): DryRunSummary {
  const aud: Record<string, number> = {c: 0, g: 0, p: 0, a: 0, omitted: 0};
  const srcType: Record<string, number> = {official: 0, gmaps: 0, onsite: 0, none: 0, omitted: 0};
  const feeUnit: Record<string, number> = {hour: 0, visit: 0, day: 0, omitted: 0};
  const feeUnitOmittedByTariffType: Record<string, number> = {};
  let verified = 0;
  let approx = 0;
  let locationCode = 0;
  let srcTypeUnknownAsNone = 0;

  for (const row of build.imported) {
    const place = row.place;
    if (place.q === "known") verified += 1;
    if (place.approx) approx += 1;
    if (place.aud) aud[place.aud] += 1;
    else aud.omitted += 1;
    if (place.srcType) {
      if (!isSrcType(place.srcType)) throw new Error(`summary saw srcType ${place.srcType}`);
      srcType[place.srcType] += 1;
      if (place.srcType === "none" && norm(row.values["Evidence Type"]) !== "no info found") {
        srcTypeUnknownAsNone += 1;
      }
    } else srcType.omitted += 1;
    if (place.locationCode) locationCode += 1;
    if (place.feeUnit) feeUnit[place.feeUnit] += 1;
    else {
      feeUnit.omitted += 1;
      const tariff = norm(row.values["Tariff Type"]) || "(blank)";
      if (mapFeeUnit(row.values["Tariff Type"], row.values["Tariff Detail"]) === undefined) {
        feeUnitOmittedByTariffType[tariff] = (feeUnitOmittedByTariffType[tariff] ?? 0) + 1;
      }
    }
  }

  const bases = build.cells.filter((doc) => !/_\d+$/.test(doc.id));
  const shards = build.cells.length - bases.length;
  const generatedAt = bases[0]?.data.generatedAt ?? "";
  const expiresAt = bases[0]?.data.expiresAt ?? "";
  const cellOf = new Map<string, string>();
  for (const doc of bases) {
    for (const place of doc.data.places) cellOf.set(place.id, doc.id);
  }
  for (const doc of build.cells) {
    if (bases.includes(doc)) continue;
    for (const place of doc.data.places) {
      if (!cellOf.has(place.id)) cellOf.set(place.id, doc.data.cell);
    }
  }

  const sample = build.imported.slice(0, 20).map((row) => ({
    ...row.place,
    cell: cellOf.get(row.place.id) ?? "",
    sheetRow: row.sheetRow,
  }));

  const verifiedSourceRows = build.verifiedSourceRows;
  const locationCodeAmbiguous = build.locationCodeAmbiguous;

  const notes = [
    "Dry run. No Firestore client was created and nothing was written.",
    "srcType is only official, gmaps, onsite, or none. Partial official evidence is official. Blank evidence omits srcType. Any other evidence text is none.",
    "feeUnit is hour, visit, or day only when the tariff names one of those units. Flat rate per night is omitted. Mixed hour/day/visit/night text is omitted.",
    "r, payMode, and tl are not written. Missing payMode means handoff in the apps.",
    `Name+postcode duplicate groups in the sheet: ${build.duplicates.sheetGroups}. Merged after skip filters: ${build.duplicates.groupsMerged}.`,
  ];
  if (srcTypeUnknownAsNone > 0) {
    notes.push(`${srcTypeUnknownAsNone} imported rows had evidence text that is not a known phrase, so srcType is none.`);
  }
  if (build.shardOverflowPlaces > 0) {
    notes.push(`${build.shardOverflowPlaces} places did not fit in the base doc plus 8 shards.`);
  }

  return {
    mode: "dry-run",
    wroteToFirestore: false,
    sheet,
    generatedAt,
    expiresAt,
    totalRows: build.totalRows,
    dataRows: build.dataRows,
    skipped: build.skipped,
    imported: build.imported.length,
    verified,
    verifiedSourceRows,
    approx,
    aud,
    srcType,
    srcTypeUnknownAsNone,
    locationCode,
    locationCodeAmbiguous,
    cells: bases.length,
    shards,
    shardOverflowPlaces: build.shardOverflowPlaces,
    duplicatesMerged: {
      sheetGroups: build.duplicates.sheetGroups,
      groupsMerged: build.duplicates.groupsMerged,
      rowsDropped: build.duplicates.rowsDropped,
    },
    duplicatePairs: build.duplicates.pairs,
    feeUnit,
    feeUnitOmittedByTariffType,
    sample,
    notes,
  };
}
