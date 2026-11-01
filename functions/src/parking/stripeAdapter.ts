import Stripe from "stripe";
import {type PaymentIntentShape, type ParkingStripe} from "./payments";
import {type ReconcileStripe} from "./reconcile";

function customerOf(customer: Stripe.PaymentIntent["customer"]): PaymentIntentShape["customer"] {
  if (typeof customer === "string" || customer === null) return customer;
  if (customer && typeof customer === "object" && "id" in customer) return {id: customer.id};
  return null;
}

export function paymentShape(pi: Stripe.PaymentIntent): PaymentIntentShape {
  return {
    id: pi.id,
    client_secret: pi.client_secret,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    customer: customerOf(pi.customer),
    last_payment_error: pi.last_payment_error ?? undefined,
  };
}

export function parkingStripe(stripe: Stripe): ParkingStripe {
  return {
    customers: {
      create: (params, options) => stripe.customers.create(params, options),
    },
    paymentIntents: {
      create: async (params, options) => paymentShape(await stripe.paymentIntents.create(params, options)),
      retrieve: async (id) => paymentShape(await stripe.paymentIntents.retrieve(id)),
      cancel: async (id) => paymentShape(await stripe.paymentIntents.cancel(id)),
    },
    ephemeralKeys: {
      create: (params, options) => stripe.ephemeralKeys.create(params, options),
    },
  };
}

export function reconcileStripe(stripe: Stripe): ReconcileStripe {
  return {
    paymentIntents: {
      retrieve: async (id) => paymentShape(await stripe.paymentIntents.retrieve(id)),
      cancel: async (id) => paymentShape(await stripe.paymentIntents.cancel(id)),
    },
    events: {
      list: async (params) => {
        const page = await stripe.events.list({
          types: params.types,
          created: params.created,
          limit: params.limit,
          starting_after: params.starting_after,
        });
        return {
          has_more: page.has_more,
          data: page.data.map((event) => ({
            id: event.id,
            type: event.type,
            created: event.created,
            livemode: event.livemode,
            data: {object: eventObject(event.data.object)},
          })),
        };
      },
    },
  };
}

function eventObject(object: Stripe.Event.Data.Object): Record<string, unknown> {
  if (typeof object === "object" && object !== null) {
    const entries = Object.entries(object).filter((entry) => typeof entry[1] !== "function");
    return Object.fromEntries(entries);
  }
  return {};
}
