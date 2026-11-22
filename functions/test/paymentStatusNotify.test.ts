import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {join} from "node:path";
import {before, beforeEach, describe, it} from "node:test";
import {
  DEFAULT_PAYMENTS_EMAIL,
  SLACK_TIMEOUT_MS,
  SMTP_TIMEOUT_MS,
  buildPaymentStatusMessage,
  changedNotifyStatus,
  formatPaymentAmount,
  londonTime,
  notifyParkingPaymentStatus,
  postSlackWebhook,
  readSecret,
  sendPaymentsEmail,
  statusNotificationId,
  stripeDashboardPaymentUrl,
  type PaymentEmail,
  type PaymentNotifyIo,
  type SecretReaders,
} from "../src/parking/onParkingPaymentStatus";
import {clearDb, testDb} from "./support";

const PLATE = "ZZ99ZZZ";
const UID = "uid_9f3a_should_stay_out";
const DRIVER_EMAIL = "driver.secret@example.com";
const DRIVER_NAME = "Jemima Driver";
const CARD = "4242424242424242";
const WHEN = new Date("2026-11-22T08:30:00.000Z");
const SLACK_URL = "https://hooks.slack.com/services/T00/B00/test";
const SMTP_URL = "smtps://pay%40ferromaps.com:app%20pass@smtp.gmail.com:465";

const FORBIDDEN = [PLATE, UID, DRIVER_EMAIL, DRIVER_NAME, CARD, "pm_card_visa"];

function assertClean(text: string): void {
  for (const secret of FORBIDDEN) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(text.includes("@"), false);
}

describe("payment status message", () => {
  it("names the status, amount, place, payment, Stripe link, and London time", () => {
    const message = buildPaymentStatusMessage({
      status: "paid",
      amount: 610,
      currency: "gbp",
      place: "Station Car Park",
      paymentIntentId: "pi_paid1",
      livemode: false,
      when: WHEN,
    });
    assert.equal(message.subject, "Parking payment paid");
    assert.equal(message.text, [
      "Status: paid",
      "Amount: 6.10 GBP",
      "Place: Station Car Park",
      "Payment: pi_paid1",
      "Stripe: https://dashboard.stripe.com/test/payments/pi_paid1",
      "Time: 22 Nov 2026, 08:30 (Europe/London)",
    ].join("\n"));
    assertClean(message.text);
    assertClean(message.subject);
  });

  it("uses the live Stripe link only when livemode is exactly true", () => {
    assert.equal(
      stripeDashboardPaymentUrl("pi_live1", true),
      "https://dashboard.stripe.com/payments/pi_live1",
    );
    assert.equal(
      stripeDashboardPaymentUrl("pi_live1", false),
      "https://dashboard.stripe.com/test/payments/pi_live1",
    );
    assert.equal(
      stripeDashboardPaymentUrl("pi_live1", "true"),
      "https://dashboard.stripe.com/test/payments/pi_live1",
    );
  });

  it("formats London time in winter and summer", () => {
    assert.equal(londonTime(WHEN), "22 Nov 2026, 08:30 (Europe/London)");
    assert.equal(
      londonTime(new Date("2026-07-22T08:30:00.000Z")),
      "22 Jul 2026, 09:30 (Europe/London)",
    );
  });

  it("formats amounts in major units and keeps an unknown amount", () => {
    assert.equal(formatPaymentAmount(160, "gbp"), "1.60 GBP");
    assert.equal(formatPaymentAmount(0, "eur"), "0.00 EUR");
    assert.equal(formatPaymentAmount(undefined, "gbp"), "unknown GBP");
    assert.equal(formatPaymentAmount(610, "nope"), "6.10 UNKNOWN");
  });

  it("notifies paid, failed, canceled, and refunded, and ignores the other statuses", () => {
    for (const status of ["paid", "failed", "canceled", "refunded"]) {
      assert.equal(changedNotifyStatus("created", status), status);
      assert.equal(changedNotifyStatus(undefined, status), status);
      assert.equal(changedNotifyStatus(status, status), null);
    }
    assert.equal(changedNotifyStatus("paid", "refunded"), "refunded");
    assert.equal(changedNotifyStatus("created", "processing"), null);
    assert.equal(changedNotifyStatus("paid", "partially_refunded"), null);
    assert.equal(changedNotifyStatus("paid", "refund_pending"), null);
    assert.equal(changedNotifyStatus("paid", undefined), null);
  });

  it("treats a throwing or blank secret as missing", () => {
    assert.equal(readSecret(() => {
      throw new Error("unset");
    }), null);
    assert.equal(readSecret(() => "  "), null);
    assert.equal(readSecret(() => " https://hooks.slack.com/services/x "), "https://hooks.slack.com/services/x");
  });
});

