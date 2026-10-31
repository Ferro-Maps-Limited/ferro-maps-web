# Static pin seed

iOS hides its bundled FixedHotspots while `pinsV1` is on, so these five categories have to exist as `pins` with `src: "static"` first:

`hospital`, `university`, `pub`, `boosted_train`, `shopping`.

The source file on iOS main `b3084e7` is `FerroMaps/FerroMaps/Resources/Data/fixedHotspots.json` (3,968 records: `id`, `name`, `category`, `city`, `country`, `location`, `events`, `expire_at`, `fetched_at`). That repo was not readable from this run, so `example-fixed-hotspots.json` is only a shape example. Point `--input` at a copy of the real file before turning `pinsV1` on.

Display labels are lowercased and stripped of spaces, `_`, and `-`, then mapped: Hospital → `hospital`, University → `university`, Pubs → `pub`, Boosted Trains → `boosted_train`, Shopping → `shopping`. The record `id` is the pin id and is not rewritten. `g5` is `geohash5(location)`.

## Windows

Each pin is one document. `window_start` and `window_end` cover only the next 24 hours, in Europe/London, taken from `events` (`opening_time`/`closing_time`, `start_time`/`end_time`, or a weekday map). The daily `publishPinFeed` job rolls that window forward the same way it sets parking pins to now + 24 hours, which keeps iOS tiering Cold.

If `events` has no open window in the next 24 hours, the doc is still written and `window_end` is set to `now`. `window_end > now` does not return it. The id stays put for saved places. The next daily run can open it again.

## Tiles over 500

The dry run prints a per-`g5` count of static pins plus live pins. Live counts are read only when `--project` is a `demo-` id and `FIRESTORE_EMULATOR_HOST` is set. Any raw tile over 500 is flagged.

The publisher splits a tile that does not fit in 500 pins across the base `pinTiles/{g5}` doc and up to eight `{g5}_n` siblings (500 each). Static pins are packed first. Only the base shard keeps `window_end` in the future, so the client query stays at or under 500. `g5` on the pin stays `geohash5(p)` and is never rewritten to a shard id. A cell that still does not fit in nine shards leaves `tilesOver500` above 0.

**`pinsV1` stays off until a dry run prints `tilesOver500: 0` and this seed has been applied.**

## Run

Dry-run is the default. `--project` and `--input` are required. Nothing is written, and a real project is never contacted.

```bash
cd functions && npm run build
node scripts/seed-static-pins.cjs \
  --project demo-ferromaps-pins \
  --input ../scripts/seed-static-pins/example-fixed-hotspots.json
```

`--write` is refused unless the emulator is set and the project id starts with `demo-`.
