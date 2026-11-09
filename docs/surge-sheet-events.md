# Surge sheet events

The Ferro SURGE sheet has one row per event on the Events tab, and one row per price check on the Readings tab. A scheduled job reads those two tabs and writes one pin per event into `hotspots_test`.

It is not only for football. A stadium, station, hospital, university, pub, shop, or any other row is written the same way, as long as it has an event id, a start time, and at least one pickup point with coordinates.

This job is already exported. It is not running until it is deployed, and it does not read the sheet until the spreadsheet id is set. This change does not deploy it.

## When a pin comes off the map

Phones do not start their own timer.

- `surgeEnded` is true when the sheet shows the price back to normal (two checks in a row, during or after the event, at the same pickup), or when `removeBy` has already passed at the moment the job runs.
- `removeBy` is the sheet's hard stop. If that cell is blank or not a real time, it is the expected finish plus 3 hours. If the expected finish is blank too, the job uses kick-off plus 1 hour 55 minutes (the sheet's own finish rule) plus 3 hours.

The pin should disappear when `surgeEnded` is true or when `removeBy` has passed, whichever comes first.

`window_end` and `expire_at` are set to the same moment as `removeBy`, so an older phone, and the admin map, also drop the pin at the hard stop.

## The fields on each pin

The document id is `sheet_` plus the sheet Event ID, in capitals. The same row always updates that same document. Other pins are never deleted. A pin that only has the same name and the same map position is left alone. The job does not join onto it.

| Field | Meaning |
|---|---|
| `idSource` | Always `sheet_event`, so this pin is not an app id (`fixed_local`) and not some other hotspot id. |
| `sheetEventId` | The Event ID from the sheet. |
| `name` | Home team and away team when both are filled (`Home v Away`). Otherwise the venue name (Ground, or Venue, or Venue name). |
| `description` | The competition and the venue, when both are filled and they differ. Otherwise the venue name. |
| `category` | The venue type from the sheet. The job looks at Venue type, then Category, then Venue category, then Type. Hospitals, universities, pubs, shops, hotels, nightclubs, stations, and sport use those words (a trailing "s" is ignored). Anything else usable is kept as written. A blank or missing cell becomes `event`. |
| `country` | `United Kingdom`. The sheet's clocks are UK times. |
| `location` | The map point for the pin. When the sheet lists pickup points, this is their middle. When it does not, and the venue is in the checked offline table, this is that venue coordinate. |
| `positionSource` | `pickup_centroid` when pickups provided the point, or `venue_lookup` when the offline venue table did. Phones can treat `venue_lookup` as approximate venue centre with no verified pickups. |
| `window_start` | When the event starts. See below for notes that are not a full date and time. |
| `startTimeSource` | Where that start came from: `sheet_exact` (the cell was already a full date and time), `sheet_start` (a start, show, listed, face-off, ringwalk, or a time written on its own), `sheet_doors` (only a doors time), or `derived_from_finish` (no clock time at all, so expected finish minus 3 hours). |
| `window_end` | The same moment as `removeBy`. |
| `expire_at` | The same moment as `removeBy`. There is no `expiresAt`. |
| `fetched_at` | When this job last wrote the pin. |
| `events.start_time` | The same as `window_start`. |
| `events.end_time` and `events.closing_time` | Expected finish, or kick-off plus 1 hour 55 minutes when that cell is blank. |
| `removeBy` | When the pin must come off, even if nobody has marked the surge as finished. Always present. |
| `surgeEnded` | `true` or `false`, as above. |
| `updatedFromSheetAt` | When this job last applied the sheet. Same moment as `fetched_at`. |
| `pickupPoints` | Each approved pickup: `name`, `lat`, `lng`, and `verified`. A verified point also has `confidence` of `low`, `medium`, or `high`. When that point has its own past results, it also has `confidencePercent` (how many of those past events surged, out of 100). Otherwise that number is left off. `verified: false` means the phone should hide that point. |
| `forecast` | Either `{state: "no_prediction"}` with nothing else, or `{state: "available", v: 1, startAt, endAt, strength, confidence, confidencePercent, basedOnEvents}`. Strength and confidence are `low`, `medium`, or `high`. `confidencePercent` is how many of the past events in that set surged, out of 100. `basedOnEvents` is how many past events that percent used. Neither number is written on `no_prediction`. |

## How the start time is read

The day is the date at the front of the Event ID, such as `2026-10-20` in `2026-10-20-O2-JCOLE`. That date has to be a real calendar day. The clock is UK time, including when the clocks change.

