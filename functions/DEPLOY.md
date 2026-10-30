# Deploying Cloud Functions

This repo deploys one Firebase codebase, `default`, from `functions/`. Firestore rules and indexes are owned by [Ferro-Maps-Limited/ferromaps-ios-mvp-staging](https://github.com/Ferro-Maps-Limited/ferromaps-ios-mvp-staging). `firebase.json` has no `firestore` target, and `firestore.rules` in this repo is a read-only mirror. Do not deploy rules from here.

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
