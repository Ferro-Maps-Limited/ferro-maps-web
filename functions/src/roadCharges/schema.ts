/*
 * Headers and types from FR-UK-Road-Charges dataset v1.1, field_dictionary tab.
 * `notes` is on the points and rates tabs and is not a dictionary row.
 */

export const CHARGE_HEADERS = [
  "doc_id", "name", "charge_type", "geometry_type", "status", "country_code",
  "region", "city", "operator", "lat", "lng", "geohash", "geofence_radius_m",
  "coord_precision", "boundary_description", "is_24_7", "charge_days", "charge_hours",
  "free_periods", "direction_charged", "charge_basis", "currency", "car_std_gbp",
  "car_account_gbp", "car_peak_gbp", "car_offpeak_gbp", "ev_car_gbp", "taxi_phv_gbp",
  "van_gbp", "hgv_gbp", "applies_to_private_car", "applies_to_phv", "applies_to_ev",
  "noncompliant_entry_permitted", "emission_standard", "payment_deadline", "payment_methods",
  "penalty_gbp", "penalty_reduced_gbp", "exemptions_discounts", "rules_summary",
  "driver_alert", "official_url", "effective_from", "effective_to", "last_verified",
  "data_confidence", "source_note", "restriction_type", "geocode_query",
] as const;

export const POINT_HEADERS = [
  "point_id", "parent_doc_id", "point_name", "point_type", "lat", "lng",
  "geohash", "direction", "coord_precision", "notes",
] as const;

export const RATE_HEADERS = [
  "rate_id", "parent_doc_id", "vehicle_class", "payment_method", "time_band",
  "amount_gbp", "unit", "notes",
] as const;

export const CHARGE_REQUIRED = [
  "doc_id", "name", "charge_type", "geometry_type", "status", "country_code",
  "lat", "lng", "geohash", "coord_precision", "is_24_7", "charge_basis", "currency",
  "last_verified", "data_confidence", "restriction_type",
] as const;

export const POINT_REQUIRED = [
  "point_id", "parent_doc_id", "point_name", "point_type", "lat", "lng", "geohash",
] as const;

export const RATE_REQUIRED = [
  "rate_id", "parent_doc_id", "vehicle_class", "payment_method", "time_band",
  "amount_gbp", "unit",
] as const;

const NUMBER_FIELDS = new Set([
  "lat", "lng", "geofence_radius_m", "car_std_gbp", "car_account_gbp", "car_peak_gbp",
  "car_offpeak_gbp", "ev_car_gbp", "taxi_phv_gbp", "van_gbp", "hgv_gbp",
  "penalty_gbp", "penalty_reduced_gbp", "amount_gbp",
]);

const BOOLEAN_FIELDS = new Set([
  "is_24_7", "applies_to_private_car", "applies_to_phv", "applies_to_ev",
  "noncompliant_entry_permitted",
]);

/* Points use their own coord vocabulary (`approx_200m`, `published`). */
const CHARGE_ENUMS: Record<string, string> = {
  charge_type: "charge_type",
  geometry_type: "geometry_type",
  status: "status",
  country_code: "country_code",
  direction_charged: "direction_charged",
  charge_basis: "charge_basis",
  coord_precision: "coord_precision",
  restriction_type: "restriction_type",
  data_confidence: "data_confidence",
};

export type FieldKind = "string" | "number" | "boolean" | "enum";

export function fieldKind(table: "charges" | "points" | "rates", name: string): FieldKind {
  if (table === "points" && name === "point_type") return "enum";
  if (table === "charges" && CHARGE_ENUMS[name]) return "enum";
  if (NUMBER_FIELDS.has(name)) return "number";
  if (BOOLEAN_FIELDS.has(name)) return "boolean";
  return "string";
}

export function enumColumn(table: "charges" | "points" | "rates", name: string): string | null {
  if (table === "points" && name === "point_type") return "point_type";
  if (table === "charges" && CHARGE_ENUMS[name]) return CHARGE_ENUMS[name];
  return null;
}

export function sameHeaderSet(actual: string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const got = new Set(actual);
  if (got.size !== actual.length) return false;
  return expected.every((name) => got.has(name));
}
