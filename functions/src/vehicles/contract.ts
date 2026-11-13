import {createHash} from "crypto";

// Parking's normalizePlate allows 1 to 10 characters for a payment request.
// A DVLA lookup is only 2 to 8 letters and digits, so it does not share that helper.

export const DVLA_VES_URL = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
export const DVLA_TIMEOUT_MS = 5_000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const USER_LIMIT = 10;
export const USER_WINDOW_MS = 60 * 1000;
export const DVLA_MIN_INTERVAL_MS = 500;
export const DVLA_MAX_WAIT_MS = 2_000;

export const LOOKUPS = "vehicle_lookups";
export const LIMITS = "vehicle_lookup_limits";
export const THROTTLE = "vehicle_lookup_throttle";
export const THROTTLE_DOC = "dvla";
export const REQUESTS = "vehicleLookupRequests";

// The phone creates exactly these fields. The trigger adds the result.
export const REQUEST_FIELDS = ["uid", "registration", "createdAt"] as const;

export const VEHICLE_FIELDS = [
  "registration",
  "make",
  "colour",
  "fuelType",
  "co2Emissions",
  "taxStatus",
  "taxDueDate",
  "motStatus",
  "motExpiryDate",
  "typeApproval",
  "firstRegistered",
  "fetchedAt",
] as const;

// Written on the request document as `code` when status is "error".
export type VehicleLookupCode =
  | "invalid"
  | "not_found"
  | "rate_limited"
  | "upstream_error";

export type LookupOutcome = "cache_hit" | "ok" | VehicleLookupCode;

export interface VehicleLookup {
  registration: string;
  make: string | null;
  colour: string | null;
  fuelType: string | null;
  co2Emissions: number | null;
  taxStatus: string | null;
  taxDueDate: string | null;
  motStatus: string | null;
  motExpiryDate: string | null;
  typeApproval: string | null;
  firstRegistered: string | null;
  fetchedAt: string;
}

export interface LookupLogEntry {
  uid: string | null;
  time: string;
  outcome: LookupOutcome;
  registrationHash?: string;
}

const REGISTRATION = /^[A-Z0-9]{2,8}$/;

export class VehicleLookupError extends Error {
  readonly code: VehicleLookupCode;

  constructor(code: VehicleLookupCode) {
    super(code);
    this.name = "VehicleLookupError";
    this.code = code;
  }
}

export function normaliseRegistration(input: unknown): string {
  if (typeof input !== "string") throw new VehicleLookupError("invalid");
  const normalised = input.toUpperCase().replace(/\s+/g, "");
  if (!REGISTRATION.test(normalised)) throw new VehicleLookupError("invalid");
  return normalised;
}

export function registrationFromRequest(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new VehicleLookupError("invalid");
  }
  const registration = (data as {registration?: unknown}).registration;
  return normaliseRegistration(registration);
}

// SHA-256 of the normalised registration. Logs store this instead of the plate.
export function hashRegistration(registration: string): string {
  return createHash("sha256").update(registration, "utf8").digest("hex");
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function sanitiseDvla(
  registration: string,
  body: Record<string, unknown>,
  fetchedAt: string,
): VehicleLookup {
  return {
    registration,
    make: asText(body.make),
    colour: asText(body.colour),
    fuelType: asText(body.fuelType),
    co2Emissions: asFiniteNumber(body.co2Emissions),
    taxStatus: asText(body.taxStatus),
    taxDueDate: asText(body.taxDueDate),
    motStatus: asText(body.motStatus),
    motExpiryDate: asText(body.motExpiryDate),
    typeApproval: asText(body.typeApproval),
    firstRegistered: asText(body.monthOfFirstRegistration),
    fetchedAt,
  };
}

export function vehicleFromStored(
  registration: string,
  data: Record<string, unknown>,
): VehicleLookup | null {
  if (typeof data.fetchedAt !== "string" || Number.isNaN(Date.parse(data.fetchedAt))) return null;
  return {
    registration,
    make: asText(data.make),
    colour: asText(data.colour),
    fuelType: asText(data.fuelType),
    co2Emissions: asFiniteNumber(data.co2Emissions),
    taxStatus: asText(data.taxStatus),
    taxDueDate: asText(data.taxDueDate),
    motStatus: asText(data.motStatus),
    motExpiryDate: asText(data.motExpiryDate),
    typeApproval: asText(data.typeApproval),
    firstRegistered: asText(data.firstRegistered),
    fetchedAt: data.fetchedAt,
  };
}