describe("slack webhook and smtp", () => {
  it("posts the text with fetch and a short timeout", async () => {
    const calls: Array<{url: string; init: RequestInit | undefined}> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({url: String(url), init});
      return new Response("ok", {status: 200});
    };
    await postSlackWebhook(SLACK_URL, "Status: paid", fetchImpl);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, SLACK_URL);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[0]?.init?.redirect, "error");
    assert.equal(calls[0]?.init?.body, JSON.stringify({text: "Status: paid"}));
    assert.ok(calls[0]?.init?.signal);
    assert.equal(SLACK_TIMEOUT_MS, 5000);
  });

  it("rejects a slack failure without including the webhook url", async () => {
    const fetchImpl: typeof fetch = async () => new Response("no", {status: 500});
    await assert.rejects(
      () => postSlackWebhook(SLACK_URL, "Status: failed", fetchImpl),
      (err: Error) => {
        assert.equal(err.message, "slack webhook failed");
        assert.equal(err.message.includes(SLACK_URL), false);
        assert.equal(err.message.includes("hooks.slack.com"), false);
        return true;
      },
    );
    const throwing: typeof fetch = async () => {
      throw new Error(`network ${SLACK_URL}`);
    };
    await assert.rejects(() => postSlackWebhook(SLACK_URL, "Status: failed", throwing));
  });

  it("sends through a mocked nodemailer transport and closes it", async () => {
    const sent: PaymentEmail[] = [];
    let closed = 0;
    let seenHost = "";
    let seenUser = "";
    let seenPass = "";
    let seenTimeout = 0;
    await sendPaymentsEmail(SMTP_URL, {
      from: DEFAULT_PAYMENTS_EMAIL,
      to: DEFAULT_PAYMENTS_EMAIL,
      subject: "Parking payment paid",
      text: "Status: paid",
    }, (settings) => {
      seenHost = settings.host ?? "";
      const auth = settings.auth;
      seenUser = auth && "user" in auth && typeof auth.user === "string" ? auth.user : "";
      seenPass = auth && "pass" in auth && typeof auth.pass === "string" ? auth.pass : "";
      seenTimeout = settings.connectionTimeout ?? 0;
      assert.equal(settings.port, 465);
      assert.equal(settings.secure, true);
      assert.equal(settings.greetingTimeout, SMTP_TIMEOUT_MS);
      assert.equal(settings.socketTimeout, SMTP_TIMEOUT_MS);
      return {
        async sendMail(message) {
          sent.push(message);
        },
        close() {
          closed += 1;
        },
      };
    });
    assert.equal(seenHost, "smtp.gmail.com");
    assert.equal(seenUser, "pay@ferromaps.com");
    assert.equal(seenPass, "app pass");
    assert.equal(seenTimeout, 5000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, DEFAULT_PAYMENTS_EMAIL);
    assert.equal(closed, 1);
  });

  it("closes the transport when nodemailer fails and hides a bad url", async () => {
    let closed = 0;
    await assert.rejects(
      () => sendPaymentsEmail(SMTP_URL, {
        from: "pay@ferromaps.com",
        to: "pay@ferromaps.com",
        subject: "Parking payment failed",
        text: "Status: failed",
      }, () => ({
        async sendMail() {
          throw new Error("smtp down");
        },
        close() {
          closed += 1;
        },
      })),
      (err: Error) => {
        assert.equal(err.message, "smtp down");
        return true;
      },
    );
    assert.equal(closed, 1);

    const secret = "smtp://user:super-secret-password@";
    await assert.rejects(
      () => sendPaymentsEmail(secret, {
        from: "pay@ferromaps.com",
        to: "pay@ferromaps.com",
        subject: "x",
        text: "y",
      }, () => {
        throw new Error("should not connect");
      }),
      (err: Error) => {
        assert.equal(err.message, "smtp url is not usable");
        assert.equal(err.message.includes("super-secret-password"), false);
        return true;
      },
    );
  });
});

