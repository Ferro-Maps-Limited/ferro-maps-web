import {parseBirminghamCaz} from "./parsers/birminghamCaz.ts";
import {parseBristolCaz} from "./parsers/bristolCaz.ts";
import {parseGovUkCazList, type CazListEntry} from "./parsers/govukCazList.ts";
import {parseGovUkTollRoads} from "./parsers/govukTollRoads.ts";
import {parseLondonUlez} from "./parsers/londonUlez.ts";
import {parseOsmGates} from "./parsers/osmGates.ts";
import {parseTflCongestion} from "./parsers/tflCongestion.ts";
import {EXCLUDED_SOURCES, type ExcludedSource} from "./sources.ts";
import {assertFetchedAt, assertZone, type OmittedSource, type RoadChargeZone} from "./types.ts";

export interface LocalFiles {
  tflCongestion?: string;
  londonUlez?: string;
  birminghamCaz?: string;
  wecaCaz?: string;
  govukCazList?: string;
  govukTollRoads?: string;
  osmGates?: string;
  /** The OSM file is on disk and the switch is off, so it was not read. */
  osmGatesSkipped: boolean;
}

export interface ImportOptions {
  fetchedAt: string;
  includeOsmGates: boolean;
}

export interface ImportPlan {
  zones: RoadChargeZone[];
  omitted: OmittedSource[];
  excluded: ExcludedSource[];
}

export function buildImport(files: LocalFiles, options: ImportOptions): ImportPlan {
  assertFetchedAt(options.fetchedAt);
  const zones: RoadChargeZone[] = [];
  const omitted: OmittedSource[] = [];
  if (files.tflCongestion) zones.push(parseTflCongestion(files.tflCongestion, options.fetchedAt));
  if (files.londonUlez) zones.push(parseLondonUlez(files.londonUlez, options.fetchedAt));
  if (files.govukTollRoads) omitted.push(...parseGovUkTollRoads(files.govukTollRoads));

  const list = files.govukCazList ? parseGovUkCazList(files.govukCazList) : null;
  const covered = new Set<string>();
  const birmingham = files.birminghamCaz ? parseBirminghamCaz(files.birminghamCaz, options.fetchedAt) : null;
  const bristol = files.wecaCaz ? parseBristolCaz(files.wecaCaz, options.fetchedAt) : null;
  if (bristol) omitted.push(...bristol.omitted);
  acceptCaz(zones, omitted, list, birmingham, "Birmingham", covered);
  acceptCaz(zones, omitted, list, bristol?.zone ?? null, "Bristol", covered);
  if (list) {
    for (const entry of list.entries) {
      if (covered.has(entry.name)) continue;
      omitted.push({
        name: entry.name,
        kind: "caz",
        reason: `Listed by GOV.UK as class ${entry.cazClass}. No licensed boundary file for this city is in the input, so nothing is written.`,
      });
    }
  }

  if (options.includeOsmGates && files.osmGates) {
    const gates = parseOsmGates(files.osmGates, options.fetchedAt);
    zones.push(...gates.zones);
    omitted.push(...gates.omitted);
  } else if (files.osmGatesSkipped || files.osmGates) {
    omitted.push({
      name: "OpenStreetMap toll gates",
      kind: "gate",
      reason: "OpenStreetMap gates are off. Pass --include-osm-gates to parse them. That switch is not set by any script in this repo.",
    });
  }

  const ids = new Set<string>();
  for (const zone of zones) {
    assertZone(zone);
    if (ids.has(zone.id)) throw new Error(`duplicate zone id ${zone.id}`);
    ids.add(zone.id);
  }
  zones.sort((a, b) => a.id.localeCompare(b.id));
  return {zones, omitted, excluded: EXCLUDED_SOURCES};
}

function acceptCaz(
  zones: RoadChargeZone[],
  omitted: OmittedSource[],
  list: {entries: CazListEntry[]} | null,
  zone: RoadChargeZone | null,
  city: string,
  covered: Set<string>,
): void {
  if (!zone) return;
  if (!list) {
    omitted.push({
      name: zone.name,
      kind: "caz",
      reason: "Clean Air Zone boundaries are not written unless the GOV.UK list is in the input.",
    });
    return;
  }
  if (!list.entries.some((entry) => entry.name === city)) {
    omitted.push({
      name: zone.name,
      kind: "caz",
      reason: `${city} is not on the GOV.UK Clean Air Zone list in this input, so the boundary was not written.`,
    });
    return;
  }
  covered.add(city);
  zones.push(zone);
}

export function summarise(plan: ImportPlan, wrote: boolean): string {
  const lines = [
    `zones ${plan.zones.length}`,
    ...plan.zones.map((zone) => `${zone.id} ${zone.kind} ${zone.name}`),
    "not written",
    ...plan.omitted.map((item) => `${item.name}: ${item.reason}`),
    "left out",
    ...plan.excluded.map((item) => `${item.name}: ${item.reason}`),
    wrote ? "wrote to the emulator" : "Nothing was written.",
  ];
  const text = `${lines.join("\n")}\n`;
  if (text.includes("£")) throw new Error("summary contains a price");
  return text;
}
