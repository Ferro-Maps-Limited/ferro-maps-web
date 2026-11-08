# Surge access: how the app and the server talk

Contract `surge-access-binding/v1`, revision 2. This is a draft. Do not adopt it in the app yet. Revision 1 said the app could create the request documents. That is withdrawn. Nothing here is deployed, and no purchase is verified.

## Who owns it

New surge billing, when a later approval activates it, belongs to the web shared backend, the Firebase Functions codebase named `default`. The new code is not registered as a Cloud Function. `functions/src/index.ts` does not export it, so a deploy of today's functions does not run it.

`firebase.json` publishes `firestore.rules` only. The surge draft rules are `firestore.surge-access.prototype.rules`, loaded by emulator tests as their own demo target. They are not part of a rules deploy. Who should own Firestore rules long term is not settled. An older web-canonical note was from TPM, not a verified owner decision, and a later iOS-canonical note was withdrawn. This change does not compare the repo with the live rules.

Legacy Apple Gold stays where it is. Do not reuse these for surge:

- Function name `onSubscriptionRequest`
- Function name `refreshEntitlements`
- Firestore path `subscriptionRequests/{uid}`

The web stub of `onSubscriptionRequest` was removed in merged PR 28 (`a44a083`). This repository does not contain the iOS `mobile` codebase. iOS reports its branch has no `surgeAccountRequests` or `iapRequests` path, and that its legacy verifier filters `PREMIUM_PRODUCT_IDS`. This repo has not audited that source, so those statements are not confirmed here. Proposed surge product ids are not on the web Play Gold path. That does not prove what the mobile filter does in production.

Gold (`users/{uid}.subscriptionExpiresAt`) does not unlock surge. Play Gold receipts stay on `playPurchaseRequests`. Parking payments stay as they are.

## Account binding

The server can issue two stable ids for a Firebase Auth user. The app must not create `surgeAccountRequests` or `surgeBillingAccounts` yet. Client creates are denied, because an open create would let any signed-in user store unbounded documents. A per-account cap inside the unexported helper is not a live endpoint, does not grant surge opens, and does not reset when the plan changes. A new Firebase account gets its own cap. That does not stop one person using many accounts.

The app may not choose the ids, change them, or move them to another account.

An `appAccountToken` is a UUID the app passes to StoreKit. It binds a purchase to this FerroMaps account. It is not a login and it does not prove the user is signed in.

The Play id is a different opaque UUID for `obfuscatedAccountId`. It is not the Firebase uid.

Server paths, not for the app to create: `surgeAccountRequests/{requestId}`, `surgeBillingAccounts/{uid}`, and the server-only reverse maps `surgeAccountTokens/{token}` and `surgePlayAccountIds/{id}`. The helper counts the request documents for that account. `surgeAdmission/{uid}` is only a floor: deleting it does not allow more requests while the documents remain. A counter that has been raised above the document count fails closed. Deleting the request documents themselves is a privileged Admin change. This draft does not claim to stop that, and it does not delete or expire those documents. No retention period has been decided, so there is no cleanup job.

`requestId` is a UUID for one server-side ask. Firebase Auth uids are any non-empty string up to 128 characters. This helper also rejects a uid that cannot be a Firestore document id (`/`, `.`, `..`, a reserved `__name__`, or an ASCII control). A hyphen, a dot, or an underscore is accepted. A repeat for the same account returns the same two ids. A different account gets a different pair. Signing out and back in, reinstalling, or switching plan does not rotate them.

Deployed handlers: none. The emulator-only function `fulfillSurgeAccountRequest` is not exported.

## Apple purchase request

Path: `iapRequests/{requestId}`. This name does not appear elsewhere in this web repository. iOS reports its current branch does not use it. This web repo has not audited the mobile source, so that report is not confirmed here.

The app must not create `iapRequests` documents yet. Rules deny every client read and write. Payload size alone does not stop a signed-in user from storing many 16 KB blobs. The unexported helper will store at most 3 open Apple requests per uid, and only by its own write. That cap is not an App Check check. Firestore rules cannot validate App Check, and App Check alone would not enforce this cap. There is no public endpoint.

The stored document, when the helper creates it, has `v: 1`, `uid`, `platform: apple`, the signed transaction, a server `createdAt`, `status: held`, and `outcome: verifier-not-implemented`. A later call judges that stored snapshot. A different blob passed by the caller does not replace it. Do not send a product id, tier, price, transaction id, entitlement, or grant. Those fields on a stored document are rejected and do not become `delivered`.

