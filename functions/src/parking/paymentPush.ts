import * as logger from "firebase-functions/logger";
import {FieldValue, getFirestore, type Firestore} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";

/* Copy is pending Nafiu's approval. Do not put an amount in the title, body, or data. */
export const PARKING_PAID_TITLE = "Parking paid";
export const PARKING_PAID_BODY = "You're all set.";
export const PARKING_FAILED_TITLE = "Payment didn't go through";
export const PARKING_FAILED_BODY = "You haven't been charged.";
export const PARKING_CANCELED_TITLE = "Payment cancelled";
export const PARKING_CANCELED_BODY = "You haven't been charged.";

export type ParkingPushStatus = "paid" | "failed" | "canceled";

export interface ParkingPushClaim {
  paymentId: string;
  uid: string;
  placeId: string;
  status: ParkingPushStatus;
  /* Set in the claim transaction. The send uses these so it matches the stored copy. */
  title?: string;
  body?: string;
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

export function pushCopy(status: ParkingPushStatus, placeName: string | null): {title: string; body: string} {
  const title = status === "paid" ? PARKING_PAID_TITLE :
    status === "canceled" ? PARKING_CANCELED_TITLE :
      PARKING_FAILED_TITLE;
  const body = status === "paid" ? paidBody(placeName) :
    status === "canceled" ? PARKING_CANCELED_BODY :
      PARKING_FAILED_BODY;
  return {title, body};
}

function copyFromClaim(claim: ParkingPushClaim, placeName: string | null): {title: string; body: string} {
  if (typeof claim.title === "string" && typeof claim.body === "string") {
    return {title: claim.title, body: claim.body};
  }
  return pushCopy(claim.status, placeName);
}

export function buildParkingPaymentMessage(input: {
  token: string;
  claim: ParkingPushClaim;
  placeName: string | null;
}): ParkingPushMessage {
  const {title, body} = copyFromClaim(input.claim, input.placeName);
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
  const held = typeof claim.title === "string" && typeof claim.body === "string";
  let placeName: string | null = null;
  if (!held && claim.placeId) {
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