const PROJECT = "demo-ferromaps-payment-notify";
const db = testDb(PROJECT);

interface Capture {
  slack: string[];
  emails: PaymentEmail[];
  slackReads: number;
  smtpReads: number;
}

function readers(slack: string | null, smtp: string | null, capture: Capture): SecretReaders {
  return {
    slackWebhook: () => {
      capture.slackReads += 1;
      if (slack === null) throw new Error("SLACK_PAYMENTS_WEBHOOK_URL is not set");
      return slack;
    },
    smtpUrl: () => {
      capture.smtpReads += 1;
      if (smtp === null) throw new Error("PAYMENTS_SMTP_URL is not set");
      return smtp;
    },
  };
}

function ioFor(
  capture: Capture,
  modes: {slack?: "ok" | "status" | "throw"; email?: "ok" | "throw"} = {},
): PaymentNotifyIo {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(body) as {text?: string};
    if (modes.slack === "throw") throw new Error("network down");
    if (modes.slack === "status") return new Response("no", {status: 502});
    capture.slack.push(parsed.text ?? "");
    return new Response("ok", {status: 200});
  };
  return {
    postSlack: (url, text) => postSlackWebhook(url, text, fetchImpl),
    sendEmail: (smtpUrl, message) => sendPaymentsEmail(smtpUrl, message, () => ({
      async sendMail(mail) {
        if (modes.email === "throw") throw new Error("smtp down");
        capture.emails.push(mail);
      },
      close() {
        void smtpUrl;
      },
    })),
  };
}

function payment(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status,
    amount: 610,
    currency: "gbp",
    placeId: "place-1",
    livemode: false,
    plate: PLATE,
    uid: UID,
    email: DRIVER_EMAIL,
    name: DRIVER_NAME,
    card: CARD,
    paymentMethod: "pm_card_visa",
    ...extra,
  };
}

async function notify(
  id: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  capture: Capture,
  slack: string | null = SLACK_URL,
  smtp: string | null = SMTP_URL,
  modes: {slack?: "ok" | "status" | "throw"; email?: "ok" | "throw"} = {},
): Promise<void> {
  await notifyParkingPaymentStatus(
    db,
    id,
    before,
    after,
    WHEN,
    readers(slack, smtp, capture),
    ioFor(capture, modes),
  );
}

