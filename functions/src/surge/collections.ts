/* Shared collection ids. forecastMirror must not import commit.ts (that file imports the mirror). */
export const HOTSPOTS_COLLECTION = "hotspots_test";

/* Gold-only copy of the forecast fields. The document id is the hotspots_test pin id. */
export const FORECASTS_COLLECTION = "hotspot_forecasts";

/*
 * Locked planner list. One document per pin, same id. It carries the pin name,
 * venue, place, event start, and location. It does not carry the forecast window,
 * strength, or confidence. Writers delete it when the forecast is cleared.
 */
export const SUMMARIES_COLLECTION = "hotspot_forecast_summaries";
