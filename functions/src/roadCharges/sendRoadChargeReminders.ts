import {randomUUID} from "node:crypto";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {getMessaging, type Messaging} from "firebase-admin/messaging";
import {FieldValue, getFirestore, Timestamp, type Firestore} from "firebase-admin/firestore";
import {LONDON_TZ} from "../admin/london.js";
import {ROAD_CHARGES_COLLECTION, REMINDER_PAGE_SIZE, ROAD_CHARGE_CHANNEL_ID} from "./config.js";
import {runReminders, type EntryOutcome, type HistoryPayState, type SendOutcome, type UserPushState} from "./runReminders.js";
import {historyDocId, type DeviceToken, type DueZoneEntry, type ReminderMessage} from "./plan.js";

function asDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  return null;
}

const MAX_TOKEN_READ = 20;

function dueFromDoc(uid: string, entryId: string, data: Record<string, unknown>): DueZoneEntry | null {
  const type = data.type;
  const travelDate = data.travelDate;
  const activeVehicleId = data.activeVehicleId;
  const chargePence = data.chargePence;
  const ruleId = data.ruleId;
  const payByAt = asDate(data.payByAt);
  const reminder1At = asDate(data.reminder1At);
  const reminder2At = asDate(data.reminder2At);
  const nextReminderAt = asDate(data.nextReminderAt);
  const expireAt = asDate(data.expireAt);
  const zoneVersion = data.configZoneVersion ?? data.zoneVersion;
  const slot = data.nextReminderSlot;
  if (type !== "cc" && type !== "ulez") return null;
  if (typeof travelDate !== "string" || typeof activeVehicleId !== "string" || typeof chargePence !== "number") {
    return null;
  }
  if (typeof ruleId !== "string") return null;
  if (!payByAt || !reminder1At || !reminder2At || !nextReminderAt || !expireAt) return null;
  if (slot !== 1 && slot !== 2) return null;
  if (typeof zoneVersion !== "string") return null;
  const sendAttempts = data.sendAttempts;
  return {
    uid,
    entryId,
    type,
    travelDate,
    activeVehicleId,
    chargePence,
    ruleId,
    bookingCondition: data.bookingCondition === true,
    latePence: typeof data.latePence === "number" ? data.latePence : undefined,
    lateRuleId: typeof data.lateRuleId === "string" ? data.lateRuleId : undefined,
    payByAt,
    reminder1At,
    reminder2At,
    nextReminderSlot: slot,
    nextReminderAt,
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
    loadHolidayLists: async () => {
      const cc = await db.doc(`${ROAD_CHARGES_COLLECTION}/cc`).get();
      const ulez = await db.doc(`${ROAD_CHARGES_COLLECTION}/ulez`).get();
      return {cc: cc.get("bankHolidays"), ulez: ulez.get("bankHolidays")};
    },
    warn: (message, details) => {
      if (details) logger.warn(message, details);
      else logger.warn(message);
    },
    loadDue: async (limit) => {
      const snap = await db.collectionGroup("zoneEntries")
        .where("reminderEligible", "==", true)
        .where("nextReminderAt", "<=", Timestamp.fromDate(now))
        .orderBy("nextReminderAt", "asc")
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
        if (snap.get("reminderEligible") !== true) return false;
        if (snap.get("nextReminderSlot") !== entry.nextReminderSlot) return false;
        const dueAt = asDate(snap.get("nextReminderAt"));
        if (!dueAt || dueAt.getTime() > now.getTime()) return false;
        const sentField = entry.nextReminderSlot === 1 ? "reminder1SentAt" : "reminder2SentAt";
        if (snap.get(sentField) != null) return false;
        tx.update(ref, {
          reminderEligible: false,
          sendingSlot: entry.nextReminderSlot,
          claimId,
          claimedAt: Timestamp.fromDate(now),
        });
        return true;
      });
    },
    loadHistory: async (entry): Promise<HistoryPayState> => {
      const rowId = historyDocId(entry.type, entry.activeVehicleId, entry.travelDate);
      const snap = await db.doc(`users/${entry.uid}/gig_history/${rowId}`).get();
      const paidAt = asDate(snap.get("paidAt"));
      const method = snap.get("method");
      const payByAt = snap.get("payByAt");
      const lateDeadline = snap.get("lateDeadline");
      return {
        rowId,
        uid: entry.uid,
        paidAtMs: paidAt ? paidAt.getTime() : null,
        method: typeof method === "string" ? method : null,
        type: snap.get("type"),
        status: snap.get("status"),
        chargePence: snap.get("chargePence"),
        travelDate: snap.get("travelDate"),
        payByAt: asDate(payByAt) ?? (payByAt == null ? null : payByAt),
        lateDeadline: asDate(lateDeadline) ?? (lateDeadline == null ? null : lateDeadline),
      };
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
        reminderEligible: patch.reminderEligible,
        claimId: FieldValue.delete(),
        claimedAt: FieldValue.delete(),
        sendingSlot: FieldValue.delete(),
      };
      if (patch.nextReminderSlot != null) data.nextReminderSlot = patch.nextReminderSlot;
      if (patch.nextReminderAt) data.nextReminderAt = Timestamp.fromDate(patch.nextReminderAt);
      if (patch.reminder1SentAt) data.reminder1SentAt = Timestamp.fromDate(patch.reminder1SentAt);
      if (patch.reminder2SentAt) data.reminder2SentAt = Timestamp.fromDate(patch.reminder2SentAt);
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
