# Parking and congestion payments, phase 1

Ferro is the merchant of record. A driver pays Ferro's own Stripe account. Ferro then pays the authority or operator, in this phase by hand from the admin desk. There is no Stripe Connect account and no destination charge.

The Stripe account is **acct_1UYo41K3YqihBBbk**, the account for **pay@ferromaps.com**. A test secret (`sk_test_` or `rk_test_`) always works. An `sk_live_` secret is accepted only when `config/payments.stripeLiveEnabled` is exactly true. A missing document, or any other value, means off. The key itself is never logged. Only the word `test` or `live` is. `config/parkingPayments.testMode` is not a gate. The publishable key must be the same mode as the secret.

This doc supersedes the destination-charge and Gold-gate notes in `docs/backend-contract.md` and `functions/DEPLOY.md`. Do not set `reverse_transfer` on a refund. The charge never left Ferro's account.

Nothing here is deployed.

## Config

`config/parkingPayments` (server-only; clients cannot read or write it):

| Field | Value |
| --- | --- |
| `enabled` | `true` to take payments. Missing or anything else refuses the create. |
| `testMode` | ignored. Live versus test is the key prefix and `config/payments.stripeLiveEnabled` |
| `stripeAccountId` | must be `acct_1UYo41K3YqihBBbk` |

The function also calls `accounts.retrieve()` and refuses the charge unless Stripe reports that same account id. The expected id is `EXPECTED_STRIPE_ACCOUNT_ID` in `functions/src/parking/stripeClient.ts`. A mismatch is not cached. A match is cached for the process.

Create the document in the console before turning payments on. Leave `enabled` false until the secrets below are set.

## What the driver pays

Amount = authority or operator charge + the Ferro fee: **1.5%** of that charge, rounded to the nearest penny (half a penny rounds up), and **at least 60p**. A £3.40 stay or an £18.00 charge has a 60p fee, and a £41.00 charge 62p. Before 27 Nov 2026 the fee was a flat £1.60; payments made then keep the `feePence` they were charged. `places.feePence` is not the charge. `places.connectedAccountId` is ignored.

`chargeType` is one of `parking`, `congestion`, `ulez`, `tunnel`, `heathrow_dropoff`, `pcn`. A parking create that omits `chargeType` is parking. The iOS create body is otherwise unchanged: same fields, same `{paymentId}_confirm` read-back, same idempotency key `uid:placeId:visitId` (or the retry key when the previous PaymentIntent is failed or canceled). The phone sends no price. The done document adds `publishableKey` beside the client secret, customer, ephemeral key, `parkingPence`, `feePence`, `amount`, and `currency`. Paid still means `parkingPayments/{paymentIntentId}.status` is exactly `paid`.

Road charges are on hold. Any request that carries a client `authorityPence` (congestion, ULEZ, tunnel, fine) is rejected with `failed-precondition` and is not charged. The London Congestion Charge is the exception: the server prices it itself, with no client amount (`docs/backend-contract.md` section 14.1d, behind `config/payments.congestionCharges`).

The total, including the Ferro fee, must be at most `config/payments.maxPaymentPence`. If that field is missing or not a positive whole number of pence, the cap is 5000 (£50). A higher total is refused before a PaymentIntent is created. Clients cannot read `config/payments`.

## Length of stay

`config/flags.parkingDurationPricing` must be exactly true. Missing, false, or any other value leaves the old flat price: `places/{id}.parkingPence`. A flat-priced place ignores `durationMinutes` even when the phone sends one, including a value that would not be valid.

When the flag is exactly true and the place has a non-empty `parkingTariffs` list, the server prices the stay from that list. The phone does not pick a price. Each row is `{maxMinutes, pence}`: `pence` is the stay in GBP pence, before the Ferro fee. The server sorts by `maxMinutes` and takes the smallest row whose `maxMinutes` is at least the requested minutes (it rounds up to the next row). A stay longer than the largest row is `duration-invalid`.

The request field is `durationMinutes`. For a place priced this way it is required. A missing value is `duration-required`. A value that is not a whole number, or is outside 15 to 1440 inclusive, is `duration-invalid`. There is no default row.

The phone's picker offers these lengths, and a place that uses the table should have one row for each:

| maxMinutes | Example pence |
| --- | --- |
| 15 | 100 |
| 30 | 200 |
| 60 | 350 |
| 120 | 500 |
| 180 | 700 |
| 240 | 900 |
| 480 | 1200 |
| 1440 | 1800 |

The example pence are the figures in the tests. They are not hardcoded in the server. 16 minutes uses the 30-minute row, 31 the 60-minute row, and so on. The idempotency key is `uid:placeId:visitId:durationMinutes:amount`. A flat stay uses `-` for the duration. The same duration and amount returns the open PaymentIntent. A different duration or amount cancels that PaymentIntent and opens a new one, unless Stripe will not cancel it: that is `open-payment-in-progress`, and the phones show their own copy. The visit id stays the same. A visit that is already `paid` returns that receipt, with the price already charged, and does not reprice or open another PaymentIntent.

The current iOS app does not send `durationMinutes`. Leave the flag off until it does. With the flag off, today's create (no duration, no price) still charges `parkingPence` plus the Ferro fee.

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
4. Admin `fulfill` (open jobs only) commits the amount the authority charged and releases the rest. A lower authority charge refunds the difference to the driver. The Ferro fee stays. The authority reference is stored.
5. Admin `fail` or `already_paid`, on `open` or `queued`, releases any reserve and refunds the driver in full, including the fee.
6. A queued job is refunded in full at the earlier of `deadlineAt` minus 3 hours and 24 hours after it was queued. The scheduled function runs every five minutes, so a job can sit until that pass.

