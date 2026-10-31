import {createHash} from "crypto";

// Status values written on parkingPayments. The server is the only writer.
export const PARKING_STATUSES = [
  "created",
  "processing",
  "paid",
  "failed",
  "canceled",
  "refund_pending",
  "partially_refunded",
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
export const STRIPE_SYNC_PATH = "stripeSync/cursor";

/** Stripe's GBP minimum. Not in the contract; a guard so a bad place price fails here. */
export const MIN_TOTAL_PENCE = 30;
/** Safety cap (£1,000). Not in the contract. */
export const MAX_TOTAL_PENCE = 100_000;
export const PENDING_AFTER_MS = 2 * 60 * 1000;
export const ABANDON_AFTER_MS = 2 * 60 * 60 * 1000;
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const FORWARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECONCILE_LOOKBACK_SEC = 24 * 60 * 60;
export const RECONCILE_PAGE_SIZE = 50;

const OPERATORS: Record<string, string> = {
  ringgo: "RingGo",
  paybyphone: "PayByPhone",
  justpark: "JustPark",
};

// Forward only. A succeeded PaymentIntent is applied as created → processing → paid
// so the plate can be registered on the way into processing. failed is written only
// after the PaymentIntent is canceled, and it sticks. canceled sticks.
// A partial refund is partially_refunded. A won dispute may return refund_pending to paid.
const FORWARD: Record<ParkingStatus, readonly ParkingStatus[]> = {
  created: ["processing", "failed", "canceled", "refund_pending"],
  processing: ["paid", "failed", "canceled", "refund_pending"],
  failed: [],
  paid: ["refund_pending", "partially_refunded", "refunded"],
  refund_pending: ["partially_refunded", "refunded", "paid"],
  partially_refunded: ["refund_pending", "refunded"],
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

// Stripe `succeeded` is `paid`, but the only path from `created` is through `processing`.
export function resolveStatus(current: string | undefined, incoming: ParkingStatus): ParkingStatus {
  if (current === "created" && incoming === "paid") {
    return mergeStatus(mergeStatus("created", "processing"), "paid");
  }
  return mergeStatus(current, incoming);
}

function boundedIdempotencyKey(raw: string): string {
  if (raw.length <= 255) return raw;
  return `p_${createHash("sha256").update(raw).digest("hex")}`;
}

// One PaymentIntent per driver, place, and visit. Stripe allows 255 characters.
export function paymentIntentIdempotencyKey(uid: string, placeId: string, visitId: string): string {
  return boundedIdempotencyKey(`${uid}:${placeId}:${visitId}`);
}

// A failed or canceled PaymentIntent keeps its idempotency key. A retry uses a new one.
export function retryIdempotencyKey(
  uid: string,
  placeId: string,
  visitId: string,
  previousPaymentId: string,
): string {
  return boundedIdempotencyKey(`${uid}:${placeId}:${visitId}:${previousPaymentId}`);
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
  if (status === "canceled") return "The payment was canceled.";
  if (status === "refunded") return "The payment was refunded.";
  if (status === "partially_refunded") return "Part of the payment was refunded.";
  if (status === "refund_pending") return previous ?? "The payment is being reviewed.";
  return null;
}

export function plateClearedOn(status: ParkingStatus): boolean {
  return status === "failed" ||
    status === "canceled" ||
    status === "refunded" ||
    status === "partially_refunded";
}