The signed transaction is not copied into `status` or `outcome`, and this code does not log it. Do not put it, or a billing id, on `hotspots_test` or any other signed-in-wide feed. `playObfuscatedId` only names the Play account. It is not a Play purchase check. Android does not have a purchase contract in this slice.

## When the app may finish the Apple transaction

`Transaction.finish()` waits for a future result whose status is `delivered`.

This version never writes `delivered`. The emulator function `holdSurgeIapRequest` writes:

- `status`: `held`
- `outcome`: `verifier-not-implemented`

`held`, a later `accepted`, and `rejected` are not permission to finish. `delivered` would mean a verified store transaction was granted. There is no verifier in this version, and an unverified blob grants nothing.

There is no production listener on `iapRequests`. Do not finish. Do not create the document from the app.

A later grant key will be the verified store transaction id, not this request id and not the raw blob. One verified transaction grants once. It must not add both a weekly allowance and a £2.99 credit. Restore, reinstall, and plan switch do not refill allowance. That ledger is not built here. Two held requests with the same blob still grant nothing.

## What the owner has decided, and what this draft does not do

Free is 3 opens in a calendar month, starting at the first successful server-authorized open. It is not 3 per week and not a fixed 30 days. The anchor is stored for the account. The phone clock, a reinstall, and a plan change do not reset it. The calendar arithmetic (time zone, month length, 31 January, 29 February, daylight saving) is not decided. Illustrations in code are marked inactive.

Premium is £3.99 a week for 10 opens, Ultimate £7.99 for 30, Stardust £14.99 for unlimited. Those weekly plans are unchanged. A driver who has used the week's opens can buy single surges at £2.99 each. The weekly plan keeps running. That is not a top-up pack and not a new subscription. The store product id `ferro.surge.single` is a proposal, not a product that exists in App Store Connect or Play Console.

A PAYG event card stays open until the verified event end, and opening it again does not charge again. The same idea applies to an event already unlocked: it stays open through a monthly or weekly reset until that end. This draft does not unlock anything.

Surge detail on the hotspot sheet is a different door from the event card. A single £2.99 purchase does not answer whether a paid plan with no opens left still sees hotspot-sheet surge info. That remains unresolved and off.

An account ledger keyed by Firebase uid would stop one signed-in user reading or spending another user's record. It would not stop one person opening many Firebase accounts. This draft does not claim that abuse is prevented.

No sheet feed, publisher, notification, store product, sandbox call, or flag is included.

## Purchase ledger, on paper

A later ledger would record each verified store transaction once, for one account. The same transaction cannot add both a weekly allowance and a £2.99 credit, and it cannot be replayed onto a second account. A failed or unverified purchase records nothing. A refund or revoke does not put opens back. An event already unlocked stays open until its verified end, including across a weekly or monthly reset, and opening it again does not charge. After that end it does not silently extend.

`functions/src/surgeAccess/syntheticLedger.ts` is a test-only picture of those rules. It does not check an Apple signature or call Play. `unavailableVerifier` means that picture is not a purchase service. It is not exported.

## Apple signature check

`appleValidation.ts` uses Apple's App Store Server Library (`@apple/app-store-server-library`) and the public Apple root certificates pinned in this repo. Online revocation checks stay on. After a certificate chain reaches an Apple root, the library asks Apple's OCSP responders. A forged blob is rejected before that network call. Xcode and LocalTesting are rejected because that library skips signature checks for them.

The check still cannot accept a purchase. This repo has no bundle id, Apple app id, environment, or product allowlist from App Store Connect. `loadAuthoritativeAppleConfig` returns nothing, and the purchase path stops with `apple-config-missing`. An empty product list would also stop. The example ids in tests are not configured products.

A genuine positive check needs an Apple-signed transaction for this app's real bundle id, environment, and app Apple id, plus the owner's product allowlist. None of those are in this repo. A locally made certificate is not that proof.

If a check ever succeeded, the server would write one `surgePurchaseEvidence/apple_{transactionId}` row. The transaction id, product, bundle, and environment come only from that library result. The account comes from the server binding for that token, checked against the stored request. A caller cannot substitute a different account or app. A test-labeled row cannot become an Apple row. The raw signed transaction is not stored. The row is not an allowance, a credit, or `delivered`. Retries of the same transaction keep that one row. A second account is rejected. Clients cannot read or write the row.

Play verification, Play request shape, and acknowledge or consume ownership are not built.
