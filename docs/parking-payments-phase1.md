# Parking and congestion payments, phase 1

Ferro is the merchant of record. A driver pays Ferro's own Stripe account. Ferro then pays the authority or operator, in this phase by hand from the admin desk. There is no Stripe Connect account and no destination charge.

The Stripe account is **acct_1UYo41K3YqihBBbk**, the account for **pay@ferromaps.com**. Phase 1 is **test mode only**. A live secret is refused before any Stripe call, and `config/parkingPayments.testMode` must be `true`.

This doc supersedes the destination-charge and Gold-gate notes in `docs/backend-contract.md` and `functions/DEPLOY.md`. Do not set `reverse_transfer` on a refund. The charge never left Ferro's account.

Nothing here is deployed.

## Config

`config/parkingPayments` (server-only; clients cannot read or write it):

| Field | Value |
| --- | --- |
| `enabled` | `true` to take payments. Missing or anything else refuses the create. |
| `testMode` | must be `true` |
| `stripeAccountId` | must be `acct_1UYo41K3YqihBBbk` |

The function also calls `accounts.retrieve()` and refuses the charge unless Stripe reports that same account id. The expected id is `EXPECTED_STRIPE_ACCOUNT_ID` in `functions/src/parking/stripeClient.ts`. A mismatch is not cached. A match is cached for the process.

Create the document in the console before turning payments on. Leave `enabled` false until the secrets below are set.

## What the driver pays

Amount = authority or operator charge + **£1.60** Ferro fee (`160` pence). The fee is fixed. `places.feePence` is not the charge. `places.connectedAccountId` is ignored.

`chargeType` is one of `parking`, `congestion`, `ulez`, `tunnel`, `heathrow_dropoff`, `pcn`. A parking create that omits `chargeType` is parking. The iOS create body is otherwise unchanged: same fields, same `{paymentId}_confirm` read-back, same idempotency key `uid:placeId:visitId` (or the retry key when the previous PaymentIntent is failed or canceled). The PaymentSheet fields on the request are unchanged: client secret, customer, ephemeral key, `parkingPence`, `feePence`, `amount`, `currency`.

Other charge types use the same `parkingPaymentRequests` collection with `authorityPence`, `zone`, `occurredOn` (`YYYY-MM-DD`), and an `https` `paymentUrl`. `deadlineAt` and `reference` are optional. The idempotency key is `uid:chargeType:reference` (or zone, date, and plate when there is no reference).

No card number is stored. The company funding card is paid outside this system. A top-up only records that the money is now in the funding balance.

## Collections

| Collection | Who |
| --- | --- |
| `parkingPaymentRequests/{id}` | Driver creates `pending`. Trigger writes the result. Confirm id is `{paymentIntentId}_confirm`. |
| `parkingPayments/{paymentIntentId}` | Server writes. The driver can read their own, including `authorityStatus` and `authorityReference`. |
| `authorityPayments/{paymentIntentId}` | One job per successful driver payment. Admin read. No client write. |
| `authorityPaymentActionRequests/{id}` | Admin create: `fulfill`, `fail`, or `already_paid`. Trigger applies it. |
| `funding/state` | `balancePence`, `reservedPence`, `spentTodayPence` with `spentDay` (Europe/London), `dailyCapPence` 200000, `lowWaterPence` 10000, `paused`. Admin read. |
| `fundingLedger/{id}` | Append-only `topup`, `reserve`, `commit`, `release`. Ids are `topup:{requestId}`, `reserve:{pi}`, `commit:{pi}`, `release:{pi}`. Admin read. |
| `fundingTopUpRequests/{id}` | Admin create. Trigger adds the ledger row and then opens queued jobs. |
| `paymentNotifications/{pi}:{event}` | Outbox. Server only. Funding alerts use `funding:low_water:{n}`, `funding:paused:{n}`, `funding:resumed:{n}`. |
| `operatorForwards/{pi}` | Unchanged plate hand-off. Still server-only. The authority job copies the plate from here. |
| `stripeCustomers/{uid}`, `stripeSync/cursor` | Unchanged. Server only. |

Available = min(balance − reserved, daily cap − spent today). A new London day treats today's spend as 0.

## State machine

Driver payment statuses are unchanged (`created` → `processing` → `paid`, then refund states).

Authority job, after the driver payment is `paid`:

1. If funding is not paused and the authority amount fits, status `open`, ledger `reserve`, Slack `#payment`.
2. Otherwise status `queued`, funding `paused`, no reserve. The driver's payment is kept.
3. A top-up, or the scheduled pass, opens queued jobs oldest first. The first job that does not fit stops the pass. When the queue is empty, funding is resumed.
4. Admin `fulfill` (open jobs only) commits the amount the authority charged and releases the rest. A lower authority charge refunds the difference to the driver. The £1.60 fee stays. The authority reference is stored.
5. Admin `fail` or `already_paid`, on `open` or `queued`, releases any reserve and refunds the driver in full, including the fee.
6. A queued job is refunded in full at the earlier of `deadlineAt` minus 3 hours and 24 hours after it was queued. The scheduled function runs every five minutes, so a job can sit until that pass.

