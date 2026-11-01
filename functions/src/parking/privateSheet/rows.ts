import {type SourceRow} from "./types.js";

function headerName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function sheetCell(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value;
  return null;
}

/* First row is the header. `sheetRow` is the 1-based spreadsheet row, including the header. */
export function rowsFromMatrix(matrix: unknown[][]): SourceRow[] {
  if (matrix.length === 0) return [];
  const header = (matrix[0] ?? []).map(headerName);
  const rows: SourceRow[] = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const source = matrix[index] ?? [];
    const values: Record<string, unknown> = {};
    let any = false;
    header.forEach((name, col) => {
      if (!name) return;
      const value = sheetCell(source[col]);
      values[name] = value;
      if (value != null) any = true;
    });
    rows.push({sheetRow: index + 1, blank: !any, values: any ? values : {}});
  }
  return rows;
}
