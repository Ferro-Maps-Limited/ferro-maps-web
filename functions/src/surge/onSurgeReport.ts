import {logger} from "firebase-functions/logger";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {Timestamp, type DocumentReference, type Firestore, getFirestore} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "./collections.js";

/*
 * Driver surge reports (backend contract section 10, v2). The phone creates
 * surgeReports/{reportId} with the driver's own answer to "Is it surging here
 * right now?" and listens for done or error. v2 only stores a valid report.
 * Nothing reads reports into the live surge yet. No price, fare, multiplier
 * or position is ever on a report.
 */
export const SURGE_REPORTS = "surgeReports";
export const SURGE_REPORT_VERSION = 2;
export const SURGE_REPORT_WINDOW_MS = 20 * 60 * 1000;
export const SURGE_REPORT_ANSWERS = ["yes", "no", "not_sure"] as const;
export const SURGE_REPORT_PLATFORMS = ["ios", "android"] as const;
export const SURGE_REPORT_KEYS = [
  "v", "uid", "pinId", "answer", "reportedAt", "platform", "appVersion", "status", "createdAt",
] as const;
/* Categories with no event behind them: nothing to report. */
export const NOT_REPORTABLE = new Set(["egg", "parking", "contribute"]);

export type SurgeReportErrorCode =
  | "invalid-payload"
  | "invalid-pin"
  | "not-reportable"
  | "rate-limited"
  | "flag-off";

/* The phone shows this text as it is. */
export const SURGE_REPORT_ERROR_TEXT: Record<SurgeReportErrorCode, string> = {
  "invalid-payload": "This report couldn't be read. Please try again.",
  "invalid-pin": "This place can't take surge reports.",
  "not-reportable": "This kind of place can't take surge reports.",
  "rate-limited": "You've already reported this place in the last 20 minutes.",
  "flag-off": "Surge reports are switched off right now.",
};

export interface SurgeReportDecision {
  status: "done" | "error" | "ignore";
  errorCode?: SurgeReportErrorCode;
}

function validDocId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("/");
}

/* Exactly the client keys, with the types the rules check. */
export function validReport(report: Record<string, unknown>): boolean {
  const keys = Object.keys(report);
  if (keys.length !== SURGE_REPORT_KEYS.length) return false;
  if (!SURGE_REPORT_KEYS.every((key) => keys.includes(key))) return false;
  if (report.v !== SURGE_REPORT_VERSION) return false;
  if (typeof report.uid !== "string" || report.uid.length === 0) return false;
  if (typeof report.pinId !== "string") return false;
  if (!(SURGE_REPORT_ANSWERS as readonly unknown[]).includes(report.answer)) return false;
  if (!(report.reportedAt instanceof Timestamp)) return false;
  if (!(SURGE_REPORT_PLATFORMS as readonly unknown[]).includes(report.platform)) return false;
  if (typeof report.appVersion !== "string" || report.appVersion.length > 32) return false;
  return true;
}

/*
 * config/flags.surgeReports for one platform, read the way the phones read a
 * layer: a bare bool, or a map where the platform key (a bool, or a map with
 * `enabled`) wins over `enabled`. Missing or unreadable is off.
 */
export function surgeReportsOn(value: unknown, platform: string): boolean {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const map = value as Record<string, unknown>;
  const own = map[platform];
  if (typeof own === "boolean") return own;
  if (own && typeof own === "object" && !Array.isArray(own)) {
    const enabled = (own as {enabled?: unknown}).enabled;
    if (typeof enabled === "boolean") return enabled;
  }
  return map.enabled === true;
}

export interface SurgeReportInput {
  report: Record<string, unknown>;
  flags: Record<string, unknown> | undefined;
  /* The pin's category, or null when the pin is not a Firestore document. */
  pinCategory: string | null;
  /* reportedAt of this driver's other done reports for this pin. */
  doneReportedAtMs: number[];
}

/* Pure, so every outcome is tested without Firestore. */
export function decideSurgeReport(input: SurgeReportInput): SurgeReportDecision {
  const {report} = input;
  if (report.status !== "pending") return {status: "ignore"};
  if (!validReport(report)) return {status: "error", errorCode: "invalid-payload"};
  if (!validDocId(report.pinId)) return {status: "error", errorCode: "invalid-pin"};
  if (!surgeReportsOn(input.flags?.surgeReports, report.platform as string)) {
    return {status: "error", errorCode: "flag-off"};
  }
  if (input.pinCategory && NOT_REPORTABLE.has(input.pinCategory.toLowerCase())) {
    return {status: "error", errorCode: "not-reportable"};
  }
  const at = (report.reportedAt as Timestamp).toMillis();
  if (input.doneReportedAtMs.some((other) => Math.abs(other - at) < SURGE_REPORT_WINDOW_MS)) {
    return {status: "error", errorCode: "rate-limited"};
  }
  return {status: "done"};
}

async function pinCategory(db: Firestore, pinId: unknown): Promise<string | null> {
  if (!validDocId(pinId)) return null;
  const pin = await db.collection(HOTSPOTS_COLLECTION).doc(pinId).get();
  const category = pin.exists ? pin.get("category") : null;
  return typeof category === "string" ? category : null;
}

/*
 * Equality on uid and pinId only, so no composite index is needed. A driver
 * has few reports for one pin. Status and the 20 minutes are checked here.
 */
async function doneReportTimes(db: Firestore, reportId: string, uid: unknown, pinId: unknown): Promise<number[]> {
  if (typeof uid !== "string" || !validDocId(pinId)) return [];
  const snap = await db.collection(SURGE_REPORTS).where("uid", "==", uid).where("pinId", "==", pinId).get();
  return snap.docs
    .filter((doc) => doc.id !== reportId && doc.get("status") === "done")
    .map((doc) => doc.get("reportedAt"))
    .filter((value): value is Timestamp => value instanceof Timestamp)
    .map((value) => value.toMillis());
}

export async function handleSurgeReport(db: Firestore, ref: DocumentReference, now: Date): Promise<void> {
  const first = await ref.get();
  if (!first.exists) return;
  const report = first.data() ?? {};
  if (report.status !== "pending") return;
  const [flagsSnap, category, doneAt] = await Promise.all([
    db.doc("config/flags").get(),
    pinCategory(db, report.pinId),
    doneReportTimes(db, ref.id, report.uid, report.pinId),
  ]);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = snap.data() ?? {};
    const decision = decideSurgeReport({
      report: current,
      flags: flagsSnap.exists ? flagsSnap.data() : undefined,
      pinCategory: category,
      doneReportedAtMs: doneAt,
    });
    if (decision.status === "ignore") return;
    const update: Record<string, unknown> = {
      status: decision.status,
      completedAt: Timestamp.fromDate(now),
    };
    if (decision.status === "error" && decision.errorCode) {
      update.errorCode = decision.errorCode;
      update.error = SURGE_REPORT_ERROR_TEXT[decision.errorCode];
    }
    tx.update(ref, update);
  });
}

export const onSurgeReport = onDocumentCreated(
  {
    document: `${SURGE_REPORTS}/{reportId}`,
    region: "europe-west2",
    retry: false,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    try {
      await handleSurgeReport(getFirestore(), snapshot.ref, new Date());
    } catch (err) {
      // Left pending. The phone retries the same id, and the sweep ends it.
      logger.error("onSurgeReport failed", {reportId: snapshot.id, err});
    }
  },
);
