import assert from "node:assert/strict";
import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {buildImport, summarise} from "../src/buildImport.ts";
import {bngToWgs84} from "../src/bng.ts";
import {readInput} from "../src/files.ts";
import {parseBirminghamCaz} from "../src/parsers/birminghamCaz.ts";
import {parseBristolCaz} from "../src/parsers/bristolCaz.ts";
import {parseGovUkCazList} from "../src/parsers/govukCazList.ts";
import {parseGovUkTollRoads} from "../src/parsers/govukTollRoads.ts";
import {parseLondonUlez} from "../src/parsers/londonUlez.ts";
import {parseOsmGates} from "../src/parsers/osmGates.ts";
import {parseTflCongestion} from "../src/parsers/tflCongestion.ts";
import * as sources from "../src/sources.ts";
import {parseArgs, run} from "../import.ts";
import {assertEmulatorOnly, COLLECTION, writeToEmulator, zoneDocuments} from "../src/writer.ts";

const FETCHED = "2026-01-15T12:00:00.000Z";
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function read(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function moneyBlob(value: unknown): string {
  return JSON.stringify(value);
}

test("British National Grid matches the Ordnance Survey worked example", () => {
  const [lon, lat] = bngToWgs84(651409.903, 313177.27);
  assert.ok(Math.abs(lon - 1.71605195) < 1e-7);
  assert.ok(Math.abs(lat - 52.6579786) < 1e-7);
  const [londonLon, londonLat] = bngToWgs84(530000, 180000);
  assert.ok(Math.abs(londonLon + 0.127) < 0.01);
  assert.ok(Math.abs(londonLat - 51.504) < 0.01);
});

test("congestion, ULEZ, Birmingham and Bristol parsers keep attribution and drop prices", () => {
  const congestion = parseTflCongestion(read("tfl-congestion-charge.geojson"), FETCHED);
  assert.equal(congestion.id, "uk-lon-congestion-charge");
  assert.equal(congestion.kind, "congestion");
  assert.equal(congestion.licence, "Open Government Licence v3.0");
  assert.match(congestion.attribution, /Transport for London/);
  assert.match(congestion.attribution, /Ordnance Survey 100035971/);
  assert.equal(congestion.geometry.type, "MultiPolygon");
  if (congestion.geometry.type !== "MultiPolygon") return;
  assert.equal(congestion.geometry.coordinates.length, 2);
  assert.equal(congestion.geometry.coordinates[0]?.[0]?.[0]?.[0], -0.1);

  const ulez = parseLondonUlez(read("london-wide-ulez.geojson"), FETCHED);
  assert.equal(ulez.id, "uk-lon-ulez");
  assert.equal(ulez.kind, "ulez");
  assert.equal(ulez.licence, "Open Government Licence v2.0");
  assert.equal(ulez.sourceUrl, sources.LONDON_ULEZ.sourceUrl);
  assert.equal(ulez.geometry.type, "Polygon");
  if (ulez.geometry.type !== "Polygon") return;
  const [lon, lat] = ulez.geometry.coordinates[0]?.[0] ?? [0, 0];
  assert.ok(lon !== undefined && lat !== undefined);
  assert.ok(Math.abs(lon - 1.71605195) < 1e-7);
  assert.ok(Math.abs(lat - 52.6579786) < 1e-7);

  const birmingham = parseBirminghamCaz(read("birmingham-caz.geojson"), FETCHED);
  assert.equal(birmingham.id, "uk-bir-caz");
  assert.match(birmingham.attribution, /Birmingham City Council/);

  const bristol = parseBristolCaz(read("weca-caz.geojson"), FETCHED);
  assert.equal(bristol.zone?.id, "uk-brs-caz");
  assert.equal(bristol.zone?.licence, "Open Government Licence v3.0");
  assert.deepEqual(bristol.omitted.map((item) => item.name), ["Bath and North East Somerset"]);
  const blob = moneyBlob([congestion, ulez, birmingham, bristol]);
  assert.equal(blob.includes("£"), false);
  assert.equal(blob.includes("daily_charge"), false);
  assert.equal(blob.includes("fee_gbp"), false);
  assert.equal(blob.includes("charge_gbp"), false);
  assert.equal(blob.includes("-2.36"), false);
});

test("a grid file with no CRS is rejected, and an unclosed ring is rejected", () => {
  const grid = JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: {type: "Point", coordinates: [530000, 180000]},
    }],
  });
  assert.throws(() => parseLondonUlez(grid, FETCHED), /coordinate reference system is missing/);
  const open = JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {DESCRIPTIO: "Central London Congestion Charging Scheme"},
      geometry: {type: "Polygon", coordinates: [[[0, 51], [0.1, 51], [0.1, 51.1], [0, 51.1]]]},
    }],
  });
  assert.throws(() => parseTflCongestion(open, FETCHED), /not closed/);
});

