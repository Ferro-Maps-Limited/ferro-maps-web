import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {getFirestore} from "firebase-admin/firestore";
import {addDays, londonDayKey, LONDON_TZ} from "./london";
import {computeDaily, computeLive, type LiveStats} from "./stats";

/**
 * Where the console reads its figures. Rules give admins read and nobody
 * write, so these documents are only ever produced here.
 */
export const LIVE_DOC = "adminStats/live";

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

    logger.info(
      `buildAdminDailyStats ${dayKey}: ${daily.drivers.active} active, ${daily.alerts.sent} alerts, ` +
      `${daily.outcomes.visits} visits`
    );
  }
);
