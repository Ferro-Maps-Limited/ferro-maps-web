#!/usr/bin/env node
/**
 * Read-only pinsV1 gate for ferro-maps-staging-v2 (alias live).
 * Static docs come from scripts/seed-static-pins/fixedHotspots.json.
 * Live parking and event pins are what publishPinFeed would build from
 * hotspots_test. Existing pins with window_end > now are included too.
 * This process never writes.
 *
 *   GOOGLE_CLOUD_PROJECT=ferro-maps-staging-v2 \
 *     node scripts/pins-dryrun-combined.js --project ferro-maps-staging-v2
 */
const fs = require("fs");
const path = require("path");
const {createRequire} = require("module");
const {parseReadOnlyProject} = require("./read-only-args");

const requireFromFunctions = createRequire(path.join(__dirname, "../functions/package.json"));
const {planStaticSeed, loadRows} = requireFromFunctions("./lib/pins/seedStatic");
const {liveDraftFromHotspot} = requireFromFunctions("./lib/pins/drafts");
const {splitTiles} = requireFromFunctions("./lib/pins/splitTile");
const {geohash5} = requireFromFunctions("./lib/pins/geohash");

const STATIC_FILE = path.join(__dirname, "seed-static-pins/fixedHotspots.json");

function sourceOfLive(draft) {
  if (draft.category === "parking") return "parking";
  if (draft.category === "event") return "event";
  return "other";
}

async function readAll(db, name, build) {
  const out = [];
  let last = null;
  for (;;) {
    let query = build(db.collection(name)).limit(300);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;
    out.push(...snap.docs);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 300) break;
  }
  return out;
}

function existingMember(doc, nowMs) {
  const data = doc.data();
  const end = data.window_end && typeof data.window_end.toDate === "function" ?
    data.window_end.toDate() : null;
  if (!end || end.getTime() <= nowMs) return null;
  let g5 = typeof data.g5 === "string" ? data.g5 : "";
  if (!g5 && data.p && typeof data.p.latitude === "number") {
    g5 = geohash5(data.p.latitude, data.p.longitude);
  }
  if (!g5) return null;
  return {
    id: doc.id,
    g5,
    staticPin: String(data.src || "").toLowerCase() === "static",
    windowEndMs: end.getTime(),
    source: "existing",
  };
}

async function main(argv) {
  const parsed = parseReadOnlyProject(argv);
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const project = parsed.project;
  console.log(`project: ${project}`);

  const {initializeApp, getApps} = requireFromFunctions("firebase-admin/app");
  const {getFirestore, FieldPath, Timestamp} = requireFromFunctions("firebase-admin/firestore");
  if (getApps().length === 0) initializeApp({projectId: project});
  const db = getFirestore();
  const now = new Date();
  const nowTs = Timestamp.fromDate(now);

  const rows = loadRows(JSON.parse(fs.readFileSync(STATIC_FILE, "utf8")));
  const staticPlan = planStaticSeed(rows, now, null);
  const staticActive = staticPlan.drafts
      .filter((draft) => draft.windowEndMs > now.getTime())
      .map((draft) => ({
        id: draft.id,
        g5: draft.g5,
        staticPin: true,
        windowEndMs: draft.windowEndMs,
        source: "static",
      }));

  const hotspots = await readAll(db, "hotspots_test", (col) => col
      .orderBy(FieldPath.documentId())
      .select(
          "name", "category", "location", "window_start", "window_end",
          "expire_at", "createdAt", "fetched_at", "src", "city", "country",
          "events", "parking", "liveSurge",
      ));
  const live = [];
  for (const doc of hotspots) {
    const draft = liveDraftFromHotspot(doc.id, doc.data(), now);
    if (!draft || draft.windowEndMs <= now.getTime()) continue;
    live.push({
      id: draft.id,
      g5: draft.g5,
      staticPin: false,
      windowEndMs: draft.windowEndMs,
      source: sourceOfLive(draft),
    });
  }

  const pinDocs = await readAll(db, "pins", (col) => col
      .where("window_end", ">", nowTs)
      .orderBy("window_end")
      .select("g5", "category", "src", "p", "window_end"));
  const existing = [];
  let existingSkipped = 0;
  for (const doc of pinDocs) {
    const member = existingMember(doc, now.getTime());
    if (!member) {
      existingSkipped += 1;
      continue;
    }
    existing.push(member);
  }

  const byId = new Map();
  for (const member of staticActive) byId.set(member.id, member);
  for (const member of live) {
    if (!byId.has(member.id)) byId.set(member.id, member);
  }
  for (const member of existing) {
    if (!byId.has(member.id)) byId.set(member.id, member);
  }
  const combined = [...byId.values()];
  const split = splitTiles(combined);
  const tilesOver500Before = split.rawOver.length;
  const tilesOver500After = new Set(split.unassigned.map((member) => member.g5)).size;

  const raw = {
    static: staticActive.length,
    parking: live.filter((member) => member.source === "parking").length,
    event: live.filter((member) => member.source === "event").length,
    existing: existing.length,
    other: live.filter((member) => member.source === "other").length,
  };
  console.log(`static: ${raw.static} active of ${staticPlan.drafts.length} seed docs`);
  console.log(`parking: ${raw.parking}`);
  console.log(`event: ${raw.event}`);
  console.log(`existing: ${raw.existing}`);
  if (raw.other) console.log(`other: ${raw.other}`);
  if (existingSkipped) console.log(`existingSkipped: ${existingSkipped}`);
  console.log(`combinedUnique: ${combined.length}`);

  const tiles = new Map();
  for (const member of combined) {
    const tile = tiles.get(member.g5) || {static: 0, parking: 0, event: 0, existing: 0, other: 0, total: 0};
    tile[member.source] += 1;
    tile.total += 1;
    tiles.set(member.g5, tile);
  }
  const ranked = [...tiles.entries()].sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1));
  console.log(`distinctG5: ${tiles.size}`);
  console.log(`tilesOver500Before: ${tilesOver500Before}`);
  console.log(`tilesOver500After: ${tilesOver500After}`);
  console.log("top20:");
  for (const [g5, tile] of ranked.slice(0, 20)) {
    console.log(
        `  ${g5} total=${tile.total} static=${tile.static} parking=${tile.parking} ` +
        `event=${tile.event} existing=${tile.existing} other=${tile.other}`,
    );
  }
  console.log("Live pins beyond parking and event are counted as other. No documents were written.");
  if (tilesOver500After > 0) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {main};