test("the GOV.UK lists name zones and do not copy prices or Google coordinates", () => {
  const list = parseGovUkCazList(read("govuk-caz-list.html"));
  assert.deepEqual(list.entries.map((entry) => entry.name), [
    "Bath",
    "Birmingham",
    "Bradford",
    "Bristol",
    "Portsmouth",
    "Sheffield",
    "Tyneside (Newcastle and Gateshead)",
  ]);
  assert.equal(list.entries.find((entry) => entry.name === "Birmingham")?.cazClass, "D");
  const escaped = parseGovUkCazList(String.raw`<table><tr><th>City</th><th>Class</th></tr><tr><td>Birmingham</td><td>D</td></tr></table>`.replace(/</g, "\\u003c").replace(/>/g, "\\u003e"));
  assert.equal(escaped.entries[0]?.name, "Birmingham");
  const tolls = parseGovUkTollRoads(read("govuk-toll-roads.html"));
  assert.deepEqual(tolls.map((item) => [item.name, item.kind]), [
    ["M6 Toll", "toll"],
    ["Dartford Crossing", "toll"],
    ["Humber Bridge", "toll"],
    ["Tyne Tunnels", "tunnel"],
    ["Mersey Gateway", "toll"],
  ]);
  assert.match(tolls[0]?.reason ?? "", /Google map/);
  const blob = moneyBlob([list, tolls]);
  assert.equal(blob.includes("£"), false);
  assert.equal(blob.includes("52.6696759"), false);
  assert.equal(blob.includes("51.458435"), false);
  assert.equal(blob.includes("google.com"), false);
  assert.equal(blob.includes("3.50"), false);
  assert.equal(blob.includes("Tamar"), false);
});

test("OpenStreetMap gates keep ODbL attribution and drop fee tags", () => {
  const parsed = parseOsmGates(read("osm-gates.json"), FETCHED);
  assert.equal(parsed.zones.length, 1);
  const gate = parsed.zones[0];
  assert.ok(gate);
  assert.equal(gate.id, "osm-gate-42");
  assert.equal(gate.kind, "gate");
  assert.equal(gate.licence, "Open Database Licence (ODbL) 1.0");
  assert.equal(gate.attribution, "© OpenStreetMap contributors");
  assert.equal(gate.sourceUrl, "https://www.openstreetmap.org/node/42");
  assert.deepEqual(gate.geometry, {type: "Point", coordinates: [-2.71, 53.35]});
  assert.equal(parsed.omitted.map((item) => item.name).join(), "Booth with no position");
  const blob = moneyBlob(parsed);
  assert.equal(blob.includes("£"), false);
  assert.equal(blob.includes("2.50"), false);
  assert.equal(blob.includes("Farm gate"), false);
});

