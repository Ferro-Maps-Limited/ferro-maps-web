import {Firestore, Timestamp} from "firebase-admin/firestore";
import {canonicalCategory} from "./categories";

/**
 * How each hotspot actually worked out for the drivers sent to it.
 *
 * The question the console could never answer: this pin was on the map, and
 * the alert went out — did anyone get a job? It is answered by joining two
 * owner-scoped collections no browser may read, hotspotOutcomes and
 * notificationLog, on hotspotId.
 *
 * The result is one document rather than one per hotspot. Visits are counted
 * in the low hundreds a month, so the whole scoreboard fits in a single read,
 * and a table that loads at once can be sorted without paging.
 */

/** How far back a scorecard looks. */
export const SCORE_WINDOW_DAYS = 30;

/** Rows kept, busiest first. Beyond this the tail is noise. */
const MAX_ROWS = 150;

/** Distance bands, in metres, for how far drivers move after arriving. */
const DRIFT_BANDS = [50, 100, 150, 200, 300, 400, 600];

export interface HotspotScore {
  hotspotId: string;
  name: string;
  category: string;
  visits: number;
  jobQuick: number;
  jobSlow: number;
  noJob: number;
  /** Visits that began with an alert rather than the driver browsing the map. */
  fromAlert: number;
  medianWaitMinutes: number | null;
  alertsSent: number;
  alertsActedOn: number;
}

export interface HotspotScores {
  builtAt: Timestamp;
  windowDays: number;
  items: HotspotScore[];
  /** Counts per distance band, plus the median, of arrival to waiting spot. */
  drift: {bands: Record<string, number>; medianMetres: number | null};
  totals: {visits: number; jobs: number; alertsSent: number; alertsActedOn: number};
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/**
 * Metres between two points, near enough at city distances.
 * @param {number} lat1 first latitude.
 * @param {number} lng1 first longitude.
 * @param {number} lat2 second latitude.
 * @param {number} lng2 second longitude.
 * @return {number} the distance in whole metres.
 */
function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const metresPerDegree = 111_320;
  const dy = (lat2 - lat1) * metresPerDegree;
  const dx = (lng2 - lng1) * metresPerDegree * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

function bandFor(metres: number): string {
  for (const band of DRIFT_BANDS) {
    if (metres < band) return `<${band}`;
  }
  return `${DRIFT_BANDS[DRIFT_BANDS.length - 1]}+`;
}

function emptyScore(hotspotId: string): HotspotScore {
  return {
    hotspotId,
    name: hotspotId,
    category: "unknown",
    visits: 0,
    jobQuick: 0,
    jobSlow: 0,
    noJob: 0,
    fromAlert: 0,
    medianWaitMinutes: null,
    alertsSent: 0,
    alertsActedOn: 0,
  };
}

/**
 * Score every hotspot drivers visited or were alerted to in the window.
 * @param {Firestore} db the Admin SDK handle, which rules do not apply to.
 * @param {Date} now the instant to measure back from.
 * @return {Promise<HotspotScores>} the scoreboard document to write.
 */
export async function computeHotspotScores(db: Firestore, now = new Date()): Promise<HotspotScores> {
  const since = Timestamp.fromMillis(now.getTime() - SCORE_WINDOW_DAYS * 86_400_000);

  const [outcomes, alerts] = await Promise.all([
    db
      .collection("hotspotOutcomes")
      .where("recordedAt", ">=", since)
      .select(
        "hotspotId", "hotspotName", "category", "outcome", "waitMinutes",
        "cameFromNotification", "arrivalLat", "arrivalLng", "waitLat", "waitLng"
      )
      .get(),
    db
      .collection("notificationLog")
      .where("sentAt", ">=", since)
      .select("hotspotId", "category", "actedOn", "checked")
      .get(),
  ]);

  const scores = new Map<string, HotspotScore>();
  const waits = new Map<string, number[]>();
  const driftBands: Record<string, number> = {};
  const drifts: number[] = [];

  for (const doc of outcomes.docs) {
    const hotspotId = doc.get("hotspotId") as string | undefined;
    if (!hotspotId) continue;

    const score = scores.get(hotspotId) ?? emptyScore(hotspotId);
    score.name = (doc.get("hotspotName") as string) ?? score.name;
    score.category = canonicalCategory(doc.get("category") as string | undefined);
    score.visits++;

    const outcome = doc.get("outcome") as string | undefined;
    if (outcome === "job_quick") score.jobQuick++;
    else if (outcome === "job_slow") score.jobSlow++;
    else score.noJob++;

    if (doc.get("cameFromNotification") === true) score.fromAlert++;

    const wait = doc.get("waitMinutes") as number | undefined;
    if (typeof wait === "number") {
      const list = waits.get(hotspotId) ?? [];
      list.push(wait);
      waits.set(hotspotId, list);
    }

    // Where a driver ended up waiting, against where they first stopped. A pin
    // that everyone walks away from is a pin in the wrong place — the one
    // thing the demand pipeline cannot work out for itself.
    const arrivalLat = doc.get("arrivalLat") as number | undefined;
    const arrivalLng = doc.get("arrivalLng") as number | undefined;
    const waitLat = doc.get("waitLat") as number | undefined;
    const waitLng = doc.get("waitLng") as number | undefined;
    if (
      typeof arrivalLat === "number" && typeof arrivalLng === "number" &&
      typeof waitLat === "number" && typeof waitLng === "number"
    ) {
      const metres = metresBetween(arrivalLat, arrivalLng, waitLat, waitLng);
      drifts.push(metres);
      const band = bandFor(metres);
      driftBands[band] = (driftBands[band] ?? 0) + 1;
    }

    scores.set(hotspotId, score);
  }

  for (const doc of alerts.docs) {
    const hotspotId = doc.get("hotspotId") as string | undefined;
    if (!hotspotId) continue;

    const score = scores.get(hotspotId) ?? emptyScore(hotspotId);
    if (score.category === "unknown") score.category = canonicalCategory(doc.get("category") as string | undefined);
    score.alertsSent++;
    if (doc.get("actedOn") === true) score.alertsActedOn++;
    scores.set(hotspotId, score);
  }

  for (const [hotspotId, list] of waits) {
    const score = scores.get(hotspotId);
    if (score) score.medianWaitMinutes = median(list);
  }

  const items = [...scores.values()]
    .sort((a, b) => b.visits - a.visits || b.alertsSent - a.alertsSent)
    .slice(0, MAX_ROWS);

  const totals = items.reduce(
    (sum, item) => ({
      visits: sum.visits + item.visits,
      jobs: sum.jobs + item.jobQuick + item.jobSlow,
      alertsSent: sum.alertsSent + item.alertsSent,
      alertsActedOn: sum.alertsActedOn + item.alertsActedOn,
    }),
    {visits: 0, jobs: 0, alertsSent: 0, alertsActedOn: 0}
  );

  return {
    builtAt: Timestamp.fromDate(now),
    windowDays: SCORE_WINDOW_DAYS,
    items,
    drift: {bands: driftBands, medianMetres: median(drifts)},
    totals,
  };
}
