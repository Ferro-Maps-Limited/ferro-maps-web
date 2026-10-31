# Static pin seed

iOS hides its bundled FixedHotspots while `pinsV1` is on, so these five categories have to exist as `pins` with `src: "static"` first:

`hospital`, `university`, `pub`, `boosted_train`, `shopping`.

The file this seed reads is `scripts/seed-static-pins/fixedHotspots.json`. It is the iOS file `FerroMaps/FerroMaps/Resources/Data/fixedHotspots.json` from `Ferro-Maps-Limited/ferromaps-ios-mvp-staging` at `b3084e7` (3,968 records). The SHA-256 is recorded in the pull request. Each record keeps its iOS `id` (those ids include the weekday and time slot, so one venue is several pins).

Display labels are lowercased and stripped of spaces, `_`, and `-`, then mapped: Hospital → `hospital`, University → `university`, Pubs → `pub`, Boosted Trains → `boosted_train`, Shopping → `shopping`. `g5` is `geohash5(location)`.

## Windows

Each pin is one document. `events.day` (`Mon`, …) plus `events.starting_time` / `events.ending_time` is a weekly slot. The timestamps are read as Europe/London wall-clock times and the next occurrence of that weekday is clipped to the following 24 hours. A slot whose end clock is earlier than its start clock runs past midnight. The daily `publishPinFeed` job rolls the window forward the same way it sets parking pins to now + 24 hours, which keeps iOS tiering Cold.

A record with no open slot in the next 24 hours is still written, with `window_end` set to `now`, so `window_end > now` does not return it. A record whose `expire_at` is already past is handled the same way: the doc is kept and closed, not skipped. The id stays put for saved places.

## Tiles over 500

The dry run prints total docs, docs per category, distinct `g5` tiles, the top 10 tiles by active count, and `rawTilesOver500`. That count is static pins with `window_end > now` only. Live pins add more. Live counts are read only when `--project` is a `demo-` id and `FIRESTORE_EMULATOR_HOST` is set.

The publisher splits a tile that does not fit in 500 pins across the base `pinTiles/{g5}` doc and up to eight `{g5}_n` siblings (500 each). Static pins are packed first. Only the base shard keeps `window_end` in the future, so the client query stays at or under 500. `g5` on the pin stays `geohash5(p)`. `tilesOver500` stays above 0 only when a cell still does not fit in those nine shards.

**`pinsV1` stays off until a dry run prints `tilesOver500: 0` and this seed has been applied.**

## Run

Dry-run is the default. `--project` is required. `--input` defaults to `scripts/seed-static-pins/fixedHotspots.json`. Nothing is written, and a real project is never contacted.

```bash
cd functions && npm run build
node scripts/seed-static-pins.cjs --project demo-ferromaps-pins
```

`--write` is refused unless the emulator is set and the project id starts with `demo-`.
