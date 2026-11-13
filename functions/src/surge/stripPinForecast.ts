import {type Firestore} from "firebase-admin/firestore";

/*
 * Forecast fields these writers put on a public pin. The map holds the
 * forecast window, strength, and confidence. The other keys are the same
 * forecast.
 *
 * When the flag is on and the payload has a forecast, window_start and
 * window_end are left out of the pin write as well. A payload with no
 * forecast still writes those two. removeBy and expire_at stay either way.
 * Turning the flag on stops new writes. It does not delete a value already
 * stored on a document.
 */
export const PIN_FORECAST_FIELDS = [
  "forecast",
  "forecastHistory",
  "forecastSource",
  "forecastUpdatedAt",
  "surgeEnded",
] as const;

export type PinForecastField = typeof PIN_FORECAST_FIELDS[number];

export interface StripPinForecastOptions {
  stripPinForecastFields?: boolean;
}

/* config/flags.stripPinForecastFields. Missing, false, or unreadable means off. */
export function flagIsOn(value: unknown): boolean {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as {enabled?: unknown}).enabled === true;
}

export async function stripPinForecastFieldsEnabled(db: Firestore): Promise<boolean> {
  const flags = await db.doc("config/flags").get();
  return flagIsOn(flags.get("stripPinForecastFields"));
}

/* A forecast map is present. null is a clear, not a forecast. */
function payloadHasForecast(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, "forecast") && data.forecast != null;
}

/*
 * A copy of the pin payload with the forecast fields left out. Nothing is deleted.
 * window_start and window_end are omitted only when this payload has a forecast.
 */
export function omitPinForecastFields(data: Record<string, unknown>): Record<string, unknown> {
  const dropWindows = payloadHasForecast(data);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (PIN_FORECAST_FIELDS.includes(key as PinForecastField)) continue;
    if (dropWindows && (key === "window_start" || key === "window_end")) continue;
    out[key] = value;
  }
  return out;
}
