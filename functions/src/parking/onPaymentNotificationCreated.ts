import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import sgMail from "@sendgrid/mail";
import {getAuth} from "firebase-admin/auth";
import {getFirestore} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";
import {PAYMENTS_FROM, deliverNotification} from "./notices";
import {clearFcmToken, readFcmToken} from "./paymentPush";

const sendgridApiKey = defineSecret("SENDGRID_API_KEY");
const slackPaymentsWebhook = defineSecret("SLACK_PAYMENTS_WEBHOOK_URL");

async function postSlack(url: string, text: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({text}),
  });
  if (!response.ok) {
    logger.error("slack payments webhook failed", {status: response.status});
    throw new Error("slack webhook failed");
  }
}

async function emailForUid(uid: string): Promise<string | null> {
  const snap = await getFirestore().collection("users").doc(uid).get();
  const stored = snap.get("email");
  if (typeof stored === "string" && stored.includes("@")) return stored;
  try {
    const user = await getAuth().getUser(uid);
    return user.email ?? null;
  } catch (err) {
    logger.warn("driver email lookup failed", {
      name: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

export const onPaymentNotificationCreated = onDocumentCreated(
  {
    document: "paymentNotifications/{notificationId}",
    region: "europe-west2",
    secrets: [sendgridApiKey, slackPaymentsWebhook],
    retry: true,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    sgMail.setApiKey(sendgridApiKey.value());
    const webhook = slackPaymentsWebhook.value();
    const db = getFirestore();
    await deliverNotification(db, snapshot.id, {
      emailForUid,
      postSlack: (text) => postSlack(webhook, text),
      sendEmail: async (input) => {
        await sgMail.send({
          from: {email: PAYMENTS_FROM, name: "Ferro Maps"},
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
      },
      tokenForUid: (uid) => readFcmToken(db, uid),
      clearToken: (uid) => clearFcmToken(db, uid),
      sendPush: async (message) => {
        await getMessaging().send(message);
      },
    });
  },
);
