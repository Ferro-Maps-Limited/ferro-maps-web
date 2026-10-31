import {FieldPath, Firestore, GeoPoint, Timestamp} from "firebase-admin/firestore";
import {PinDraft, liveDraftFromHotspot, staticDraftFromStored, activeMembers} from "./drafts";
import {splitTiles} from "./splitTile";
import {formatTileReport, tileReport} from "./tileReport";

export interface PinLog {
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface PublishResult {
  written: number;
  active: number;
  tilesOver500: number;
  rawOver: string[];
  report: string;
}

const silent: PinLog = {
  warn() {
    return undefined;
  },
  info() {
    return undefined;
  },
};

async function readAll(db: Firestore, name: string) {
  const out = [];
  const base = db.collection(name);
  let query = base.orderBy(FieldPath.documentId()).limit(400);
  for (;;) {
    const snap = await query.get();
    if (snap.empty) break;
    out.push(...snap.docs);
    if (snap.size < 400) break;
    query = base.orderBy(FieldPath.documentId()).startAfter(snap.docs[snap.docs.length - 1]).limit(400);
  }
  return out;
}

function payload(draft: PinDraft, now: Date, active: boolean): Record<string, unknown> {
  const end = active ? draft.openEnd : now;
  const start = active ? draft.openStart : now;
  const body: Record<string, unknown> = {
    v: 1,
    category: draft.category,
    title: draft.title,
    p: new GeoPoint(draft.lat, draft.lng),
    startAt: Timestamp.fromDate(start),
    endAt: Timestamp.fromDate(end),
    window_start: Timestamp.fromDate(start),
    window_end: Timestamp.fromDate(end),
    g5: draft.g5,
    src: draft.staticPin ? "static" : "live",
    pinId: draft.id,
    updatedAt: Timestamp.fromDate(now),
  };
  if (draft.city) body.city = draft.city;
  if (draft.country) body.country = draft.country;
  if (draft.events) body.events = draft.events;
  if (draft.parking) body.parking = draft.parking;
  if (draft.expireAt) body.expire_at = Timestamp.fromDate(draft.expireAt);
  return body;
}

function tileBody(now: Date, shards: number, pins: Record<string, Record<string, unknown>>) {
  const body: Record<string, unknown> = {
    v: 1,
    generatedAt: Timestamp.fromDate(now),
    pins,
  };
  if (shards > 0) body.shards = shards;
  return body;
}

function surgeEntry(draft: PinDraft): Record<string, unknown> {
  if (!draft.liveSurge) return {};
  const surge = draft.liveSurge;
  return {
    liveSurge: {
      active: surge.active,
      level: surge.level,
      since: Timestamp.fromDate(surge.since as Date),
      expiresAt: Timestamp.fromDate(surge.expiresAt as Date),
      v: 1,
    },
  };
}

/**
 * Rebuild pins and pinTiles. Static windows roll forward from events.
 * Parking windows are now plus 24h. Overflow past 500 pins goes to shards.
 * @param {Firestore} db emulator or project database.
 * @param {Date} now clock.
 * @param {PinLog} log warning sink.
 * @return {Promise<PublishResult>} counts and the tile report.
 */
export async function publishPins(db: Firestore, now: Date, log: PinLog = silent): Promise<PublishResult> {
  const [hotspots, existingPins, existingTiles] = await Promise.all([
    readAll(db, "hotspots_test"),
    readAll(db, "pins"),
    readAll(db, "pinTiles"),
  ]);

  const drafts = new Map<string, PinDraft>();
  const hotspotSrc = new Map<string, "static" | "live">();
  for (const doc of existingPins) {
    const data = doc.data();
    if (String(data.src ?? "").toLowerCase() !== "static") continue;
    const draft = staticDraftFromStored(doc.id, data, now);
    if (draft) drafts.set(draft.id, draft);
  }
  for (const doc of hotspots) {
    const draft = liveDraftFromHotspot(doc.id, doc.data(), now);
    if (!draft || drafts.has(draft.id)) {
      if (draft?.hotspotSrc) hotspotSrc.set(doc.id, draft.hotspotSrc);
      continue;
    }
    drafts.set(draft.id, draft);
    if (draft.hotspotSrc) hotspotSrc.set(doc.id, draft.hotspotSrc);
  }

  const visible = activeMembers([...drafts.values()], now);
  const hidden = [...drafts.values()].filter((draft) => draft.windowEndMs <= now.getTime());
  const split = splitTiles(visible);
  const assigned = new Set<string>();
  for (const group of split.groups) {
    for (const member of group.members) assigned.add(member.id);
  }
  const report = tileReport(visible, split, true);
  for (const g5 of split.warnG5) {
    const count = visible.filter((draft) => draft.g5 === g5).length;
    log.warn("pin tile is close to or over the 500 cap", {g5, count});
  }
  if (!split.tilesFit) {
    log.warn("pin tile still over 500 after splitting into 9 shards", {
      unassigned: split.unassigned.length,
    });
  }

  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };
  const queue = async (fn: () => void) => {
    fn();
    ops += 1;
    if (ops >= 400) await flush();
  };

