# Payment status messages

When a parking payment becomes paid, failed, canceled, or refunded, Ferro can send a short note to a Slack channel and to the payments inbox. The note is the same in both places. It says the status, the amount and the currency, the place name (or the place id when the place has no name), the Stripe PaymentIntent id, a link to that payment in the Stripe Dashboard, and the time in London.

With the usual switches, the note leaves out the vehicle plate, the driver's name, their email, their phone number, their user id, and any card data. A separate switch, `config/flags.paymentAlertOperatorDetails`, adds the facts Nafiu needs to pay the car park and to forward the car park's receipt. It stays off unless the value is the boolean `true`. The word "true" does not turn it on. A missing field is off.

This is separate from the message the driver already gets on their phone. Stripe's own emails, described below, are also separate. Nothing in this change is deployed, and no secret is stored in the repo.

The payment record is `parkingPayments/{paymentIntentId}`. The Stripe link uses the `livemode` field on that record. The field is copied from the PaymentIntent when the payment is created and when its status is updated. `true` opens the live Stripe Dashboard. Any other value opens the test dashboard. The webhook, the five-minute reconcile, the confirm step, and a refund that updates the same record all go through this one watch. The function is `onParkingPaymentStatus`, in `europe-west2`. It does not talk to Stripe itself. A full refund is the status `refunded`. A partial refund stays `partially_refunded` and does not send this note. `refund_pending` does not send it either.

The function keeps a marker at `paymentNotifications/{paymentIntentId}_{status}`. The marker records whether Slack succeeded and whether the email succeeded. A retry sends a channel again only when that channel failed or was not tried. A channel that already succeeded is left alone. The marker stores the payment id, the status, the time, and those two results. It does not store the plate or the user id.

Each channel has its own switch. Both live on `config/flags` and both stay off unless the value is the boolean `true`.

| Switch | Channel |
| --- | --- |
| `paymentSlackNotify` | Slack |
| `paymentEmailNotify` | Email |
| `paymentAlertOperatorDetails` | Extra lines on both notes, for paying the car park |

The email goes to `config/notifications.paymentsEmail` when that value is an email address. Otherwise it goes to pay@ferromaps.com.

## Paying the car park

When `paymentAlertOperatorDetails` is exactly true, the same Slack note and the same email also list what is already stored, for a payment that becomes paid, failed, canceled, or refunded:

- Car park name. The place document uses `name`. Older imported places use `n`. Either one is used. There is no third name field.
- Address. The place document uses `addr` (street and postcode). It is optional, so many places have none. The note leaves the address line out when it is missing.
- Operator name. The payment stores `operator` (RingGo, PayByPhone, or JustPark). The place document has the same field.
- The operator's site code. That is `locationCode` on the place. When the payment starts, the same code is also copied onto `operatorForwards/{paymentIntentId}`. There is no separate zone id. The payment's `zone` field is a label (the place name, or the operator plus the code), not a code of its own. If `locationCode` was never set, the note has no site-code line.
- Vehicle plate. It is not stored on the payment. It is stored on `operatorForwards/{paymentIntentId}` once the payment has started, and on the payment request until that moment. If neither still has it, the note has no plate line.
- Length of stay. That is `durationMinutes` on the payment, in minutes. A flat-priced place does not store a length, and the note then has no stay line.
- When the driver paid, in Europe/London. The line is labelled `Paid at`. There is no separate stay-start field, so this is `createdAt` on the payment, the moment the payment was opened, not the start of the stay. If that time is missing, the line is left out.
- The amount the driver paid, which is `amount` and `currency` on the payment (the stay plus the Ferro fee).
- The driver's phone number. Signup stores it as `users/{uid}.phoneNumber`. Firebase Auth is not read for the phone. If that field is missing, the note has no phone line. No phone field is added anywhere else.
- The driver's email, so the car park's receipt can be forwarded. The line is labelled `Driver email`. It is taken from `users/{uid}.email` when that field is stored. If it is not, the note uses the email on the driver's Firebase Auth account. If neither exists, the line is left out. The email on the payment record is not used.

The driver's name and card data are never added. The plate, the phone number, and the driver's email are written only in the body of that email and in the Slack message. They are not put in the email subject, and they are not written to the logs. The Slack channel that receives this note must be a private channel, because the note can contain a plate, a phone number, and an email address.

The public privacy notice is section 6.5, Paying for parking, in `apps/marketing/src/pages/PrivacyPolicy.tsx`. It tells the driver that our payments team receives their number plate, phone number, and email address, and uses them only to pay the car park for the stay and to send the receipt. It also says the car park operator receives the number plate and the length of the stay so the parking is recorded, and that we don't use these details for anything else. That public text does not name this switch, the payments inbox, or Slack. Do not turn the switch on until that section is what the app shows.

