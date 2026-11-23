import {htmlTables} from "../html.ts";
import {GOVUK_TOLL_ROADS} from "../sources.ts";
import {type OmittedSource, type ZoneKind} from "../types.ts";

const CROSSINGS: Array<{name: string; kind: ZoneKind}> = [
  {name: "M6 Toll", kind: "toll"},
  {name: "Dartford Crossing", kind: "toll"},
  {name: "Humber Bridge", kind: "toll"},
  {name: "Tyne Tunnels", kind: "tunnel"},
  {name: "Mersey Gateway", kind: "toll"},
];

/**
 * GOV.UK toll-road list, Open Government Licence v3.0.
 * The page names each crossing and a town. The location column is a Google
 * map link, which is not read. No coordinates are taken from the href, and
 * no price is stored. Nothing is written: the page has no boundary.
 */
export function parseGovUkTollRoads(raw: string): OmittedSource[] {
  const found = new Set<string>();
  for (const table of htmlTables(raw)) {
    const header = table[0] ?? [];
    const nameColumn = header.findIndex((cell) => /bridge or tunnel/i.test(cell));
    if (nameColumn < 0) continue;
    for (const row of table.slice(1)) {
      const name = row[nameColumn]?.trim() ?? "";
      if (CROSSINGS.some((crossing) => crossing.name === name)) found.add(name);
    }
  }
  return CROSSINGS.map((crossing) => ({
    name: crossing.name,
    kind: crossing.kind,
    reason: found.has(crossing.name)
      ? `Named on GOV.UK (${GOVUK_TOLL_ROADS.licence}). The page does not publish a boundary. Its location link is a Google map, which this importer does not read. No price is stored.`
      : `Expected on the GOV.UK toll-road page (${GOVUK_TOLL_ROADS.sourceUrl}) but the name was not in the table.`,
  }));
}
