# config/flags and config/categories

One `get()` of each document per app launch. Clients do not listen, and they cannot write these docs.

## Defaults

| Key | Seed |
|---|---|
| `surge` | on |
| `parking` | on |
| `traffic` | off |
| `privateParking` | off |
| `tickets` | off |
| `insights` | off |
| `payOrIgnore` | off |
| `pinsV1` | **off** |
| `surgeReports` | off |

Values are bare booleans, so there is no `minVersion` on any flag. A platform override (`android` / `ios` as a bool, or `{enabled}`) wins over `enabled` in both directions. The resolver is `flags.js`.

`config/categories` lists all 14 wire keys with the iOS display names (`event` = Event, `flight` = Flights, `egg` = Contribute, and the rest in `categories.js`). `icon` is the wire key. There is no `minVersion` and no `timeRule`. A category that is not in the list is not hidden. `enabled: false` hides that key only.

`config/liveSurge` and the other job switches are not in this seed and are not client-readable.

## pinsV1 stays off

Do not set `pinsV1` until both of these are true:

1. The static pin seed (`scripts/seed-static-pins`) has been applied, so iOS can hide its bundled FixedHotspots.
2. A static-seed dry run reports `tilesOver500: 0`. A g5 tile over 500 is split across pinTiles shards; if the split still leaves a tile over 500, `pinsV1` stays off.

The seed builder throws if `pinsV1` resolves on for either platform.

## Run

Dry-run is the default. It prints the documents and does not connect.

```bash
node scripts/seed-config/seed.js --project demo-ferromaps-rules
```

`--write` is refused unless `FIRESTORE_EMULATOR_HOST` is set and `--project` starts with `demo-`. Do not point it at a real project.

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  node scripts/seed-config/seed.js --project demo-ferromaps-rules --write
```

Unit tests: `node --test scripts/seed-config/flags.test.js`.

Rules tests (emulator): `cd firestore-tests && npm test`.