## 1. Stripe emails for successful payments and refunds

Stripe can email the person who is signed in to the Dashboard. The Ferro account uses pay@ferromaps.com, so sign in as that address. The steps below use the menu names from Stripe's guide, [Start a team](https://docs.stripe.com/get-started/account/teams).

1. In the Stripe Dashboard, open your profile, then **Personal details**, then **Communication preferences**.
2. Turn on email for a successful payment. Stripe's name for that event is "A successful payment is received."
3. Stay on **Communication preferences**. Stripe keeps the full list of events on that page. Turn on the refund email if it is in the list. The guide names successful payments and does not print a refund label, so use the refund label Stripe shows you.

Those messages arrive at the email of the signed-in user, which is pay@ferromaps.com when you are signed in as that user.

Stripe also has customer receipts. Those go to the driver, not to pay@ferromaps.com. The switches are named in [Receipts and paid invoices](https://docs.stripe.com/receipts):

1. Open **Settings**, then **Business**, then **Customer emails**.
2. Under **Payments**, turn on **Successful payments** and **Refunds**.

To send one receipt to pay@ferromaps.com as well, from the same guide:

1. Open **Transactions**, then **Payments**.
2. Open the payment.
3. In **Receipt history**, open the overflow menu and choose **Send receipt**.
4. Add pay@ferromaps.com as another address, separated by a comma, and click **Send**.

Automatic customer receipts are for live payments. A test payment can be sent by hand with **Send receipt**.

## 2. Stripe's Slack app

Stripe publishes its own Slack app and describes it in [Stripe Workflows for Slack](https://docs.stripe.com/use-stripe-apps/stripe-workflows-slack). This is the app to install if you want Stripe itself to post into Slack. It is separate from the incoming webhook in section 3.

1. Open the Slack app page in the Stripe App Marketplace. Choose the Ferro account. Click **Install**.
2. Open the app from the sidebar. Click **Go to Settings**, or open the overflow menu and choose **View app settings**.
3. Click **Add to Slack**. Choose the workspace. Click **Allow**.
4. In Slack, open the channel that should receive the messages and type `/invite @Stripe`. The channel then shows in the app's channel list. Click **Test** next to the channel to confirm a message arrives.

## 3. What Nafiu needs to say yes to

The backend version in this repo stays off until each of these is agreed. This change does not do them.

1. Create a Slack incoming webhook for the payments channel, and store that URL as the secret `SLACK_PAYMENTS_WEBHOOK_URL` (`firebase functions:secrets:set SLACK_PAYMENTS_WEBHOOK_URL`). The URL is not written into the repo.
2. Create the SMTP secret `PAYMENTS_SMTP_URL` (`firebase functions:secrets:set PAYMENTS_SMTP_URL`). Use a Google Workspace SMTP relay or an app password for the payments mailbox. See the choice below. The URL is not written into the repo.
3. Turn the switches on, in the Firestore console: `config/flags.paymentSlackNotify` and `config/flags.paymentEmailNotify`, each set to the boolean `true`. Either one can stay off. Optionally set `config/notifications.paymentsEmail` if the inbox should be somewhere other than pay@ferromaps.com.
4. Deploy that one function, by name:

```bash
firebase deploy --only functions:default:onParkingPaymentStatus -P <alias>
```

Create both secrets before that deploy. Firebase will not deploy the function until the secrets it names exist. Leave the switches off until the messages should start. Rules, indexes, TTL, and `firebase.json` stay as they are. There is no new permission to grant.

## How the email is sent

The function sends mail with nodemailer over SMTP. The secret is a URL:

- Workspace relay: `smtp://USER:PASSWORD@smtp-relay.gmail.com:587`
- App password for the pay@ mailbox: `smtps://pay%40ferromaps.com:APP_PASSWORD@smtp.gmail.com:465`

Encode anything odd in the user or password (`@` is `%40`, a space is `%20`). The From address is the payments inbox, so that mailbox, or the relay, has to be allowed to send as that address. The connection waits five seconds and then gives up. A failure is written to the logs and the payment record is left as it was.

This needs no new access grant. Two other ways were considered and not used:

- SendGrid is already used for support mail and for the note that goes to the driver. It would work with the existing `SENDGRID_API_KEY`. SMTP is used here so the payments inbox can be a Workspace mailbox, without adding this channel to that account.
- Firebase's Trigger Email extension watches a mail collection and sends from its own service account. Installing it grants that account new permissions. This function sends the message itself, so that grant is not needed.

Slack is an incoming webhook URL in `SLACK_PAYMENTS_WEBHOOK_URL`. The function posts the same short note and waits five seconds. If the URL is missing, or Slack or the mail server answers with an error, that channel is skipped and the log says so. The other channel still sends. The payment update is not undone.
