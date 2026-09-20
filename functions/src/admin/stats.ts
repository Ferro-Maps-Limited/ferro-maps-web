import {Firestore, Timestamp} from "firebase-admin/firestore";
import {londonDayKey, londonDayRange} from "./london";

/**
 * The figures behind the admin console, computed with the Admin SDK and
 * written where the console can read them.
 *
 * The console cannot compute these itself. Security rules keep notificationLog,
 * hotspotOutcomes and the users subcollections owner-only, and the pipeline
 * collections server-only — deliberately, after a leak. What the console could
 * read it read badly: five screens each opened a live listener on the whole
 * users collection, so every page view cost one document read per driver.
 *
 * So the work happens here, once, and the console reads a single document.
 *
 * Reads are kept down with select(): these queries pull the three or four
 * fields a figure needs, not whole documents.
 */

/** Queues where a client writes a request document and a trigger answers it. */
export const REQUEST_QUEUES = [
  "contributionRequests",
  "deviceSessionRequests",
  "subscriptionRequests",
  "accountDeletionRequests",
  "accountActions",
  "ticketRequests",
] as const;

/**
 * Hotspot kinds the demand pipeline writes, in the order the console shows
 * them. hotspots_test is the collection the apps read; hotspots_prod is the
 * newer ingest's output and is not serving drivers.
 */
export const HOTSPOT_CATEGORIES = [
  "events",
  "venues",
  "flights",
  "flight disruptions",
  "travel disruptions",
] as const;

/** How many pending request documents a queue is scanned for. */
const QUEUE_SCAN_LIMIT = 200;

/** How many open tickets the SLA figures are computed from. */
const TICKET_SCAN_LIMIT = 500;

export interface QueueStats {
  pending: number;
  oldestMinutes: number | null;
  /** True when the queue hit the scan limit, so `pending` is a floor. */
  capped: boolean;
}

export interface LiveStats {
  builtAt: Timestamp;
  dayKey: string;
  drivers: {
    /**
     * Drivers whose position is currently fresh, summed from driverDensity.
     * This is the honest count: the trigger behind those cells drops anyone
     * whose location has gone stale.
     */
    online: number;
    /**
     * Drivers whose user document still says isOnline. Kept beside the real
     * count because the two disagree badly — the flag is left set when an app
     * is killed rather than signed out, so it drifts upwards forever.
     */
    flaggedOnline: number;
    total: number;
    suspended: number;
    activeLast7d: number;
    deviceClaimed: number;
  };
  tickets: {
    open: number;
    /**
     * Open tickets whose last word came from the driver, or which have no
     * reply at all. "Open" on its own says nothing: a ticket stays open after
     * it is answered, so counting those as a backlog cries wolf.
     */
    waitingOnUs: number;
    waitingOnUsOverDay: number;
    /** Age of the oldest ticket waiting on us. */
    oldestWaitingMinutes: number | null;
  };
  queues: Record<string, QueueStats>;
  pipeline: {
    lastRunAt: Timestamp | null;
    lastRunLoadId: string | null;
    lastRunWritten: number | null;
    lastRunFailures: string[];
    firingAlerts: string[];
  };
  hotspots: {
    /** Live pins in hotspots_test, what drivers actually see. */
    total: number;
    byCategory: Record<string, number>;
    /** Parking bays and eggs drivers contributed, which no refresh clears. */
    driverPins: number;
  };
  /** Highest `drivers.online` seen today, carried across runs. */
  onlinePeak: {dayKey: string; value: number};
}

export interface DailyStats {
  dayKey: string;
  builtAt: Timestamp;
  drivers: {
    new: number;
    /**
     * Drivers whose lastActiveAt falls in the day. That field only holds the
     * most recent activity, so this is exact when the nightly close runs the
     * morning after, and an undercount for any day rebuilt later.
     */
    active: number;
    premium: number;
    suspended: number;
    deviceClaimed: number;
    onlinePeak: number | null;
  };
  alerts: {
    sent: number;
    opened: number;
    actedOn: number;
    checked: number;
    byCategory: Record<string, {sent: number; actedOn: number}>;
  };
  outcomes: {
    visits: number;
    jobQuick: number;
    jobSlow: number;
    noJob: number;
    fromAlert: number;
    medianWaitMinutes: number | null;
    byCategory: Record<string, {visits: number; jobs: number}>;
  };
  community: {
    pinsCreated: number;
    requests: number;
    requestsFailed: number;
    errorCodes: Record<string, number>;
  };
  growth: {
    waitlistSignups: number;
  };
  support: {
    opened: number;
    firstReplyMedianMinutes: number | null;
  };
  pipeline: {
    runs: number;
    written: number;
    failedSources: Record<string, number>;
    geminiCacheHits: number;
    geminiApiCalls: number;
  };
}

