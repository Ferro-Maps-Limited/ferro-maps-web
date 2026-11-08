# Surge access: how the app and the server talk

Contract `surge-access-binding/v1`. This is a draft for the app team. Nothing in this document is deployed, and no purchase is verified yet.

## Who owns it

New surge billing belongs to the web shared backend, the Firebase Functions codebase named `default`. The new code is not registered as a Cloud Function. `functions/src/index.ts` does not export it, so a deploy of today's functions does not run it.

Legacy Apple Gold stays where it is. Do not reuse these for surge:

- Function name `onSubscriptionRequest`
- Function name `refreshEntitlements`
- Firestore path `subscriptionRequests/{uid}`

The web stub of `onSubscriptionRequest` was removed in merged PR 28 (`a44a083`). This repository does not contain the iOS `mobile` codebase. A historical overlap on that name and path is not proof of what is deployed today. iOS must confirm its current request paths before adopting this contract. That confirmation is still pending.

Gold (`users/{uid}.subscriptionExpiresAt`) does not unlock surge. Play Gold receipts stay on `playPurchaseRequests`. Parking payments stay as they are.

## Account binding

The server issues two stable ids for the signed-in Firebase user. The app may read them. The app may not choose them, change them, or move them to another account.

An `appAccountToken` is a UUID the app passes to StoreKit. It binds a purchase to this FerroMaps account. It is not a login and it does not prove the user is signed in.

The Play id is a different opaque UUID for `obfuscatedAccountId`. It is not the Firebase uid.

| | |
|---|---|
| Ask | Create `surgeAccountRequests/{requestId}` |
| Stable record | `surgeBillingAccounts/{uid}` |
| Reverse maps | `surgeAccountTokens/{token}` and `surgePlayAccountIds/{id}`, server only |

`requestId` is a new UUID for that ask. The signed-in user may create a document with only:

- `v`: `1`
- `uid`: the same as Firebase Auth
- `createdAt`: the server time

The client cannot update or delete that document, and cannot list other people's documents. A repeat for the same account returns the same two ids. A different account gets a different pair. Signing out and back in, reinstalling, or switching plan does not rotate them.

Deployed handlers: none. Writing the ask today does not by itself produce a response in production. The emulator-only function `fulfillSurgeAccountRequest` is what a later, still unexported, trigger would call.

## Apple purchase request

Path: `iapRequests/{requestId}`. This name does not appear elsewhere in this repository. iOS still has to confirm it is free on the mobile codebase before the app ships it.

The signed-in user may create a document with only:

- `v`: `1`
- `uid`: the same as Firebase Auth
- `platform`: `apple`
- `signedTransaction`: the signed transaction string, 64 to 16384 characters
- `createdAt`: the server time

Do not send a product id, tier, price, transaction id, entitlement, grant, or status. The server will not trust those if a client adds them.

The owner may read their own document. Nobody may list the collection. Nobody may update or delete, including the owner. That blocks a client from writing `delivered` or a grant after the create.

The signed transaction stays on that private document so a future verifier can read it. It is not copied into `status` or `outcome`, and this code does not log it. Do not put it, or a billing id, on `hotspots_test` or any other signed-in-wide feed.

## When the app may finish the Apple transaction

`Transaction.finish()` waits for a future result whose status is `delivered`.

This version never writes `delivered`. The emulator function `holdSurgeIapRequest` writes:

- `status`: `held`
- `outcome`: `verifier-not-implemented`

`held`, a later `accepted`, and `rejected` are not permission to finish. `delivered` would mean a verified store transaction was granted. There is no verifier in this version, and an unverified blob grants nothing.

There is no production listener on `iapRequests` yet. A document left without `status` is also not `delivered`. Do not finish.

A later grant key will be the verified store transaction id, not this request id and not the raw blob. One verified transaction grants once. It must not add both a weekly allowance and a £2.99 credit. Restore, reinstall, and plan switch do not refill allowance. That ledger is not built here. Two held requests with the same blob still grant nothing.

## What the owner has decided, and what this draft does not do

Free is 3 opens in a calendar month, starting at the first successful server-authorized open. It is not 3 per week and not a fixed 30 days. The anchor is stored for the account. The phone clock, a reinstall, and a plan change do not reset it. The calendar arithmetic (time zone, month length, 31 January, 29 February, daylight saving) is not decided. Illustrations in code are marked inactive.

Premium is £3.99 a week for 10 opens, Ultimate £7.99 for 30, Stardust £14.99 for unlimited. Those weekly plans are unchanged. A driver who has used the week's opens can buy single surges at £2.99 each. The weekly plan keeps running. That is not a top-up pack and not a new subscription. The store product id `ferro.surge.single` is a proposal, not a product that exists in App Store Connect or Play Console.

A PAYG event card stays open until the verified event end, and opening it again does not charge again. The same idea applies to an event already unlocked: it stays open through a monthly or weekly reset until that end. This draft does not unlock anything.

Surge detail on the hotspot sheet is a different door from the event card. A single £2.99 purchase does not answer whether a paid plan with no opens left still sees hotspot-sheet surge info. That remains unresolved and off.

An account ledger keyed by Firebase uid would stop one signed-in user reading or spending another user's record. It would not stop one person opening many Firebase accounts. This draft does not claim that abuse is prevented.

No sheet feed, publisher, notification, store product, sandbox call, or flag is included.
