import * as logger from "firebase-functions/logger";
import {FieldValue, getFirestore, type Firestore} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";

/* Copy is pending Nafiu's approval. Do not put an amount in the title, body, or data. */
export const PARKING_PAID_TITLE = "Parking paid";
export const PARKING_PAID_BODY = "You're all set.";
export const PARKING_FAILED_TITLE = "Payment didn't go through";
export const PARKING_FAILED_BODY = "You haven't been charged. Tap to try again.";

export type ParkingPushStatus = "paid" | "failed" | "canceled";

export interface ParkingPushClaim {
  paymentId: string;
  uid: string;
  placeId: string;
  status: ParkingPushStatus;
}

export interface ParkingPushMessage {
  token: string;
  data: {
    type: "parking_payment";
    paymentId: string;
    placeId: string;
    status: ParkingPushStatus;
  };
  notification: {title: string; body: string};
  android: {priority: "high"};
  apns: {
    payload: {
      aps: {
        "alert": {title: string; body: string};
        "interruption-level": "time-sensitive";
      };
    };
  };
}

export function isParkingPushStatus(value: unknown): value is ParkingPushStatus {
  return value === "paid" || value === "failed" || value === "canceled";
}

/* The pay place has no required name. `name` is used when set, otherwise `n`. */
export function placeNameFrom(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  for (const key of ["name", "n"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function paidBody(placeName: string | null): string {
  return placeName ? `${placeName}. ${PARKING_PAID_BODY}` : PARKING_PAID_BODY;
}

export function buildParkingPaymentMessage(input: {
  token: string;
  claim: ParkingPushClaim;
  placeName: string | null;
}): ParkingPushMessage {
  const title = input.claim.status === "paid" ? PARKING_PAID_TITLE : PARKING_FAILED_TITLE;
  const body = input.claim.status === "paid" ? paidBody(input.placeName) : PARKING_FAILED_BODY;
  return {
    token: input.token,
    data: {
      type: "parking_payment",
      paymentId: input.claim.paymentId,
      placeId: input.claim.placeId,
      status: input.claim.status,
    },
    notification: {title, body},
    android: {priority: "high"},
    apns: {
      payload: {
        aps: {
          "alert": {title, body},
          "interruption-level": "time-sensitive",
        },
      },
    },
  };
}

export function isStaleFcmToken(err: unknown): boolean {
  const code = err !== null && typeof err === "object" && "code" in err ?
    String((err as {code: unknown}).code) :
    "";
  return code === "messaging/invalid-registration-token" ||
    code === "messaging/registration-token-not-registered";
}

export interface PushTransport {
  send(message: ParkingPushMessage): Promise<void>;
}

export function adminPushTransport(): PushTransport {
  return {
    async send(message: ParkingPushMessage): Promise<void> {
      await getMessaging().send(message);
    },
  };
}

async function clearTokenIfCurrent(db: Firestore, uid: string, token: string): Promise<void> {
  const ref = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get("fcmToken") === token) {
      tx.update(ref, {fcmToken: FieldValue.delete()});
    }
  });
}

/*
 * Token path is users/{uid}.fcmToken, the string iOS and Android already write.
 * There is no fcmTokens collection in the rules or in this repo.
 */
export async function deliverParkingPaymentPush(
  db: Firestore,
  claim: ParkingPushClaim,
  transport: PushTransport = adminPushTransport(),
): Promise<void> {
  const user = await db.collection("users").doc(claim.uid).get();
  const stored = user.get("fcmToken");
  const token = typeof stored === "string" ? stored.trim() : "";
  if (!token) return;
  let placeName: string | null = null;
  if (claim.placeId) {
    const place = await db.collection("places").doc(claim.placeId).get();
    placeName = placeNameFrom(place.data());
  }
  const message = buildParkingPaymentMessage({token, claim, placeName});
  try {
    await transport.send(message);
  } catch (err) {
    if (isStaleFcmToken(err)) {
      try {
        await clearTokenIfCurrent(db, claim.uid, token);
      } catch (clearErr) {
        logger.warn("could not remove a stale parking payment token", {
          paymentId: claim.paymentId,
          name: clearErr instanceof Error ? clearErr.name : "unknown",
        });
      }
    }
    logger.error("parking payment push failed", {
      paymentId: claim.paymentId,
      status: claim.status,
      name: err instanceof Error ? err.name : "unknown",
    });
  }
}

export async function deliverParkingPaymentPushFromDefaultApp(claim: ParkingPushClaim): Promise<void> {
  await deliverParkingPaymentPush(getFirestore(), claim);
}
