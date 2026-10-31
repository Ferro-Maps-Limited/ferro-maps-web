#!/usr/bin/env bash
# Firestore emulator tests for Play receipt verification.
# Uses a config outside firebase.json so `firebase deploy` still has no
# firestore target and cannot publish rules.
set -euo pipefail
FUNCS="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$FUNCS/.." && pwd)"
cd "$FUNCS"
npm run build
"$FUNCS/node_modules/.bin/firebase" emulators:exec \
  --config "$ROOT/firebase.emulator.json" \
  --project demo-play-receipts \
  --only firestore \
  "node --test --test-concurrency=1 --test-force-exit $FUNCS/lib/play/play.test.js $FUNCS/lib/play/rules.test.js"
