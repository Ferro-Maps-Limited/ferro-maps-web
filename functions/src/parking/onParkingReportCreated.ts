import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {
  FieldValue,
  Timestamp,
  getFirestore,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";

export const PARKING_REPORT_REASONS = ["cant_park", "wrong_rules", "closed", "wrong_place"] as const;
export type ParkingReportReason = (typeof PARKING_REPORT_REASONS)[number];

/* 20 accepted reports per driver per London day. The next one is RATE_LIMIT. */
export const PARKING_REPORT_DAILY_LIMIT = 20;

/*
 * AUTO_HIDE_THRESHOLD = null.
 * Hiding a place after N reports is Nafiu's decision. v1 does not hide.
 */
export const AUTO_HIDE_THRESHOLD = null;

const RETENTION_MONTHS = 24;

export function isParkingReportReason(value: unknown): value is ParkingReportReason {
  return typeof value === "string" && (PARKING_REPORT_REASONS as readonly string[]).includes(value);
}

/* Calendar months in UTC. 1 Nov 2026 plus 24 months is 1 Nov 2028. */
export function addMonthsUtc(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/* YYYY-MM-DD in Europe/London. */
export function londonDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function reasonCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isInteger(count) && count > 0) out[key] = count;
  }
  return out;
}

function storedCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return 0;
}

/*
 * `places/{placeId}` is the only place id this repo can read in one get.
 * parkingCells and privateParkingCells are geohash documents. Their ids are
 * nested, so there is no cheap place-id index over the map.
 */
async function placeExists(
  db: Firestore,
  placeId: string,
  tx: {get(ref: DocumentReference): Promise<{exists: boolean}>},
): Promise<boolean> {
  if (placeId.length === 0 || placeId.includes("/")) return false;
  const snap = await tx.get(db.collection("places").doc(placeId));
  return snap.exists;
}

export async function processParkingReport(db: Firestore, reportRef: DocumentReference): Promise<void> {
  await db.runTransaction(async (tx) => {
    const reportSnap = await tx.get(reportRef);
    if (!reportSnap.exists) return;
    const status = reportSnap.get("status");
    if (status === "accepted" || status === "rejected") return;

    const uid = reportSnap.get("uid");
    const placeId = reportSnap.get("placeId");
    const reason = reportSnap.get("reason");
    const reportedAt = reportSnap.get("reportedAt");
    if (typeof uid !== "string" || typeof placeId !== "string" || !(reportedAt instanceof Timestamp)) return;
    if (!isParkingReportReason(reason)) return;

    const known = await placeExists(db, placeId, tx);
    const counterRef = db.collection("users").doc(uid).collection("meta").doc("parkingReportDay");
    const statsRef = db.collection("parkingReportStats").doc(placeId);
    const counterSnap = await tx.get(counterRef);
    const statsSnap = await tx.get(statsRef);

    const expireAt = Timestamp.fromDate(addMonthsUtc(reportedAt.toDate(), RETENTION_MONTHS));
    const processedAt = FieldValue.serverTimestamp();
    if (!known) {
      tx.update(reportRef, {
        status: "rejected",
        rejectReason: "UNKNOWN_PLACE",
        processedAt,
        expireAt,
      });
      return;
    }

    const day = londonDay(reportedAt.toDate());
    const sameDay = counterSnap.exists && counterSnap.get("day") === day;
    const acceptedToday = sameDay ? storedCount(counterSnap.get("count")) : 0;
    if (acceptedToday >= PARKING_REPORT_DAILY_LIMIT) {
      tx.update(reportRef, {
        status: "rejected",
        rejectReason: "RATE_LIMIT",
        processedAt,
        expireAt,
      });
      return;
    }

    const byReason = reasonCounts(statsSnap.get("byReason"));
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    tx.update(reportRef, {
      status: "accepted",
      reviewStatus: "pending",
      processedAt,
      expireAt,
    });
    tx.set(counterRef, {day, count: acceptedToday + 1});
    tx.set(statsRef, {
      count: storedCount(statsSnap.get("count")) + 1,
      byReason,
      lastReportedAt: reportedAt,
    });
  });
}

export const onParkingReportCreated = onDocumentCreated(
  {
    document: "parkingReports/{reportId}",
    region: "europe-west2",
    timeoutSeconds: 60,
    memory: "256MiB",
    retry: false,
  },
  async (event) => {
    if (!event.data) return;
    await processParkingReport(getFirestore(), event.data.ref);
  },
);