Parking creates are refused up front while `paused` is true, before a PaymentIntent is opened. Parking has to be paid at the start of the stay. Other charge types can still be paid and queued. A parking payment that is not paused, but does not fit the balance, is still taken and then queued; that is what sets `paused`.

Stripe refund idempotency key: `refund:{pi}`. One refund per PaymentIntent. A full refund and a partial refund are not both issued for the same payment.

A live-mode refund or dispute from Stripe is applied. The old reconciler dropped every event with `livemode: true`. The API key already selects the mode, and a live key cannot get past the test-mode check.

## Admin desk

`/payments` in the admin app, admin role only.

The desk shows balance, reserved, available, and today's spend. Record a top-up in pounds after the funding card has been loaded outside Stripe (maximum £20,000 per request). Open jobs have the official link. Mark fulfilled with the authority reference and the amount the authority actually charged, or mark failed / already paid.

## Notifications

One outbox document per event, so a retry does not send twice. A phone push is a second document, `{paymentIntentId}:{event}:push`, beside the email.

- Email the driver and pay@ferromaps.com on paid, fulfilled, and refunded (including a partial refund). From `admin@ferromaps.com`, the sender SendGrid already uses.
- On those same events, send an FCM push to `users/{uid}.fcmToken`. The data keys are `type` = `parking_payment`, `paymentId`, `status` (`paid`, `fulfilled`, `refunded`, or `partially_refunded`), and `placeId` when the payment document has one. The notification title and body are plain English and name the charge type and the amount stored for that event. A missing charge type is not called parking, and a missing amount is not filled in: that push is skipped and the email still sends. A missing or unusable token is skipped. If FCM says the token is not registered or not valid, `fcmToken` is deleted. The same title and body are written to `parkingPayments/{id}.notifiedTitle` and `notifiedBody` only after a push is accepted.
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
| `onPaymentNotificationCreated` | Sends the outbox. Emails and Slack as before, and the payment push beside the driver emails. |
| `reconcileAuthorityPayments` | New. Every five minutes, Europe/London. Expires queued jobs, drains the queue, retries a job whose follow-up failed. |

These names are not in the iOS `mobile` codebase export list. `onHotspotUnlockRequest` is already exported by both codebases; this change does not add another copy. Do not deploy both.

## Secrets

Set with `firebase functions:secrets:set`, test values only. Do not commit them.

| Secret | Used by |
| --- | --- |
| `STRIPE_SECRET_KEY` | Existing secret. `sk_test_…` or `rk_test_…` always. `sk_live_…` only when `config/payments.stripeLiveEnabled` is exactly true. |
| `STRIPE_PUBLISHABLE_KEY` | Not a secret. String param. Empty in the repo. `pk_test_…` always. `pk_live_…` only when the same live switch is exactly true. `finishCreate` writes it as `publishableKey`. |
| `SENDGRID_API_KEY` | Existing. |
| `SLACK_PAYMENTS_WEBHOOK_URL` | New. Incoming webhook for `#payment`. |

There is no webhook signing secret. Stripe is not given an inbound URL.

## Rules to mirror

`firestore.rules` is still the source of truth and must stay byte-identical with ferromaps-ios-mvp-staging. This branch is based on open PR #60 (`cursor/surge-rules-merge-1d95`), which matches iOS PR 177. Copy the rules file across, or apply this diff:

- `payRequestPending()` no longer calls `isGold()`. Any signed-in driver may create a payment request. This is the one existing rule that is wider, because Gold was removed. `isGold()` itself is unchanged and still gates `privateParkingCells`.
- Parking creates may include optional `chargeType == 'parking'`. Omitting it still matches the old iOS body.
- Parking creates may include optional `durationMinutes`, an integer from 15 to 1440 inclusive. Missing is still allowed. 14, 1441, a fraction, and a string are denied. **This rules change needs Nafiu's yes before deploy.** It is not approved to go live.
- A third create on `parkingPaymentRequests` allows `congestion`, `ulez`, `tunnel`, `heathrow_dropoff`, and `pcn` with the field list in the rules. Confirm is unchanged.
- New admin-read, no-client-write matches: `authorityPayments`, `funding`, `fundingLedger`.
- New admin-create request matches: `authorityPaymentActionRequests`, `fundingTopUpRequests`. Update and delete stay false.
- `paymentNotifications` is denied to every client, including admins.
- No existing allow was removed except the Gold check inside `payRequestPending()`. Places, operator forwards, Stripe customers, the reconciler cursor, and private parking are unchanged.

## Left open

- No deploy, no live key, no inbound Stripe webhook. `stripeLiveEnabled` stays off. `parkingDurationPricing` stays off.
- Road charges that send `authorityPence` are rejected and not charged. There is no authority quote API. An admin cannot record an authority charge higher than the amount already stored on a paid job; mark the job failed and refund the driver instead.
- `functions/scripts/refundTrialPayments.ts` is a dry-run unless `--execute` is passed. Do not run `--execute` until Nafiu says yes.
- A won dispute does not reopen a job that was already failed, expired, or fulfilled.
- `onHotspotUnlockRequest` is still exported here and in the iOS mobile codebase. Deploying both replaces one with the other.
- The official parking link is `places.paymentUrl` when that is https, otherwise the operator homepage plus the location code in the Slack text.
- Queued auto-refund runs on the five-minute schedule, so it can be a few minutes after the deadline.
