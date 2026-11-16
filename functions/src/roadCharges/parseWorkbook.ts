import {createHash} from "node:crypto";
import ExcelJS from "exceljs";
import {
  CHARGE_HEADERS,
  CHARGE_REQUIRED,
  POINT_HEADERS,
  POINT_REQUIRED,
  RATE_HEADERS,
  RATE_REQUIRED,
  enumColumn,
  fieldKind,
  sameHeaderSet,
  type FieldKind,
} from "./schema.js";
import {asBoolean, asNumber, asString, plainCell} from "./values.js";

export interface ChargeRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface ChildRecord {
  id: string;
  parentId: string;
  fields: Record<string, unknown>;
}

export interface RoadChargeDataset {
  version: string | null;
  charges: ChargeRecord[];
  points: ChildRecord[];
  rates: ChildRecord[];
}

export type ParseOutcome =
  | {ok: true; dataset: RoadChargeDataset}
  | {ok: false; reason: string};

const ID_MAX = 750;

export function sourceSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(reason: string): ParseOutcome {
  return {ok: false, reason};
}

function headersOf(sheet: ExcelJS.Worksheet): string[] {
  const row = sheet.getRow(1);
  const headers: string[] = [];
  const width = Math.max(sheet.columnCount, row.cellCount);
  for (let col = 1; col <= width; col += 1) {
    const value = plainCell(row.getCell(col).value);
    headers.push(typeof value === "string" ? value : "");
  }
  while (headers.length > 0 && headers[headers.length - 1] === "") headers.pop();
  return headers;
}

function dictionaryNames(sheet: ExcelJS.Worksheet): string[] {
  const names: string[] = [];
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    const name = plainCell(row.getCell(1).value);
    const firestoreType = plainCell(row.getCell(2).value);
    if (typeof name !== "string") continue;
    if (name.includes("—")) continue;
    if (typeof firestoreType !== "string") continue;
    names.push(name);
  }
  return names;
}

function enumSets(sheet: ExcelJS.Worksheet): Map<string, Set<string>> {
  const headers = headersOf(sheet);
  const sets = new Map<string, Set<string>>();
  headers.forEach((name) => {
    if (name) sets.set(name, new Set());
  });
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    headers.forEach((name, offset) => {
      if (!name) return;
      const value = plainCell(row.getCell(offset + 1).value);
      if (typeof value === "string" && value) sets.get(name)?.add(value);
    });
  }
  return sets;
}

function versionOf(sheet: ExcelJS.Worksheet | undefined): string | null {
  if (!sheet) return null;
  let found: string | null = null;
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      const value = plainCell(cell.value);
      if (typeof value !== "string") return;
      const match = /Dataset (v\d+\.\d+)/.exec(value);
      if (match?.[1]) found = match[1];
    });
  });
  return found;
}

function validId(id: string): boolean {
  if (id === "." || id === "..") return false;
  if (id.length > ID_MAX || id.includes("/")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id);
}

/*
 * Firestore document ids cannot contain `/`. A few rate ids use `n/a`.
 * The stored `rate_id` field keeps the workbook value. The path uses `_`.
 */
export function firestoreDocId(id: string): string {
  return id.split("/").join("_");
}

function coerce(
  table: "charges" | "points" | "rates",
  name: string,
  raw: unknown,
  enums: Map<string, Set<string>>,
): {ok: true; value: unknown} | {ok: false; reason: string} {
  const kind: FieldKind = fieldKind(table, name);
  if (kind === "number") {
    const value = asNumber(raw);
    if (value === "bad") return {ok: false, reason: `${name} is not a number`};
    return {ok: true, value};
  }
  if (kind === "boolean") {
    const value = asBoolean(raw);
    if (value === "bad") return {ok: false, reason: `${name} is not true or false`};
    return {ok: true, value};
  }
  const value = asString(raw);
  if (value === "bad") return {ok: false, reason: `${name} is not text`};
  const column = enumColumn(table, name);
  if (column && value != null) {
    const allowed = enums.get(column);
    if (!allowed || !allowed.has(value)) return {ok: false, reason: `${name} is not an allowed ${column}`};
  }
  return {ok: true, value};
}

function blankRow(values: unknown[]): boolean {
  return values.every((value) => value == null);
}

function readTable(
  sheet: ExcelJS.Worksheet,
  headers: string[],
): Array<{rowNumber: number; values: Record<string, unknown>}> {
  const rows: Array<{rowNumber: number; values: Record<string, unknown>}> = [];
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    const raw = headers.map((_, offset) => row.getCell(offset + 1).value);
    if (blankRow(raw.map((value) => plainCell(value)))) continue;
    const values: Record<string, unknown> = {};
    headers.forEach((name, offset) => {
      values[name] = raw[offset];
    });
    rows.push({rowNumber: index, values});
  }
  return rows;
}

function locationOf(fields: Record<string, unknown>): {ok: true} | {ok: false; reason: string} {
  const lat = fields.lat;
  const lng = fields.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return {ok: false, reason: "lat and lng are required"};
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return {ok: false, reason: "lat or lng is out of range"};
  fields.location = {latitude: lat, longitude: lng};
  return {ok: true};
}

