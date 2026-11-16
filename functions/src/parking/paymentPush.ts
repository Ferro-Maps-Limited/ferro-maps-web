import type {Message} from "firebase-admin/messaging";
import {FieldValue, Firestore} from "firebase-admin/firestore";
import {isPaymentIntentId, isSafeId} from "./contract";
import {formatPence} from "./fundingMath";

// Keys the iOS parser reads in ParkingPaymentPush (ParkingPaymentStatus.swift).
// `paymentId` must be a PaymentIntent id or the phone drops the push. `status`
// is informational: the phone re-reads parkingPayments/{paymentId} for the
// result. Title and body travel on the notification, not in `data`.
export const PARKING_PAYMENT_PUSH_TYPE = "parking_payment";

export const PARKING_PAYMENT_PUSH_KEYS = {
  type: "type",
  paymentId: "paymentId",
  placeId: "placeId",
  status: "status",
} as const;

export const PAYMENT_PUSH_EVENTS = ["paid", "fulfilled", "refunded", "partial_refund"] as const;
export type PaymentPushEvent = typeof PAYMENT_PUSH_EVENTS[number];

const PAYLOAD_STATUS: Record<PaymentPushEvent, string> = {
  paid: "paid",
  fulfilled: "fulfilled",
  refunded: "refunded",
  partial_refund: "partially_refunded",
};

// The mobile sender (recipients.ts, notifyOnStateChange.ts) deletes the token
// only for these two codes. `invalid-argument` is not one of them: a bad
// payload returns it for every recipient.
const DEAD_FCM_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

const CHARGE_PHRASE: Record<string, string> = {
  parking: "parking charge",
  congestion: "congestion charge",
  ulez: "ULEZ charge",
  tunnel: "tunnel charge",
  heathrow_dropoff: "Heathrow drop-off charge",
  pcn: "penalty charge",
};

export function chargePhrase(chargeType: unknown): string | null {
  if (typeof chargeType !== "string") return null;
  return CHARGE_PHRASE[chargeType] ?? null;
}

export function payloadStatusFor(event: PaymentPushEvent): string {
  return PAYLOAD_STATUS[event];
}

// Copy is built only from a known charge type and a real pence amount.
// A missing type is not treated as parking, and an amount is never filled in.
export function paymentPushCopy(
  event: PaymentPushEvent,
  chargeType: unknown,
  amountPence: unknown,
): {title: string; body: string} | null {
  const phrase = chargePhrase(chargeType);
  if (!phrase) return null;
  if (typeof amountPence !== "number" || !Number.isSafeInteger(amountPence) || amountPence < 1) {
    return null;
  }
  const money = formatPence(amountPence);
  switch (event) {
  case "paid":
    return {title: "Payment taken", body: `We've taken ${money} for your ${phrase}.`};
  case "fulfilled":
    return {
      title: "Authority payment done",
      body: `We've paid the ${money} ${phrase} to the authority.`,
    };
  case "refunded":
    return {title: "Payment refunded", body: `We've refunded ${money} for your ${phrase}.`};
  case "partial_refund":
    return {
      title: "Payment partly refunded",
      body: `We've refunded ${money} of your ${phrase}.`,
    };
  default:
    return null;
  }
}

export function classifyFcmToken(
  value: unknown,
): {ok: true; token: string} | {ok: false; reason: "missing-token" | "invalid-token"} {
  if (value == null || value === "") return {ok: false, reason: "missing-token"};
  if (typeof value !== "string" || value.length > 4096 || /\s/.test(value)) {
    return {ok: false, reason: "invalid-token"};
  }
  return {ok: true, token: value};
}

export function fcmErrorCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const record = err as {code?: unknown; errorInfo?: {code?: unknown}};
  if (typeof record.errorInfo?.code === "string") return record.errorInfo.code;
  if (typeof record.code === "string") return record.code;
  return "";
}

export function isDeadFcmTokenError(err: unknown): boolean {
  return DEAD_FCM_TOKEN_CODES.has(fcmErrorCode(err));
}

export interface ParkingPushPlan {
  uid: string;
  title: string;
  body: string;
  paymentId: string;
  status: string;
  placeId?: string;
}

export function planParkingPush(fields: {
  subject: unknown;
  text: unknown;
  payloadStatus: unknown;
  paymentIntentId: unknown;
  placeId: unknown;
  uid: unknown;
}): ParkingPushPlan | null {
  if (typeof fields.subject !== "string" || fields.subject.trim() === "") return null;
  if (typeof fields.text !== "string" || fields.text.trim() === "") return null;
  if (typeof fields.payloadStatus !== "string" || !Object.values(PAYLOAD_STATUS).includes(fields.payloadStatus)) {
    return null;
  }
  if (!isPaymentIntentId(fields.paymentIntentId)) return null;
  if (!isSafeId(fields.uid)) return null;
  const plan: ParkingPushPlan = {
    uid: fields.uid,
    title: fields.subject,
    body: fields.text,
    paymentId: fields.paymentIntentId,
    status: fields.payloadStatus,
  };
  if (isSafeId(fields.placeId)) plan.placeId = fields.placeId;
  return plan;
}

export function parkingPaymentPushMessage(input: {
  token: string;
  title: string;
  body: string;
  paymentId: string;
  status: string;
  placeId?: string;
}): Message {
  const data: Record<string, string> = {
    [PARKING_PAYMENT_PUSH_KEYS.type]: PARKING_PAYMENT_PUSH_TYPE,
    [PARKING_PAYMENT_PUSH_KEYS.paymentId]: input.paymentId,
    [PARKING_PAYMENT_PUSH_KEYS.status]: input.status,
  };
  if (input.placeId) data[PARKING_PAYMENT_PUSH_KEYS.placeId] = input.placeId;
  return {
    token: input.token,
    notification: {title: input.title, body: input.body},
    data,
    apns: {payload: {aps: {sound: "default"}}},
  };
}

export async function readFcmToken(db: Firestore, uid: string): Promise<unknown> {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return snap.get("fcmToken");
}

// Field delete, not a null write. Matches the mobile sender.
export async function clearFcmToken(db: Firestore, uid: string): Promise<void> {
  await db.collection("users").doc(uid).update({
    fcmToken: FieldValue.delete(),
  });
}
