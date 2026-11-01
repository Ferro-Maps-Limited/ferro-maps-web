import ExcelJS from "exceljs";
import {type SourceRow} from "./types.ts";

export const SHEET_NAME = "ALL LONDON (clean)";

/** Turn an ExcelJS cell into a string, number, boolean, Date, or null. */
export function plainValue(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("result" in record && record.result != null) return plainValue(record.result);
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => {
        if (typeof part === "object" && part && "text" in part) return String((part as {text?: unknown}).text ?? "");
        return "";
      }).join("");
    }
    if (typeof record.text === "string") return record.text;
    if (typeof record.hyperlink === "string") return record.hyperlink;
  }
  return null;
}

export async function readSheet(file: string, sheetName = SHEET_NAME): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    const names = workbook.worksheets.map((item) => item.name).join(", ");
    throw new Error(`sheet not found: ${sheetName}. Workbook has: ${names}`);
  }
  const header = sheet.getRow(1);
  const columns = new Map<number, string>();
  header.eachCell({includeEmpty: false}, (cell, col) => {
    const name = String(plainValue(cell.value) ?? "").trim();
    if (name) columns.set(col, name);
  });
  const required = ["Location Name", "Latitude", "Longitude", "Postcode", "Location Status", "Evidence Type"];
  for (const name of required) {
    if (![...columns.values()].includes(name)) throw new Error(`missing column ${name}`);
  }
  const rows: SourceRow[] = [];
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    const values: Record<string, unknown> = {};
    let any = false;
    for (const [col, name] of columns) {
      const value = plainValue(row.getCell(col).value);
      values[name] = value;
      if (value != null && !(typeof value === "string" && value.trim() === "")) any = true;
    }
    rows.push({sheetRow: number, blank: !any, values: any ? values : {}});
  }
  return rows;
}