1. If Kick-off is already a full date and time, that is the start (`sheet_exact`).
2. Otherwise use a start, show, listed, face-off, or ringwalk time, or a time written on its own such as `19:00 (Dice)` or `19:30 (doors 18:30)` (`sheet_start`).
3. If the only time is when the doors open, use that (`sheet_doors`).
4. If there is no clock time at all (TBC, TBA, not given, not published), use the expected finish minus 3 hours (`derived_from_finish`). A time mentioned only as a readings note is not a start.
5. If the expected finish is blank as well, the row is not written.

A start that would fall after the expected finish is not written, and it is counted as rejected. The same start is what the forecast and the backtest treat as "earlier".

## When there is no prediction

The job does not guess. `forecast.state` is `no_prediction`, and there is no window, strength, or confidence, unless all of the following are true.

Completed rows only. "Did it surge?" must be YES or NO, and the kick-off must be earlier than this event. PENDING is ignored. The sheet's "Predicted surge confidence %" column is ignored.

1. The same fixture (same venue, home team, and away team) needs at least 3 completed earlier rows. If it does not have those, the venue needs at least 4.
2. At least 3 of the rows in that set are YES, and at least 60% are YES. A run of NOs is not stored as a "no surge" forecast. It is still `no_prediction`.
3. Those YES rows need a peak uplift, and the middle value has to be at least 20%. That percent is used only to pick a band, then thrown away.
   - low: 20% up to 40%
   - medium: 40% up to 70%
   - high: 70% and above
4. The surge window has to be a real start and end. The start is the sheet's surge-window start, or the expected finish if that cell is blank. The end is the sheet's estimated end, or `removeBy`. A window longer than 6 hours is cut to 6 hours, which is as long as the phones show. If there is still no window, the forecast is `no_prediction` even when the history is strong.

Confidence, only when a forecast is written:

- low: fewer than 5 completed rows in the set
- medium: at least 5 rows, and a YES share of at least 60%
- high: at least 8 rows, and a YES share of at least 75%

On that same set, `confidencePercent` is the YES rows divided by all completed rows, times 100, rounded to the nearest whole number. `basedOnEvents` is how many completed rows were used. Example: 3 YES and 1 NO is 75 percent, based on 4 events. A `no_prediction` pin does not carry either number.

A pickup point's confidence is separate. It counts earlier completed events at that venue where that same pickup was checked at least twice.

- fewer than 2 such events: `verified: false`, and no confidence (hide the point). No percent either.
- 2 or 3: low
- 4 to 7: medium
- 8 or more: high

A verified point also gets `confidencePercent` from those same earlier events: how many of them surged, out of 100. If there is no such set, the percent is left off.

## Prices stay in the sheet

Fares, baseline fares, and pound amounts are read only to decide whether the price is back to normal, and the peak uplift percent is read only to pick the strength band. None of those figures, and no £ sign, is written to Firestore or into the job's log.

## What has to be true before the first useful run

1. Deploy this one function by name. Do not deploy the whole functions codebase.

   `firebase deploy --only functions:default:syncSurgeSheetEvents -P <alias>`

2. Set `SURGE_SHEET_ID` to the spreadsheet id (the long id in the sheet URL). `SURGE_EVENTS_TAB` defaults to Events and `SURGE_READINGS_TAB` defaults to Readings. These are ordinary settings, not secrets. See `functions/.env.example`.

3. Share the sheet with the function's runtime account as a viewer. The function does not set its own account, so Cloud Functions (2nd gen) uses the project's default Compute Engine account:

   `{project number}-compute@developer.gserviceaccount.com`

   The project number is in Firebase console → Project settings, under the project name. After deploy, the function details page shows the same email. No new account and no new secret are created.

Until the spreadsheet id is set, the job wakes every 15 minutes, writes nothing, and logs `sheet-id-missing`.

The schedule is every 15 minutes, London time, region `europe-west2`.

## Checking the forecast on a private export

The committed tests use synthetic rows only. To score a private export later, without committing it:

```bash
cd functions
npm run backtest:surge -- --synthetic
npm run backtest:surge -- --json /path/outside/the/repo/export.json
npm run backtest:surge -- --events events.csv --readings readings.csv
```

The JSON file is `{ "events": [ ...rows including the header... ], "readings": [ ... ] }`. The printed result is counts only: how often a surge forecast matched a recorded YES, and how often the strength band matched. Rows with no prediction are counted separately. They are not misses.

## Venue locations without pickups

Some Events rows have a venue name but no pickup points. Those used to be skipped. The job now looks the venue name up in an offline table checked from OpenStreetMap and Wikipedia/Wikidata (see `functions/src/surge/venueLocations.ts`, ODbL attribution in that file). A match must already be verified offline: UK, venue-like, and two free sources agreeing within 500 m. The job never calls a geocoder at runtime and never invents pickup points. Unchecked venues stay skipped (`skippedVenueUnverified` in the run log).
