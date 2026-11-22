import {access, readFile} from "node:fs/promises";
import path from "node:path";
import {type LocalFiles} from "./buildImport.ts";

const TEXT_FILES = [
  ["tfl-congestion-charge.geojson", "tflCongestion"],
  ["london-wide-ulez.geojson", "londonUlez"],
  ["birmingham-caz.geojson", "birminghamCaz"],
  ["weca-caz.geojson", "wecaCaz"],
  ["govuk-caz-list.html", "govukCazList"],
  ["govuk-toll-roads.html", "govukTollRoads"],
] as const;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the known local files only. There is no network. The OSM file is
 * not opened unless includeOsmGates is true.
 */
export async function readInput(dir: string, includeOsmGates: boolean): Promise<LocalFiles> {
  const files: LocalFiles = {osmGatesSkipped: false};
  for (const [name, key] of TEXT_FILES) {
    const full = path.join(dir, name);
    if (await exists(full)) files[key] = await readFile(full, "utf8");
  }
  const osm = path.join(dir, "osm-gates.json");
  if (await exists(osm)) {
    if (includeOsmGates) files.osmGates = await readFile(osm, "utf8");
    else files.osmGatesSkipped = true;
  }
  return files;
}
