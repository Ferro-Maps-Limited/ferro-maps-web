# Forecast history

Each event pin can keep two extra facts: the forecast as it stood four hours before the event started, and what the post-event checks actually showed after it finished. Both sit on the pin in a new field, `forecastHistory`. The forecast the phones already read is left as it is, including `confidencePercent`.

The spreadsheet is the Ferro SURGE sheet, id `1ktnMOhn3yipZAZL_7W_xEsyFrTbKTCbYskfyRNL4riw`. Set that id in `SURGE_SHEET_ID`. The job does not read until the id is set, and it does not call Uber or any other ride-hail app. Someone types the checks into the sheet. This change does not edit the Events tab or the Readings tab, and it does not deploy anything.

## The pre-event snapshot

`forecastHistory.preEvent` is written once, on the first run in the four hours before the event starts. A later run does not replace it, even if the live forecast has changed. If that window has already passed and no snapshot was stored, it is left blank. It is not filled in afterwards.

The snapshot is the forecast already on the pin at that moment:

| Field | Meaning |
|---|---|
| `snapshotAt` | When this snapshot was stored. |
| `state` | `available` or `no_prediction`, copied from the forecast. |
| `strength` | `low`, `medium`, or `high`. Only when the forecast was available. |
| `confidencePercent` | The same percent the forecast already had. |
| `basedOnEvents` | How many past events that percent used. |
| `startAt` and `endAt` | The forecast window, copied as it stood. |

A `no_prediction` snapshot has `snapshotAt` and `state` only.

Sheet pins (`sheet_` plus the event id) are included. So are other pins that already have a forecast, such as a Ticketmaster event pin or a station pin. The event start is the pin's own start (`window_start`, or `starting_time`, or the hour in a `910G…_date_Hhour` id). It is not the surge window.

## What actually happened

After the event's finish (`events.end_time`, or `ending_time`), `forecastHistory.outcome` records the post-event checks.

| Field | Meaning |
|---|---|
| `surged` | `yes`, `no`, or `unknown`. |
| `windowStartAt` and `windowEndAt` | The first and last check that showed a surge. Only when `surged` is `yes`. |
| `strength` | The band of the highest surge seen in those checks. Only when a check was high enough to band, using the same 20% / 40% / 70% cuts as the forecast. |
| `readingCount` | How many post-event checks were used. |
| `readingTimes` | When each of those checks was taken. |

`unknown` means there were no usable checks. The job does not look at the Events tab "Did it surge?" cell, and it does not invent a yes or a no. It also does not write that answer back onto Events, Readings, or any other tab that already exists. The answer lives only on the pin, in `forecastHistory`. A check during the event does not count. A Readings row counts only when its phase is already Post. On the Check-ins tab, only a row whose phase is Post counts. Pre and Fixed rows stay on the tab.

A blank "Did it surge?" cell is judged from the fare and the normal fare, in memory, and only when both are filled in. At least 20% above the normal fare is a yes. Anything short of that is a no. The pounds are not stored. If the cell says YES or NO, that answer is used, and the fare cannot overrule it. If the cell is blank and the fares are blank, that row is counted in `readingCount` and `readingTimes` but it does not decide yes or no.

Checks are meant to be taken every 10 to 20 minutes after the finish, until the surge is over or the hard stop. The job itself wakes every 15 minutes and reads whatever rows are there. It does not fill gaps.

A yes or no can be updated as more checks are added. An unknown can become a yes or a no once checks exist. A stored yes or no is not put back to unknown just because a later read saw no rows.

## Proposed tab: Check-ins

This is a new tab. It is not on the sheet yet. Do not rename Events or Readings, and do not add these columns to them. The jobs only read tabs. They never write Events, Readings, the TPC tabs, or Check-ins. When Check-ins is missing, the jobs still read the tabs that already exist.

One row per check. The phase says which kind of check it is.

| Column | What to type |
|---|---|
| Place or Event ID | The event id from the Events tab, or the place name for a fixed-place check. |
| Time (UK) | When this check was taken. |
| Phase (Pre / Post / Fixed) | `Pre` about 4 hours before the start. `Post` every 10 to 20 minutes after the finish. `Fixed` for a standing place. |
| Pickup point | Which pickup was checked. |
| Did it surge? | YES or NO. Leave it blank if you are not sure. |
| Fare shown (£) | Optional. Used only in memory, then discarded. |
| Normal fare (£) | Optional. Same. |
| Pickup wait (min) | Optional. Not copied onto the pin. |
| Notes | Optional. Not copied onto the pin. |

`SURGE_CHECK_INS_TAB` defaults to `Check-ins`.

A `Pre` row and a `Fixed` row are not the result of an event. A `Fixed` row is not matched onto a different event by place name. Only a `Post` row whose id is that event's id becomes the outcome.

## How later forecasts use this

A recorded yes or no is read back in code and used in the history the forecast already uses. The read comes from `forecastHistory` on the pin, or from Post rows on Check-ins. The Events row is not edited. A yes or no already typed on the sheet is kept, and so is that row's peak. This is the same event id only, and only when that row is still pending. The fixture still needs 3 completed rows, and the venue still needs 4. Category pins still do not get the 3-row fixture shortcut. Nothing else about matching changes, and the backtest is unchanged.

The strength band is carried back only as the bottom of that band, and only when the sheet row has no peak of its own. That stand-in is used while choosing the next band. It is not written to the pin.

Outcomes on pins that are not `sheet_` ids stay on those pins. They are not added as extra history rows.

## What would need deploying

Nothing in this change is deployed. When it is, deploy by name only:

- `recordForecastHistory` writes `forecastHistory`.
- `syncSurgeSheetEvents` so later sheet forecasts can see a recorded yes or no.
- `attachCategoryForecasts` so later category forecasts can see the same sheet outcomes.

Do not deploy the whole functions codebase. The schedule, region, and runtime account stay the same as the other two surge jobs.
