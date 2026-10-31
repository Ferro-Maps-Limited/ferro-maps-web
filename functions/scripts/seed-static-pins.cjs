#!/usr/bin/env node
/**
 * Idempotent static pin seed. Dry-run by default. Does not connect unless
 * --project is a demo- id and FIRESTORE_EMULATOR_HOST is set.
 *
 *   node functions/scripts/seed-static-pins.cjs --project demo-ferromaps-pins
 *
 * Default input is scripts/seed-static-pins/fixedHotspots.json
 * (iOS main b3084e7, FerroMaps/FerroMaps/Resources/Data/fixedHotspots.json).
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_INPUT = path.resolve(__dirname, "../../scripts/seed-static-pins/fixedHotspots.json");
const {
  planStaticSeed,
  loadRows,
  applyStaticSeed,
  parseSeedArgs,
  canReadLive,
  assertCanWrite,
} = require("../lib/pins/seedStatic");
const {liveDraftFromHotspot} = require("../lib/pins/drafts");

async function readLive(project, now) {
  const {initializeApp, getApps} = require("firebase-admin/app");
  const {getFirestore} = require("firebase-admin/firestore");
  if (getApps().length === 0) initializeApp({projectId: project});
  const db = getFirestore();
  const snap = await db.collection("hotspots_test").get();
  const live = [];
  for (const doc of snap.docs) {
    const draft = liveDraftFromHotspot(doc.id, doc.data(), now);
    if (draft) live.push(draft);
  }
  return live;
}

async function main(argv) {
  const args = parseSeedArgs(argv);
  if (!args.project) {
    console.error("Refusing to run without --project.");
    process.exitCode = 1;
    return;
  }
  if (!args.input) args.input = DEFAULT_INPUT;
  const parsed = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
  const rows = loadRows(parsed);
  const now = new Date();
  let live = null;
  if (canReadLive(args.project)) {
    live = await readLive(args.project, now);
  }
  const plan = planStaticSeed(rows, now, live);
  const closed = plan.drafts.filter((draft) => draft.windowEndMs <= now.getTime()).length;
  const byCategory = {};
  const tiles = new Map();
  for (const draft of plan.drafts) {
    byCategory[draft.category] = (byCategory[draft.category] || 0) + 1;
    const tile = tiles.get(draft.g5) || {all: 0, active: 0};
    tile.all += 1;
    if (draft.windowEndMs > now.getTime()) tile.active += 1;
    tiles.set(draft.g5, tile);
  }
  const ranked = [...tiles.entries()].sort((a, b) => b[1].active - a[1].active || b[1].all - a[1].all);
  const rawOver = ranked.filter((entry) => entry[1].active > 500);
  console.log(`totalDocs: ${plan.drafts.length}`);
  console.log(`docsPerCategory: ${JSON.stringify(byCategory)}`);
  console.log(`distinctG5: ${tiles.size}`);
  console.log("top10ByActiveCount:");
  for (const [g5, tile] of ranked.slice(0, 10)) {
    console.log(`  ${g5} active=${tile.active} all=${tile.all}`);
  }
  console.log(
      `rawTilesOver500: ${rawOver.length} (static pins with window_end > now; live pins add more)`,
  );
  console.log(plan.report);
  console.log(`staticPins: ${plan.drafts.length}`);
  console.log(`staticClosed: ${closed}`);
  if (plan.errors.length) {
    console.log(`errors: ${plan.errors.length}`);
    for (const error of plan.errors) console.log(`  ${error}`);
  }
  if (!canReadLive(args.project)) {
    console.log("Live counts were not read because this is not an emulator demo- project.");
  }
  if (!args.write) {
    console.log("Dry run. No documents were written.");
    return;
  }
  assertCanWrite(args.project);
  const {initializeApp, getApps} = require("firebase-admin/app");
  const {getFirestore} = require("firebase-admin/firestore");
  if (getApps().length === 0) initializeApp({projectId: args.project});
  await applyStaticSeed(getFirestore(), rows, now);
  console.log(`Wrote ${plan.drafts.length} static pins on ${args.project}.`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {main};
