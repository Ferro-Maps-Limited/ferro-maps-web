// Status values written on parkingPayments. The server is the only writer.
export const PARKING_STATUSES = [
  "created",
  "processing",
  "paid",
  "failed",
  "canceled",
  "refund_pending",
  "refunded",
] as const;

export type ParkingStatus = typeof PARKING_STATUSES[number];

export type ParkingErrorCode =
  | "permission-denied"
  | "failed-precondition"
  | "not-found"
  | "invalid-argument"
  | "unavailable"
  | "deadline-exceeded"
  | "internal";

export class ParkingPaymentError extends Error {
  readonly errorCode: ParkingErrorCode;

  constructor(errorCode: ParkingErrorCode, message: string) {
    super(message);
    this.name = "ParkingPaymentError";
    this.errorCode = errorCode;
  }
}

export const REQUESTS = "parkingPaymentRequests";
export const PAYMENTS = "parkingPayments";
export const PLACES = "places";
export const STRIPE_CUSTOMERS = "stripeCustomers";
export const OPERATOR_FORWARDS = "operatorForwards";
export const STRIPE_SYNC_PATH = "stripeSync/events";

/** Stripe's GBP minimum. Not in the contract; a guard so a bad place price fails here. */
export const MIN_TOTAL_PENCE = 30;
/** Safety cap (£1,000). Not in the contract. */
export const MAX_TOTAL_PENCE = 100_000;
export const PENDING_AFTER_MS = 2 * 60 * 1000;
export const RECONCILE_LOOKBACK_SEC = 24 * 60 * 60;

const OPERATORS: Record<string, string> = {
  ringgo: "RingGo",
  paybyphone: "PayByPhone",
  justpark: "JustPark",
};

// Status only moves forward. A failed attempt may later be paid on retry.
// Refunded and canceled do not move again.
const FORWARD: Record<ParkingStatus, readonly ParkingStatus[]> = {
  created: ["processing", "paid", "failed", "canceled"],
  processing: ["paid", "failed", "canceled", "refund_pending"],
  failed: ["processing", "paid", "canceled"],
  paid: ["refund_pending", "refunded"],
  refund_pending: ["refunded", "paid"],
  canceled: [],
  refunded: [],
};

export function isParkingStatus(value: unknown): value is ParkingStatus {
  return typeof value === "string" && (PARKING_STATUSES as readonly string[]).includes(value);
}

export function mergeStatus(current: string | undefined, incoming: ParkingStatus): ParkingStatus {
  if (!isParkingStatus(current)) return incoming;
  if (current === incoming) return current;
  return FORWARD[current].includes(incoming) ? incoming : current;
}

export function canonicalOperator(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return OPERATORS[key] ?? null;
}

// Letters and digits only, no spaces, compared case-insensitively.
export function normalizePlate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(compact)) return null;
  return compact;
}

export function isSafeId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 128) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/")) return false;
  if (/\s/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function isPaymentIntentId(value: unknown): value is string {
  return typeof value === "string" && /^pi_[A-Za-z0-9]+$/.test(value) && value.length <= 128;
}

export function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) return null;
  return trimmed;
}

export function wholePence(value: unknown, min: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < min || value > MAX_TOTAL_PENCE) return null;
  return value;
}

export function statusFromStripe(status: string, failedAttempt: boolean): ParkingStatus {
  if (status === "succeeded") return "paid";
  if (status === "processing") return "processing";
  if (status === "canceled") return "canceled";
  if (status === "requires_payment_method" && failedAttempt) return "failed";
  return "created";
}

export function failureReasonFor(status: ParkingStatus, previous: string | null): string | null {
  if (status === "failed") return "The payment didn't go through.";
  if (status === "refunded") return "The payment was refunded.";
  if (status === "refund_pending") return previous ?? "The payment is being reviewed.";
  return null;
}