describe("parking payment status notifier", () => {
  before(() => {
    testDb(PROJECT);
  });

  beforeEach(async () => {
    await clearDb(db);
    await db.collection("places").doc("place-1").set({name: "Station Car Park"});
  });

  it("notifies each of paid, failed, canceled, and refunded once", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    const cases = [
      ["pi_paid1", "paid"],
      ["pi_fail1", "failed"],
      ["pi_cancel1", "canceled"],
      ["pi_refund1", "refunded"],
    ] as const;
    for (const [id, status] of cases) {
      await notify(id, {status: "created"}, payment(status), capture);
      await notify(id, {status: "created"}, payment(status), capture);
    }
    assert.equal(capture.slack.length, 4);
    assert.equal(capture.emails.length, 4);
    for (const [id, status] of cases) {
      const text = capture.slack.find((line) => line.includes(`Payment: ${id}`)) ?? "";
      assert.match(text, new RegExp(`Status: ${status}`));
      assert.match(text, /Amount: 6\.10 GBP/);
      assert.match(text, /Place: Station Car Park/);
      assert.match(text, /Stripe: https:\/\/dashboard\.stripe\.com\/test\/payments\//);
      assert.match(text, /Time: 22 Nov 2026, 08:30 \(Europe\/London\)/);
      assertClean(text);
      const email = capture.emails.find((item) => item.text.includes(`Payment: ${id}`));
      assert.equal(email?.text, text);
      assert.equal(email?.subject, `Parking payment ${status}`);
      assert.equal(email?.to, DEFAULT_PAYMENTS_EMAIL);
      assert.equal(email?.from, DEFAULT_PAYMENTS_EMAIL);
      assertClean(email?.subject ?? "");
      const marker = await db.collection("paymentNotifications").doc(statusNotificationId(id, status)).get();
      assert.equal(marker.exists, true);
      assert.deepEqual(
        Object.keys(marker.data() ?? {}).sort(),
        ["createdAt", "email", "paymentIntentId", "slack", "status"],
      );
      assert.equal(marker.get("status"), status);
      assert.equal(marker.get("paymentIntentId"), id);
      assert.equal(marker.get("slack"), true);
      assert.equal(marker.get("email"), true);
    }
  });

  it("sends a refund after a paid notice, and a repeat of paid does not send again", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_both1", {status: "created"}, payment("paid"), capture);
    await notify("pi_both1", {status: "paid"}, payment("refunded"), capture);
    await notify("pi_both1", {status: "created"}, payment("paid"), capture);
    assert.deepEqual(capture.slack.map((text) => text.split("\n")[0]), ["Status: paid", "Status: refunded"]);
    assert.equal(capture.emails.length, 2);
    assertClean(capture.slack.join("\n"));
  });

  it("a duplicate call in parallel sends once", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    const before = {status: "processing"};
    const after = payment("paid");
    await Promise.all([
      notify("pi_race1", before, after, capture),
      notify("pi_race1", before, after, capture),
    ]);
    assert.equal(capture.slack.length, 1);
    assert.equal(capture.emails.length, 1);
  });

  it("sends nothing when the switches are missing, false, or not boolean true", async () => {
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_off1", {status: "created"}, payment("paid"), capture);
    await db.doc("config/flags").set({paymentSlackNotify: false, paymentEmailNotify: false});
    await notify("pi_off1", {status: "created"}, payment("paid"), capture);
    await db.doc("config/flags").set({paymentSlackNotify: "true", paymentEmailNotify: 1});
    await notify("pi_off1", {status: "created"}, payment("paid"), capture);
    assert.equal(capture.slack.length, 0);
    assert.equal(capture.emails.length, 0);
    assert.equal(capture.slackReads, 0);
    assert.equal(capture.smtpReads, 0);
    assert.equal((await db.collection("paymentNotifications").get()).size, 0);
  });

  it("sends only the channel whose switch is exactly true", async () => {
    const slackOnly: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: false});
    await notify("pi_slackonly", {status: "created"}, payment("failed"), slackOnly);
    assert.equal(slackOnly.slack.length, 1);
    assert.equal(slackOnly.emails.length, 0);
    assert.equal(slackOnly.smtpReads, 0);

    await clearDb(db);
    await db.collection("places").doc("place-1").set({name: "Station Car Park"});
    const emailOnly: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await db.doc("config/flags").set({paymentSlackNotify: false, paymentEmailNotify: true});
    await notify("pi_emailonly", {status: "created"}, payment("canceled"), emailOnly);
    assert.equal(emailOnly.slack.length, 0);
    assert.equal(emailOnly.emails.length, 1);
    assert.equal(emailOnly.slackReads, 0);
  });

  it("skips a channel whose secret is missing and still sends the other", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_noslack", {status: "created"}, payment("paid"), capture, null, SMTP_URL);
    assert.equal(capture.slack.length, 0);
    assert.equal(capture.emails.length, 1);
    assert.equal(capture.slackReads, 1);
    await notify("pi_noslack", {status: "created"}, payment("paid"), capture, SLACK_URL, SMTP_URL);
    assert.equal(capture.slack.length, 1);
    assert.equal(capture.emails.length, 1);

    const other: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_nomail", {status: "created"}, payment("refunded"), other, SLACK_URL, "  ");
    assert.equal(other.slack.length, 1);
    assert.equal(other.emails.length, 0);
    assert.equal(other.smtpReads, 1);
  });

  it("sends nothing and writes no marker when every switched-on secret is missing", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_nosecret", {status: "created"}, payment("paid"), capture, null, null);
    assert.equal(capture.slack.length, 0);
    assert.equal(capture.emails.length, 0);
    assert.equal((await db.collection("paymentNotifications").get()).size, 0);
  });

  it("keeps the plate, uid, name, email, and card out of the message", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_private1", {status: "created"}, payment("paid", {
      placeId: "place-1",
      amount: 610,
    }), capture);
    assert.equal(capture.slack.length, 1);
    assertClean(capture.slack[0] ?? "");
    assertClean(capture.emails[0]?.text ?? "");
    assert.equal((capture.emails[0]?.text ?? "").includes("Station Car Park"), true);
  });

  it("uses the place id when the place has no public name", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true});
    await db.collection("places").doc("place-email").set({name: "desk@ferromaps.com"});
    await db.collection("places").doc("place-card").set({name: CARD});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_placemail", undefined, payment("failed", {placeId: "place-email"}), capture);
    await notify("pi_placecard", undefined, payment("failed", {placeId: "place-card"}), capture);
    await notify("pi_placemissing", undefined, payment("failed", {placeId: "place-missing"}), capture);
    assert.equal(capture.slack.length, 3);
    assert.equal(capture.slack[0]?.includes("Place: place-email"), true);
    assert.equal(capture.slack[0]?.includes("desk@ferromaps.com"), false);
    assert.equal(capture.slack[1]?.includes(CARD), false);
    assert.equal(capture.slack[1]?.includes("[redacted]"), true);
    assert.equal(capture.slack[2]?.includes("Place: place-missing"), true);
    for (const text of capture.slack) assertClean(text.replace("[redacted]", ""));
  });

  it("uses the configured inbox and a live dashboard link", async () => {
    await db.doc("config/flags").set({paymentEmailNotify: true, paymentSlackNotify: true});
    await db.doc("config/notifications").set({paymentsEmail: "finance@ferromaps.com"});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_live1", {status: "paid"}, payment("refunded", {livemode: true, amount: 2500}), capture);
    assert.match(capture.slack[0] ?? "", /Amount: 25\.00 GBP/);
    assert.match(capture.slack[0] ?? "", /Stripe: https:\/\/dashboard\.stripe\.com\/payments\/pi_live1/);
    assert.equal((capture.slack[0] ?? "").includes("/test/"), false);
    assert.equal(capture.emails[0]?.to, "finance@ferromaps.com");
    assert.equal(capture.emails[0]?.from, "finance@ferromaps.com");
    assert.equal((capture.emails[0]?.text ?? "").includes("finance@ferromaps.com"), false);
    assertClean(capture.slack[0] ?? "");
  });

  it("falls back to pay@ferromaps.com when the inbox setting is unusable", async () => {
    await db.doc("config/flags").set({paymentEmailNotify: true});
    await db.doc("config/notifications").set({paymentsEmail: "not-an-email"});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_inbox1", {status: "created"}, payment("canceled"), capture);
    assert.equal(capture.emails[0]?.to, DEFAULT_PAYMENTS_EMAIL);
  });

  it("ignores a same-status write, a partial refund, and an id that is not a PaymentIntent", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_same1", payment("paid"), payment("paid", {amount: 999}), capture);
    await notify("pi_partial1", payment("paid"), payment("partially_refunded"), capture);
    await notify("not_a_pi", {status: "created"}, payment("paid"), capture);
    assert.equal(capture.slack.length, 0);
    assert.equal(capture.emails.length, 0);
    assert.equal((await db.collection("paymentNotifications").get()).size, 0);
  });

  it("retries only the channel that failed", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_partialfail", {status: "created"}, payment("paid"), capture, SLACK_URL, SMTP_URL, {
      slack: "throw",
    });
    assert.equal(capture.slack.length, 0);
    assert.equal(capture.emails.length, 1);
    const mid = await db.collection("paymentNotifications").doc("pi_partialfail_paid").get();
    assert.equal(mid.get("email"), true);
    assert.equal(mid.get("slack") === true, false);

    await notify("pi_partialfail", {status: "created"}, payment("paid"), capture);
    assert.equal(capture.slack.length, 1);
    assert.equal(capture.emails.length, 1);
    const done = await db.collection("paymentNotifications").doc("pi_partialfail_paid").get();
    assert.equal(done.get("slack"), true);
    assert.equal(done.get("email"), true);

    await notify("pi_partialfail", {status: "created"}, payment("paid"), capture);
    assert.equal(capture.slack.length, 1);
    assert.equal(capture.emails.length, 1);

    const emailFailed: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_mailfail", {status: "paid"}, payment("refunded"), emailFailed, SLACK_URL, SMTP_URL, {
      email: "throw",
    });
    assert.equal(emailFailed.slack.length, 1);
    assert.equal(emailFailed.emails.length, 0);
    await notify("pi_mailfail", {status: "paid"}, payment("refunded"), emailFailed);
    assert.equal(emailFailed.slack.length, 1);
    assert.equal(emailFailed.emails.length, 1);
    const refundMarker = await db.collection("paymentNotifications").doc("pi_mailfail_refunded").get();
    assert.equal(refundMarker.get("slack"), true);
    assert.equal(refundMarker.get("email"), true);
  });

  it("keeps going when Slack or SMTP fails", async () => {
    await db.doc("config/flags").set({paymentSlackNotify: true, paymentEmailNotify: true});
    const slackDown: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_slackdown", {status: "created"}, payment("paid"), slackDown, SLACK_URL, SMTP_URL, {
      slack: "status",
    });
    assert.equal(slackDown.slack.length, 0);
    assert.equal(slackDown.emails.length, 1);
    assertClean(slackDown.emails[0]?.text ?? "");

    const smtpDown: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_smtpdown", {status: "created"}, payment("failed"), smtpDown, SLACK_URL, SMTP_URL, {
      email: "throw",
    });
    assert.equal(smtpDown.slack.length, 1);
    assert.equal(smtpDown.emails.length, 0);

    const bothDown: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_bothdown", {status: "created"}, payment("canceled"), bothDown, SLACK_URL, SMTP_URL, {
      slack: "throw",
      email: "throw",
    });
    assert.equal(bothDown.slack.length, 0);
    assert.equal(bothDown.emails.length, 0);
    const marker = await db.collection("paymentNotifications").doc("pi_bothdown_canceled").get();
    assert.equal(marker.get("slack") === true, false);
    assert.equal(marker.get("email") === true, false);
  });

  it("sends the short note when the operator-details flag is absent", async () => {
    await db.doc("config/flags").set({
      paymentSlackNotify: true,
      paymentEmailNotify: true,
    });
    await seedOperatorContext();
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_opabsent", {status: "created"}, operatorPayment("paid"), capture);
    const slack = capture.slack[0] ?? "";
    const email = capture.emails[0]?.text ?? "";
    assert.equal(capture.slack.length, 1);
    assert.equal(capture.emails.length, 1);
    for (const text of [slack, email]) {
      assert.equal(text.includes(OPERATOR_PLATE), false);
      assert.equal(text.includes(OPERATOR_PHONE), false);
      assert.equal(text.includes("Plate:"), false);
      assert.equal(text.includes("Phone:"), false);
    }
    const flags = await db.doc("config/flags").get();
    assert.equal(flags.get("paymentAlertOperatorDetails"), undefined);
  });

  it("leaves the plate and phone out when operator details are off", async () => {
    await db.doc("config/flags").set({
      paymentSlackNotify: true,
      paymentEmailNotify: true,
      paymentAlertOperatorDetails: "true",
    });
    await seedOperatorContext();
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_opoff", {status: "created"}, operatorPayment("paid"), capture);
    assert.equal(capture.slack.length, 1);
    assert.equal(capture.emails.length, 1);
    assert.equal((capture.slack[0] ?? "").includes(OPERATOR_PLATE), false);
    assert.equal((capture.slack[0] ?? "").includes(OPERATOR_PHONE), false);
    assert.equal((capture.emails[0]?.text ?? "").includes(OPERATOR_PLATE), false);
    assert.equal((capture.emails[0]?.text ?? "").includes(OPERATOR_PHONE), false);
    assert.equal((capture.slack[0] ?? "").includes("Plate:"), false);
    assert.equal((capture.slack[0] ?? "").includes("Phone:"), false);
  });

  it("adds the car park payment details when the operator switch is exactly true", async () => {
    await db.doc("config/flags").set({
      paymentSlackNotify: true,
      paymentEmailNotify: true,
      paymentAlertOperatorDetails: true,
    });
    await seedOperatorContext();
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_opon", {status: "created"}, operatorPayment("paid"), capture);
    const text = capture.slack[0] ?? "";
    assert.equal(capture.emails[0]?.text, text);
    assert.match(text, /Car park: Station Car Park/);
    assert.match(text, /Address: 1 High Street, London E1 1AA/);
    assert.match(text, /Operator: RingGo/);
    assert.match(text, /Site code: 37208/);
    assert.match(text, new RegExp(`Plate: ${OPERATOR_PLATE}`));
    assert.match(text, /Stay: 60 minutes/);
    assert.match(text, /Paid at: 22 Nov 2026, 08:30 \(Europe\/London\)/);
    assert.equal(text.includes("Start:"), false);
    assert.match(text, /Driver paid: 6\.10 GBP/);
    assert.match(text, new RegExp(`Phone: ${OPERATOR_PHONE.replace("+", "\\+")}`));
    assert.equal(text.includes("Jemima Driver"), false);
    assert.equal(text.includes("driver.secret@example.com"), false);
    assert.equal(text.includes(CARD), false);
    assert.equal((capture.emails[0]?.subject ?? "").includes(OPERATOR_PLATE), false);
    assert.equal((capture.emails[0]?.subject ?? "").includes(OPERATOR_PHONE), false);

    const refunded: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_opon", {status: "paid"}, operatorPayment("refunded"), refunded);
    assert.match(refunded.slack[0] ?? "", /Status: refunded/);
    assert.match(refunded.slack[0] ?? "", new RegExp(`Plate: ${OPERATOR_PLATE}`));
  });

  it("omits operator details that are not stored", async () => {
    await db.doc("config/flags").set({
      paymentSlackNotify: true,
      paymentAlertOperatorDetails: true,
    });
    await db.collection("places").doc("place-bare").set({name: "Bare Yard"});
    const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
    await notify("pi_opmiss", {status: "created"}, {
      status: "paid",
      amount: 610,
      currency: "gbp",
      placeId: "place-bare",
      uid: "nobody",
      operator: "RingGo",
    }, capture);
    const text = capture.slack[0] ?? "";
    assert.match(text, /Car park: Bare Yard/);
    assert.match(text, /Operator: RingGo/);
    assert.match(text, /Driver paid: 6\.10 GBP/);
    assert.equal(text.includes("Plate:"), false);
    assert.equal(text.includes("Phone:"), false);
    assert.equal(text.includes("Address:"), false);
    assert.equal(text.includes("Site code:"), false);
    assert.equal(text.includes("Stay:"), false);
    assert.equal(text.includes("Paid at:"), false);
    assert.equal(text.includes("Start:"), false);
  });

  it("does not write the plate or phone into logs", async () => {
    await db.doc("config/flags").set({
      paymentSlackNotify: true,
      paymentEmailNotify: true,
      paymentAlertOperatorDetails: true,
    });
    await seedOperatorContext();
    const logs = captureLogger();
    try {
      const capture: Capture = {slack: [], emails: [], slackReads: 0, smtpReads: 0};
      await notify("pi_oplog", {status: "created"}, operatorPayment("failed"), capture, SLACK_URL, SMTP_URL, {
        slack: "throw",
      });
      await notifyParkingPaymentStatus(
        db,
        "pi_oplog2",
        {status: "created"},
        operatorPayment("canceled"),
        WHEN,
        readers(SLACK_URL, SMTP_URL, capture),
        {
          postSlack: async () => {
            throw new Error(`boom ${OPERATOR_PLATE} ${OPERATOR_PHONE}`);
          },
          sendEmail: async () => {
            throw new Error(`mail ${OPERATOR_PLATE} ${OPERATOR_PHONE}`);
          },
        },
      );
    } finally {
      logs.restore();
    }
    assert.equal(logs.text().includes(OPERATOR_PLATE), false);
    assert.equal(logs.text().includes(OPERATOR_PHONE), false);
  });
});

