# Read-only checks

These two scripts never write. They use Application Default Credentials (`gcloud auth application-default login`). `--project` is required. There is no default, and any write flag is refused.

`ferro-maps-staging-v2` is the `live` alias. The scripts do not read `.firebaserc`. Build the functions package once so the pins gate can reuse the seed planner:

```bash
cd functions && npm ci && npm run build
```

pinsV1 gate. Static docs are computed from `scripts/seed-static-pins/fixedHotspots.json`. Parking and event pins are what `publishPinFeed` would build from `hotspots_test`. Existing `pins` with `window_end > now` are included. The process exits non-zero when `tilesOver500After` is above 0.

```bash
GOOGLE_CLOUD_PROJECT=ferro-maps-staging-v2 node scripts/pins-dryrun-combined.js --project ferro-maps-staging-v2
```

WEB-BE-15. Counts `appVersion` values longer than 32 characters. It prints the count per collection and up to 10 document ids with the length, not the value.

```bash
GOOGLE_CLOUD_PROJECT=ferro-maps-staging-v2 node scripts/check-appversion-length.js --project ferro-maps-staging-v2
```