test("the fixture directory imports four zones and leaves gates off", async () => {
  const files = await readInput(FIXTURES, false);
  assert.equal(files.osmGates, undefined);
  assert.equal(files.osmGatesSkipped, true);
  const plan = buildImport(files, {fetchedAt: FETCHED, includeOsmGates: false});
  assert.deepEqual(plan.zones.map((zone) => zone.id), [
    "uk-bir-caz",
    "uk-brs-caz",
    "uk-lon-congestion-charge",
    "uk-lon-ulez",
  ]);
  const blob = moneyBlob(plan.zones);
  assert.equal(blob.includes("£"), false);
  assert.equal(blob.includes("9.876"), false);
  assert.equal(blob.includes("osm-gate"), false);
  assert.equal(plan.omitted.some((item) => item.name === "OpenStreetMap toll gates"), true);
  assert.equal(plan.omitted.some((item) => item.name === "Dartford Crossing"), true);
  assert.equal(plan.omitted.some((item) => item.name === "Bradford"), true);
  assert.equal(plan.omitted.some((item) => item.name === "Birmingham"), false);
  assert.equal(plan.excluded.map((item) => item.name).includes("Heathrow terminal drop-off"), true);
  const summary = summarise(plan, false);
  assert.match(summary, /Nothing was written/);
  assert.equal(summary.includes("£"), false);

  const withGates = buildImport(await readInput(FIXTURES, true), {fetchedAt: FETCHED, includeOsmGates: true});
  assert.equal(withGates.zones.some((zone) => zone.id === "osm-gate-42"), true);
  assert.equal(moneyBlob(withGates.zones).includes("£"), false);
});

test("a Clean Air Zone boundary is not written without the GOV.UK list", () => {
  const plan = buildImport({
    birminghamCaz: read("birmingham-caz.geojson"),
    osmGatesSkipped: false,
  }, {fetchedAt: FETCHED, includeOsmGates: false});
  assert.equal(plan.zones.length, 0);
  assert.match(plan.omitted[0]?.reason ?? "", /GOV.UK list/);
});

