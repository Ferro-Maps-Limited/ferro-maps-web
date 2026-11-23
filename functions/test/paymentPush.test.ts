import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {paidNotice, paymentPushNotice} from "../src/parking/notices";
import {
  PARKING_PAYMENT_PUSH_KEYS,
  PARKING_PAYMENT_PUSH_TYPE,
  chargePhrase,
  classifyFcmToken,
  fcmErrorCode,
  isDeadFcmTokenError,
  parkingPaymentPushMessage,
  paymentPushCopy,
  planParkingPush,
} from "../src/parking/paymentPush";

const FACTS = {
  paymentIntentId: "pi_test1",
  uid: "alice",
  chargeType: "congestion",
  amountPence: 1410,
  placeId: "london-cc",
  event: "paid" as const,
};

describe("parking payment push copy", () => {
  it("keeps the paid email as it is", () => {
    const email = paidNotice({
      paymentIntentId: "pi_email1",
      uid: "alice",
      plate: "AB12CDE",
      occurredOn: "2026-11-16",
      zone: "Yard",
      chargeType: "parking",
      authorityPence: 450,
      driverAmountPence: 610,
      feePence: 160,
      paymentUrl: "https://www.myringgo.com/location/12345",
    });
    assert.equal(email.channel, "email");
    assert.equal(email.id, "pi_email1:paid");
    assert.equal(email.subject, "Your Ferro Maps payment");
    assert.match(email.text, /^We've taken your Ferro Maps payment\./);
    assert.equal(email.text.includes("parking charge payment taken"), false);
  });

  it("names the charge type and the amount, and does not fill either in", () => {
    const cases: Array<[string, number, string]> = [
      ["parking", 610, "We've taken £6.10 for your parking charge."],
      ["congestion", 1410, "We've taken £14.10 for your congestion charge."],
      ["ulez", 1500, "We've taken £15.00 for your ULEZ charge."],
      ["tunnel", 250, "We've taken £2.50 for your tunnel charge."],
      ["heathrow_dropoff", 700, "We've taken £7.00 for your Heathrow drop-off charge."],
      ["pcn", 6500, "We've taken £65.00 for your penalty charge."],
    ];
    for (const [chargeType, amountPence, body] of cases) {
      const copy = paymentPushCopy("paid", chargeType, amountPence);
      assert.equal(copy?.title, "Payment taken");
      assert.equal(copy?.body, body);
    }
    assert.equal(paymentPushCopy("fulfilled", "ulez", 1250)?.body,
      "We've paid the £12.50 ULEZ charge to the authority.");
    assert.equal(paymentPushCopy("refunded", "parking", 610)?.body,
      "We've refunded £6.10 for your parking charge.");
    assert.equal(paymentPushCopy("partial_refund", "congestion", 50)?.body,
      "We've refunded £0.50 of your congestion charge.");

    assert.equal(chargePhrase(undefined), null);
    assert.equal(paymentPushCopy("paid", undefined, 610), null);
    assert.equal(paymentPushCopy("paid", "parking", undefined), null);
    assert.equal(paymentPushCopy("paid", "PARKING", 610), null);
    assert.equal(paymentPushCopy("paid", "bus", 610), null);
    assert.equal(paymentPushCopy("paid", "parking", 0), null);
    assert.equal(paymentPushCopy("paid", "parking", 1.5), null);
    assert.equal(paymentPushCopy("paid", "parking", -610), null);
  });

  it("builds one outbox id and drops a push that would have to invent a field", () => {
    const notice = paymentPushNotice(FACTS);
    assert.equal(notice?.id, "pi_test1:paid:push");
    assert.equal(notice?.channel, "push");
    assert.equal(notice?.payloadStatus, "paid");
    assert.equal(notice?.placeId, "london-cc");
    assert.equal(notice?.text, "We've taken £14.10 for your congestion charge.");
    assert.equal(paymentPushNotice({...FACTS, placeId: ""})?.placeId, undefined);
    assert.equal(paymentPushNotice({...FACTS, chargeType: undefined}), null);
    assert.equal(paymentPushNotice({...FACTS, amountPence: "1410"}), null);
    assert.equal(paymentPushNotice({...FACTS, paymentIntentId: "pay_123"}), null);
    assert.equal(paymentPushNotice({...FACTS, uid: ""}), null);
    assert.equal(paymentPushNotice({...FACTS, event: "fulfilled"})?.payloadStatus, "fulfilled");
    assert.equal(paymentPushNotice({...FACTS, event: "partial_refund"})?.payloadStatus, "partially_refunded");
    assert.equal(paymentPushNotice({...FACTS, event: "refunded"} )?.id, "pi_test1:refunded:push");
  });
});

describe("parking payment push payload", () => {
  it("uses the keys the iOS parser reads", () => {
    assert.equal(PARKING_PAYMENT_PUSH_TYPE, "parking_payment");
    assert.equal(PARKING_PAYMENT_PUSH_KEYS.type, "type");
    assert.equal(PARKING_PAYMENT_PUSH_KEYS.paymentId, "paymentId");
    assert.equal(PARKING_PAYMENT_PUSH_KEYS.placeId, "placeId");
    assert.equal(PARKING_PAYMENT_PUSH_KEYS.status, "status");

    const message = parkingPaymentPushMessage({
      token: "token-1",
      title: "Payment taken",
      body: "We've taken £14.10 for your congestion charge.",
      paymentId: "pi_test1",
      status: "paid",
      placeId: "london-cc",
    });
    assert.deepEqual(message.data, {
      type: "parking_payment",
      paymentId: "pi_test1",
      placeId: "london-cc",
      status: "paid",
    });
    assert.deepEqual(message.notification, {
      title: "Payment taken",
      body: "We've taken £14.10 for your congestion charge.",
    });
    assert.equal("token" in message ? message.token : undefined, "token-1");
    assert.equal(message.apns?.payload?.aps?.sound, "default");

    const withoutPlace = parkingPaymentPushMessage({
      token: "token-1",
      title: "Payment refunded",
      body: "We've refunded £9.99 for your ULEZ charge.",
      paymentId: "pi_test1",
      status: "refunded",
    });
    assert.deepEqual(Object.keys(withoutPlace.data ?? {}).sort(), ["paymentId", "status", "type"]);
    assert.equal(withoutPlace.data?.placeId, undefined);
  });

  it("rejects a notice the phone would drop", () => {
    const fields = {
      subject: "Payment taken",
      text: "We've taken £6.10 for your parking charge.",
      payloadStatus: "paid",
      paymentIntentId: "pi_test1",
      placeId: "place-1",
      uid: "alice",
    };
    assert.equal(planParkingPush(fields)?.placeId, "place-1");
    assert.equal(planParkingPush({...fields, placeId: ""})?.placeId, undefined);
    assert.equal(planParkingPush({...fields, paymentIntentId: "abc"}), null);
    assert.equal(planParkingPush({...fields, payloadStatus: "parking_payment"}), null);
    assert.equal(planParkingPush({...fields, subject: "  "}), null);
    assert.equal(planParkingPush({...fields, uid: "bad/uid"}), null);
  });
});

describe("fcm token", () => {
  it("skips a missing or unusable token and only treats the mobile dead-token codes as dead", () => {
    assert.deepEqual(classifyFcmToken(null), {ok: false, reason: "missing-token"});
    assert.deepEqual(classifyFcmToken(undefined), {ok: false, reason: "missing-token"});
    assert.deepEqual(classifyFcmToken(""), {ok: false, reason: "missing-token"});
    assert.deepEqual(classifyFcmToken("bad token"), {ok: false, reason: "invalid-token"});
    assert.deepEqual(classifyFcmToken(12), {ok: false, reason: "invalid-token"});
    assert.deepEqual(classifyFcmToken("a".repeat(4097)), {ok: false, reason: "invalid-token"});
    assert.deepEqual(classifyFcmToken("device-token"), {ok: true, token: "device-token"});

    const unregistered = {
      code: "messaging/internal",
      errorInfo: {code: "messaging/registration-token-not-registered"},
    };
    assert.equal(fcmErrorCode(unregistered), "messaging/registration-token-not-registered");
    assert.equal(isDeadFcmTokenError(unregistered), true);
    assert.equal(isDeadFcmTokenError({code: "messaging/invalid-registration-token"}), true);
    assert.equal(isDeadFcmTokenError({code: "messaging/invalid-argument"}), false);
    assert.equal(isDeadFcmTokenError({code: "messaging/internal"}), false);
    assert.equal(isDeadFcmTokenError(new Error("nope")), false);
  });
});
