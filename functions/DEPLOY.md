# Deploying

Firestore rules deploy only from ferro-maps-web. This repo is the single source of truth for `firestore.rules`. Never deploy rules from the iOS or Android repos.

```bash
firebase deploy --only firestore:rules -P <alias>
```

`firestore.indexes.json` holds the parking TTL fields, the parking payment query indexes, and is not published by the functions script below.

## Parking refunds

A refund issued from the Stripe Dashboard for an in-app parking payment must set `reverse_transfer: true`. The charge is a destination charge: `transfer_data.amount` is the operator's `parkingPence`. Without reversing that transfer, the driver is refunded from the FerroMaps balance and the operator keeps the parking share.

## Cloud Functions

This repo deploys one Firebase codebase, `default`, from `functions/`.

> **Paused:** do not run the whole-codebase deploy below until a guard exists. Deploy by name only. See "Function names owned by the iOS `mobile` codebase".

An alias is required. The script will not fall back to the `default` project in `.firebaserc` (today that alias is `ferro-maps-staging-v2`).

```bash
cd functions
npm run deploy -- <alias>
```

That runs:

```bash
firebase deploy --only functions:default -P <alias>
```

`-P <alias>` works the same way: `npm run deploy -- -P <alias>`.

Node 24 is required (`engines.node` in `functions/package.json`, and `.nvmrc` at the repo root). `npm run lint` and `npm run build` run as the firebase predeploy hook. Do not use a bare `firebase deploy`.

## Function names owned by the iOS `mobile` codebase

`onSubscriptionRequest` (the Apple Gold writer) and `refreshEntitlements` belong only to the iOS `mobile` functions codebase in ferromaps-ios-mvp-staging. This repo must never export them. The list lives in `functions/src/codebases/mobileOwnedFunctions.ts`, and `npm run test:guard` (run by `npm test` and CI) fails if the built `lib/index.js` exports any of them.

Why: both codebases deploy to the same project in region `europe-west2`. firebase-tools (`groupEndpointsByCodebase`) assigns an existing function to the codebase being deployed by its resource name, whatever codebase label it carries. So a web deploy that includes a same-named function silently replaces the iOS one, and new App Store buyers stop getting Gold. On `ferro-maps-staging-v2`, which is production, that hits real drivers.

## Parking sheet and road charges

Do not deploy from this change until the steps below are done. Neither feed writes anything until its `config/*.enabled` field is exactly true.

Parking sync runtime account: `private-parking-sync@ferro-maps-staging-v2.iam.gserviceaccount.com` (`PRIVATE_PARKING_SYNC_SERVICE_ACCOUNT`). Share spreadsheet `1VHtzY1001e0aRSXE6s_-IJU9YioJtjSNZ5WCOt1IO-o` with that account as a viewer. The tab is `ALL LONDON (clean)`. Params live in `functions/.env.ferro-maps-staging-v2`.

Road-charge runtime account: `road-charges-sync@ferro-maps-staging-v2.iam.gserviceaccount.com` (`ROAD_CHARGES_SYNC_SERVICE_ACCOUNT`). Create that account before deploying `syncRoadCharges` or `onRoadChargesImportRequest`. Grant it `roles/datastore.user` and `roles/logging.logWriter` on `ferro-maps-staging-v2`. Enable the Google Drive API. Share Drive file `1FVYnb0Ho6Cr-ITk8rO-gbJdNEVSMzDSK` with that account as a viewer. The file is an `.xlsx`, not a Google Sheet.

```bash
firebase deploy --only functions:default:syncPrivateParkingSheet,functions:default:syncRoadCharges,functions:default:onRoadChargesImportRequest,firestore:rules -P ferro-maps-staging-v2
```

Then, in the Firestore console (Admin SDK, rules do not apply):

- `config/privateParking` merged with `enabled: true`
- `config/roadCharges` merged with `enabled: true`

The parking job runs at minute 0. The road-charge job runs at minute 20. To load road charges immediately, create `roadChargesImportRequests/{id}` with `status: "pending"`. An admin client must also set `requestedBy` to its uid and `createdAt` to a server timestamp. The console bypasses that rule.

Until a deploy guard exists, deploy web functions by name only:

```bash
firebase deploy --only functions:default:<name> -P <alias>
```

Never use `--only functions`, `--only functions:default`, a bare `firebase deploy`, or `npm run deploy` (which runs `--only functions:default`). A whole-codebase deploy can also try to delete a function that the last web deploy labelled `default` but this repo no longer exports, `onSubscriptionRequest` included.
