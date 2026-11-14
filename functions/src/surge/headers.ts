/* Column titles from the Ferro SURGE (Booker) sheet. Tests use these strings. */

export const EVENT_ID = "Event ID";
export const COMPETITION = "Competition";
export const HOME_TEAM = "Home team";
export const AWAY_TEAM = "Away team";
export const GROUND = "Ground";
export const KICKOFF = "Kick-off (UK)";
export const EXPECTED_FULL_TIME = "Expected full time (UK)";
export const SURGE_START = "Surge window starts (UK)";
export const SURGE_END = "Surge window ends (UK, est.)";
export const HARD_STOP = "Hard stop (UK, FT + 3h)";
export const PICKUP_POINTS = "Pickup points (name | lat,lng)";
export const DID_IT_SURGE = "Did it surge?";
export const PEAK_UPLIFT = "Peak uplift %";
export const PREDICTED_SURGE_CONFIDENCE = "Predicted surge confidence %";

export const TIME_UK = "Time (UK)";
export const TIME_UTC = "Time (UTC)";
export const PHASE = "Phase (Baseline / Pre / During / Post)";
export const PICKUP_POINT = "Pickup point";
export const LATITUDE = "Latitude";
export const LONGITUDE = "Longitude";
export const FARE_SHOWN = "Fare shown (£)";
export const BASELINE_FARE = "Baseline fare (£)";
export const BACK_TO_BASELINE = "Back to baseline? (within 5%)";
export const UPLIFT_PERCENT = "Uplift %";

export const CHECK_IN_PLACE = "Place or Event ID";
export const CHECK_IN_PHASE = "Phase (Pre / Post / Fixed)";
export const NORMAL_FARE = "Normal fare (£)";
export const PICKUP_WAIT = "Pickup wait (min)";

/*
 * Proposed tab, "Check-ins". It does not exist yet. Nothing here creates it,
 * and nothing writes Events, Readings, or any other tab that already exists.
 * One row is a pre-event check (about 4 hours before the start), a post-event
 * check (every 10 to 20 minutes after the finish), or a fixed-place check.
 * Fare cells are optional. They are used in memory and are not stored.
 */
export const CHECK_IN_HEADERS = [
  CHECK_IN_PLACE,
  TIME_UK,
  CHECK_IN_PHASE,
  PICKUP_POINT,
  DID_IT_SURGE,
  FARE_SHOWN,
  NORMAL_FARE,
  PICKUP_WAIT,
  "Notes",
] as const;

export const EVENTS_HEADERS = [
  EVENT_ID,
  COMPETITION,
  HOME_TEAM,
  AWAY_TEAM,
  GROUND,
  KICKOFF,
  EXPECTED_FULL_TIME,
  SURGE_START,
  SURGE_END,
  "Baseline price check (UK, 4h before window)",
  HARD_STOP,
  "Ground capacity",
  "When to stop checking",
  "Kick-off time sources",
  "Status",
  "Notes",
  PICKUP_POINTS,
  "Fixed destination for price checks",
  DID_IT_SURGE,
  PEAK_UPLIFT,
  "Read by (bot)",
  "#REF!",
  "Priority",
  "Pipeline note",
  PREDICTED_SURGE_CONFIDENCE,
  "X Factors",
  "Predicted Traffic (TomTom)",
  "SEND DRIVER",
  "SEND DRIVER - detail (stands in for a cell note)",
] as const;

export const READINGS_HEADERS = [
  TIME_UK,
  TIME_UTC,
  EVENT_ID,
  PHASE,
  PICKUP_POINT,
  LATITUDE,
  LONGITUDE,
  "Distance to ground (m)",
  "Destination",
  "Uber product",
  FARE_SHOWN,
  "Pickup wait (min)",
  "'Busy / fares higher' shown?",
  BASELINE_FARE,
  UPLIFT_PERCENT,
  "Uplift (£)",
  BACK_TO_BASELINE,
  "Confidence %",
  DID_IT_SURGE,
  "Peak uplift % (so far)",
  "Source (manual / browser)",
  "Screenshot link",
  "Notes",
  "H3 cell (res 8) - technical",
  "H3 cell (res 9) - technical",
  "Month",
  "Live Traffic (TomTom)",
] as const;
