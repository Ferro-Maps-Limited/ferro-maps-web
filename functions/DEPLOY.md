# Deploying

`firebase.json` publishes Firestore rules only from `firestore.rules`. Never deploy rules from the iOS or Android repos.

Who is the long-term canonical owner of those rules is not settled. An older note that this web repo is canonical came from TPM, not from a verified owner decision, and a later iOS-canonical note was withdrawn. This file does not mean the live deployed rules have been compared with this repo. Do not deploy rules to reconcile them.

```bash
firebase deploy --only firestore:rules -P <alias>
```

That command replaces the live rules with `firestore.rules` only. `firestore.surge-access.prototype.rules` is an emulator draft. It is not listed in `firebase.json`. Do not copy it into `firestore.rules`, and do not point `firebase.json` at it. There is no production deploy path for that draft.

`firestore.indexes.json` holds the parking TTL fields, the parking payment query indexes, and is not published by the functions script below.

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

Until a deploy guard exists, deploy web functions by name only:

```bash
firebase deploy --only functions:default:<name> -P <alias>
```

Never use `--only functions`, `--only functions:default`, a bare `firebase deploy`, or `npm run deploy` (which runs `--only functions:default`). A whole-codebase deploy can also try to delete a function that the last web deploy labelled `default` but this repo no longer exports, `onSubscriptionRequest` included.
