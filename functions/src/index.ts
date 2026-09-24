import {setGlobalOptions} from "firebase-functions";
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import sgMail from "@sendgrid/mail";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getAuth} from "firebase-admin/auth";
import {initializeApp, getApps} from "firebase-admin/app";
import * as crypto from "crypto";

export * from "./sendWaitlistWelcomeEmail";
export * from "./admin/rollups";
export * from "./admin/onConfigRequest";

if (getApps().length === 0) {
  initializeApp();
}
const db = getFirestore();

const sendgridApiKey = defineSecret("SENDGRID_API_KEY");
const ticketSecret = defineSecret("TICKET_HMAC_SECRET");

setGlobalOptions({maxInstances: 10, region: "europe-west2"});

const FROM_EMAIL = "admin@ferromaps.com";
const FROM_NAME = "Ferro Maps";
const ADMIN_NOTIFICATION_EMAIL = "admin@ferromaps.com";
const ADMIN_DASHBOARD_URL = "https://admin.ferromaps.com";
const MARKETING_SITE_URL = "https://ferromaps.com";

function formatTicketNumber(ticketNumber: number): string {
  return "#" + String(ticketNumber).slice(-5).padStart(5, "0");
}

export function generateToken(ticketId: string, email: string, secret: string): string {
  const payload = `${ticketId}:${email}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.${sig}`;
}

function verifyToken(
  token: string,
  secret: string
): {ticketId: string; email: string} | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const payload = Buffer.from(b64, "base64url").toString();
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  if (sig !== expected) return null;
  const [ticketId, email] = payload.split(":");
  if (!ticketId || !email) return null;
  return {ticketId, email};
}

export const onNewTicket = onDocumentCreated(
  {document: "supportRequests/{ticketId}", secrets: [sendgridApiKey]},
  async (event) => {
    sgMail.setApiKey(sendgridApiKey.value());

    const data = event.data?.data();
    if (!data) {
      logger.warn("onNewTicket: no data in event, skipping");
      return;
    }

    const {name, email, message, ticketNumber, subject} = data as {
      name: string;
      email: string;
      message: string;
      ticketNumber: number;
      subject: string;
    };

    const formattedTicket = formatTicketNumber(ticketNumber);

    // EMAIL A — confirmation to driver
    try {
      await sgMail.send({
        from: {email: FROM_EMAIL, name: FROM_NAME},
        to: email,
        subject: `Thank you for contacting us (${formattedTicket})`,
        text: [
          `Hi ${name},`,
          "",
          "Thank you for contacting Ferro Maps support. We've received your message and will review your request and get back to you soon.",
          "",
          `Your ticket reference is ${formattedTicket}.`,
          "",
          "The Ferro Maps Team",
        ].join("\n"),
        html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1E7BFF;margin-bottom:8px">We've received your message</h2>
  <p>Hi ${name},</p>
  <p>Thank you for contacting <strong>Ferro Maps</strong> support. We've received your message and will review your request and get back to you soon.</p>
  <p>Your ticket reference is <strong>${formattedTicket}</strong>.</p>
  <p style="margin-top:32px;color:#666">The Ferro Maps Team</p>
</div>`,
      });
      logger.info(`onNewTicket: confirmation email sent to ${email} (${formattedTicket})`);
    } catch (err) {
      logger.error(`onNewTicket: failed to send confirmation email to ${email}`, err);
    }

    // EMAIL B — admin notification
    try {
      await sgMail.send({
        from: {email: FROM_EMAIL, name: FROM_NAME},
        to: ADMIN_NOTIFICATION_EMAIL,
        subject: `New support ticket (${formattedTicket})`,
        text: [
          `New support ticket ${formattedTicket}`,
          "",
          `Driver name:  ${name}`,
          `Driver email: ${email}`,
          `Subject:      ${subject}`,
          "",
          "Message:",
          message,
          "",
          `View in dashboard: ${ADMIN_DASHBOARD_URL}/messages`,
        ].join("\n"),
        html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1E7BFF;margin-bottom:8px">New support ticket ${formattedTicket}</h2>
  <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
    <tr><td style="padding:4px 8px 4px 0;color:#666;white-space:nowrap">Driver name</td><td style="padding:4px 0">${name}</td></tr>
    <tr><td style="padding:4px 8px 4px 0;color:#666;white-space:nowrap">Driver email</td><td style="padding:4px 0"><a href="mailto:${email}">${email}</a></td></tr>
    <tr><td style="padding:4px 8px 4px 0;color:#666;white-space:nowrap">Subject</td><td style="padding:4px 0">${subject}</td></tr>
  </table>
  <p style="background:#f5f5f5;padding:12px;border-radius:4px;white-space:pre-wrap">${message}</p>
  <a href="${ADMIN_DASHBOARD_URL}/messages" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#1E7BFF;color:#fff;text-decoration:none;border-radius:6px">View in dashboard</a>
</div>`,
      });
      logger.info(`onNewTicket: admin notification sent for ${formattedTicket}`);
    } catch (err) {
      logger.error(`onNewTicket: failed to send admin notification for ${formattedTicket}`, err);
    }
  }
);

