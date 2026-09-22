import {Firestore, Timestamp} from "firebase-admin/firestore";

/**
 * Where drivers come from, and whether they stay.
 *
 * The waitlist-to-driver figure is the reason this runs on the server: it
 * needs every waitlist email against every driver email, and a browser holding
 * both lists is exactly the sort of thing the rules exist to prevent. Only the
 * counts come out.
 *
 * Both collections are small — hundreds — so a full scan nightly is cheaper
 * and simpler than maintaining a join, and stays that way for a long while.
 */

/** How far back "recent" reaches for sign-ups and deletions. */
const RECENT_DAYS = 30;

/** Day-streak buckets, as a person would describe a habit. */
const STREAK_BUCKETS: [string, number, number][] = [
  ["none", 0, 1],
  ["1-2 days", 1, 3],
  ["3-6 days", 3, 7],
  ["1-2 weeks", 7, 14],
  ["2-4 weeks", 14, 30],
  ["a month or more", 30, Number.MAX_SAFE_INTEGER],
];

export interface GrowthStats {
  builtAt: Timestamp;
  windowDays: number;
  waitlist: {
    total: number;
    recent: number;
    /** Waitlist entries whose email now belongs to a driver. */
    converted: number;
    byCountry: Record<string, number>;
  };
  drivers: {
    total: number;
    recent: number;
    /** Drivers who have never been active since the day they signed up. */
    neverReturned: number;
    streaks: Record<string, number>;
  };
  premium: {
    active: number;
    byProduct: Record<string, number>;
    expiringSoon: number;
  };
  churn: {
    deletionRequests: number;
    suspended: number;
  };
}

function bucketFor(streak: number): string {
  for (const [label, from, to] of STREAK_BUCKETS) {
    if (streak >= from && streak < to) return label;
  }
  return STREAK_BUCKETS[STREAK_BUCKETS.length - 1][0];
}

function normaliseEmail(value: unknown): string | null {
  return typeof value === "string" && value.includes("@") ? value.trim().toLowerCase() : null;
}

/**
 * Count sign-ups, conversion, habit and subscriptions.
 * @param {Firestore} db the Admin SDK handle, which rules do not apply to.
 * @param {Date} now the instant to measure back from.
 * @return {Promise<GrowthStats>} the document to write.
 */
export async function computeGrowth(db: Firestore, now = new Date()): Promise<GrowthStats> {
  const since = Timestamp.fromMillis(now.getTime() - RECENT_DAYS * 86_400_000);
  const soon = Timestamp.fromMillis(now.getTime() + 7 * 86_400_000);
  const nowStamp = Timestamp.fromDate(now);

  const [waitlist, users, deletions] = await Promise.all([
    db.collection("waitlist").select("email", "country", "signedUpAt").get(),
    db
      .collection("users")
      .select("email", "createdAt", "lastActiveAt", "dayStreak", "subscriptionExpiresAt", "premiumProductId", "isSuspended")
      .get(),
    db.collection("accountDeletionRequests").select("createdAt").get(),
  ]);

  const driverEmails = new Set<string>();
  const streaks: Record<string, number> = {};
  const byProduct: Record<string, number> = {};
  let recentDrivers = 0;
  let neverReturned = 0;
  let premiumActive = 0;
  let expiringSoon = 0;
  let suspended = 0;

  for (const doc of users.docs) {
    const email = normaliseEmail(doc.get("email"));
    if (email) driverEmails.add(email);

    const createdAt = doc.get("createdAt") as Timestamp | undefined;
    if (createdAt && createdAt.toMillis() >= since.toMillis()) recentDrivers++;

    // Signed up, opened the app that day, and never came back.
    const lastActiveAt = doc.get("lastActiveAt") as Timestamp | undefined;
    if (createdAt && (!lastActiveAt || lastActiveAt.toMillis() - createdAt.toMillis() < 86_400_000)) {
      neverReturned++;
    }

    const streak = doc.get("dayStreak");
    const bucket = bucketFor(typeof streak === "number" ? streak : 0);
    streaks[bucket] = (streaks[bucket] ?? 0) + 1;

    const expires = doc.get("subscriptionExpiresAt") as Timestamp | undefined;
    if (expires && expires.toMillis() > nowStamp.toMillis()) {
      premiumActive++;
      if (expires.toMillis() <= soon.toMillis()) expiringSoon++;
      const product = (doc.get("premiumProductId") as string | undefined) ?? "unknown";
      byProduct[product] = (byProduct[product] ?? 0) + 1;
    }

    if (doc.get("isSuspended") === true) suspended++;
  }

  const byCountry: Record<string, number> = {};
  let converted = 0;
  let recentWaitlist = 0;

  for (const doc of waitlist.docs) {
    // Firestore refuses an empty map key, and some entries have no country.
    const country = ((doc.get("country") as string | undefined) ?? "").trim() || "Unknown";
    byCountry[country] = (byCountry[country] ?? 0) + 1;

    const signedUpAt = doc.get("signedUpAt") as Timestamp | undefined;
    if (signedUpAt && signedUpAt.toMillis() >= since.toMillis()) recentWaitlist++;

    const email = normaliseEmail(doc.get("email"));
    if (email && driverEmails.has(email)) converted++;
  }

  const deletionRequests = deletions.docs.filter((doc) => {
    const createdAt = doc.get("createdAt") as Timestamp | undefined;
    return createdAt ? createdAt.toMillis() >= since.toMillis() : false;
  }).length;

  return {
    builtAt: Timestamp.fromDate(now),
    windowDays: RECENT_DAYS,
    waitlist: {total: waitlist.size, recent: recentWaitlist, converted, byCountry},
    drivers: {total: users.size, recent: recentDrivers, neverReturned, streaks},
    premium: {active: premiumActive, byProduct, expiringSoon},
    churn: {deletionRequests, suspended},
  };
}
