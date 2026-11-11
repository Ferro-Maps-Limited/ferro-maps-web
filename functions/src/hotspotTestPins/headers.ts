/*
 * Header of the Ferro SURGE tab "Hotspot Test Pins" (gid 876403614), copied
 * from that tab. A run that does not see this exact row writes nothing.
 */

export const HOTSPOT_TEST_PINS_TAB = "Hotspot Test Pins";
export const HOTSPOT_TEST_PINS_GID = 876403614;

export const PIN_ID = "Pin ID";
export const PIN_NAME = "Name";
export const CATEGORY_TYPE = "Category/type";
export const ID_SOURCE = "Source (idSource)";
export const LATITUDE = "Latitude";
export const LONGITUDE = "Longitude";
export const CITY_AREA = "City/area";
export const START_TIME_UK = "Start time (UK)";
export const END_TIME_UK = "End time (UK)";
export const REMOVE_BY = "Remove by";
export const SURGE_ENDED = "Surge ended?";
export const FORECAST_STATUS = "Forecast status (likely surge / no prediction)";
export const FORECAST_WINDOW = "Forecast window";
export const STRENGTH_BAND = "Strength band";
export const CONFIDENCE_PERCENT = "Confidence %";
export const BASED_ON_EVENTS = "Based on N events";
export const FORECAST_SOURCE = "Forecast source";
export const FORECAST_UPDATED_UK = "Forecast updated (UK)";
export const MATCHING_FIXED_PLACES = "Matching Fixed Places row";
export const SNAPSHOT_TAKEN_UK = "Snapshot taken (UK)";

export const HOTSPOT_TEST_PIN_HEADERS = [
  PIN_ID,
  PIN_NAME,
  CATEGORY_TYPE,
  ID_SOURCE,
  LATITUDE,
  LONGITUDE,
  CITY_AREA,
  START_TIME_UK,
  END_TIME_UK,
  REMOVE_BY,
  SURGE_ENDED,
  FORECAST_STATUS,
  FORECAST_WINDOW,
  STRENGTH_BAND,
  CONFIDENCE_PERCENT,
  BASED_ON_EVENTS,
  FORECAST_SOURCE,
  FORECAST_UPDATED_UK,
  MATCHING_FIXED_PLACES,
  SNAPSHOT_TAKEN_UK,
] as const;

/* How many new rows one run may append. The rest wait for a later run. */
export const MAX_APPEND_PER_RUN = 2000;

/* Rows per values.append call. Inserts new rows; it does not rewrite the tab. */
export const APPEND_BATCH_SIZE = 500;

/*
 * Fields read from hotspots_test. Price, fare, baseline, and Uber amount
 * fields are not in this list, and the row builder does not copy them even
 * when a document has them.
 */
export const PIN_READ_FIELDS = [
  "name",
  "category",
  "idSource",
  "location",
  "city",
  "area",
  "window_start",
  "events",
  "removeBy",
  "expire_at",
  "surgeEnded",
  "forecast",
  "forecastSource",
  "forecastUpdatedAt",
] as const;

/* Nested keys copied out of `events`. Anything else on that map is ignored. */
export const EVENT_TIME_FIELDS = ["start_time", "end_time", "closing_time"] as const;

/* Nested keys copied out of `forecast`. Fare and uplift keys are not here. */
export const FORECAST_FIELDS = [
  "state",
  "startAt",
  "endAt",
  "strength",
  "confidencePercent",
  "confidenceSource",
  "basedOnEvents",
] as const;

/*
 * Values accepted for the Forecast source column. `events_tab` and `none`
 * come from a sheet-event forecast. The others are category forecast sources.
 */
export const FORECAST_SOURCE_VALUES = [
  "events_tab",
  "none",
  "sheet_venue_history",
  "tpc_station_history",
  "tpc_route_history",
] as const;