function minutesBetween(from: Timestamp, to: Date): number {
  return Math.round((to.getTime() - from.toMillis()) / 60_000);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function bump(counts: Record<string, number>, key: string | undefined): void {
  const name = key ?? "unknown";
  counts[name] = (counts[name] ?? 0) + 1;
}

async function countOf(query: FirebaseFirestore.Query): Promise<number> {
  const snapshot = await query.count().get();
  return snapshot.data().count;
}

async function queueStats(db: Firestore, name: string, now: Date): Promise<QueueStats> {
  const snapshot = await db
    .collection(name)
    .where("status", "==", "pending")
    .select("createdAt")
    .limit(QUEUE_SCAN_LIMIT)
    .get();

  let oldest: Timestamp | null = null;
  for (const doc of snapshot.docs) {
    const createdAt = doc.get("createdAt") as Timestamp | undefined;
    if (createdAt && (!oldest || createdAt.toMillis() < oldest.toMillis())) oldest = createdAt;
  }

  return {
    pending: snapshot.size,
    oldestMinutes: oldest ? minutesBetween(oldest, now) : null,
    capped: snapshot.size === QUEUE_SCAN_LIMIT,
  };
}

/**
 * The "right now" figures on the Overview, refreshed every few minutes.
 * @param {Firestore} db the Admin SDK handle, which rules do not apply to.
 * @param {LiveStats | null} previous the last document written, for the running peak.
 * @param {Date} now the instant to report as of.
 * @return {Promise<LiveStats>} the document to write to adminStats/live.
 */
export async function computeLive(db: Firestore, previous: LiveStats | null, now = new Date()): Promise<LiveStats> {
  const users = db.collection("users");
  const weekAgo = Timestamp.fromMillis(now.getTime() - 7 * 86_400_000);
  const dayKey = londonDayKey(now);

  const [flaggedOnline, total, suspended, activeLast7d, deviceClaimed] = await Promise.all([
    countOf(users.where("isOnline", "==", true)),
    countOf(users),
    countOf(users.where("isSuspended", "==", true)),
    countOf(users.where("lastActiveAt", ">=", weekAgo)),
    countOf(users.where("deviceClaimedAt", "!=", null)),
  ]);

  // Summed rather than counted: driverDensity holds one document per ~5 km
  // cell with a running total, and empty cells are deleted, so this is a
  // handful of reads and already excludes stale positions.
  const densityCells = await db.collection("driverDensity").select("total").get();
  const online = densityCells.docs.reduce((sum, cell) => sum + ((cell.get("total") as number | undefined) ?? 0), 0);

  const openTickets = await db
    .collection("supportRequests")
    .where("status", "==", "open")
    .select("submittedAt", "replies")
    .limit(TICKET_SCAN_LIMIT)
    .get();

  const dayAgoMs = now.getTime() - 86_400_000;
  let waitingOnUs = 0;
  let waitingOnUsOverDay = 0;
  let oldestWaiting: Timestamp | null = null;
  for (const doc of openTickets.docs) {
    const replies = (doc.get("replies") as {sentBy?: string}[] | undefined) ?? [];
    const last = replies[replies.length - 1];
    // Driver replies are stamped "driver"; ours carry the admin's email.
    if (replies.length > 0 && last?.sentBy !== "driver") continue;

    waitingOnUs++;
    const submittedAt = doc.get("submittedAt") as Timestamp | undefined;
    if (!submittedAt) continue;
    if (submittedAt.toMillis() <= dayAgoMs) waitingOnUsOverDay++;
    if (!oldestWaiting || submittedAt.toMillis() < oldestWaiting.toMillis()) oldestWaiting = submittedAt;
  }

  const queueEntries = await Promise.all(
    REQUEST_QUEUES.map(async (name) => [name, await queueStats(db, name, now)] as const)
  );

  const hotspots = db.collection("hotspots_test");
  const [hotspotTotal, driverPins, ...categoryCounts] = await Promise.all([
    countOf(hotspots),
    countOf(db.collection("contributions")),
    ...HOTSPOT_CATEGORIES.map((category) => countOf(hotspots.where("category", "==", category))),
  ]);

  const [lastRun, alertState] = await Promise.all([
    db.collection("_ingest_runs").orderBy("startedAt", "desc").limit(1).get(),
    db.collection("_alert_state").get(),
  ]);
  const run = lastRun.docs[0];

  const carriedPeak = previous && previous.onlinePeak?.dayKey === dayKey ? previous.onlinePeak.value : 0;

  return {
    builtAt: Timestamp.fromDate(now),
    dayKey,
    drivers: {online, flaggedOnline, total, suspended, activeLast7d, deviceClaimed},
    tickets: {
      open: openTickets.size,
      waitingOnUs,
      waitingOnUsOverDay,
      oldestWaitingMinutes: oldestWaiting ? minutesBetween(oldestWaiting, now) : null,
    },
    queues: Object.fromEntries(queueEntries),
    pipeline: {
      lastRunAt: (run?.get("startedAt") as Timestamp | undefined) ?? null,
      lastRunLoadId: (run?.get("loadId") as string | undefined) ?? null,
      lastRunWritten: (run?.get("written") as number | undefined) ?? null,
      lastRunFailures: (run?.get("sourceFailures") as string[] | undefined) ?? [],
      firingAlerts: alertState.docs.filter((doc) => doc.get("firing") === true).map((doc) => doc.id),
    },
    hotspots: {
      total: hotspotTotal,
      driverPins,
      byCategory: Object.fromEntries(HOTSPOT_CATEGORIES.map((category, i) => [category, categoryCounts[i]])),
    },
    onlinePeak: {dayKey, value: Math.max(online, carriedPeak)},
  };
}

/**
 * Everything the charts need for one finished London day.
 * @param {Firestore} db the Admin SDK handle, which rules do not apply to.
 * @param {string} dayKey the London day to close, as YYYY-MM-DD.
 * @param {object} options figures only the live sampler knows, currently onlinePeak.
 * @return {Promise<DailyStats>} the document to write to adminStats/daily_<dayKey>.
 */
export async function computeDaily(
  db: Firestore,
  dayKey: string,
  options: {onlinePeak?: number | null} = {}
): Promise<DailyStats> {
  const {start, end} = londonDayRange(dayKey);
  const users = db.collection("users");

  const [newDrivers, activeDrivers, premium, suspended, deviceClaimed, waitlistSignups] = await Promise.all([
    countOf(users.where("createdAt", ">=", start).where("createdAt", "<", end)),
    countOf(users.where("lastActiveAt", ">=", start).where("lastActiveAt", "<", end)),
    countOf(users.where("subscriptionExpiresAt", ">", end)),
    countOf(users.where("isSuspended", "==", true)),
    countOf(users.where("deviceClaimedAt", "!=", null)),
    countOf(db.collection("waitlist").where("signedUpAt", ">=", start).where("signedUpAt", "<", end)),
  ]);

  const [alertDocs, outcomeDocs, pinDocs, requestDocs, ticketDocs, runDocs] = await Promise.all([
    db.collection("notificationLog")
      .where("sentAt", ">=", start).where("sentAt", "<", end)
      .select("category", "opened", "actedOn", "checked").get(),
    db.collection("hotspotOutcomes")
      .where("recordedAt", ">=", start).where("recordedAt", "<", end)
      .select("outcome", "waitMinutes", "cameFromNotification", "category").get(),
    db.collection("contributions")
      .where("createdAt", ">=", start).where("createdAt", "<", end)
      .select("category").get(),
    db.collection("contributionRequests")
      .where("createdAt", ">=", start).where("createdAt", "<", end)
      .select("status", "errorCode").get(),
    db.collection("supportRequests")
      .where("submittedAt", ">=", start).where("submittedAt", "<", end)
      .select("submittedAt", "replies").get(),
    db.collection("_ingest_runs")
      .where("startedAt", ">=", start).where("startedAt", "<", end)
      .select("written", "sourceFailures", "geminiCacheHits", "geminiApiCalls").get(),
  ]);

  const alerts: DailyStats["alerts"] = {sent: 0, opened: 0, actedOn: 0, checked: 0, byCategory: {}};
  for (const doc of alertDocs.docs) {
    const category = (doc.get("category") as string | undefined) ?? "unknown";
    const entry = alerts.byCategory[category] ?? {sent: 0, actedOn: 0};
    alerts.sent++;
    entry.sent++;
    if (doc.get("opened") === true) alerts.opened++;
    if (doc.get("checked") === true) alerts.checked++;
    if (doc.get("actedOn") === true) {
      alerts.actedOn++;
      entry.actedOn++;
    }
    alerts.byCategory[category] = entry;
  }

  const outcomes: DailyStats["outcomes"] = {
    visits: 0, jobQuick: 0, jobSlow: 0, noJob: 0, fromAlert: 0, medianWaitMinutes: null, byCategory: {},
  };
  const waits: number[] = [];
  for (const doc of outcomeDocs.docs) {
    const outcome = doc.get("outcome") as string | undefined;
    const category = (doc.get("category") as string | undefined) ?? "unknown";
    const entry = outcomes.byCategory[category] ?? {visits: 0, jobs: 0};
    outcomes.visits++;
    entry.visits++;
    if (outcome === "job_quick") {
      outcomes.jobQuick++;
      entry.jobs++;
    } else if (outcome === "job_slow") {
      outcomes.jobSlow++;
      entry.jobs++;
    } else {
      outcomes.noJob++;
    }
    if (doc.get("cameFromNotification") === true) outcomes.fromAlert++;
    const wait = doc.get("waitMinutes") as number | undefined;
    if (typeof wait === "number") waits.push(wait);
    outcomes.byCategory[category] = entry;
  }
  outcomes.medianWaitMinutes = median(waits);

  const errorCodes: Record<string, number> = {};
  let requestsFailed = 0;
  for (const doc of requestDocs.docs) {
    if (doc.get("status") !== "error") continue;
    requestsFailed++;
    bump(errorCodes, doc.get("errorCode") as string | undefined);
  }

  // Cohort-based: how long the tickets opened on this day waited for a human,
  // which is why it can still move after the day closes. Tickets with no reply
  // yet are left out rather than counted as instant.
  const firstReplies: number[] = [];
  for (const doc of ticketDocs.docs) {
    const submittedAt = doc.get("submittedAt") as Timestamp | undefined;
    const replies = (doc.get("replies") as {sentAt?: Timestamp | string}[] | undefined) ?? [];
    const firstReply = replies[0]?.sentAt;
    if (!submittedAt || !firstReply) continue;
    const repliedAt = typeof firstReply === "string" ? new Date(firstReply) : firstReply.toDate();
    if (Number.isNaN(repliedAt.getTime())) continue;
    firstReplies.push(minutesBetween(submittedAt, repliedAt));
  }

  const failedSources: Record<string, number> = {};
  let written = 0;
  let geminiCacheHits = 0;
  let geminiApiCalls = 0;
  for (const doc of runDocs.docs) {
    written += (doc.get("written") as number | undefined) ?? 0;
    geminiCacheHits += (doc.get("geminiCacheHits") as number | undefined) ?? 0;
    geminiApiCalls += (doc.get("geminiApiCalls") as number | undefined) ?? 0;
    for (const source of (doc.get("sourceFailures") as string[] | undefined) ?? []) bump(failedSources, source);
  }

  return {
    dayKey,
    builtAt: Timestamp.now(),
    drivers: {
      new: newDrivers,
      active: activeDrivers,
      premium,
      suspended,
      deviceClaimed,
      onlinePeak: options.onlinePeak ?? null,
    },
    alerts,
    outcomes,
    community: {
      pinsCreated: pinDocs.size,
      requests: requestDocs.size,
      requestsFailed,
      errorCodes,
    },
    growth: {waitlistSignups},
    support: {
      opened: ticketDocs.size,
      firstReplyMedianMinutes: median(firstReplies),
    },
    pipeline: {
      runs: runDocs.size,
      written,
      failedSources,
      geminiCacheHits,
      geminiApiCalls,
    },
  };
}
