import {Timestamp, type Firestore} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "./commit.js";
import {type Forecast} from "./forecast.js";
import {queueForecastMirrors} from "./forecastMirror.js";
import {type StripPinForecastOptions} from "./stripPinForecast.js";
import {assertNoPrices} from "./priceGuard.js";

/*
 * Three fields, and nothing else, on the pin. update() refuses a missing
 * document, so this cannot create a pin. The payload has no other keys, so
 * name, window_end, removeBy, and the rest of a document another job owns
 * stay as they were.
 *
 * TODO: remove the forecast fields from hotspots_test in the following release.
 * Until then the same forecast values are also written to hotspot_forecasts.
 */
export const CATEGORY_FORECAST_FIELDS = ["forecast", "forecastSource", "forecastUpdatedAt"] as const;

export const SHEET_VENUE_HISTORY = "sheet_venue_history";
export const TPC_STATION_HISTORY = "tpc_station_history";
export const TPC_ROUTE_HISTORY = "tpc_route_history";
export const TPC_WATCHLIST_HISTORY = "tpc_watchlist_history";

export type ForecastSource =
  | typeof SHEET_VENUE_HISTORY
  | typeof TPC_STATION_HISTORY
  | typeof TPC_ROUTE_HISTORY
  | typeof TPC_WATCHLIST_HISTORY;

export interface CategoryForecastPatch {
  id: string;
  forecast: Forecast;
  forecastSource: ForecastSource;
  updatedAt: string;
}

function stamp(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

/* Same rule as the sheet writer. A real source is kept. Nothing else is filled in. */
function categoryConfidenceSource(forecast: Forecast): "events_tab" | "none" {
  return forecast.confidenceSource ?? "none";
}

export function toCategoryForecastData(patch: CategoryForecastPatch): Record<string, unknown> {
  const source = categoryConfidenceSource(patch.forecast);
  const forecast = patch.forecast.state === "no_prediction" ?
    {state: "no_prediction", confidenceSource: source} :
    {
      state: "available",
      v: 1,
      startAt: stamp(patch.forecast.startAt),
      endAt: stamp(patch.forecast.endAt),
      strength: patch.forecast.strength,
      confidence: patch.forecast.confidence,
      confidencePercent: patch.forecast.confidencePercent,
      confidenceSource: source,
      basedOnEvents: patch.forecast.basedOnEvents,
    };
  const data: Record<string, unknown> = {
    forecast,
    forecastSource: patch.forecastSource,
    forecastUpdatedAt: stamp(patch.updatedAt),
  };
  const keys = Object.keys(data);
  if (keys.length !== CATEGORY_FORECAST_FIELDS.length || CATEGORY_FORECAST_FIELDS.some((key) => !keys.includes(key))) {
    throw new Error("forecast-fields-only");
  }
  assertNoPrices(data);
  return data;
}

export async function commitCategoryForecasts(
  db: Firestore,
  patches: CategoryForecastPatch[],
  options?: StripPinForecastOptions,
): Promise<number> {
  const writes = patches.map((patch) => {
    if (!patch.id || patch.id.startsWith("sheet_") || patch.id.includes("/")) {
      throw new Error("existing-non-sheet-id-required");
    }
    return {id: patch.id, data: toCategoryForecastData(patch)};
  });
  const strip = options?.stripPinForecastFields === true;
  let batch = db.batch();
  let pending = 0;
  for (const write of writes) {
    if (!strip) {
      batch.update(db.collection(HOTSPOTS_COLLECTION).doc(write.id), write.data);
      pending += 1;
    }
    const mirrored = await queueForecastMirrors(db, batch, [{
      id: write.id,
      fields: write.data,
    }], "attachCategoryForecasts");
    pending += mirrored;
    if (pending >= 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
  return writes.length;
}
