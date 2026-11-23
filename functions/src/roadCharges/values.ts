/*
 * Cell values from an .xlsx. Boolean columns in the road-charges workbook are
 * stored as `=TRUE()` / `=FALSE()`, and FALSE() often has no cached result.
 */

export function plainCell(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "object") return plainObject(value as Record<string, unknown>);
  return null;
}

function plainObject(record: Record<string, unknown>): unknown {
  if (typeof record.formula === "string" || typeof record.sharedFormula === "string") {
    const raw = typeof record.formula === "string" ? record.formula : String(record.sharedFormula);
    const formula = raw.replace(/\s+/g, "").toUpperCase();
    if (formula === "TRUE()" || formula === "FALSE()") {
      if (typeof record.result === "boolean") return record.result;
      return formula === "TRUE()";
    }
    if ("result" in record && record.result != null) return plainCell(record.result);
    return null;
  }
  if ("result" in record && record.result != null) return plainCell(record.result);
  if (Array.isArray(record.richText)) {
    const text = record.richText.map((part) => {
      if (typeof part === "object" && part && "text" in part) return String((part as {text?: unknown}).text ?? "");
      return "";
    }).join("").trim();
    return text === "" ? null : text;
  }
  if (typeof record.text === "string") {
    const text = record.text.trim();
    return text === "" ? null : text;
  }
  if (typeof record.hyperlink === "string") return record.hyperlink;
  return null;
}

export function asString(value: unknown): string | null | "bad" {
  const plain = plainCell(value);
  if (plain == null) return null;
  if (typeof plain === "string") return plain;
  if (typeof plain === "number" && Number.isFinite(plain)) return String(plain);
  if (typeof plain === "boolean") return plain ? "TRUE" : "FALSE";
  return "bad";
}

export function asNumber(value: unknown): number | null | "bad" {
  const plain = plainCell(value);
  if (plain == null) return null;
  if (typeof plain === "number" && Number.isFinite(plain)) return plain;
  if (typeof plain === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(plain)) {
    const n = Number(plain);
    return Number.isFinite(n) ? n : "bad";
  }
  return "bad";
}

export function asBoolean(value: unknown): boolean | null | "bad" {
  const plain = plainCell(value);
  if (plain == null) return null;
  if (typeof plain === "boolean") return plain;
  if (typeof plain === "string") {
    const token = plain.trim().toUpperCase();
    if (token === "TRUE") return true;
    if (token === "FALSE") return false;
  }
  return "bad";
}
