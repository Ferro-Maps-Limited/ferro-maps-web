import {type Firestore} from "firebase-admin/firestore";

/*
 * Forecast fields these writers put on a public pin. The map holds the
 * forecast window, strength, and confidence. The other keys are the same
 * forecast, not the event times the map query uses.
 *
 * window_start, window_end, removeBy, and expire_at stay on the pin.
 * Turning the flag on stops new writes of the fields below. It does not
 * delete a value already stored on a document.
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

/* A copy of the pin payload with the forecast fields left out. Nothing is deleted. */
export function omitPinForecastFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (PIN_FORECAST_FIELDS.includes(key as PinForecastField)) continue;
    out[key] = value;
  }
  return out;
}