export const onTicketUpdated = onDocumentUpdated(
  {document: "supportRequests/{ticketId}", secrets: [sendgridApiKey, ticketSecret]},
  async (event) => {
    sgMail.setApiKey(sendgridApiKey.value());

    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();
    if (!beforeData || !afterData) {
      logger.warn("onTicketUpdated: missing before/after data, skipping");
      return;
    }

    const {email, ticketNumber} = afterData as {
      email: string;
      ticketNumber: number;
      replies?: { text: string }[];
      status?: string;
    };
    const formattedTicket = formatTicketNumber(ticketNumber);

    // CASE A: new reply added
    const beforeRepliesLen: number = (beforeData.replies as unknown[] | undefined)?.length ?? 0;
    const afterReplies = afterData.replies as { text: string }[] | undefined;
    const afterRepliesLen = afterReplies?.length ?? 0;

    if (afterRepliesLen > beforeRepliesLen && afterReplies) {
      const newestReply = afterReplies[afterReplies.length - 1];
      const replyToken = generateToken(
        event.params.ticketId,
        afterData.email,
        ticketSecret.value()
      );
      const replyUrl = `${MARKETING_SITE_URL}/ticket/${replyToken}`;
      try {
        await sgMail.send({
          from: {email: FROM_EMAIL, name: FROM_NAME},
          to: email,
          subject: `New reply to your ticket (${formattedTicket})`,
          text: [
            "Hi,",
            "",
            `There's a new reply on your support ticket ${formattedTicket}:`,
            "",
            newestReply.text,
            "",
            "If you need further assistance, feel free to visit our contact page and submit a new message. Our team will continue to follow up with you.",
            "",
            "The Ferro Maps Team",
            "",
            `To reply to this ticket, visit: ${replyUrl}`,
          ].join("\n"),
          html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1E7BFF;margin-bottom:8px">New reply on ticket ${formattedTicket}</h2>
  <p style="background:#f5f5f5;padding:12px;border-radius:4px;white-space:pre-wrap">${newestReply.text}</p>
  <p>If you need further assistance, feel free to visit our contact page and submit a new message. Our team will continue to follow up with you.</p>
  <p style="margin-top:32px;color:#666">The Ferro Maps Team</p>
  <div style="text-align:center;margin-top:24px;">
    <a href="${replyUrl}" style="display:inline-block;background:#1E7BFF;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Reply to this ticket</a>
  </div>
</div>`,
        });
        logger.info(`onTicketUpdated: reply notification sent to ${email} (${formattedTicket})`);
      } catch (err) {
        logger.error(`onTicketUpdated: failed to send reply notification to ${email}`, err);
      }
    }

    // CASE B: status changed to closed
    if (beforeData.status !== "closed" && afterData.status === "closed") {
      try {
        await sgMail.send({
          from: {email: FROM_EMAIL, name: FROM_NAME},
          to: email,
          subject: `Your ticket (${formattedTicket}) has been closed`,
          text: [
            "Hi,",
            "",
            `Your support ticket ${formattedTicket} has been marked as resolved and closed.`,
            "",
            "If you need further help, feel free to submit a new request.",
            "",
            "The Ferro Maps Team",
          ].join("\n"),
          html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1E7BFF;margin-bottom:8px">Ticket ${formattedTicket} closed</h2>
  <p>Your support ticket has been marked as resolved and closed.</p>
  <p>If you need further help, feel free to submit a new request.</p>
  <p style="margin-top:32px;color:#666">The Ferro Maps Team</p>
</div>`,
        });
        logger.info(`onTicketUpdated: closed notification sent to ${email} (${formattedTicket})`);
      } catch (err) {
        logger.error(`onTicketUpdated: failed to send closed notification to ${email}`, err);
      }
    }

    // CASE C: status changed from closed back to open (reopened)
    if (beforeData.status === "closed" && afterData.status !== "closed") {
      const reopenToken = generateToken(
        event.params.ticketId,
        afterData.email,
        ticketSecret.value()
      );
      const reopenReplyUrl = `${MARKETING_SITE_URL}/ticket/${reopenToken}`;
      try {
        await sgMail.send({
          from: {email: FROM_EMAIL, name: FROM_NAME},
          to: email,
          subject: `Your ticket (${formattedTicket}) has been reopened`,
          text: [
            "Hi,",
            "",
            `Your support ticket ${formattedTicket} has been reopened by our team.`,
            "",
            "The Ferro Maps Team",
            "",
            `To reply to this ticket, visit: ${reopenReplyUrl}`,
          ].join("\n"),
          html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1E7BFF;margin-bottom:8px">Ticket ${formattedTicket} reopened</h2>
  <p>Your support ticket has been reopened by our team.</p>
  <p style="margin-top:32px;color:#666">The Ferro Maps Team</p>
  <div style="text-align:center;margin-top:24px;">
    <a href="${reopenReplyUrl}" style="display:inline-block;background:#1E7BFF;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Reply to this ticket</a>
  </div>
</div>`,
        });
        logger.info(`onTicketUpdated: reopened notification sent to ${email} (${formattedTicket})`);
      } catch (err) {
        logger.error(`onTicketUpdated: failed to send reopened notification to ${email}`, err);
      }
    }
  }
);

// Handles driver ticket-page requests (validating a link, submitting a reply)
// via a Firestore-triggered function rather than onCall -- onCall requires a
// public invoker IAM grant this project's org policy blocks, and separately,
// the driver visiting this page is never signed in, so a direct client-side
// Firestore read would also fail the supportRequests auth rule regardless.
// Writing a request document (public create, public read on a fresh random
// ID, but content only ever populated after real server-side HMAC token
// verification) sidesteps both problems -- same pattern as onAccountAction.
export const onTicketRequest = onDocumentCreated(
  {document: "ticketRequests/{requestId}", secrets: [ticketSecret]},
  async (event) => {
    const data = event.data?.data();
    const requestRef = event.data?.ref;
    if (!data || !requestRef) {
      logger.warn("onTicketRequest: no data in event, skipping");
      return;
    }

    const {type, token, replyText} = data as {
      type: "validate" | "reply";
      token: string;
      replyText?: string;
    };

    try {
      const parsed = verifyToken(token, ticketSecret.value());
      if (!parsed) {
        throw new Error("Invalid or tampered link.");
      }
      const {ticketId, email} = parsed;

      const ticketRef = db.collection("supportRequests").doc(ticketId);
      const ticketSnap = await ticketRef.get();
      if (!ticketSnap.exists) {
        throw new Error("Ticket not found.");
      }
      const ticket = ticketSnap.data()!;
      if (ticket.email !== email) {
        throw new Error("This link does not match this ticket.");
      }
      if (ticket.status === "closed") {
        throw new Error("This ticket has been closed and can no longer be replied to.");
      }

      if (type === "validate") {
        const repliesForDriver = (ticket.replies ?? []).map(
          (reply: {text: string; sentBy: string; sentAt?: {toDate?: () => Date}}) => ({
            text: reply.text,
            sentBy: reply.sentBy,
            sentAt: reply.sentAt?.toDate?.()?.toISOString() ?? null,
          })
        );
        await requestRef.update({
          status: "done",
          result: {
            ticketId,
            ticketNumber: ticket.ticketNumber,
            subject: ticket.subject,
            message: ticket.message,
            status: ticket.status,
            replies: repliesForDriver,
            submittedAt: ticket.submittedAt?.toDate?.()?.toISOString() ?? null,
          },
        });
      } else if (type === "reply") {
        if (!replyText?.trim()) {
          throw new Error("Reply text is required.");
        }
        await ticketRef.update({
          replies: FieldValue.arrayUnion({
            text: replyText.trim(),
            sentAt: new Date(),
            sentBy: "driver",
          }),
        });
        await requestRef.update({status: "done", result: {success: true}});
      } else {
        throw new Error("Unknown request type.");
      }

      logger.info(`onTicketRequest: ${type} succeeded for ticket ${ticketId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await requestRef.update({status: "error", error: message});
      logger.warn(`onTicketRequest: ${type} failed: ${message}`);
    }
  }
);

export const onAccountAction = onDocumentCreated(
  {document: "accountActions/{actionId}"},
  async (event) => {
    const data = event.data?.data();
    const actionRef = event.data?.ref;
    if (!data || !actionRef) {
      logger.warn("onAccountAction: no data in event, skipping");
      return;
    }

    const {type, uid} = data as {type: string; uid: string};

    try {
      if (type === "suspend" || type === "unsuspend") {
        const userRef = db.collection("users").doc(uid);
        if (type === "suspend") {
          await userRef.update({
            isSuspended: true,
            suspendedAt: FieldValue.serverTimestamp(),
          });
        } else {
          await userRef.update({isSuspended: false});
        }

        try {
          await getAuth().updateUser(uid, {disabled: type === "suspend"});
          if (type === "suspend") {
            await getAuth().revokeRefreshTokens(uid);
          }
        } catch (err) {
          logger.warn(`onAccountAction: could not ${type} auth user for uid=${uid}`, err);
        }
      } else if (type === "delete") {
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          throw new Error("Driver account not found.");
        }

        await db.recursiveDelete(userRef);

        try {
          await getAuth().deleteUser(uid);
        } catch (err) {
          logger.warn(`onAccountAction: could not delete auth user for uid=${uid}`, err);
        }
      } else if (type === "resetStats") {
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          throw new Error("Driver account not found.");
        }

        await db.recursiveDelete(userRef.collection("ferroEarnings"));

        await userRef.update({
          ferroBalance: 0,
          xp: 0,
          level: 1,
          dayStreak: 0,
        });
      } else {
        throw new Error(`Unknown action type: ${type}`);
      }

      await actionRef.update({status: "done", completedAt: FieldValue.serverTimestamp()});
      logger.info(`onAccountAction: ${type} completed for uid=${uid}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await actionRef.update({status: "error", error: message});
      logger.error(`onAccountAction: ${type} failed for uid=${uid}`, err);
    }
  }
);
