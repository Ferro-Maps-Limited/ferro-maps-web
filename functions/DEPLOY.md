# Deploying Cloud Functions

This repo deploys one Firebase codebase, `default`, from `functions/`. The functions deploy script publishes only that codebase. `firestore.indexes.json` is config for the parking TTL fields and the reconciler query. It is not published by `npm run deploy`.

## Parking refunds

A refund issued from the Stripe Dashboard for an in-app parking payment must set `reverse_transfer: true`. The charge is a destination charge: `transfer_data.amount` is the operator's `parkingPence`. Without reversing that transfer, the driver is refunded from the FerroMaps balance and the operator keeps the parking share.

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
