import Stripe from "stripe";
import {ParkingPaymentError, isPaymentIntentId, refundIdempotencyKey} from "./contract";

export interface RefundClient {
  refunds: {
    create(
      params: {payment_intent: string; amount: number},
      options: {idempotencyKey: string},
    ): Promise<{id: string}>;
  };
}

export async function refundDriverCharge(
  client: RefundClient,
  paymentIntentId: string,
  amountPence: number,
): Promise<void> {
  if (!isPaymentIntentId(paymentIntentId)) {
    throw new ParkingPaymentError("invalid-argument", "This payment isn't valid.");
  }
  if (!Number.isSafeInteger(amountPence) || amountPence < 1) {
    throw new ParkingPaymentError("invalid-argument", "This refund amount isn't valid.");
  }
  try {
    await client.refunds.create(
      {payment_intent: paymentIntentId, amount: amountPence},
      {idempotencyKey: refundIdempotencyKey(paymentIntentId)},
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && err.code === "charge_already_refunded") return;
    throw err;
  }
}
