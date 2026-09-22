import {Firestore, Timestamp} from "firebase-admin/firestore";
import {canonicalCategory} from "./categories";
import {LONDON_TZ} from "./london";

/**
 * Why drivers do or do not act on an alert.
 *
 * notificationLog records what was sent and what became of it, but nobody has
 * ever been able to read it: it is owner-scoped, one row per driver per alert.
 * Aggregated here, it answers the question the funnel alone cannot — not how
 * many alerts failed, but which kind failed: too far away, too weakly scored,
 * sent at the wrong hour, or for a kind of place drivers have given up on.
 *
 * Rates are taken over CHECKED alerts only. markActedNotifications decides
 * whether a driver turned up once the window has passed, so an alert sent an
 * hour ago is not yet a failure and must not be counted as one.
 */

export const INSIGHT_WINDOW_DAYS = 30;

/** Travel-time bands, in minutes. The question is how far is too far. */
const TRAVEL_BANDS = [5, 10, 15, 20, 30];

/** Alerts read per run. Comfortably above a month at present volumes. */
const SCAN_LIMIT = 20_000;

export interface Split {
  sent: number;
  opened: number;
  checked: number;
  actedOn: number;
}

export interface AlertInsights {
  builtAt: Timestamp;
  windowDays: number;
  totals: Split;
  /** Keyed by "<5", "5-10" … "30+". */
  byTravel: Record<string, Split>;
  /** Keyed by score rounded down to the nearest 0.05. */
  byScore: Record<string, Split>;
  /** Keyed by hour of the London day, "00" to "23". */
  byHour: Record<string, Split>;
  byCategory: Record<string, Split>;
  /** Whether an alert-led visit works out better than one found on the map. */
  visits: {fromAlert: {visits: number; jobs: number}; fromMap: {visits: number; jobs: number}};
  /** Drivers against the three-a-day ceiling, from the per-driver budgets. */
  budget: {driversNotified: number; atCap: number};
}

function emptySplit(): Split {
  return {sent: 0, opened: 0, checked: 0, actedOn: 0};
}

function add(into: Record<string, Split>, key: string, opened: boolean, checked: boolean, acted: boolean): void {
  const split = into[key] ?? emptySplit();
  split.sent++;
  if (opened) split.opened++;
  if (checked) split.checked++;
  if (acted) split.actedOn++;
  into[key] = split;
}

function travelBand(minutes: number): string {
  let previous = 0;
  for (const band of TRAVEL_BANDS) {
    if (minutes < band) return previous === 0 ? `<${band}` : `${previous}-${band}`;
    previous = band;
  }
  return `${TRAVEL_BANDS[TRAVEL_BANDS.length - 1]}+`;
}

function scoreBand(score: number): string {
  return (Math.floor(score * 20) / 20).toFixed(2);
}

function londonHour(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {timeZone: LONDON_TZ, hour: "2-digit", hour12: false}).format(date);
}

/**
 * Aggregate the alert log, and what visits followed, over the window.
 * @param {Firestore} db the Admin SDK handle, which rules do not apply to.
 * @param {Date} now the instant to measure back from.
 * @return {Promise<AlertInsights>} the document to write.
 */
export async function computeAlertInsights(db: Firestore, now = new Date()): Promise<AlertInsights> {
  const since = Timestamp.fromMillis(now.getTime() - INSIGHT_WINDOW_DAYS * 86_400_000);

  const [alerts, outcomes, budgets] = await Promise.all([
    db
      .collection("notificationLog")
      .where("sentAt", ">=", since)
      .select("category", "score", "travelMinutes", "opened", "actedOn", "checked", "sentAt")
      .limit(SCAN_LIMIT)
      .get(),
    db
      .collection("hotspotOutcomes")
      .where("recordedAt", ">=", since)
      .select("outcome", "cameFromNotification")
      .get(),
    db.collectionGroup("private").select("notificationsToday").get(),
  ]);

  const totals = emptySplit();
  const byTravel: Record<string, Split> = {};
  const byScore: Record<string, Split> = {};
  const byHour: Record<string, Split> = {};
  const byCategory: Record<string, Split> = {};

  for (const doc of alerts.docs) {
    const opened = doc.get("opened") === true;
    const checked = doc.get("checked") === true;
    const acted = doc.get("actedOn") === true;

    totals.sent++;
    if (opened) totals.opened++;
    if (checked) totals.checked++;
    if (acted) totals.actedOn++;

    const travel = doc.get("travelMinutes") as number | undefined;
    if (typeof travel === "number") add(byTravel, travelBand(travel), opened, checked, acted);

    const score = doc.get("score") as number | undefined;
    if (typeof score === "number") add(byScore, scoreBand(score), opened, checked, acted);

    const sentAt = doc.get("sentAt") as Timestamp | undefined;
    if (sentAt) add(byHour, londonHour(sentAt.toDate()), opened, checked, acted);

    add(byCategory, canonicalCategory(doc.get("category") as string | undefined), opened, checked, acted);
  }

  const visits = {
    fromAlert: {visits: 0, jobs: 0},
    fromMap: {visits: 0, jobs: 0},
  };
  for (const doc of outcomes.docs) {
    const side = doc.get("cameFromNotification") === true ? visits.fromAlert : visits.fromMap;
    side.visits++;
    const outcome = doc.get("outcome") as string | undefined;
    if (outcome === "job_quick" || outcome === "job_slow") side.jobs++;
  }

  // One budget document per driver who has ever been alerted, holding today's
  // count. Three is the daily ceiling notifyOnStateChange enforces.
  let driversNotified = 0;
  let atCap = 0;
  for (const doc of budgets.docs) {
    const count = doc.get("notificationsToday") as number | undefined;
    if (typeof count !== "number") continue;
    driversNotified++;
    if (count >= 3) atCap++;
  }

  return {
    builtAt: Timestamp.fromDate(now),
    windowDays: INSIGHT_WINDOW_DAYS,
    totals,
    byTravel,
    byScore,
    byHour,
    byCategory,
    visits,
    budget: {driversNotified, atCap},
  };
}
