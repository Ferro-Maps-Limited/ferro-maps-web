import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {getFirestore} from "firebase-admin/firestore";
import {addDays, londonDayKey, LONDON_TZ} from "./london";
import {computeDaily, computeLive, type LiveStats} from "./stats";
import {computeHotspotScores} from "./hotspotScores";
import {computeAlertInsights} from "./alertInsights";
import {computeGrowth} from "./growth";

/**
 * Where the console reads its figures. Rules give admins read and nobody
 * write, so these documents are only ever produced here.
 */
export const LIVE_DOC = "adminStats/live";

/** The hotspot scoreboard. No dayKey, so the daily queries pass over it. */
export const HOTSPOT_SCORES_DOC = "adminStats/hotspotScores";

/** Why alerts land or do not. Also carries no dayKey, for the same reason. */
export const ALERT_INSIGHTS_DOC = "adminStats/alertInsights";

/** Sign-ups, conversion and subscriptions. Likewise no dayKey. */
export const GROWTH_DOC = "adminStats/growth";

export function dailyDocPath(dayKey: string): string {
  return `adminStats/daily_${dayKey}`;
}

/**
 * The Overview's "right now" panel.
 *
 * Five minutes is a compromise: often enough that "drivers online" is worth
 * looking at, rare enough that the counts cost a few hundred reads an hour
 * however many drivers there are. The console shows builtAt so nobody mistakes
 * it for a live feed.
 */
export const buildAdminLiveStats = onSchedule(
  {schedule: "*/5 * * * *", timeZone: LONDON_TZ, region: "europe-west2"},
  async () => {
    const db = getFirestore();
    const liveRef = db.doc(LIVE_DOC);

    // Carried forward so today's peak survives a restart; it is the one figure
    // here that cannot be recovered from a later query.
    const existing = await liveRef.get();
    const previous = existing.exists ? (existing.data() as LiveStats) : null;

    const live = await computeLive(db, previous);
    await liveRef.set(live);

    logger.info(
      `buildAdminLiveStats: ${live.drivers.online} online, ${live.tickets.open} open tickets, ` +
      `${live.pipeline.firingAlerts.length} firing alerts`
    );
  }
);

/**
 * Closes yesterday.
 *
 * Runs at 00:20 London, twenty minutes after the day ends, so the day is
 * settled but lastActiveAt has not yet been overwritten by today's activity —
 * see the note on DailyStats.drivers.active.
 *
 * Daily documents are never rewritten by the console and never expire: a
 * 30-day chart is 30 document reads whatever the fleet grows to.
 */
export const buildAdminDailyStats = onSchedule(
  {schedule: "20 0 * * *", timeZone: LONDON_TZ, region: "europe-west2"},
  async () => {
    const db = getFirestore();
    const dayKey = addDays(londonDayKey(new Date()), -1);

    const live = await db.doc(LIVE_DOC).get();
    const peak = live.exists ? (live.data() as LiveStats).onlinePeak : null;

    const daily = await computeDaily(db, dayKey, {
      onlinePeak: peak?.dayKey === dayKey ? peak.value : null,
    });
    await db.doc(dailyDocPath(dayKey)).set(daily);

    // Scored in the same run: the scoreboard reads the same two collections
    // the day just closed over, and nothing else reads them.
    const [scores, insights, growth] = await Promise.all([
      computeHotspotScores(db),
      computeAlertInsights(db),
      computeGrowth(db),
    ]);
    await Promise.all([
      db.doc(HOTSPOT_SCORES_DOC).set(scores),
      db.doc(ALERT_INSIGHTS_DOC).set(insights),
      db.doc(GROWTH_DOC).set(growth),
    ]);

    logger.info(
      `buildAdminDailyStats ${dayKey}: ${daily.drivers.active} active, ${daily.alerts.sent} alerts, ` +
      `${daily.outcomes.visits} visits, ${scores.items.length} hotspots scored, ` +
      `${insights.totals.sent} alerts analysed`
    );
  }
);
