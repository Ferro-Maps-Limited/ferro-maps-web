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

## Road-charge reminders

Do not deploy every function in codebase `default` for this change. Deploy the two new functions by name:

```bash
firebase deploy --only functions:default:onZoneEntryCreated,functions:default:sendRoadChargeReminders -P <alias>
```

Rules and indexes are separate. Indexes publishes the whole `firestore.indexes.json`, including the parking indexes already in that file and the new `zoneEntries` composite plus the `zoneEntries.expireAt` TTL:

```bash
firebase deploy --only firestore:rules -P <alias>
firebase deploy --only firestore:indexes -P <alias>
```

Deploy indexes before `sendRoadChargeReminders`, and wait until the composite index is enabled. The function has no params and no secrets. It uses the default runtime service account for codebase `default`. This repo does not grant IAM and does not write `roadCharges/cc` or `roadCharges/ulez`. `npm run seed:road-charges` prints an example and refuses `--write`.

Node 24 is required (`engines.node` in `functions/package.json`, and `.nvmrc` at the repo root). `npm run lint` and `npm run build` run as the firebase predeploy hook. Do not use a bare `firebase deploy`.