Parking creates are refused up front while `paused` is true, before a PaymentIntent is opened. Parking has to be paid at the start of the stay. Other charge types can still be paid and queued. A parking payment that is not paused, but does not fit the balance, is still taken and then queued; that is what sets `paused`.

Stripe refund idempotency key: `refund:{pi}`. One refund per PaymentIntent. A full refund and a partial refund are not both issued for the same payment.

A live-mode refund or dispute from Stripe is applied. The old reconciler dropped every event with `livemode: true`. The API key already selects the mode, and a live key cannot get past the test-mode check.

## Admin desk

`/payments` in the admin app, admin role only.

The desk shows balance, reserved, available, and today's spend. Record a top-up in pounds after the funding card has been loaded outside Stripe (maximum £20,000 per request). Open jobs have the official link. Mark fulfilled with the authority reference and the amount the authority actually charged, or mark failed / already paid.

## Notifications

One outbox document per event, so a retry does not send twice.

- Email the driver and pay@ferromaps.com on paid, fulfilled, and refunded (including a partial refund). From `admin@ferromaps.com`, the sender SendGrid already uses.
- Slack `#payment` for a new open job (plate, date, zone, amount, official link), available falling below £100, pause, resume, and a failed / already-paid / expired job.

The low-balance Slack message is sent once per time available drops under £100, and again only after it has risen back to £100 or more.

## Functions

Cloud Functions codebase `default`, region `europe-west2`, project `ferro-maps-staging-v2`. No callables and no inbound HTTP. Same request-doc pattern as the rest of this project.

| Function | Change |
| --- | --- |
| `onParkingPaymentRequest` | Kept. Drops the Gold check and destination charge. Checks config, test mode, and the Stripe account. |
| `reconcileParkingPayments` | Kept. Live-mode events are applied. Checks the Stripe account. |
| `onOperatorForwardAcked` | Unchanged. |
| `onAuthorityPaymentActionRequest` | New. Admin fulfill / fail / already paid. |
| `onFundingTopUpRequest` | New. |
| `onPaymentNotificationCreated` | New. Sends the outbox. |
| `reconcileAuthorityPayments` | New. Every five minutes, Europe/London. Expires queued jobs, drains the queue, retries a job whose follow-up failed. |

These names are not in the iOS `mobile` codebase export list. `onHotspotUnlockRequest` is already exported by both codebases; this change does not add another copy. Do not deploy both.

## Secrets

Set with `firebase functions:secrets:set`, test values only. Do not commit them.

| Secret | Used by |
| --- | --- |
| `STRIPE_SECRET_KEY` | Existing. Must be `sk_test_…` or `rk_test_…` for account `acct_1UYo41K3YqihBBbk`. |
| `SENDGRID_API_KEY` | Existing. |
| `SLACK_PAYMENTS_WEBHOOK_URL` | New. Incoming webhook for `#payment`. |

There is no webhook signing secret. Stripe is not given an inbound URL.

## Rules to mirror

`firestore.rules` is still the source of truth and must stay byte-identical with ferromaps-ios-mvp-staging. This branch is based on open PR #60 (`cursor/surge-rules-merge-1d95`), which matches iOS PR 177. Copy the rules file across, or apply this diff:

- `payRequestPending()` no longer calls `isGold()`. Any signed-in driver may create a payment request. This is the one existing rule that is wider, because Gold was removed. `isGold()` itself is unchanged and still gates `privateParkingCells`.
- Parking creates may include optional `chargeType == 'parking'`. Omitting it still matches the old iOS body. No other new parking field is accepted.
- A third create on `parkingPaymentRequests` allows `congestion`, `ulez`, `tunnel`, `heathrow_dropoff`, and `pcn` with the field list in the rules. Confirm is unchanged.
- New admin-read, no-client-write matches: `authorityPayments`, `funding`, `fundingLedger`.
- New admin-create request matches: `authorityPaymentActionRequests`, `fundingTopUpRequests`. Update and delete stay false.
- `paymentNotifications` is denied to every client, including admins.
- No existing allow was removed except the Gold check inside `payRequestPending()`. Places, operator forwards, Stripe customers, the reconciler cursor, and private parking are unchanged.

## Left open

- No deploy, no live key, no inbound Stripe webhook.
- Non-parking amounts are what the driver submits. There is no authority quote API. An admin cannot record an authority charge higher than that amount; mark the job failed and refund the driver instead.
- A won dispute does not reopen a job that was already failed, expired, or fulfilled.
- `onHotspotUnlockRequest` is still exported here and in the iOS mobile codebase. Deploying both replaces one with the other.
- The official parking link is `places.paymentUrl` when that is https, otherwise the operator homepage plus the location code in the Slack text.
- Queued auto-refund runs on the five-minute schedule, so it can be a few minutes after the deadline.
