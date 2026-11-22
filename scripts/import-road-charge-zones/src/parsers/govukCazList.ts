import {htmlTables} from "../html.ts";
import {GOVUK_CAZ_LIST} from "../sources.ts";
import {type OmittedSource} from "../types.ts";

export interface CazListEntry {
  name: string;
  cazClass: "A" | "B" | "C" | "D";
}

export interface CazListParse {
  entries: CazListEntry[];
  omitted: OmittedSource[];
}

/**
 * GOV.UK Clean Air Zone list, Open Government Licence v3.0.
 * The page names each city, a class, and an area. It does not publish a
 * boundary, so this parser returns no zones. Other tables and any prices
 * on the page are ignored.
 */
export function parseGovUkCazList(raw: string): CazListParse {
  const entries: CazListEntry[] = [];
  for (const table of htmlTables(raw)) {
    const header = table[0] ?? [];
    const city = header.findIndex((cell) => cell.toLowerCase() === "city");
    const cazClass = header.findIndex((cell) => cell.toLowerCase() === "class");
    if (city < 0 || cazClass < 0) continue;
    for (const row of table.slice(1)) {
      const name = row[city]?.trim() ?? "";
      const code = row[cazClass]?.trim() ?? "";
      if (!name || !/^[ABCD]$/.test(code)) continue;
      entries.push({name, cazClass: code as CazListEntry["cazClass"]});
    }
  }
  if (entries.length === 0) throw new Error("GOV.UK Clean Air Zone list has no city table");
  const omitted = entries.map((entry) => ({
    name: entry.name,
    kind: "caz" as const,
    reason: `Listed by GOV.UK (${GOVUK_CAZ_LIST.licence}) as class ${entry.cazClass}. The page does not publish a boundary, so nothing is written from the list itself.`,
  }));
  return {entries, omitted};
}
