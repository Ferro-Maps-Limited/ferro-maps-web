/* Shared collection ids. forecastMirror must not import commit.ts (that file imports the mirror). */
export const HOTSPOTS_COLLECTION = "hotspots_test";

/* Gold-only copy of the forecast fields. The document id is the hotspots_test pin id. */
export const FORECASTS_COLLECTION = "hotspot_forecasts";

/*
 * Locked planner list. The document id is random, one per forecast window.
 * The pin id lives only in plannerSummaryKeys.
 */
export const SUMMARIES_COLLECTION = "hotspot_forecast_summaries";
