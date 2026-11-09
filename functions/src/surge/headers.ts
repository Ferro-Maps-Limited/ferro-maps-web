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

export const TIME_UK = "Time (UK)";
export const TIME_UTC = "Time (UTC)";
export const PHASE = "Phase (Baseline / Pre / During / Post)";
export const PICKUP_POINT = "Pickup point";
export const FARE_SHOWN = "Fare shown (£)";
export const BASELINE_FARE = "Baseline fare (£)";
export const BACK_TO_BASELINE = "Back to baseline? (within 5%)";

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
  "Predicted surge confidence %",
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
  "Latitude",
  "Longitude",
  "Distance to ground (m)",
  "Destination",
  "Uber product",
  FARE_SHOWN,
  "Pickup wait (min)",
  "'Busy / fares higher' shown?",
  BASELINE_FARE,
  "Uplift %",
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