  const keep = new Set<string>();
  const tilePins = new Map<string, Record<string, Record<string, unknown>>>();
  const extraShards = new Map<string, number>();
  for (const group of split.groups) {
    extraShards.set(group.g5, Math.max(extraShards.get(group.g5) ?? 0, group.shard));
    const pins = tilePins.get(`${group.g5}:${group.shard}`) ?? {};
    for (const member of group.members) {
      const draft = drafts.get(member.id);
      if (!draft) continue;
      keep.add(draft.id);
      pins[draft.id] = surgeEntry(draft);
      const active = group.shard === 0;
      await queue(() => batch.set(db.collection("pins").doc(draft.id), payload(draft, now, active)));
    }
    tilePins.set(`${group.g5}:${group.shard}`, pins);
  }
  for (const draft of hidden) {
    keep.add(draft.id);
    await queue(() => batch.set(db.collection("pins").doc(draft.id), payload(draft, now, false)));
  }

  const g5s = new Set<string>([...extraShards.keys(), ...hidden.map((draft) => draft.g5)]);
  for (const g5 of g5s) {
    const shards = extraShards.get(g5) ?? 0;
    const basePins = tilePins.get(`${g5}:0`) ?? {};
    await queue(() => batch.set(db.collection("pinTiles").doc(g5), tileBody(now, shards, basePins)));
    for (let shard = 1; shard <= 8; shard += 1) {
      const id = `${g5}_${shard}`;
      if (shard <= shards) {
        const pins = tilePins.get(`${g5}:${shard}`) ?? {};
        await queue(() => batch.set(db.collection("pinTiles").doc(id), tileBody(now, 0, pins)));
      }
    }
  }

  for (const doc of existingPins) {
    if (!keep.has(doc.id)) {
      await queue(() => batch.delete(doc.ref));
    }
  }
  for (const doc of existingTiles) {
    const parsed = doc.id.match(/^([0-9b-hjkmnp-z]{5})(?:_([1-8]))?$/);
    if (!parsed) continue;
    const g5 = parsed[1];
    const shard = parsed[2] ? Number(parsed[2]) : 0;
    if (!g5s.has(g5) || shard > (extraShards.get(g5) ?? 0)) {
      await queue(() => batch.delete(doc.ref));
    }
  }
  for (const [id, src] of hotspotSrc) {
    await queue(() => batch.set(db.collection("hotspots_test").doc(id), {src}, {merge: true}));
  }
  await flush();

  log.info("publishPins complete", {written: keep.size, tilesOver500: report.tilesOver500});
  return {
    written: keep.size,
    active: split.groups.filter((group) => group.shard === 0)
      .reduce((sum, group) => sum + group.members.length, 0),
    tilesOver500: report.tilesOver500,
    rawOver: split.rawOver,
    report: formatTileReport(report.lines, report.tilesOver500, true),
  };
}