export async function parseRoadChargesWorkbook(bytes: Buffer): Promise<ParseOutcome> {
  const workbook = new ExcelJS.Workbook();
  try {
    /* exceljs 4 types still name the pre-Node-22 Buffer. The bytes are a Node Buffer. */
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    return fail("workbook-unreadable");
  }
  const chargesSheet = workbook.getWorksheet("road_charges");
  const pointsSheet = workbook.getWorksheet("charge_points");
  const ratesSheet = workbook.getWorksheet("rates");
  const dictionary = workbook.getWorksheet("field_dictionary");
  const enumsSheet = workbook.getWorksheet("enums");
  if (!chargesSheet) return fail("missing-sheet:road_charges");
  if (!pointsSheet) return fail("missing-sheet:charge_points");
  if (!ratesSheet) return fail("missing-sheet:rates");
  if (!dictionary) return fail("missing-sheet:field_dictionary");
  if (!enumsSheet) return fail("missing-sheet:enums");

  const chargeHeaders = headersOf(chargesSheet);
  const pointHeaders = headersOf(pointsSheet);
  const rateHeaders = headersOf(ratesSheet);
  if (!sameHeaderSet(chargeHeaders, CHARGE_HEADERS)) return fail("header-unexpected:road_charges");
  if (!sameHeaderSet(pointHeaders, POINT_HEADERS)) return fail("header-unexpected:charge_points");
  if (!sameHeaderSet(rateHeaders, RATE_HEADERS)) return fail("header-unexpected:rates");

  const known = new Set<string>([...CHARGE_HEADERS, ...POINT_HEADERS, ...RATE_HEADERS]);
  for (const name of dictionaryNames(dictionary)) {
    if (!known.has(name)) return fail(`dictionary-field-unmapped:${name}`);
  }

  const enums = enumSets(enumsSheet);
  for (const column of ["charge_type", "geometry_type", "status", "point_type"]) {
    if (!enums.get(column)?.size) return fail(`enum-column-empty:${column}`);
  }

  const charges: ChargeRecord[] = [];
  const seenCharges = new Set<string>();
  for (const row of readTable(chargesSheet, chargeHeaders)) {
    const built = buildFields("charges", "road_charges", row.rowNumber, chargeHeaders, row.values, CHARGE_REQUIRED, enums);
    if (!built.ok) return fail(built.reason);
    const id = built.fields.doc_id;
    if (typeof id !== "string" || !validId(id)) return fail(`road_charges row ${row.rowNumber}: doc_id is not a safe id`);
    if (seenCharges.has(id)) return fail(`road_charges row ${row.rowNumber}: duplicate doc_id ${id}`);
    seenCharges.add(id);
    const located = locationOf(built.fields);
    if (!located.ok) return fail(`road_charges row ${row.rowNumber}: ${located.reason}`);
    charges.push({id, fields: built.fields});
  }

  const points: ChildRecord[] = [];
  const seenPoints = new Set<string>();
  for (const row of readTable(pointsSheet, pointHeaders)) {
    const built = buildFields("points", "charge_points", row.rowNumber, pointHeaders, row.values, POINT_REQUIRED, enums);
    if (!built.ok) return fail(built.reason);
    const id = built.fields.point_id;
    const parentId = built.fields.parent_doc_id;
    if (typeof id !== "string" || !validId(id)) return fail(`charge_points row ${row.rowNumber}: point_id is not a safe id`);
    if (typeof parentId !== "string" || !seenCharges.has(parentId)) {
      return fail(`charge_points row ${row.rowNumber}: parent_doc_id is not a road charge`);
    }
    const key = `${parentId}/${id}`;
    if (seenPoints.has(key)) return fail(`charge_points row ${row.rowNumber}: duplicate point_id ${id}`);
    seenPoints.add(key);
    const located = locationOf(built.fields);
    if (!located.ok) return fail(`charge_points row ${row.rowNumber}: ${located.reason}`);
    points.push({id, parentId, fields: built.fields});
  }

  const rates: ChildRecord[] = [];
  const seenRates = new Set<string>();
  for (const row of readTable(ratesSheet, rateHeaders)) {
    const built = buildFields("rates", "rates", row.rowNumber, rateHeaders, row.values, RATE_REQUIRED, enums);
    if (!built.ok) return fail(built.reason);
    const id = built.fields.rate_id;
    const parentId = built.fields.parent_doc_id;
    const docId = typeof id === "string" ? firestoreDocId(id) : "";
    if (!validId(docId)) return fail(`rates row ${row.rowNumber}: rate_id is not a safe id`);
    if (typeof parentId !== "string" || !seenCharges.has(parentId)) {
      return fail(`rates row ${row.rowNumber}: parent_doc_id is not a road charge`);
    }
    const key = `${parentId}/${docId}`;
    if (seenRates.has(key)) return fail(`rates row ${row.rowNumber}: duplicate rate_id ${id}`);
    seenRates.add(key);
    rates.push({id: docId, parentId, fields: built.fields});
  }

  return {
    ok: true,
    dataset: {version: versionOf(workbook.getWorksheet("README")), charges, points, rates},
  };
}

function buildFields(
  table: "charges" | "points" | "rates",
  label: string,
  rowNumber: number,
  headers: string[],
  raw: Record<string, unknown>,
  required: readonly string[],
  enums: Map<string, Set<string>>,
): {ok: true; fields: Record<string, unknown>} | {ok: false; reason: string} {
  const fields: Record<string, unknown> = {};
  for (const name of headers) {
    const coerced = coerce(table, name, raw[name], enums);
    if (!coerced.ok) return {ok: false, reason: `${label} row ${rowNumber}: ${coerced.reason}`};
    fields[name] = coerced.value;
  }
  for (const name of required) {
    if (fields[name] == null || fields[name] === "") {
      return {ok: false, reason: `${label} row ${rowNumber}: ${name} is required`};
    }
  }
  return {ok: true, fields};
}
