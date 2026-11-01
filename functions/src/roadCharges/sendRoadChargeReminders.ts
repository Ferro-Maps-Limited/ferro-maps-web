import {randomUUID} from "node:crypto";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getMessaging, type Messaging} from "firebase-admin/messaging";
import {FieldValue, getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {LONDON_TZ} from "../admin/london.js";
import {REMINDER_PAGE_SIZE, ROAD_CHARGE_CHANNEL_ID} from "./config.js";
import {runReminders, type EntryOutcome, type SendOutcome, type UserPushState} from "./runReminders.js";
import {type DeviceToken, type DueZoneEntry, type ReminderMessage} from "./plan.js";

function asDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  return null;
}

const MAX_TOKEN_READ = 20;

function dueFromDoc(uid: string, entryId: string, data: Record<string, unknown>): DueZoneEntry | null {
  const type = data.type;
  const travelDate = data.travelDate;
  const chargePence = data.chargePence;
  const payByAt = asDate(data.payByAt);
  const reminderDueAt = asDate(data.reminderDueAt);
  const expireAt = asDate(data.expireAt);
  const zoneVersion = data.configZoneVersion ?? data.zoneVersion;
  if (type !== "cc" && type !== "ulez") return null;
  if (typeof travelDate !== "string" || typeof chargePence !== "number") return null;
  if (!payByAt || !reminderDueAt || !expireAt) return null;
  if (typeof zoneVersion !== "string") return null;
  const sendAttempts = data.sendAttempts;
  return {
    uid,
    entryId,
    type,
    travelDate,
    chargePence,
    payByAt,
    reminderDueAt,
    expireAt,
    zoneVersion,
    sendAttempts: typeof sendAttempts === "number" && Number.isInteger(sendAttempts) ? sendAttempts : 0,
  };
}

async function sendMessages(messaging: Messaging, messages: ReminderMessage[]): Promise<SendOutcome[]> {
  const response = await messaging.sendEach(messages.map((message) => ({
    token: message.token,
    data: message.data,
    notification: message.notification,
    android: {
      priority: "high" as const,
      collapseKey: message.collapseKey,
      notification: {channelId: ROAD_CHARGE_CHANNEL_ID},
    },
    apns: {
      headers: {"apns-collapse-id": message.collapseKey},
      payload: {aps: {sound: "default"}},
    },
  })));
  return response.responses.map((row) => row.success ?
    {ok: true} :
    {ok: false, errorCode: row.error?.code});
}

export async function sendRoadChargeRemindersRun(
  db: Firestore,
  messaging: Messaging,
  now: Date,
): Promise<void> {
  const summary = await runReminders({
    now,
    limit: REMINDER_PAGE_SIZE,
    newClaimId: () => randomUUID(),
    loadDue: async (limit) => {
      const snap = await db.collectionGroup("zoneEntries")
        .where("reminderState", "==", "due")
        .where("reminderDueAt", "<=", Timestamp.fromDate(now))
        .orderBy("reminderDueAt", "asc")
        .limit(limit)
        .get();
      const due: DueZoneEntry[] = [];
      for (const doc of snap.docs) {
        const uid = doc.ref.parent.parent?.id;
        if (!uid) continue;
        const entry = dueFromDoc(uid, doc.id, doc.data() as Record<string, unknown>);
        if (entry) due.push(entry);
      }
      return due;
    },
    claim: async (entry, claimId) => {
      const ref = db.doc(`users/${entry.uid}/zoneEntries/${entry.entryId}`);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.get("reminderState") !== "due") return false;
        const dueAt = asDate(snap.get("reminderDueAt"));
        if (!dueAt || dueAt.getTime() > now.getTime()) return false;
        tx.update(ref, {
          reminderState: "sending",
          claimId,
          claimedAt: Timestamp.fromDate(now),
        });
        return true;
      });
    },
    loadUser: async (uid): Promise<UserPushState> => {
      const snap = await db.doc(`users/${uid}`).get();
      const expires = asDate(snap.get("subscriptionExpiresAt"));
      const legacy = snap.get("fcmToken");
      return {
        subscriptionExpiresAtMs: expires ? expires.getTime() : null,
        legacyFcmToken: typeof legacy === "string" && legacy.trim() ? legacy : null,
      };
    },
    loadTokens: async (uid): Promise<DeviceToken[]> => {
      const snap = await db.collection(`users/${uid}/fcmTokens`)
        .orderBy("updatedAt", "desc")
        .limit(MAX_TOKEN_READ)
        .get();
      return snap.docs.flatMap((doc) => {
        const token = doc.get("token");
        const platform = doc.get("platform");
        const updatedAt = asDate(doc.get("updatedAt"));
        if (typeof token !== "string" || typeof platform !== "string" || !updatedAt) return [];
        return [{deviceId: doc.id, token, platform, updatedAtMs: updatedAt.getTime()}];
      });
    },
    send: (messages) => sendMessages(messaging, messages),
    writeEntry: async (uid, entryId, patch: EntryOutcome) => {
      const data: Record<string, unknown> = {
        reminderState: patch.reminderState,
        reminderReason: patch.reminderReason,
        sendAttempts: patch.sendAttempts,
        claimId: FieldValue.delete(),
        claimedAt: FieldValue.delete(),
      };
      if (patch.reminderSentAt) data.reminderSentAt = Timestamp.fromDate(patch.reminderSentAt);
      await db.doc(`users/${uid}/zoneEntries/${entryId}`).update(data);
    },
    deleteToken: async (uid, deviceId) => {
      await db.doc(`users/${uid}/fcmTokens/${deviceId}`).delete();
    },
    clearLegacyToken: async (uid, token) => {
      const ref = db.doc(`users/${uid}`);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.get("fcmToken") === token) {
          tx.update(ref, {fcmToken: FieldValue.delete()});
        }
      });
    },
  });
  logger.info("sendRoadChargeReminders", summary);
}

export const sendRoadChargeReminders = onSchedule(
  {
    schedule: "*/15 * * * *",
    timeZone: LONDON_TZ,
    region: "europe-west2",
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    await sendRoadChargeRemindersRun(getFirestore(), getMessaging(), new Date());
  },
);
