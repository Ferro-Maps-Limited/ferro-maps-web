# Admin custom claim setup (FM-WEB-041)

One-off tool for granting admin access to admin.ferromaps.com. Not part of the
deployed apps and not run in CI.

## Background

Anyone who signs in to admin.ferromaps.com with a valid Firebase Auth email +
password is rejected unless their account also has the custom claim
`role: admin`. This claim can only be set with Admin SDK credentials (a service
account key) — never from the browser.

## How it works

1. Create a Firebase Auth account in the Firebase console
   (Authentication > Users > Add user). This gives you an email and a UID, but
   the account cannot sign in to the dashboard yet.
2. Run this script once to set role: admin on that account.
3. The person can then sign in normally at admin.ferromaps.com/login.

## One-time setup

ferro-maps-staging-v2 has `iam.disableServiceAccountKeyCreation` enabled via org
policy, so the primary auth method is Application Default Credentials (ADC):

1. `gcloud auth application-default login`
2. `gcloud auth application-default set-quota-project ferro-maps-staging-v2`
3. Run `npm install` in this folder.

**Fallback (if the org policy is ever relaxed):** you can instead place a
serviceAccountKey.json in this folder — the script will use it automatically if
present. To obtain one: Firebase console > ferro-maps-staging-v2 > Project
Settings > Service Accounts > "Generate new private key". Save as
serviceAccountKey.json here (already in .gitignore — NEVER commit this file).

## Granting admin access to a team member

1. Add them in the Firebase console under Authentication > Users, with a
   password they change later.
2. node set-admin-claim.mjs their.email@ferromaps.com
3. Confirm: node set-admin-claim.mjs their.email@ferromaps.com --check
4. They sign in at admin.ferromaps.com/login.

## Granting support access

Support staff answer tickets on the Messages page and see nothing else — no
driver data, waitlist or account controls. firestore.rules lets the support role
read and update supportRequests only.

1. Add them in the Firebase console, as above.
2. node set-admin-claim.mjs their.email@ferromaps.com --support
3. They sign in at admin.ferromaps.com/login and land on Messages.

Running the script without --support on the same account promotes them to
admin; running it with --support demotes an admin to support.

## Removing access

node set-admin-claim.mjs their.email@ferromaps.com --remove

Removes the role claim entirely, whether admin or support.

## Security notes

- serviceAccountKey.json grants full admin access to the Firebase project. Never
  commit it or share it over Slack/email. Delete it from your machine when done,
  or store it in a password manager.
- If a key is exposed, revoke it immediately from the Firebase console
  (Service Accounts > Manage service account permissions > delete the key).
- The temporary /create-account page has been removed now the first accounts
  exist. Accounts are made in the Firebase console, so the admin app has no
  public sign-up route at all.