const OPERATOR_PLATE = "LD04PAY";
const OPERATOR_PHONE = "+447700900555";

function operatorPayment(status: string): Record<string, unknown> {
  return {
    status,
    amount: 610,
    currency: "gbp",
    placeId: "place-op",
    uid: "driverop",
    operator: "RingGo",
    durationMinutes: 60,
    createdAt: WHEN,
    plate: OPERATOR_PLATE,
    phoneNumber: OPERATOR_PHONE,
    email: "driver.secret@example.com",
    name: "Jemima Driver",
    card: CARD,
  };
}

async function seedOperatorContext(): Promise<void> {
  await db.collection("places").doc("place-op").set({
    name: "Station Car Park",
    addr: "1 High Street, London E1 1AA",
    operator: "RingGo",
    locationCode: "37208",
  });
  await db.collection("operatorForwards").doc("pi_opabsent").set({plate: OPERATOR_PLATE});
  await db.collection("operatorForwards").doc("pi_opoff").set({plate: OPERATOR_PLATE});
  await db.collection("operatorForwards").doc("pi_opon").set({plate: OPERATOR_PLATE});
  await db.collection("operatorForwards").doc("pi_oplog").set({plate: OPERATOR_PLATE});
  await db.collection("operatorForwards").doc("pi_oplog2").set({plate: OPERATOR_PLATE});
  await db.collection("users").doc("driverop").set({
    phoneNumber: OPERATOR_PHONE,
    name: "Jemima Driver",
    email: "driver.secret@example.com",
  });
}

function captureLogger(): {text: () => string; restore: () => void} {
  const require = createRequire(join(process.cwd(), "package.json"));
  const commonPath = join(process.cwd(), "node_modules/firebase-functions/lib/logger/common.js");
  const common = require(commonPath) as {
    UNPATCHED_CONSOLE: Record<string, (...args: unknown[]) => void>;
  };
  const original = {...common.UNPATCHED_CONSOLE};
  const chunks: string[] = [];
  for (const key of Object.keys(original)) {
    const fn = original[key];
    common.UNPATCHED_CONSOLE[key] = (...args: unknown[]) => {
      chunks.push(args.map((item) => String(item)).join(" "));
      if (typeof fn === "function") fn(...args);
    };
  }
  return {
    text: () => chunks.join("\n"),
    restore: () => {
      Object.assign(common.UNPATCHED_CONSOLE, original);
    },
  };
}
