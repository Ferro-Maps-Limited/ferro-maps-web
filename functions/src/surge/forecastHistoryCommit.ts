import * as logger from "firebase-functions/logger";
import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "./commit.js";
import {
  mergeForecastHistory,
  mergeRecordedSurges,
  readStoredHistory,
  recordedSurgesFromCheckIns,
  recordedSurgesFromPins,
  sameForecastHistory,
  storedPreEventPresent,
  type ForecastHistory,
  type HistoryPin,
  type HistoryProposal,
  type OutcomeSnapshot,
  type PreEventSnapshot,
  type RecordedSurge,
} from "./forecastHistory.js";
import {assertNoPrices} from "./priceGuard.js";
import {loadCheckInsTab} from "./sheets.js";

function stamp(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

function toPreEventData(preEvent: PreEventSnapshot): Record<string, unknown> {
  if (preEvent.state === "no_prediction") {
    return {snapshotAt: stamp(preEvent.snapshotAt), state: "no_prediction"};
  }
  if (
    !preEvent.startAt ||
    !preEvent.endAt ||
    !preEvent.strength ||
    preEvent.confidencePercent == null ||
    preEvent.basedOnEvents == null
  ) {
    throw new Error("pre-event-incomplete");
  }
  return {
    snapshotAt: stamp(preEvent.snapshotAt),
    state: "available",
    strength: preEvent.strength,
    confidencePercent: preEvent.confidencePercent,
    basedOnEvents: preEvent.basedOnEvents,
    startAt: stamp(preEvent.startAt),
    endAt: stamp(preEvent.endAt),
  };
}

function toOutcomeData(outcome: OutcomeSnapshot): Record<string, unknown> {
  const data: Record<string, unknown> = {
    surged: outcome.surged,
    readingCount: outcome.readingCount,
    readingTimes: outcome.readingTimes.map(stamp),
  };
  if (outcome.windowStartAt) data.windowStartAt = stamp(outcome.windowStartAt);
  if (outcome.windowEndAt) data.windowEndAt = stamp(outcome.windowEndAt);
  if (outcome.strength) data.strength = outcome.strength;
  return data;
}

/* The only field this writer owns. Anything else on the pin is left in place. */
export function toForecastHistoryData(history: ForecastHistory): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (history.preEvent) data.preEvent = toPreEventData(history.preEvent);
  if (history.outcome) data.outcome = toOutcomeData(history.outcome);
  assertNoPrices(data);
  return data;
}

/*
 * One document at a time, so the stored pre-event snapshot is read and kept
 * in the same step that would otherwise replace it. A missing pin is skipped.
 * Nothing in this function deletes a document or any field.
 */
export async function commitForecastHistory(db: Firestore, proposals: HistoryProposal[]): Promise<number> {
  let written = 0;
  for (const proposal of proposals) {
    if (!proposal.id || proposal.id.includes("/")) throw new Error("history-id-required");
    const ref = db.collection(HOTSPOTS_COLLECTION).doc(proposal.id);
    const did = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const raw = snap.get("forecastHistory");
      if (storedPreEventPresent(raw) && !readStoredHistory(raw)?.preEvent) return false;
      const existing = readStoredHistory(raw);
      const merged = mergeForecastHistory(existing, proposal);
      if (!merged || sameForecastHistory(existing, merged)) return false;
      const data = toForecastHistoryData(merged);
      assertNoPrices({forecastHistory: data});
      tx.update(ref, {forecastHistory: data});
      return true;
    });
    if (did) written += 1;
  }
  return written;
}

export async function loadRecordedSurges(db: Firestore): Promise<RecordedSurge[]> {
  const snap = await db.collection(HOTSPOTS_COLLECTION).get();
  const pins: HistoryPin[] = snap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data() as Record<string, unknown>,
  }));
  return recordedSurgesFromPins(pins);
}

/*
 * Reads stored outcomes and Check-ins. A failure on one source leaves the other.
 * Neither source is written back onto a spreadsheet tab.
 */
export async function loadForecastOutcomes(
  db: Firestore,
  sheetId: string,
  checkInsTab: string,
  logLabel: string,
): Promise<RecordedSurge[]> {
  let fromStore: RecordedSurge[] = [];
  try {
    fromStore = await loadRecordedSurges(db);
  } catch {
    logger.error(`${logLabel} could not read recorded outcomes`);
  }
  let fromTab: RecordedSurge[] = [];
  try {
    fromTab = recordedSurgesFromCheckIns(await loadCheckInsTab(sheetId, checkInsTab));
  } catch {
    logger.error(`${logLabel} could not read check-ins`);
  }
  return mergeRecordedSurges(fromTab, fromStore);
}
