# Deploying Cloud Functions

This repo deploys one Firebase codebase, `default`, from `functions/`. `firestore.rules` is the 73508bb ruleset and `firebase.json` points at it. This script still deploys functions only. Rules are a separate `firebase deploy --only firestore:rules -P <alias>`. Indexes are not in this repo.

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
