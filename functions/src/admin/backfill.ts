/**
 * Builds adminStats/daily_* for days that have already passed.
 *
 * Run by hand, not deployed as a trigger. Callables cannot be invoked on this
 * project — the org enforces Domain Restricted Sharing, so allUsers cannot be
 * bound to roles/run.invoker — and a backfill is a one-off anyway.
 *
 *   cd functions && npm run build
 *   node lib/admin/backfill.js 90          # the last 90 closed days
 *   node lib/admin/backfill.js 7 --force   # redo the last week
 *
 * Auth is Application Default Credentials:
 *   gcloud auth application-default login
 *   gcloud auth application-default set-quota-project ferro-maps-staging-v2
 *
 * Existing documents are kept unless --force is passed, so an interrupted run
 * can simply be repeated. Note what a rebuilt day cannot recover: onlinePeak is
 * sampled live and is left null, and drivers.active reads lastActiveAt, which
 * has since moved on for anyone who came back — see DailyStats.drivers.active.
 */
import {initializeApp, getApps, applicationDefault} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {addDays, londonDayKey} from "./london";
import {computeDaily} from "./stats";
import {dailyDocPath} from "./rollups";

const PROJECT_ID = "ferro-maps-staging-v2";

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 30);
  const force = process.argv.includes("--force");

  if (!Number.isInteger(days) || days < 1 || days > 400) {
    console.error("Usage: node lib/admin/backfill.js <days 1-400> [--force]");
    process.exitCode = 1;
    return;
  }

  if (getApps().length === 0) {
    initializeApp({credential: applicationDefault(), projectId: PROJECT_ID});
  }
  const db = getFirestore();

  const today = londonDayKey(new Date());
  let written = 0;
  let skipped = 0;

  // Oldest first, so an interrupted run leaves a contiguous stretch behind it.
  for (let offset = days; offset >= 1; offset--) {
    const dayKey = addDays(today, -offset);
    const ref = db.doc(dailyDocPath(dayKey));

    if (!force && (await ref.get()).exists) {
      skipped++;
      continue;
    }

    const daily = await computeDaily(db, dayKey);
    await ref.set(daily);
    written++;
    console.log(
      `${dayKey}: ${daily.drivers.new} new, ${daily.alerts.sent} alerts, ` +
      `${daily.outcomes.visits} visits, ${daily.pipeline.runs} ingest runs`
    );
  }

  console.log(`Done. ${written} day(s) written, ${skipped} already present.`);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exitCode = 1;
});