test("the writer refuses anything but the emulator and stores geometry as text", async () => {
  assert.throws(
    () => assertEmulatorOnly({emulatorHost: "", projectId: "demo-ferromaps-zones"}),
    /FIRESTORE_EMULATOR_HOST/,
  );
  assert.throws(
    () => assertEmulatorOnly({
      emulatorHost: "127.0.0.1:8080",
      projectId: "ferro-maps-staging-v2",
    }),
    /demo-/,
  );
  assert.throws(
    () => assertEmulatorOnly({emulatorHost: "", projectId: "ferro-maps-staging-v2"}),
    /FIRESTORE_EMULATOR_HOST/,
  );
  assert.doesNotThrow(() => assertEmulatorOnly({
    emulatorHost: "127.0.0.1:8080",
    projectId: "demo-ferromaps-zones",
  }));
  await assert.rejects(
    () => writeToEmulator("demo-ferromaps-zones", [], {}),
    /FIRESTORE_EMULATOR_HOST/,
  );
  await assert.rejects(
    () => writeToEmulator("ferro-maps-staging-v2", [], {FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080"}),
    /demo-/,
  );

  const zone = parseBirminghamCaz(read("birmingham-caz.geojson"), FETCHED);
  const [doc] = zoneDocuments([zone]);
  assert.ok(doc);
  assert.equal(COLLECTION, "road_charge_zones");
  assert.deepEqual(Object.keys(doc.data).sort(), [
    "attribution",
    "fetchedAt",
    "geometry",
    "id",
    "kind",
    "licence",
    "name",
    "sourceUrl",
  ]);
  assert.equal(typeof doc.data.geometry, "string");
  const geometry = JSON.parse(doc.data.geometry) as {type: string};
  assert.equal(geometry.type, "Polygon");
  assert.equal(moneyBlob(doc).includes("£"), false);
});

test("the command is off by default and does not write without the emulator", async () => {
  const writes: string[] = [];
  const off = await run([], {
    stdout: () => undefined,
    writeZones: async () => {
      writes.push("wrote");
    },
  });
  assert.equal(off, 0);
  assert.equal(writes.length, 0);

  const lines: string[] = [];
  const dry = await run(["--input", FIXTURES, "--fetched-at", FETCHED], {
    stdout: (line) => lines.push(line),
    writeZones: async () => {
      writes.push("wrote");
    },
  });
  assert.equal(dry, 0);
  assert.match(lines.join("\n"), /Nothing was written/);
  assert.equal(lines.join("\n").includes("osm-gate-42"), false);
  assert.equal(writes.length, 0);

  const refused = await run([
    "--input", FIXTURES,
    "--fetched-at", FETCHED,
    "--write",
    "--project", "demo-ferromaps-zones",
  ], {
    stdout: () => undefined,
    stderr: () => undefined,
    env: {},
    writeZones: async () => {
      writes.push("wrote");
    },
  });
  assert.equal(refused, 1);
  assert.equal(writes.length, 0);

  const unknown = await run([
    "--allow-" + "non-emulator",
    "--input", FIXTURES,
    "--write",
    "--project", "ferro-maps-staging-v2",
  ], {
    stdout: () => undefined,
    stderr: () => undefined,
    env: {FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080"},
    writeZones: async () => {
      writes.push("wrote");
    },
  });
  assert.equal(unknown, 2);
  assert.equal(writes.length, 0);

  const allowed = await run([
    "--input", FIXTURES,
    "--fetched-at", FETCHED,
    "--write",
    "--project", "demo-ferromaps-zones",
  ], {
    stdout: () => undefined,
    stderr: () => undefined,
    env: {FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080"},
    writeZones: async (_project, zones) => {
      writes.push(String(zones.length));
    },
  });
  assert.equal(allowed, 0);
  assert.deepEqual(writes, ["4"]);
  assert.equal(parseArgs([]).includeOsmGates, false);
  assert.equal(parseArgs(["--include-osm-gates"]).includeOsmGates, true);
  assert.throws(() => parseArgs(["--allow-" + "non-emulator"]), /unknown argument/);
});

test("writes stay on the emulator, and rules and indexes are untouched", () => {
  const removedFlag = "--allow-" + "non-emulator";
  const osmFlag = "--include-osm-gates";
  const removedHits: string[] = [];
  const osmHits: string[] = [];
  const allowedOsm = `${path.sep}scripts${path.sep}import-road-charge-zones${path.sep}`;
  const docs = path.join(REPO, "docs", "road-charge-zones.md");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "lib" || entry === "dist" || entry === ".git") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const text = readFileSync(full, "utf8");
      const relative = path.relative(REPO, full);
      if (text.includes(removedFlag)) removedHits.push(relative);
      if (text.includes(osmFlag) && !full.includes(allowedOsm) && full !== docs) osmHits.push(relative);
    }
  };
  walk(REPO);
  assert.deepEqual(removedHits, []);
  assert.deepEqual(osmHits, []);

  for (const name of ["firebase.json", "firestore.indexes.json", "firestore.rules", "functions/src/index.ts"]) {
    const text = readFileSync(path.join(REPO, name), "utf8");
    assert.equal(text.includes("road_charge_zones"), false, name);
    assert.equal(text.includes(removedFlag), false, name);
  }

  const packageSrc = readFileSync(path.join(REPO, "scripts/import-road-charge-zones/package.json"), "utf8");
  assert.equal(packageSrc.includes(removedFlag), false);
  assert.equal(packageSrc.includes(osmFlag), false);
  assert.equal(packageSrc.includes("fetch"), false);
});

test("docs name every source URL, and the parsers do not open the network", () => {
  const docs = readFileSync(path.join(REPO, "docs", "road-charge-zones.md"), "utf8");
  const urls = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("https://")) urls.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(sources);
  assert.ok(urls.size >= 8);
  for (const url of urls) assert.ok(docs.includes(url), url);

  const root = fileURLToPath(new URL("..", import.meta.url));
  const files: string[] = [];
  const walkFiles = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walkFiles(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  walkFiles(root);
  const network = /from ["']node:(https|http|net)["']|\bfetch\s*\(/;
  for (const file of files) {
    assert.equal(network.test(readFileSync(file, "utf8")), false, file);
  }
});
