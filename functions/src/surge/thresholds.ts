/*
 * Forecast rules. These counts are the whole model. There is no probability number.
 *
 * A match is forecast only from completed rows (Did it surge? is YES or NO) whose
 * kick-off is strictly earlier. Pending rows are not history.
 *
 * A pending row is also completed when that same event id has a recorded
 * post-event outcome of yes or no. A yes or no already written on the sheet
 * is kept. The fixture and ground minimums below do not change.
 *
 * Use the same fixture (same ground, home team, and away team) when that fixture
 * already has FIXTURE_MIN completed rows. Otherwise use the ground, once it has
 * GROUND_MIN completed rows. Otherwise write no_prediction.
 *
 * Inside the chosen set, forecast a surge when at least one row is YES and the
 * rounded YES share is above MIN_PREDICTION_PERCENT (20). A share of 20% or
 * below is no_prediction. A run of NOs is not stored as a negative forecast.
 * MIN_YES is 1 because three YES rows would hide a share that is already above
 * 20% (two YES out of four is 50%). The fixture and ground minimums still
 * refuse a pool that is too small to call data.
 *
 * Strength is the middle of the earlier YES rows' peak uplift (a percent, read
 * internally and then thrown away):
 *   low    20% up to 40%
 *   medium 40% up to 70%
 *   high   70% and above
 * If none of those YES rows has a peak of at least 20%, write no_prediction.
 *
 * Confidence is a band from how many completed rows were used. The band stays
 * a word and does not use the sheet's "Predicted surge confidence %" column.
 * The 60% figure here is only the medium label. It does not hide a forecast:
 *   low    the set cleared the 20% floor, but is smaller than 5, or the YES
 *          share is above 20% and below 60%
 *   medium at least 5 rows and a YES share of at least 60%
 *   high   at least 8 rows and a YES share of at least 75%
 * On a category pin (venue or travel), confidencePercent is
 * round(100 * YES / (YES + NO)) on that same set. On an event pin
 * (sheet_<Event ID>) that field is the Events-tab cell instead, copied when
 * the pin is planned. basedOnEvents is the size of the set and is omitted on
 * no_prediction. An event pin still carries the sheet percent, or null, then.
 *
 * A pickup point is verified from its own earlier readings at that ground.
 * A completed earlier match counts when that point was checked at least twice.
 * Fewer than 2 such matches: verified false, and no confidence band, so phones hide it.
 *   low 2–3, medium 4–7, high 8 or more.
 */

export const FIXTURE_MIN = 3;
export const GROUND_MIN = 4;
/* One YES is enough once the pool exists. The percent floor is the real cutoff. */
export const MIN_YES = 1;
/* Rounded confidence at or below this percent is not a prediction. */
export const MIN_PREDICTION_PERCENT = 20;
/* Medium band only. Not the gate that hides a forecast from the planner. */
export const CONFIDENCE_MEDIUM_RATE = 0.6;

/*
 * Strength, not confidence. A YES whose peak never reached 20% above the
 * normal fare has no low/medium/high band, so it cannot be shown. Push
 * alerts are a different 60% and are not this number.
 */
export const MIN_STRENGTH_UPLIFT = 0.2;
export const STRENGTH_MEDIUM_AT = 0.4;
export const STRENGTH_HIGH_AT = 0.7;

export const CONFIDENCE_MEDIUM_POOL = 5;
export const CONFIDENCE_HIGH_POOL = 8;
export const CONFIDENCE_HIGH_RATE = 0.75;

export const PICKUP_MIN_EVENTS = 2;
export const PICKUP_READINGS_PER_EVENT = 2;
export const PICKUP_MEDIUM_AT = 4;
export const PICKUP_HIGH_AT = 8;
/* A reading this close to a pickup (metres) supports it even when the names differ. */
export const PICKUP_MATCH_RADIUS_M = 150;

/* The sheet's own full-time rule: kick-off plus about 1 hour 55 minutes. */
export const EXPECTED_FULL_TIME_AFTER_KICKOFF_MS = (1 * 60 + 55) * 60 * 1000;
/* Hard stop is full time plus 3 hours when that cell is blank or unusable. */
export const HARD_STOP_AFTER_FULL_TIME_MS = 3 * 60 * 60 * 1000;
/* Phones only show a surge window of at most 6 hours. */
export const MAX_FORECAST_WINDOW_MS = 6 * 60 * 60 * 1000;

export type Band = "low" | "medium" | "high";

export function strengthBand(upliftFraction: number): Band | null {
  if (!Number.isFinite(upliftFraction) || upliftFraction < MIN_STRENGTH_UPLIFT) return null;
  if (upliftFraction < STRENGTH_MEDIUM_AT) return "low";
  if (upliftFraction < STRENGTH_HIGH_AT) return "medium";
  return "high";
}

export function confidenceBand(poolSize: number, yesRate: number): Band {
  if (poolSize >= CONFIDENCE_HIGH_POOL && yesRate >= CONFIDENCE_HIGH_RATE) return "high";
  if (poolSize >= CONFIDENCE_MEDIUM_POOL && yesRate >= CONFIDENCE_MEDIUM_RATE) return "medium";
  return "low";
}

export function pickupConfidence(supportingEvents: number): {verified: false} | {verified: true; confidence: Band} {
  if (supportingEvents < PICKUP_MIN_EVENTS) return {verified: false};
  if (supportingEvents >= PICKUP_HIGH_AT) return {verified: true, confidence: "high"};
  if (supportingEvents >= PICKUP_MEDIUM_AT) return {verified: true, confidence: "medium"};
  return {verified: true, confidence: "low"};
}
