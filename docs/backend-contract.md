# FerroMaps backend contract

| | |
|---|---|
| Status | **Draft.** Docs only. No functions, rules, indexes, or deploys in this change. |
| Readers | Android and iOS. iOS adopts these names, error codes, and the flag override below. |
| Client source of truth | Android `feat/pin-platform` at `26cb596` (extract dated 31 Oct 2026). Where that code and an earlier plan disagree, the code wins. |
| Project | `ferro-maps-staging-v2` (alias `live`). New functions: `europe-west2`. |
| Rules owner | **This repo.** `firestore.rules` and indexes here are the only source of truth. iOS ports from here. The rules PR starts from iOS `main` `b3084e7`, re-adds `appVersion`, and fixes the device-claim grace. `chore/rules-merge-web-admin` is not merged. |
| Date | 31 Oct 2026 |

Every Android reader and writer below is still switched off (`FIRESTORE_READS`, `FIRESTORE_WRITES`, `HANDLE_PUSH`, `SUBSCRIBE_TOPICS`, `IN_APP_PAY` are false). Drivers today read `hotspots_test` and `users/{uid}` only. This contract is what those switches will call.

Lead TPM rulings from 31 Oct 2026 are applied below. Nothing in this contract is still proposed.

## Answers to Android's open points

### 1. In-app pay is a request document, not a callable

`RequestDocument.kt` is right for this project. Domain Restricted Sharing refuses `allUsers` on `roles/run.invoker`, and the Android app has no Functions SDK. **There is no `createParkingPayment` callable.**

The client creates `parkingPaymentRequests/{id}` (`status: "pending"`, `createdAt` = server timestamp) and listens. A Firestore trigger (`onParkingPaymentRequest`, `onDocumentCreated`) prices the stay, creates the PaymentIntent, and writes `status: "done"` plus the response fields, or `status: "error"`. The same idempotency key is `visitId` (one PaymentIntent per visit). Details in [Pay](#14-in-app-pay).

**Approved** by the lead TPM. The in-flight Stripe draft that named a callable follows this shape. It does not add a second payment path.

**No inbound Stripe webhook.** There is no `stripeWebhook` function and no `STRIPE_WEBHOOK_SECRET`. The only Stripe secret is `STRIPE_SECRET_KEY`. When the create request completes, the server creates `parkingPayments/{paymentId}` with `status: "created"`. After PaymentSheet, the client creates `parkingPaymentRequests/{paymentId}_confirm`. `onParkingPaymentRequest` retrieves the PaymentIntent. Status only moves forward, the plate is registered once, and the write is idempotent on `paymentIntentId`. A scheduled reconciler covers anything still pending, plus refunds and disputes. The server is the only source of truth for payment status. Details in [Pay](#14-in-app-pay).

### 2. The number plate does go to the server

Operator registration cannot be done from the device. The consented plate is a required field on `parkingPaymentRequests` only (`plate`, letters and digits, stored without spaces, compared case-insensitively). The trigger forwards it to the operator. It is not a field on `parkingPayments`, not on the cell, and not in analytics or logs. The request doc keeps it until the terminal sweep removes the doc (24 h, the same window as other non-deletion request docs). The plate is not copied onto the payment doc the client listens to.

### 3. The pay response splits the price

On `status: "done"` the request doc includes both `parkingPence` (operator charge, total pence for the stay) and `feePence` (FerroMaps fee, total pence). `amount` is the sum, in pence, GBP. The client does not send either number.

Charges are **destination charges**. FerroMaps carries the Stripe fees. The operator's share goes to their connected account with `transfer_data`. The client response does not include `connectedAccountId`.

### 4. One shard rule

For `pinTiles/{geohash5}`, `parkingCells/{geohash6}`, and `privateParkingCells/{geohash6}`:

| `shards` on the base doc | Documents to read |
|---|---|
| absent, not a number, or `0` | the base id only |
| `n` clamped into `1..8` | the base id **and** `{base}_1` … `{base}_n` **inclusive** |

`shards: 1` means one extra doc, `_1`. Values above 8 are read as 8. The base doc is a full payload, not a manifest. Siblings use the same schema. Clients ignore `shards` on a sibling. An id that is not `{geohash}_{integer ≥ 1}` is not a shard.

This replaces BACKEND-4's `_1.._{n-1}` range and the split in the Android tree (pinTiles `1..8`, parkingCells `2..8` only, private cells none). iOS implements this rule. Publisher constraints until Android catches up are in [Shards](#5-shards).

### 5. Surge-report rejections, and idempotency

The trigger is idempotent on the client UUID (`surgeReports/{reportId}`). A second delivery for the same id does not apply the report twice. Details and the permanent list are in [Surge reports](#10-driver-surge-reports).

### 6. No `surgePush` or `topics` flags

Do not add them. Android does not read them. The push handler is gated by `config/flags.insights` (plus the client `HANDLE_PUSH` switch). Topic subscription is Gold-only and has no flag.

`payOrIgnore` stays in the schema, default **off**. **Approved:** Android and iOS both check it before showing the pay card. Off hides the card. On allows the card. The server still takes payment only when `payMode` is `inapp`. The build at `26cb596` parses the key and does not check it yet. That check is part of turning the card on.

### 7. Shape mismatches, settled

| Topic | Contract |
|---|---|
| `tickets.priceBand` | int `1`, `2`, or `3` (low, medium, high). Not a string |
| Insight and forecast bands | strings `low`, `medium`, `high`: `demandBand`, `upliftBand`, `peakBand` |
| `surgeForecast` | **No `expiresAt`.** Required: `v == 1`, `startAt`, `endAt`. Shown while `endAt > now`. The window is at most 6 h. This is the one layer that does not use `expiresAt` |
| Kerb `fee` (segment or spot) | int, **pence per hour**, `≥ 0` |
| Private-place `fee` | int, **total pence for the stay**, sent only when the charge is clear. Not per hour |
| Server price | `parkingPence` + `feePence`, both total pence. `amount` is the sum |

### 8. `walkM`, `src`, `capturedAt`, and `aud`

Confirmed, these exact names:

| Field | Type | Where |
|---|---|---|
| `walkM` | int, `≥ 0` | `pinGold.privateNearby` places. On insights, `waitAt.walkM` is int `0..1000` |
| `src` | string | Private places and nearby places: a source label. Insights `src` is a string array (`tm`, `tfl`, `history`, `grok`) |
| `capturedAt` | timestamp | Private / nearby places. Shown with the source |
| `aud` | string | `c` or `customers`, `g` or `guests`, `p` or `public`, and the word **`permit`**. There is no one-letter code for permit. Anything else is unverified |

All four are optional. Missing `aud` is unverified.

### 9. `users/{uid}.appVersion` is refused on iOS main, and the web rules PR allows it

On iOS `main` `b3084e7`, `appVersion` is not in `clientOwnedUserKeys()`, so a client update that sets it is refused. The allow-list and `appVersionValid()` exist only on the unmerged rules at `73508bb`. `chore/rules-merge-web-admin` is not merged.

The rules PR in this repo starts from `b3084e7` and re-adds both, copied from `73508bb`: `appVersion` on the user allow-list, and `appVersionValid()` (a string of at most 32 characters, or the field absent). After that PR is deployed, `AppUpdateService.reportInstalledVersion` succeeds for a short string. Until then the write is refused. The same PR sets `graceEnds()` to `timestamp.date(2026, 12, 31)`, replacing the 15 Oct 2026 cutoff on `b3084e7`, which has already passed. A token with no `deviceId` claim is allowed through until that new date. A token with the wrong `deviceId` stays refused.

---

## Hard rules

1. **`hotspots_test` and `users/{uid}` stay backward compatible.** New fields are optional. Do not rename or delete a field those docs already have. `pins` is a new collection with its own required fields. It does not replace the hotspot field names.
2. **Do not write a top-level `expiresAt` on `pins` or `hotspots_test`.** Android never reads it there. The admin map treats a top-level `expiresAt` as pin expiry (`expire_at` is the field it actually queries). Layer clocks are nested: `liveSurge.expiresAt`, `parking.expiresAt`, `tickets.expiresAt`, `traffic.expiresAt`. `surgeForecast` has no `expiresAt`; its clock is `endAt`.
3. **Clients only read read models.** They create request docs and never write the result. Server jobs use the Admin SDK.
4. **A bad layer hides itself.** Wrong type, unknown `v`, or a failed `expiresAt` check removes that layer. The pin stays. `PERMISSION_DENIED` on a new collection is empty data, not an error UI, and is not cached.
5. **`v` is accepted as `1` or `1.0`.** Any other number hides that doc or layer. A `v: 2` beside `v: 1` is ignored.
6. **Timestamps are Firestore timestamps.** Strings and numbers are not times, except FCM data values (strings) and parking `tl` (UTC epoch minutes).
7. **Unknown fields are ignored.** A bad row is dropped on its own.
8. **No Uber or Bolt prices, fares, or multipliers** in these documents or in push payloads.
9. **Gold** on the client is an active StoreKit entitlement or `subscriptionExpiresAt` in the future. Rules use only `subscriptionExpiresAt > request.time`. Clients cannot write that field. A Play subscription writes the same field ([Play receipts](#20-play-subscription-receipts-web-be-10)). A rules denial while StoreKit is already active is catching up, not a sign-out. See [Gold](#15-gold-rule).
10. **Callables are not the client transport.** See [answer 1](#1-in-app-pay-is-a-request-document-not-a-callable).

## Who deploys what

| Piece | Home | Follow-up |
|---|---|---|
| Rules and indexes | this repo, then iOS ports the file | PR-A, based on iOS `b3084e7` |
| `onAccountDeletionRequest`, `sweepRequestDocuments`, `refreshDriverDensity`, `stampHotspotWindow` | iOS codebase `mobile` | Do not reimplement under web `default` |
| `sweepStaleDrivers` | iOS `mobile`. Approved | PR-C |
| `computeLiveSurge` | iOS `mobile` | PR-D |
| `onDriverLocationWritten` writes `driverLocations.geohash` | iOS `mobile`. Admin heat in this repo reads it | PR-Loc |
| Ingest and publishers | Cloud Run, `europe-west2` | PR-H onward |
| `onParkingPaymentRequest`, `reconcileParkingPayments`, `parkingPayments` | this repo, codebase `default`. No webhook | the Stripe draft |
| `onPlayPurchaseRequest`, `reconcilePlaySubscriptions` | this repo, codebase `default`. No callable, no RTDN | [WEB-BE-10](#20-play-subscription-receipts-web-be-10) |
| Web admin rollups, ticket mail | web `default` | unchanged |

Node on web `default` is 24. Do not rename codebase `mobile` onto `default` or the reverse.

---

## 0. Documents that already ship

### 0.1 `hotspots_test/{id}`

Signed-in read, write false. iOS and Android listen with `window_end > now`. iOS falls back to the whole collection when that query is empty. The admin map queries `expire_at > now` ordered by `expire_at`.

Keep every field already stored. Protected fields, which a publisher must copy through and must not rename or delete:

| Field | Type | Notes |
|---|---|---|
| `location` | GeoPoint | |
| `name`, `description` | string | |
| `category` | string | Live feed values stay (`events`, `venues`, `flights`, `flight disruptions`, `travel disruptions`). Also keep the aliases iOS already matches: `sport` and `sports`, `nightclub` and `nightclubs`, `hotel` and `hotels` |
| `country` | string | |
| `city` | string | |
| `expire_at` | timestamp | Admin map expiry |
| `fetched_at` | timestamp | |
| `window_start`, `window_end` | timestamp | |
| `events` | map | The whole map is protected. Indexed subfields that must remain: `events.closing_time`, `events.end_time`. The composite index on `events` + `name` stays valid |
| `jobs_accepted` and `jobsAccepted` | number | Both spellings. Do not drop one in favour of the other |
| `demand` | map | `expectedRiders`, `suppress`, `reason`, `band`, `confidence`, `assessedAt` |
| `confirmCount` | number | |
| `createdBy`, `createdAt` | string, timestamp | |

Do not rewrite `hotspots_test.category` to the pin wire keys in [section 2](#2-configcategories).

Additive server maps, optional: `liveSurge`, `parking`, and `src`. Bundled static pins are `src: "static"`. A missing or unknown `src` means `live`. `tickets` is not read from `hotspots_test`. Android reads tickets from `pins` only.

`window_end` is the end of the pin's life on the mobile listener. See [Open questions](#open-questions).

### 0.2 `users/{uid}`

Client create and the allow-list on `b3084e7` are unchanged until PR-A. That PR adds `appVersion` ([answer 9](#9-usersuidappversion-is-refused-on-ios-main-and-the-web-rules-pr-allows-it)). `subscriptionExpiresAt` stays server-only. `subscriptionSource`, `playPurchaseTokenHash`, and `subscriptionProductId` are server-only too ([Play receipts](#20-play-subscription-receipts-web-be-10)). Missing `subscriptionSource` does not change Gold. Android's signup encoder sends `subscriptionExpiresAt` and `subscriptionSource` as null. Create allows each of those two keys when it is missing or null, and refuses any other value. WEB-BE-16, stacked on the rules PR, owns the canonical users-create allow-list and the full server-only field set. Merge order is that rules PR, then WEB-BE-16, then the Play receipt PR.

`config/appVersion` (the singleton, not the user field) stays get-able. Android's existing `AppUpdateService` reads `minimumVersion`, `blockedMessage`, `updateEnabled`, `latestVersion`, and `updateMessage`. Do not remove those. `config/activeBanner` is unchanged. Remote Config is unchanged. iOS keeps reading both config docs.

A profile `get()` that returns `PERMISSION_DENIED` signs the Android driver out. Do not tighten `users/{uid}` get for the owner.

### 0.3 `driverLocations/{uid}`

The mobile position is the source of truth. Clients still create and update only `location`, `locationUpdatedAt`, and `isOnline`. The sweep may set `isOnline` to false. It does not delete that field, does not write true, and does not change `location`.

| Field | Type | Who writes | Notes |
|---|---|---|---|
| `location` | GeoPoint | client | The position. Triggers and the sweep never rewrite it |
| `locationUpdatedAt` | timestamp | client | Freshness clock for the sweep and for density. A missing value is stale |
| `isOnline` | bool | client, and the sweep (false only) | |
| `geohash` | string, precision 7 | server | Derived from `location` by `onDriverLocationWritten` whenever `location` is a GeoPoint. Recomputed when the position changes. Left as-is when the write does not move `location` |

`geohash` is not on the client allow-list. Admin heat (`recentDriverHeat` in `functions/src/admin/stats.ts`) reads `geohash` and skips a doc whose `geohash` is missing or shorter than 7 characters. It does not read `location` for the heat map. The 5-character cell and 7-character bucket already used there are prefixes of this field. Until the trigger has run for a driver, that driver is absent from the heat map.

### 0.4 Request-doc envelope

Android's `RequestDocument` writes `status: "pending"` and `createdAt` = server timestamp, then listens. The server sets `done` or `error` and a human `error` string. Android shows that string as-is. The client timeout is **30 s and includes the write**. Account deletion on the web client still waits **60 s** and then shows "still processing" ([BACKEND-1](#16-backend-1)). Those are different screens.

---

## 1. `config/flags`

One `get()` per process launch. No listener. Keys are matched **case-insensitively**. Unknown keys are ignored.

### 1.1 Keys and defaults

When the doc is missing, the read fails, or the key or value is missing or unreadable:

| Key | Default | Who consults it |
|---|---|---|
| `surge` | **on** | Strips `liveSurge`. Also required for surge reports |
| `parking` | **on** | Street parking reads and the parking UI |
| `traffic` | off | Traffic line |
| `privateParking` | off | Private cells, monitor, sheet, paywall line, `privateNearby` |
| `tickets` | off | Ticket line. Off strips the layer, so a canceled event does not hide the pin |
| `insights` | off | Insights card, Plan forecast line, **and** the surge push handler |
| `payOrIgnore` | off | Android and iOS both check it before the pay card. See [answer 6](#6-no-surgepush-or-topics-flags) |
| `pinsV1` | off | Pins feed. Also requires the client reads switch |
| `surgeReports` | off | Report-surge gate. `surge` must be on as well |

Explicit false hides. Explicit true shows. This matches `26cb596` and the commissioning brief. The older plan line "all default off" does not.

Server job switches are different docs and default **off**: `config/liveSurge.enabled`, `config/parking.enabled`, `config/staleDrivers.enabled`, `config/privateParking.enabled`, `config/playSubscriptions.enabled`. They are not client-readable. `config/playSubscriptions` is the Play receipt switch ([section 20](#20-play-subscription-receipts-web-be-10)). It is not a key on `config/flags`. There is no `playBilling` flag.

### 1.2 Value shape, including `ios`

A value is either a bool (both platforms) or a map:

| Field | Type | Meaning |
|---|---|---|
| `enabled` | bool | Used when that platform has no override |
| `android` | bool, or `{enabled: bool, minVersion}` | Android override. **Wins over `enabled` in both directions** |
| `ios` | bool, or `{enabled: bool, minVersion}` | iOS override. Exact key `ios`. Same both-directions rule. Android never reads this key |
| `minVersion` | string or number | Dotted (`"1.3.1"`, `"2"`) or a number (`2`). Applies when the platform value does not carry its own |

Resolution for a platform `P` (`android` or `ios`):

1. Bare bool: that is the result for both platforms, then apply `minVersion` if it sits beside a map. A bare bool has no `minVersion`.
2. If `P` is a bool, that bool **replaces** `enabled` (true forces on, false forces off).
3. If `P` is a map and `enabled` is present on it, that bool replaces the layer `enabled`.
4. Otherwise use the layer `enabled`. If that is also absent, use the default table.
5. Minimum version: the platform map's `minVersion` if it is set, otherwise the layer `minVersion`. Blank or unreadable means no minimum. If the **app version** is unreadable, the minimum passes and the layer stays at the result of steps 2–4. If the app version is below the minimum, the layer is off.

`android: false` with `enabled: true` is off on Android. `ios: true` with `enabled: false` is on on iOS.

Rules: add `flags` and `categories` to the client `get` allow-list. Leave `appVersion` and `activeBanner` on it. `list` and `write` stay false. `get` of `config/liveSurge` stays denied.

---

## 2. `config/categories`

One `get()` per launch. Two shapes are both valid:

- `{ categories: [ {key, ...}, ... ] }`
- A map keyed by category: `{ sport: {label, ...} }`. A `key` inside the entry wins over the map key.

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes | Trimmed, compared lowercase |
| `label` | string | no | |
| `icon` | string | no | Asset token. The client maps a known token to an image. An unknown or missing token uses the default pin. It does not hide the category |
| `colour` or `color` | string | no | `#RRGGBB`, `RRGGBB`, or `#AARRGGBB` |
| `order` | number | no | Missing sorts last |
| `enabled` or `on` | bool | no | Default **true** when the key is listed. `false` hides that key only |
| `minVersion` | string or number | no | Same compare as flags |
| `timeRule` | number, or `{offsetMinutes}` or `{minutes}` | no | Minutes before `startAt` when the pin becomes visible. `{offsetMinutes}` and `{minutes}` are the same number. Absent or unreadable: no extra time filter, and the pin is not hidden |

Duplicate keys: the first entry wins.

| Doc | Client |
|---|---|
| Missing, empty, unreadable, or no usable entry | Bundled or hardcoded list. Hides nothing |
| A valid list | A listed key with `enabled`/`on` false, or that fails `minVersion`, is hidden. A category that is not in the list is not filtered out |

Android's bundled wire keys (14, not the plan's 12) are the same strings iOS uses:

`event`, `hotel`, `hospital`, `university`, `shopping`, `sport`, `pub`, `nightclub`, `boosted_train`, `flight`, `flight_disruption`, `tfl`, `egg`, `parking`.

The first seed should include all 14 so labels and icons are present. Leaving one out does not hide that category. `hotspots_test.category` is a different vocabulary and is not rewritten.

Ingest maps unknown source categories to `other` and holds them back from `pins`.

### iOS display names

Every wire key matches iOS. The display string is what iOS already shows.

| Wire key | iOS name |
|---|---|
| `event` | Event |
| `hotel` | Hotel |
| `hospital` | Hospital |
| `university` | University |
| `shopping` | Shopping |
| `sport` | Sport |
| `pub` | Pub |
| `nightclub` | Nightclub |
| `boosted_train` | Boosted Train |
| `flight` | Flights |
| `flight_disruption` | Flights Disruption |
| `tfl` | Transport Disruption |
| `egg` | Contribute |
| `parking` | Parking |

---

## 3. `pins/{pinId}`

Signed-in read, write false. **Approved.** The client keeps a cached listener on the driver's geohash-5 cell and its 8 neighbours (9 listeners). The set moves when the driver changes cell. Each listener is:

```
where g5 == <geohash5> AND window_end > now
orderBy window_end ASC
limit 500
```

`500` is a **per-tile** cap, not a cap on the whole map. Soonest-ending pins come first. `now` is fixed when the listener is created. Pins that pass `window_end` later are dropped on the device. There is no category filter and no paging. A result of exactly 500 is truncated: the client reports analytics event `pins_tile_truncated` with `tile` set to that `g5` and `count` 500, and does not request another page.

A map view wider than those 9 cells reads `pinTiles` summaries only. It does not run this query for cells outside the nine.

The query needs a composite index on `pins`: `g5` ASC, `window_end` ASC. That entry is added in the pins build PR (PR-H) to the indexes file in this repo, not in this docs change. See [Indexes](#indexes).

The publisher keeps each `g5` under 500 pins with `window_end > now`. If a tile would pass 500, it logs a warning and does not publish the extra pin into that cell. `g5` stays `geohash5(p)`. It is not rewritten to a shard id.

If any required field is missing or invalid, **the pin is dropped**.

| Field | Type | Required | Notes |
|---|---|---|---|
| `v` | number `1` | yes | |
| `category` | string | yes | Trimmed, lowercased. Wire keys in [section 2](#2-configcategories) |
| `title` | string | yes | Non-blank. This is not `hotspots_test.name` |
| `p` | GeoPoint | yes | Only a GeoPoint. Private places accept more shapes; pins do not |
| `startAt` | timestamp | yes | |
| `endAt` | timestamp | yes | Must be `≥ startAt`, otherwise the pin is dropped |
| `window_end` | timestamp | yes | The pin's lifetime on this query. Parking pins: [section 9](#9-tiers-the-clients-apply) |
| `g5` | string, length 5 | yes | Server-written. Equals `geohash5(p)`. Clients query this field. They do not write it |
| `pinId` | string | no | If non-blank, tiles join on this instead of the doc id |
| `subcategory`, `venueName`, `venueId`, `eventId` | string | no | |
| `endConf` | `"published"` or `"estimated"` | no | Stored, unused |
| `window_start` | timestamp | no | |
| `hasGold` | bool | no | Default false. Parsed, not a gate. Gold is StoreKit or `subscriptionExpiresAt` |
| `updatedAt` | timestamp | no | |
| `src` | `"static"` or `"live"` | no | Case-insensitive. Bundled static pins are `"static"`. Missing or unknown means `live` |
| `parking` | map | no | [Section 6](#6-street-parking) |
| `tickets` | map | no | [Section 12](#12-tickets) |

There is no `capacity` field and no `attendance` field. Demand stays `demand.expectedRiders` on `hotspots_test`. Insights use bands.

`expire_at` may be copied for the admin map. It is not what Android's pins reader requires.

Fallback (`pinsV1` on, and the client reads switch on): an exception from the pins listener, including `PERMISSION_DENIED`, or a **first** result that is empty, falls back to `hotspots_test` for that collection and stays there. A later empty snapshot does not. Stale data does not. `feed_fallback` is logged. The hotspots windowed query separately logs `windowed_empty`.

---

## 4. `pinTiles/{geohash5}`

Signed-in read, write false. One listener per doc: the driver's geohash-5 cell plus 8 neighbours (9), from the **cell centre** stepped by `180/4096°` latitude and `360/8192°` longitude. Longitude wraps. Near the poles there may be fewer than 9. Listeners move only when the driver changes cell.

| Field | Type | Required |
|---|---|---|
| `v` | number `1` | yes. Any other `v` ignores the tile |
| `shards` | number | no. [Shard rule](#53-shards) |
| `generatedAt` | timestamp | no |
| `pins` | map of `pinId` → `{liveSurge?, traffic?}` | no |

A non-map entry is skipped. A bad layer is null on its own. The tile has no tile-level `expiresAt`.

**Merge:** for each layer, the first doc that carries it wins, in order base, `_1`, `_2`, …. `liveSurge` on the base and `traffic` on a shard are both kept. Worst case is 9 cells × 9 docs = 81 listeners.

---

## 5. Shards

### 5.1 The rule

See [answer 4](#4-one-shard-rule). Pin-tile merge order is in [section 4](#4-pintilesgeohash5). Cell readers dedupe segments by `id` and places by `id` (else `name@p`).

A sibling is kept only when its id is `{base}_{n}` for an integer `n` from 1 to the base doc's `shards` (and at most 8), its `v` is 1, and any `expiresAt` it carries is in the future. A sibling that fails that check is dropped. The client caches the merged base and siblings until the earliest `expiresAt` among the docs and layers it kept (cell `expiresAt`, or `liveSurge.expiresAt` and `traffic.expiresAt` on a tile). A missing `expiresAt` does not extend the cache.

### 5.2 What Android does today

| Collection | At `26cb596` |
|---|---|
| `pinTiles` | Implements the rule (`n` clamped `0..8`, `_1.._n` inclusive) |
| `parkingCells` | Fetches `_1.._n` inclusive only when `n` is `2..8`. **`shards: 1` is ignored** |
| `privateParkingCells` | No shard reads |

### 5.3 Publisher until those readers match

- `pinTiles`: `shards` `1..8` is safe now.
- `parkingCells`: put the payload in the base doc, or set `shards` to `2..8`. Do not rely on `shards: 1`.
- `privateParkingCells`: leave `shards` absent until Android reads shards. Overflow that Android cannot see is a silent hole.

iOS implements the full rule on all three now.

---

## 6. Street parking

### 6.1 `liveSurge` is not parking

Recorded here so the level rule sits with the client. On `hotspots_test.liveSurge` and `pinTiles.pins.{pinId}.liveSurge`. **Every field is required:** `active` (bool), `level` (number), `since` (timestamp), `expiresAt` (timestamp), `v` (`1`).

The client rejects the layer unless `level` is finite and `≥ 1.0`, `expiresAt` is after `since`, and `v` is 1. **There is no client upper cap** (TPM-agreed): a level above 3 is shown as sent. Shown only while `active && expiresAt > now`, and removed within 60 s of expiry. Stripped when `flags.surge` is off.

The publisher **clamps writes to 1.0–3.0**. Approved. Hysteresis and diff-only writes stay as in BACKEND-3. Clients still accept a finite level at or above 1.0, so a value above 3 does not hide the layer. The server does not write one.

`computeLiveSurge` stays the BACKEND-3 job: every 5 minutes, `config/liveSurge.enabled` default off, supply from `driverDensity`, nested `expiresAt` only, `hotspots_test` and `pinTiles` both written until old builds retire. `pmf_testing` and `contributions` stay out of v1.

### 6.2 `parking` on the pin

Read from the `hotspots_test` or `pins` doc already in hand. No extra get.

Shown only when `v == 1`, nested `expiresAt` is present and in the future, and at least one spot has a position. At most 3 spots.

`{v, generatedAt, expiresAt, cell, spots[]}`. Spot fields are all optional:

| Field | Type | Notes |
|---|---|---|
| `p` | GeoPoint, or `{latitude\|lat, longitude\|lng}` | |
| `seg` | string | |
| `len` | number, metres | |
| `walkM` | int | |
| `bearing` | number | |
| `tl` | number[] | Below |
| `conf` | number | Outside `0..1` is ignored |
| `lastVerifiedAt` | timestamp | |
| `src` | string | `dtro`, `borough`, `tfl`, `inferred`, `mixed`. Anything else is unknown |
| `fee` | int | Pence per hour, `≥ 0` |
| `label` | string | |
| `who` | int | Bitmask below. `≤ 0` or missing means not stated |

### 6.3 `tl`

Flat quads `[startEpochMin, endEpochMin, stateCode, maxStayMin]`, UTC epoch minutes, start inclusive, end exclusive. A non-number rejects the whole `tl`. A trailing partial quad is ignored. A quad with `end ≤ start` is ignored.

`stateCode`: `0` unverified, `1` permitted, `2` time-restricted, `3` prohibited. Anything else reads as `0`. `maxStayMin ≤ 0` means none.

If `conf < 0.5`, there is no quad for now, or `tl` is missing, the spot is unverified and never permitted.

### 6.4 `k`, `side`, `who`

On segments (and `who` / `fee` on spots):

| `k` | Meaning |
|---|---|
| 0 | general (also any value outside 0..6) |
| 1 | bay |
| 2 | loading |
| 3 | taxi rank |
| 4 | no stopping |
| 5 | bus lane |
| 6 | permit |

| `side` | Meaning |
|---|---|
| 0 | unknown. **Unknown never alerts.** Anything other than 1 or 2 is unknown |
| 1 | left of the `geom` direction |
| 2 | right of the `geom` direction |

| Bit | Who |
|---|---|
| 1 | all |
| 2 | taxi |
| 4 | PHV |
| 8 | permit |
| 16 | goods |

The string kind list in BACKEND-4 §2.2 stays inside ingest. Clients decode these integers.

### 6.5 `parkingCells/{geohash6}`

Geohash 6. The 9 ids are the driver's cell plus neighbours taken from the **driver's position** ± `0.0054932°` latitude and ± `0.0109863°` longitude, then de-duplicated. Not the cell centre (that method is for pin tiles).

Query: `whereIn(documentId, chunk ≤ 10).get()`, 8 s timeout. No listener. No composite index.

Cache: 30 min, or until `expiresAt` if that is sooner. A missing doc **is** cached. A failed read is not. Only missing or stale cells are fetched.

Cell fields are optional. If `v` is present it must be 1, or the cell is unused. If `expiresAt` is present it must be in the future, or the cell is unused. Absent `v` or `expiresAt` does **not** hide a street cell. (Private cells are stricter.)

Segment: `geom` is required (encoded polyline, at least 2 points) or the segment is dropped. Also `id`, `k`, `tl`, `conf`, `lastVerifiedAt`, `src`, `label`, `side`, `fee` (pence per hour), `who`.

Flag `parking` off: no reads and nothing shown.

Stationary alert is client-side, Gold, real kerbs, inside the pilot rectangles (inclusive):

| Area | minLat, minLng, maxLat, maxLng |
|---|---|
| Camden | `51.528, -0.160, 51.555, -0.120` |
| City of London | `51.505, -0.115, 51.525, -0.070` |

Also: kerb `conf ≥ 0.7`, stop ≥ 150 s within 25 m, kerb within 12 m. These rectangles are not borough outlines.

**Pilot area: Camden plus the City of London. Approved.** `parking-ingest` uses that area. D-TRO production app **FerroMaps Parking** was approved on 28 Oct 2026. Key handover is still pending. The job does not call production until that key is in Secret Manager.

OGL attribution when the sheet is shown: `Contains public sector information licensed under the Open Government Licence v3.0`.

---

## 7. Private parking

Flag `privateParking` on, and Gold (`subscriptionExpiresAt` in the future). Rules: `isGold()` else read denied. Permission-denied is silent.

Same 9 geohash-6 ids and the same `whereIn` + 8 s query as street cells. Cache 6 h, or until `expiresAt`. The monitor may keep a further 10 min in memory. That is a client cache, not a server TTL.

### 7.1 Cell

`v == 1` and a future `expiresAt` are **required**, or the whole cell is hidden. `expiresAt` is `generatedAt + 7 days`. Also `cell`, `generatedAt`, `places`. `shards` follows [section 5](#5-shards); leave it absent until Android reads it.

### 7.2 Place

Every field except `p` may be null. A bad row drops alone. Dedupe by `id`, else `name@p`.

| Field | Type | Notes |
|---|---|---|
| `p` | `[lat, lng]`, GeoPoint, or `{lat\|latitude, lng\|longitude}` | Required. Out of range or `(0,0)` drops the row |
| `id` | string | Needed to enter, count down, report, or pay. Without it the row can still be shown |
| `n` | string | Name |
| `r` | int metres, `> 0` | The monitor clamps to `10..300`. No `r`: never entered |
| `s` | int `0..3` | Same codes as `tl` stateCode. Other values are unverified |
| `free` | int minutes, `≥ 0` | `0` or null: no free stay |
| `max` | int minutes, `≥ 0` | |
| `fee` | int pence, `≥ 0` | **Total** charge, not per hour. Omit unless the charge is clear |
| `aud` | string | [Answer 8](#8-walkm-src-capturedat-and-aud) |
| `auto` | bool, or number `1` = true | |
| `conf` | number `0..1` | |
| `q` | string | Only `known`, case-insensitive, is verified |
| `tl` | number[] | Same quads as street parking. Overrides `s` for "now" |
| `status` | string | Drop `closed`, `duplicate`, `not_open`, `not_yet_open` |
| `walkM` | int `≥ 0` | Nearby sheet. [Answer 8](#8-walkm-src-capturedat-and-aud) |
| `src` | string | Source label |
| `capturedAt` | timestamp | |
| `payMode` | `inapp`, `handoff`, `off` | Case-insensitive; `_` and `-` ignored. Missing or unknown means **handoff** |
| `operator` | string | Letters and digits only. Must match RingGo, PayByPhone, or JustPark, case-insensitive. Otherwise no pay offer |
| `locationCode` | string, or number `≥ 0` | Shown for the driver to type |

**Verified** means `q == known`, `s` is not unverified, and `aud` is known. Otherwise the row is "Unverified: check the signs", with no countdown and no pay.

**Countdown:** verified, `s == 1`, `free > 0`. Starts on entry. Reminders at 15 min and 5 min left, only those that fit in the free stay. If both are due at once, only the more urgent fires. None fires after the stay has ended. Exit is beyond `r + 25` m and cancels the countdown.

**Pay or Ignore** (Gold, one offer per visit, in memory only): `config/flags.payOrIgnore` is on, the row is verified, `s == 1`, `auto` is true, `fee > 0`, the state now from `tl` is permitted, `payMode` is not `off`, and the operator is known. Android and iOS both apply that flag check before showing the card. `inapp` is handed off while the in-app writer is off. There is no FerroMaps fee on hand-off.

Hand-off opens the operator's public site. No deep link and no prefill in v1:

| Operator | URL |
|---|---|
| RingGo | `https://www.ringgo.co.uk/` |
| PayByPhone | `https://www.paybyphone.co.uk/` |
| JustPark | `https://www.justpark.com/` |

The installed app opens only if it claims that link. The server does not send URLs.

### 7.3 `parkingReports/{reportId}`

`reportId` is a new client UUID on every tap. There is no automatic retry and no replay of the same id. No position and no pin id.

Client fields, plus the envelope `status` and `createdAt`:

| Field | Type | Required |
|---|---|---|
| `v` | int `1` | yes |
| `uid` | string | yes, equals auth uid |
| `placeId` | string | yes |
| `reason` | `cant_park`, `wrong_rules`, `closed`, `wrong_place` | yes |
| `reportedAt` | timestamp | yes |
| `platform` | `"android"` or `"ios"` | yes |
| `appVersion` | string, ≤ 32 | yes |

Rules: create if `isGold()`, allow-list those keys, `status == pending`, `createdAt == request.time`. Get: owner. Update and delete: false.

One report per uid per place per 30 days. The phone enforces that locally. The trigger also rejects a second `done` or `pending` report in that window with `error` / `duplicate-report`.

**Two distinct uids** with `status: "done"` for the same `placeId` hide the place. The trigger writes server-only `privateParkingModeration/{placeId}` `{hidden: true, reportCount, updatedAt}`. The publisher omits hidden ids. A duplicate from the same uid does not increment the count.

Errors: `status: "error"` always includes `error` and `errorCode`. The client shows `error`. Any other failure is unavailable. The driver may tap again, which creates a new id. The one-per-30-days rule still applies.

Trigger `onParkingReport` is idempotent on `reportId`.

Indexes (iOS `firestore.indexes.json`): `uid + placeId + reportedAt`, and `placeId + reportedAt`.

---

## 8. `pinGold/{pinId}`

`isGold()` read, write false. One `get` by pin id, 8 s timeout. Any failure is null. Android currently issues a separate get per section (nearby and insights on each sheet open, forecast once per Gold Plan sport slot) and does not cache. Recommendation [N23](#decisions-for-nafiu): that is a client change; iOS should read the doc once per open and share it. No extra server field.

### 8.1 `privateNearby`

`{v, expiresAt, places[]}`. Places use the private-place shape plus `walkM`, `src`, and `capturedAt`. Shown when `v == 1`, `expiresAt > now`, and at least one place remains. At most 3. Gate: `flags.privateParking` and Gold.

The client shows a legal street spot from `parking` first when that spot is verified (`conf ≥ 0.5`), then these places.

### 8.2 `insights`

Pilot category `sport` only, and not an instant category (`egg`, `parking`, `contribute`). Gate: Gold and `flags.insights`.

| Field | Type | Notes |
|---|---|---|
| `v` | number `1` | Required |
| `expiresAt` | timestamp | Required, in the future |
| `arriveBy` | timestamp | |
| `crowdOut` | `{start, end}` timestamps | Both dropped if `end < start` |
| `demandBand`, `upliftBand` | `low`, `medium`, `high` | Strings, not ints |
| `conf` | number `0..1` | Outside that range is ignored. Display: `< 0.4` Low, `< 0.7` Medium, otherwise High. `0.4` is Medium. `0.7` is High |
| `waitAt` | `{p: GeoPoint, seg: string, walkM: int 0..1000}` | |
| `why` | string | ≤ 120 characters after whitespace collapse. The server drops the field when it is longer, when it contains the literal `/hr`, or when it matches Android's filter, case-insensitive: `[£$€]\|\b(gbp\|quid\|fare\|fares\|earn\|earning\|earnings\|per hour\|/hr\|uber\|bolt)\b` |
| `src` | string array | Known: `tm`, `tfl`, `history`, `grok` |
| `generatedAt` | timestamp | |

The Android `why` pattern, copied verbatim, is `[£$€]|\b(gbp|quid|fare|fares|earn|earning|earnings|per hour|/hr|uber|bolt)\b`. It is case-insensitive. The publisher also drops `why` when the string contains the characters `/hr`, because a word boundary does not match before `/`.

Do not require a `model` field. Android does not read it.

The card is shown when at least one of `arriveBy`, `crowdOut.start`, a band, `waitAt.walkM`, or `why` is present.

### 8.3 `surgeForecast`

`{v, startAt, endAt, peakBand, conf}`. `v`, `startAt`, and `endAt` are required. No `expiresAt`. Used while `endAt > now`. The window is **at most 6 h** (`endAt - startAt <= 6 h`). `peakBand` is `low`, `medium`, or `high`. `conf` is `0..1`.

---

## 9. Tiers the clients apply

Parking pins (`category == parking`) are Cold unless they are surging. **Approved:** the publisher sets `window_end` to now + 24 h and refreshes it daily, well before that instant, so the pin stays inside `window_end > now` and is not the first row the 500 cap drops. The iOS client exemption stays: a parking pin is not hidden when `window_end` passes. The daily refresh is what keeps it on the listener. Egg pins expire on their own expiry and are tiered normally. `hideExpiredLayers` runs on every pin, including parking and egg, and does not hide the parking pin itself.

Instant categories `egg`, `parking`, and `contribute` get no insights, no traffic line, no surge report, and no street-parking section on the sheet. The surge-report trigger rejects those categories with `not-reportable` when it can resolve `pinId`.

---

## 10. Driver surge reports

`surgeReports/{reportId}`. `reportId` is a client UUID, reused on every retry of that attempt. Consent lives on the device only (`CONSENT_VERSION = 1`). There is no consent document. Withdrawing consent deletes unsent reports locally. Submitted reports have no location and stay until the sweep.

### 10.1 Body

Exactly these client keys, plus `status: "pending"` and `createdAt` (server timestamp):

| Field | Type | Required |
|---|---|---|
| `v` | int `1` | yes |
| `uid` | string | yes |
| `pinId` | string | yes |
| `band` | `low`, `medium`, `high` | yes. Never a number |
| `reportedAt` | timestamp | yes. Not required to equal `request.time` |
| `platform` | `"android"` or `"ios"` | yes |
| `appVersion` | string ≤ 32 | yes |

No price, fare, multiplier, or position. `hasOnly` that list. Create: owner, `status == pending`, `createdAt == request.time`. Get: owner. Delete: false.

**Replay while still `pending`.** Android retries with `set()`, and each retry sends a fresh `serverTimestamp()` for `createdAt`. The update is allowed only when `status` is still `pending`, `uid`, `pinId`, and `band` are unchanged, and the other client fields stay inside the create allow-list. `createdAt` must equal `request.time` on that replay, so it is allowed to change. Once the server has set `done` or `error`, the update is denied.

Android uses `set()`, so a refused retry is `PERMISSION_DENIED`. It is never `ALREADY_EXISTS`. After `PERMISSION_DENIED` the client `get()`s the same id ([section 10.3](#103-what-is-permanent)).

The rules tests in PR-A cover this: a pending replay with a new `createdAt` succeeds; a replay that changes `pinId` or `band` fails; an update after `done` or `error` fails; a denied `set()` is asserted as `PERMISSION_DENIED`, not `ALREADY_EXISTS`.

One **done** report per uid per pin per 20 minutes. An `error` does not consume the slot. The phone also enforces the 20 minutes. Categories `egg`, `parking`, and `contribute` are not reportable. The button needs `flags.surge`, `flags.surgeReports`, and a writer.

### 10.2 Trigger

`onSurgeReport`, `onDocumentCreated`, idempotent on `reportId`:

- If `status` is already `done` or `error`, return.
- Validate. Failures write `status: "error"` with both `error` and `errorCode` set, and do not count as a report.
- A `done` report for the same uid and pinId with `reportedAt` inside 20 minutes writes `rate-limited`.
- `flags.surgeReports` off for that platform writes `flag-off`.
- No distance check. No read of `driverLocations` for this.

Feeding `done` reports into `computeLiveSurge` is a later change. v1 only stores a valid report.

### 10.3 Permanent errors

One table. Android's `set()` never surfaces `ALREADY_EXISTS` for this write. After `PERMISSION_DENIED`, `get()` the same id.

| Outcome | Permanent | What the client does |
|---|---|---|
| `status: "error"` with `errorCode` `invalid-payload`, `invalid-band`, `invalid-pin`, `not-reportable`, `rate-limited`, `flag-off`, or `timeout` | yes | `error` and `errorCode` are both set. Show `error`. Free the 20-minute slot. Do not retry that id |
| SDK `INVALID_ARGUMENT` or `FAILED_PRECONDITION` | yes | Do not retry |
| `PERMISSION_DENIED` and `get()` finds no doc | yes | Do not retry |
| `PERMISSION_DENIED` and `get()` finds the doc | no | Follow `done`, `error`, or `pending` |
| `status: "done"` | no | Success |
| `status` still `pending` | no | Keep listening. Do not open a second id |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `ABORTED`, the 30 s client timeout, or another network failure | no | Retry at 30 s, 1 min, 2 min, then every 5 min. Drop the unsent report after 20 min |

Android at `1934034` still retries every Firestore error, including `PERMISSION_DENIED`, until 20 min. iOS implements the table above, including `get()` after `PERMISSION_DENIED`. The pending replay rule is what lets a retry `set()` replace `createdAt` instead of being denied. Android adopts the `get()` before `FIRESTORE_WRITES` is turned on.

Index: `uid + pinId + reportedAt`.

Terminal retention is 24 h via `sweepRequestDocuments`, including a stale `pending` → `error` / `timeout` after 1 h with no live lease. A sweep `timeout` is permanent for auto-retry. The driver may tap again (new UUID).

---

## 11. Push

Data message only. Routed on `data["type"]`. All values are strings.

Topic: `surge_<geohash5>` (lowercase), the driver's geohash-5 cell plus 8 neighbours, Gold only. Free drivers subscribe to none. No `topics` flag ([answer 6](#6-no-surgepush-or-topics-flags)).

| Key | Required | Rule |
|---|---|---|
| `type` | yes | `surge_forecast` |
| `v` | yes | `1` |
| `pinId` | yes | `^[A-Za-z0-9_\-:.]{1,128}$` |
| `lat`, `lng` (or `lon`) | yes | Decimals, in range, not `0,0` |
| `startAt`, `endAt` | yes | Epoch milliseconds or ISO-8601. End after start. The window is at most 6 h |
| `category` | yes | Must be `sport`. Any other value, or a missing `category`, is dropped |
| `name` | no | ≤ 60 characters. Drop the message if it matches `[£$€]` or `fare`, `fares`, `earn`, `earnings`, `uber`, `bolt` |
| `peakBand` | no | `low`, `medium`, `high` |
| `area` | no | Geohash charset, length 4..7. The phone does not use it for the decision |

**Approved.** Both platforms subscribe to the same `surge_<g5>` topics. The payload then splits:

| Platform | What is sent | Who checks the forecast |
|---|---|---|
| Android | Data message only. No notification block | The phone: `flags.insights`, Gold, online, fix ≤ 10 min, reachable by `startAt + 10 min` and before `endAt`, one alert per `pinId\|startAt` |
| iOS | The same data keys, plus an `apns` override | The server, before it sends |

The iOS `apns` payload is:

```
apns.payload.aps.alert          title and body, no currency
apns.payload.aps.sound          the Ferro button sound
apns.payload.aps.interruption-level   time-sensitive
```

There is no top-level `notification` key, so Android does not show a system alert from this message. The server sends the iOS alert only when that token passes the same checks the phone would have run. One alert per `pinId|startAt`. The data keys on both platforms are the table above.

Channel and notification ids for alerts the phone raises itself stay client-local (surge channel `surge_alerts_v2`, id ranges 200000+ surge, 300000+ forecast, 90000+ outcome prompts). The server does not allocate those ids.

---

## 12. Tickets

On `pins` only. `{v, status, onSaleAt, priceBand, src, conf, generatedAt, expiresAt}`.

Shown when `v == 1` and `expiresAt > now`. Otherwise only the ticket line hides.

| Field | Type | Notes |
|---|---|---|
| `status` | string | Server writes `onsale`, `offsale`, `canceled`, `postponed`, `rescheduled`. The client matches letters only, so `on_sale` and `ONSALE` match, and `cancelled` matches `canceled`. Anything else: no line |
| `onSaleAt` | timestamp | Optional |
| `priceBand` | int `1..3` | Optional. Not a string. Other ints: hide the band, keep the status |
| `src` | string | `tm` or absent: show as Ticketmaster. Any other value: hide the line |
| `conf` | number `0..1` | |
| `generatedAt` | timestamp | Optional. "Updated N h ago" |
| `expiresAt` | timestamp | Required for the line to show |
| `v` | number `1` | |

A showable `canceled` hides the **pin** only while `flags.tickets` is on. Flag off strips the layer and leaves the pin. **Ticketmaster stays off. There is no outreach.** `tickets-enrich` is not run, and `config/flags.tickets` stays off. Clients do not cache ticket fields past `expiresAt`. Layer TTL about 24 h if a later ruling turns the job on.

---

## 13. Traffic

On `pinTiles` `pins.{pinId}.traffic`.

| Field | Type | Notes |
|---|---|---|
| `v` | number `1` | Required |
| `expiresAt` | timestamp | Required |
| `level` | int `0..3` | Out of range dropped on its own, not the whole layer |
| `delayMin` | int `0..240` | Same |
| `closures` | int `0..50` | Same |
| `src` | string | The line is drawn for `tfl` or a **missing** `src`. Any other `src`: draw nothing |
| `conf` | number `0..1` | |
| `generatedAt` | timestamp | Optional. If set, the client also hides the line 30 min after it |

Hidden at `expiresAt`, or 30 min after `generatedAt` when that field is set. No "all clear" line: level 0 with no delay and no closure draws nothing. Flag `traffic`. The app never calls TfL. v1 is TfL only. Set `expiresAt = generatedAt + 30 min`.

---

## 14. In-app pay

### 14.1 `places/{placeId}` (server only)

Client read and write stay denied. The trigger reads the price here. The place id matches `privateParkingCells` `places[].id`.

| Field | Type | Notes |
|---|---|---|
| `payMode` | `handoff` or `inapp` | Absent means handoff. `off` is a cell value and is not stored here. The trigger accepts only `inapp` |
| `operator` | string | |
| `locationCode` | string | |
| `parkingPence` | int | Total operator charge for the stay |
| `feePence` | int | FerroMaps fee, total pence |
| `connectedAccountId` | string | Server only. `transfer_data.destination`. Never returned to the client |

No client write can set those fields. The charge is a destination charge: `transfer_data.amount` is `parkingPence`, and FerroMaps carries the Stripe processing fee.

### 14.2 `parkingPaymentRequests/{id}`

Client id, stable for that attempt. Create:

| Field | Type | Required |
|---|---|---|
| `v` | int `1` | yes |
| `action` | `"create"` | yes |
| `placeId` | string | yes |
| `visitId` | string | yes. Client UUID per visit. One PaymentIntent per visit |
| `operator` | string | yes |
| `plate` | string | yes. [Answer 2](#2-the-number-plate-does-go-to-the-server) |
| `platform` | string | yes |
| `appVersion` | string | yes |
| `status` | `pending` | yes |
| `createdAt` | timestamp | yes, `request.time` |

No price, fee, amount, or currency. Rules: create if `isGold()` and the allow-list matches. Get: owner. Update and delete: false.

Trigger `onParkingPaymentRequest` on `action: "create"`: if this `visitId` already has a PaymentIntent, write that result again and return. Otherwise price from `places`, create a GBP PaymentIntent as a destination charge (`transfer_data.destination` = `places.connectedAccountId`, `transfer_data.amount` = `parkingPence`), and store metadata `uid`, `placeId`, `visitId`. On success it creates `parkingPayments/{paymentId}` with `status: "created"` and sets the request to `status: "done"` with:

| Field | Type | Required |
|---|---|---|
| `paymentIntentClientSecret` | string | yes |
| `ephemeralKey` | string | yes when `customerId` is set |
| `customerId` | string | no |
| `publishableKey` | string | no. Null or absent: the app uses its built-in test key |
| `amount` | int pence | yes. `parkingPence + feePence` |
| `currency` | `gbp` | yes |
| `paymentId` | string | yes. `parkingPayments` id |
| `parkingPence` | int | yes |
| `feePence` | int | yes |
| `paymentIntentId` | string | yes. The client copies this onto the confirm request. It is not a connected-account id |

On failure, `status: "error"` and both `error` (human text) and `errorCode` are set:

| `errorCode` | When | Client copy |
|---|---|---|
| `permission-denied` | not Gold | "not available here" |
| `failed-precondition` | operator not set up, or `payMode` is not `inapp` | "not available here" |
| `not-found` | unknown place | "not available here" |
| `invalid-argument` | bad plate, ids, or operator | "not available here" |
| `unavailable`, `deadline-exceeded`, `internal` | Stripe or trigger failure | fall back to hand-off |

Android falls back to hand-off on **every** failure. Nothing is retried automatically.

### 14.3 Confirm request

**Approved.** After PaymentSheet completes, the client creates a new doc. The id is `{paymentId}_confirm`. It is not an update of the create request.

| Field | Type | Required | Rule |
|---|---|---|---|
| `v` | int `1` | yes | |
| `action` | `"confirm"` | yes | |
| `status` | `"pending"` | yes | |
| `createdAt` | timestamp | yes | `request.time` |
| `uid` | string | yes | `request.auth.uid` |
| `paymentId` | string | yes | Equals the doc id with `_confirm` removed |
| `paymentIntentId` | string, 1..255 | yes | Equals `paymentIntentId` on `parkingPayments/{paymentId}` |
| `originalRequestId` | string, 1..128 | yes | The create request. Owner, `action: "create"`, `status: "done"` |

Allow-list is exactly those keys. Create if `isGold()` and the payment doc's `uid` is the caller. Get: owner. Update and delete: false.

`onParkingPaymentRequest` calls `paymentIntents.retrieve`. It writes `parkingPayments/{paymentId}` again. A repeat for the same `paymentIntentId` does not create a second payment and does not register the plate again. The PaymentSheet result is not a status.

Status only moves forward: `created` → `processing` → `paid`, or from `created` / `processing` to `failed`, `canceled`, or `refund_pending`, then `refund_pending` → `refunded`. A retrieve that would move backward is ignored. The plate is registered on the first transition into `processing` and not again. The server records that with `plateRegisteredAt` on the payment doc and does not copy the plate onto it.

### 14.4 `parkingPayments/{paymentId}`

The client listens to this one doc. "Paid" comes from here, not from PaymentSheet. Owner read (`uid == auth.uid`). No client writes.

| Field | Type | Notes |
|---|---|---|
| `v` | int `1` | |
| `status` | string | `created` → `processing` → `paid` or `failed` or `refund_pending` or `refunded` or `canceled`. Only the server writes this, from `paymentIntents.retrieve` or the reconciler |
| `amount` | int pence | |
| `currency` | `gbp` | |
| `placeId` | string | |
| `visitId` | string | |
| `operator` | string | |
| `uid` | string | |
| `createdAt`, `updatedAt` | timestamp | |
| `failureReason` | string | Human text, shown as-is. Null when there is none |
| `paymentIntentId` | string | Receipts and refunds |

No card data. No plate.

If the screen is still open and status is not `paid` or `failed` after 2 min, the client shows "still confirming" and keeps listening. `failed` shows `failureReason` and offers hand-off. The client does not infer `paid` from PaymentSheet.

### 14.5 Reconciler

`reconcileParkingPayments`, every 5 minutes, `europe-west2`, secret `STRIPE_SECRET_KEY` only.

- Loads `parkingPayments` still in `created` or `processing` whose `updatedAt` is older than 2 minutes, calls `paymentIntents.retrieve` for each, and writes the status. Idempotent on `paymentIntentId`.
- Refunds and disputes: `events.list` for `charge.refunded`, `refund.updated`, `charge.dispute.created`, and `charge.dispute.closed`. The cursor is the server-only doc `stripeSync/cursor`:

| Field | Type | Notes |
|---|---|---|
| `lastEventCreated` | int | Unix seconds from the newest Stripe event fully applied. The next call uses `created[gte]` of this value |
| `lastEventId` | string | Tie-break when several events share that second. An event id already applied is a no-op |
| `updatedAt` | timestamp | |

Rules: `stripeSync/{doc}` read and write false. The reconciler advances the cursor only after the page has been applied. Replaying an event writes the same `parkingPayments` status again.

---

## 15. Gold rule

```
function isGold() {
  return request.auth != null
      && get(/databases/$(database)/documents/users/$(request.auth.uid))
           .data.subscriptionExpiresAt > request.time;
}
```

Used for `pinGold`, `privateParkingCells`, `parkingReports` create, and `parkingPaymentRequests` create. Missing or non-timestamp `subscriptionExpiresAt` is not Gold on the server.

The client treats the driver as Gold when StoreKit has an active entitlement **or** `subscriptionExpiresAt` is in the future on the device clock. Rules cannot see StoreKit, so a purchase that has not yet been written to `subscriptionExpiresAt` fails `isGold()`. That denial is catching up: the client hides the Gold-only data, does not sign the driver out, and does not show an error. The read is tried again when the user document changes. A `PERMISSION_DENIED` on the profile `get()` is still a sign-out. A `PERMISSION_DENIED` on `pinGold` or `privateParkingCells` is not.

`isGold()` is not changed by Play. A verified Play subscription unlocks Gold on every platform by writing this same timestamp. The Play path is [section 20](#20-play-subscription-receipts-web-be-10). It does not run unless `config/playSubscriptions.enabled` is true.

---

## 16. BACKEND-1

Unchanged design, iOS `mobile`. `accountDeletionRequests/{uid}`: client creates `{status: pending, createdAt: request.time}`. Server `errorCode`: `data-cleanup-failed`, `auth-delete-failed`, `timeout`, `done-repaired-by-sweep`. `error` is the only user-visible string. Owner may reset `error` → `pending` by deleting `error`, `errorCode`, and `completedAt`.

`onAccountDeletionRequest`: 300 s, 512 MiB, `retry: false`, Auth delete before `done`. Web waits 60 s then "still processing".

`sweepRequestDocuments`: hourly. Stale `pending` uses `updateTime`, 60 min, skip a live lease. `deviceSessionRequests` is not expired. Deletion `done` docs are kept for **24 months** from `completedAt`, then deleted. The kept fields are `status`, `createdAt`, `completedAt`, and `errorCode` (uid is the doc id). Approved. Deletion `error`: 7 days. Other terminal request docs, including surge reports, parking reports, and `playPurchaseRequests`: 24 h. The Play trigger has already deleted `purchaseToken` before that sweep.

Hard rollout: rules live, IOS-5 in the App Store, trigger, 24 h, then the sweep.

---

## 17. BACKEND-2

Approved by the lead TPM. A driver is stale after 10 minutes without a `locationUpdatedAt`. The behaviour follows BACKEND-3 rulings 6 and 8.

`sweepStaleDrivers`, every 5 minutes, own constant `DRIVER_STALE_MS = 10 * 60 * 1000`. A timestamp exactly 10 minutes old is still fresh (`locationUpdatedAt >= now - DRIVER_STALE_MS`). A missing `locationUpdatedAt` is stale. `config/staleDrivers.enabled` missing or not true: return. Not client-readable.

One transaction per driver reads `driverLocations/{uid}` and `users/{uid}`. If either `locationUpdatedAt` is fresh, write nothing. Otherwise set `isOnline: false` on each doc that is not already false. Never delete the field. Never write true. Never write `location`, `geohash`, or `lastActiveAt`.

The clock is `locationUpdatedAt` on both documents. iOS heartbeats about every 4–5 minutes and ignores a server flip. The next client write sets `isOnline` true again.

---

## 18. Telemetry the app already sends

Firebase Analytics, release builds, no ids and no locations. The server does not emit these.

`firestore_reads` on background. Parameters:

| Parameter | Values |
|---|---|
| `feed` | `hotspots_test`, `pins_v1`, `pins_v1_only` |
| `reads_total`, `reads_per_hour`, `minutes` | numbers |
| `over_budget` | `0` or `1`. Budgets: 5,000/h on `hotspots_test`, 1,000/h on pins v1 |
| `reads_hotspots_test`, `reads_pmf_testing`, `reads_contributions`, `reads_pins`, `reads_pin_tiles`, `reads_parking_cells`, `reads_private_parking_cells`, `reads_pin_gold`, `reads_other` | counts. Cache snapshots count 0. The first server snapshot counts max(1, docs). Each later changed doc counts 1. A tile doc counts 1 per server snapshot |

`pins_tile_truncated`: `tile` (the `g5`) and `count` 500. Sent when a tile listener returns exactly 500 docs.

`feed_fallback`: `feed`, `reason` `windowed_empty`, `empty`, or `error`.

### New reads

These are the reads the pin platform adds. Today's drivers read `hotspots_test` and `users/{uid}` only.

| Read | When |
|---|---|
| `config/flags`, `config/categories` | one `get` each, per launch |
| `pins` where `g5` and `window_end`, limit 500 | cached listener, 9 cells |
| `pinTiles/{g5}` and shard siblings | listener, same 9 cells. Wider map views read these summaries and do not query `pins` |
| `parkingCells` by id | `get` of 9 cells, cached until the earliest `expiresAt` |
| `privateParkingCells` by id | same, Gold only |
| `pinGold/{pinId}` | Gold only |
| `parkingPayments/{paymentId}` | one listener while a payment is in flight |
| `parkingPaymentRequests/{id}` and `{paymentId}_confirm` | listener on the doc the client created |
| `playPurchaseRequests/{id}` | listener on the doc the client created. Gold itself is still `users/{uid}.subscriptionExpiresAt` |
| `surgeReports/{id}`, `parkingReports/{id}` | listener on the doc the client created |

These stay on the device and are not Firestore documents: surge-report consent, the 30-day place-report clock, one Pay-or-Ignore offer per visit (memory only), surge-push dedupe, and the set of subscribed `surge_<geohash5>` topics.

---

## 19. Code-versus-plan items, and the contract's answer

| # | Android difference | Contract |
|---|---|---|
| 1 | `surge` and `parking` default on | Locked. Plan "all off" is withdrawn |
| 2 | `payOrIgnore` unused at `26cb596`; push uses `insights` | Both clients check `payOrIgnore` before the pay card. Push stays on `insights`. No topics flag |
| 3 | 14 wire keys, not 12 | Locked. iOS display names match those keys |
| 4 | Three shard behaviours | One rule, [answer 4](#4-one-shard-rule), with publisher limits |
| 5 | `liveSurge.level` has no client cap | Client accepts `≥ 1`. Server clamp at 3.0 is approved |
| 6 | `priceBand` int vs string bands | [Answer 7](#7-shape-mismatches-settled) |
| 7 | `generatedAt` on tickets and traffic | Included, optional |
| 8 | `surgeForecast` has no `expiresAt` | Locked. Clock is `endAt` |
| 9 | Insights `model` is not read | Do not require it |
| 10 | `walkM`, `src`, `capturedAt`, `permit`, fee units | [Answers 7 and 8](#7-shape-mismatches-settled) |
| 11 | Pin `p` is GeoPoint only; private `p` is flexible | Locked per collection |
| 12 | The pins listener is capped | Per tile: `g5` + `window_end`, nine cached listeners, 500 docs. Wider views read `pinTiles` only |
| 13 | Callable vs request doc | Request doc. [Answer 1](#1-in-app-pay-is-a-request-document-not-a-callable) |

---

## 20. Play subscription receipts (WEB-BE-10)

One Play subscription unlocks Gold on every platform by writing `users/{uid}.subscriptionExpiresAt`, the same field StoreKit writes. `isGold()` is unchanged. Rules still see only that timestamp. There is no callable: Domain Restricted Sharing blocks `allUsers` on `roles/run.invoker`, same as [answer 1](#1-in-app-pay-is-a-request-document-not-a-callable). The client writes a request doc and listens.

The server switch is `config/playSubscriptions.enabled` exactly true. Missing doc, missing field, or any other value is off. The server is turned on first. Android does not read that document, and `config/flags` does not grow a Play key. There is no `playBilling` flag.

`onConfigRequest`, when it sets the request to `done`, writes `playSubscriptionsEnabled` on that response. The boolean is `config/playSubscriptions.enabled === true`. The same write is merged onto `config/appVersion`, which Android already gets. Missing or false means the purchase UI stays hidden. Android shows the purchase UI only when `playSubscriptionsEnabled` is true.

While the server switch is off, a `playPurchaseRequests` create is left `pending`. `purchaseToken` stays on the doc. The trigger does not call Play, does not acknowledge, does not delete the token, and does not write `status: "error"`. An existing Gold expiry stays as it is. After the switch is on, `reconcilePlaySubscriptions` processes those pending docs. A new create is handled at once by the trigger.

| Field | Type | Notes |
|---|---|---|
| `enabled` | bool | Default off. Only `true` runs verification. Turned on before clients are told to sell |
| `packageName` | string | Android application id. The request's `packageName` must equal it |
| `productIds` | string array | Placeholder `["ferro_gold"]`. See [the open product decision](#open-decision-product-id-base-plans-and-price) |
| `basePlans` | string array | Placeholder `["monthly", "annual"]`. Not created in Play Console by this change |

### Open decision: product id, base plans, and price

Placeholders only. This change creates nothing in Play Console.

| | Placeholder |
|---|---|
| Product id | `ferro_gold` |
| Base plans | `monthly`, `annual` |
| Prices | not set |

Nafiu's yes is required before the product, the base plans, or any price exists in Play Console. Until that yes, `productIds` and `basePlans` are names in this contract and in `config/playSubscriptions`, not live products.

### 20.1 `playPurchaseRequests/{id}`

`id` is a new client UUID for that attempt. It is not the uid. Apple stays on `subscriptionRequests/{uid}`. This collection does not replace that one.

Create, allow-list exactly these keys:

| Field | Type | Required | Rule |
|---|---|---|---|
| `v` | int `1` | yes | |
| `uid` | string | yes | `request.auth.uid` |
| `purchaseToken` | string, 1..4096 | yes | The Play token. The trigger deletes it |
| `productId` | string, 1..128 | yes | Must be one of `productIds`. Placeholder `ferro_gold` |
| `packageName` | string, 1..256 | yes | Must equal `packageName` on the config doc |
| `platform` | `"android"` | yes | iOS does not write this collection |
| `appVersion` | string, 1..32 | yes | Same cap as the user field |
| `status` | `"pending"` | yes | |
| `createdAt` | timestamp | yes | `request.time` |

Rules: create if signed in, the allow-list matches, and the checks above hold. Get: owner (`uid == auth.uid`). List, update, and delete: false. A retry is a new id. A second `set()` of the same id is `PERMISSION_DENIED`, then `get()` the same id.

Server fields, written once when the request leaves `pending`:

| Field | Type | When |
|---|---|---|
| `status` | `done` or `error` | always |
| `error` | string | `error` only. Shown as-is |
| `errorCode` | string | `error` only |
| `expiresAt` | timestamp | Play line expiry when Play returned one. On `done` this is the period end. It is not a second Gold clock |
| `purchaseTokenHash` | string | SHA-256 hex of the token. Replaces `purchaseToken` |
| `subscriptionState` | string | `active`, `grace`, `canceled`, `on_hold`, `paused`, `expired`, `pending`, `refunded` |
| `updatedAt` | timestamp | |

`purchaseToken` is deleted only when the request leaves `pending`. A request left `pending` because the server switch is off keeps the token.

Trigger `onPlayPurchaseRequest`, `onDocumentCreated`, `europe-west2`, codebase `default`, `retry: false`. If `status` is already `done` or `error`, return. Status only moves forward: `pending` → `done`, or `pending` → `error`. The off switch is not one of those moves.

The client never acknowledges. The server does. On every launch Android calls `queryPurchasesAsync` and creates a new `playPurchaseRequests` doc for each purchase token that is still unacknowledged. That resubmit uses the same token. The hash makes it the same grant ([section 20.3](#203-idempotency)).

On `done` the purchase is entitled. Entitled Play states are `SUBSCRIPTION_STATE_ACTIVE`, `SUBSCRIPTION_STATE_IN_GRACE_PERIOD`, and `SUBSCRIPTION_STATE_CANCELED` while `lineItems` expiry for that `productId` is still in the future. A user cancel keeps Gold until that expiry. The trigger reads `purchases.subscriptionsv2.get` and, when `acknowledgementState` is `ACKNOWLEDGEMENT_STATE_PENDING`, the product matched, and the account hash matched, calls `purchases.subscriptions.acknowledge` with that `productId`. Already acknowledged is success. A 5xx on acknowledge still grants, and the reconciler retries the acknowledge. A 400 that is not already-acknowledged does not grant.

The client sets Play's obfuscated account id to the SHA-256 hex of `uid` (UTF-8, lowercase hex) at purchase time. The server computes the same hash and requires `externalAccountIdentifiers.obfuscatedExternalAccountId` to match. A missing or different value is `account-mismatch`, permanent, and is not acknowledged.

License-test purchases (`testPurchase` on the Play resource) are accepted. The flag is still required.

### 20.2 What is written on `users/{uid}`

| Field | Type | Who |
|---|---|---|
| `subscriptionExpiresAt` | timestamp | server. The Gold clock. Same field as StoreKit |
| `subscriptionSource` | `play`, `appstore`, or another short string | server. Play writes `play` only when it moves the clock |
| `playPurchaseTokenHash` | string | server. The hash that owns the Play grant. Not the raw token |
| `subscriptionProductId` | string | server. The Play product id when Play owns the clock |

None of these are in `clientOwnedUserKeys()`. Update refuses them because they are outside the allow-list. Create allows `subscriptionExpiresAt` and `subscriptionSource` only when the key is missing or null, because Android signup sends null. Any other value is refused. WEB-BE-16 owns the canonical create allow-list. This contract does not replace that list.

The clock only moves forward when Play's expiry is later than the current `subscriptionExpiresAt`. A later Play period extends Gold and sets `subscriptionSource` to `play`. An App Store expiry that is already later is left alone, including its source. Play does not shorten that clock.

Gold is never removed without a live `purchases.subscriptionsv2.get`. A stored `expiresAt` that has passed is not itself a downgrade. At or after that expiry the reconciler calls `subscriptionsv2.get` before it writes an earlier clock. It downgrades only when that read shows the subscription is not active, or is in account hold, or is paused, and only when `subscriptionSource` is `play` and `playPurchaseTokenHash` is this token's hash. Account hold and pause end Gold now (Play's hold expiry is already in the past; a pause can still show a future line expiry, and that future value is not written onto the user). A refund does the same, and only after that same live read. A Play API error does not downgrade: `subscriptionExpiresAt` is left as it was. If the hash does not match, or the source is `appstore`, the user document is not pulled back.

One clock. If Play had extended past an App Store expiry and Play is then refunded, the older App Store instant is not restored here. The StoreKit writer sets `subscriptionSource` to `appstore` the next time it writes the clock. This contract does not change that writer.

### 20.3 Idempotency

The idempotency key is `SHA-256` of the raw `purchaseToken`, hex, UTF-8, no trimming that changes the token. The ledger id is `playPurchases/{tokenHash}`.

That document stores `v`, `uid`, `productId`, `packageName`, `expiresAt`, `subscriptionState`, `acknowledgementState`, `latestOrderId`, `linkedTokenHash` (hash of `linkedPurchaseToken`, or absent), `testPurchase`, `nextCheckAt`, `createdAt`, and `updatedAt`. It does not store the raw token. `latestOrderId` is Play's order id, not a token.

The same token and the same uid re-reads Play and writes the same result shape. A launch resubmit from `queryPurchasesAsync` is that second create. It does not create a second grant. If the first acknowledge failed, the resubmit acknowledges. A different uid gets `already-linked` and does not change the first driver's clock. A `linkedPurchaseToken` whose hash is already on the ledger for another uid is `already-linked` as well.

`playPurchases` read and write are false for every client.

The raw token has to be presented again for `subscriptionsv2.get`, and Play will not look a subscription up by the hash. The reconciler's copy is `playPurchaseSecrets/{tokenHash}` with `purchaseToken`, `uid`, `packageName`, `productId`, and `updatedAt`. Rules: read and write false. It is not on the user document, not on the ledger, not on the finished request, and not in logs. The document is deleted when the subscription is expired, refunded, or canceled with the period already over. Hold, pause, grace, and a cancel that is still inside the period keep it so a recovery can extend the same token.

### 20.4 Permanent errors

One table. Android implements it. The server sets `error` and `errorCode`. The app shows `error` and follows the permanent column. It does not invent codes.

After `PERMISSION_DENIED`, `get()` the same id. Update is denied, so a retry that is allowed uses a new id and the same token. Idempotency is the hash, not the id. The server switch being off is not a row in this table: the request stays `pending` and the token stays.

| Outcome | Permanent | What the client does |
|---|---|---|
| `errorCode` `invalid-payload`, `failed-precondition`, `package-mismatch`, `product-mismatch`, `already-linked`, `account-mismatch`, `invalid-token`, `not-found`, `expired`, `refunded`, `on-hold`, `paused`, or `pending` | yes | `error` and `errorCode` are both set. Show `error`. Do not retry that id |
| `status: "done"` | no | Verified. Gold is the user document, which may already have been later than this `expiresAt` |
| `status` still `pending` | no | Keep listening. Do not open a second id. This includes a request that arrived while the server switch was off |
| `errorCode` `unavailable`, `deadline-exceeded`, or `internal` | no | New id, same token. Retry at 30 s, 1 min, 2 min, then every 5 min. Drop the unsent attempt after 20 min |
| SDK `INVALID_ARGUMENT` or `FAILED_PRECONDITION` | yes | Do not retry |
| `PERMISSION_DENIED` and `get()` finds no doc | yes | Do not retry |
| `PERMISSION_DENIED` and `get()` finds the doc | no | Follow `done`, `error`, or `pending` |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `ABORTED`, the 30 s client timeout, or another network failure | no | Same backoff as `unavailable` |

`on-hold` and `paused` are permanent for that id. The user document is what changes when Play recovers. The profile listener the app already has is enough. A new request is also fine. The hash makes it the same grant.

Human `error` strings:

| `errorCode` | `error` |
|---|---|
| `failed-precondition` | Gold purchases are not available right now. |
| `invalid-payload`, `invalid-token`, `not-found`, `package-mismatch` | This purchase could not be checked. |
| `product-mismatch` | This purchase is not FerroMaps Gold. |
| `already-linked` | This purchase is already linked to another account. |
| `account-mismatch` | This purchase does not match this account. |
| `expired` | This subscription has ended. |
| `refunded` | This subscription was refunded. |
| `on-hold` | Update the payment method in Google Play to keep Gold. |
| `paused` | This subscription is paused. |
| `pending` | This purchase is not finished yet. |
| `unavailable`, `deadline-exceeded`, `internal` | Try again in a moment. |

### 20.5 Reconciler

`reconcilePlaySubscriptions`, every 60 minutes, `Europe/London`, `europe-west2`, codebase `default`. **This is the reconciliation path. Play RTDN through Pub/Sub is not used and is not required.**

Unless `enabled` is true the job does not call Play and does not write `subscriptionExpiresAt`. It still publishes `playSubscriptionsEnabled: false` so the purchase UI stays hidden. Pending request docs are left as they are.

Each run, once the switch is on:

- Processes `playPurchaseRequests` still `pending`, including ones that arrived while the switch was off.
- Reads up to 50 `playPurchases` whose `nextCheckAt` is due, and any whose `expiresAt` is at or before now even when `nextCheckAt` is still later. For each, loads the sealed token and calls `purchases.subscriptionsv2.get` before it changes Gold. A renewal, including one read at or after the old expiry, extends `subscriptionExpiresAt` when Play reports a later active expiry. Cancellations keep the period end. A downgrade is written only when that read shows the subscription is not active, or is in hold, or is paused ([section 20.2](#202-what-is-written-on-usersuid)). A Play API error leaves `subscriptionExpiresAt` unchanged and leaves the row due. A pending acknowledgement is retried. `nextCheckAt` moves forward an hour after a successful read.
- Refunds: `purchases.voidedpurchases.list` with `type=1` (subscriptions included) since `playSync/cursor.lastVoidedQueryMillis`, overlapped by 5 minutes. The first run starts 30 days back, which is as far as that API will look. Each returned token is hashed, not stored. If the hash is on the ledger, the job calls `subscriptionsv2.get` again and applies that resource. The voided list selects who to re-read. It does not downgrade by itself. `subscriptionsv2` is the source of truth, so a voided renewal order does not revoke a subscription Play still reports as active. The cursor advances only after the pages have been applied. Replaying a page writes the same user clock again. An error from `subscriptionsv2.get` does not change the clock.

`playSync/{doc}` read and write are false.

No composite index. `nextCheckAt` is one field.

### 20.6 How the client reads the result

1. Read `playSubscriptionsEnabled` on `config/appVersion` (the copy `onConfigRequest` writes). Show the purchase UI only when it is true. Do not start a purchase while it is missing or false.
2. At purchase time, set Play's obfuscated account id to the SHA-256 hex of `uid`. Do not acknowledge the purchase on the device.
3. Create `playPurchaseRequests/{id}` and listen to that doc. The timeout is 30 s and includes the write ([section 0.4](#04-request-doc-envelope)). On every later launch, `queryPurchasesAsync` resubmits each token the server has not acknowledged. Same token, new id.
4. `status: "done"` means Play verified the purchase. `expiresAt` is the Play period end. `purchaseToken` is gone.
5. `status` still `pending` means keep listening, including when the server switch was off at create time.
6. Gold on this phone and on every other platform is `users/{uid}.subscriptionExpiresAt` in the future. The app already listens to that document. `isGold()` reads it and does not read Play. iOS still treats a live StoreKit entitlement as Gold on that device. Android has no StoreKit entitlement, so Android Gold is this timestamp.
7. `status: "error"` shows `error` and follows the table in [section 20.4](#204-permanent-errors). Android owns that handling. The client does not infer Gold from an error, and does not infer Gold from `expiresAt` on the request when status is `error`.

---

## Indexes

Owned by the iOS `firestore.indexes.json`. This docs change does not add the file. PR-H adds the pins composite. The others land with the rules PR that introduces the query.

| Collection | Fields | Query |
|---|---|---|
| `pins` | `g5` ASC, `window_end` ASC | `g5 ==` and `window_end > now`, order by `window_end`, limit 500 |
| `surgeReports` | `uid` ASC, `pinId` ASC, `reportedAt` ASC | one done report per driver per pin per 20 minutes |
| `parkingReports` | `uid` ASC, `placeId` ASC, `reportedAt` ASC | one report per driver per place per 30 days |
| `parkingReports` | `placeId` ASC, `reportedAt` ASC | distinct uids that hide a place |

`parkingCells` and `privateParkingCells` are read by document id. They need no composite index.

## Client catch-up (Android `1934034`)

Review items 2, 3, 5, 7, and 8 are Android changes. The contract stays as it is for them.

Item 5 is `minVersion`. The client treats a blank or unreadable value as no minimum, and it also accepts a bare number. The PR-I seed omits `minVersion` on every flag and every category, so the seed hits neither of those forms.

## Open questions

### Is `window_end` the end of the pin's life?

**Yes.** On `pins` and on the mobile `hotspots_test` listener, the pin is in the query while `window_end > now`. That is not `expire_at`, and not a layer `expiresAt`. Publishers keep writing `expire_at` for the admin map. iOS's empty-window fallback stays valid.

### Do shards appear on base tiles?

**Yes.** The base tile holds `pins` (and `v`, and `shards` when split). Siblings hold later slices. The first slice is not an empty manifest. Same for both cell collections.

### Do pins carry capacity and attendance?

**No.** No such fields in the Android model or in this contract.

---

## Open conflicts

### C10. `appVersion` on the rules that are live today

Resolved for the contract. `b3084e7` refuses `appVersion`. PR-A in this repo re-adds it. `chore/rules-merge-web-admin` is not the vehicle. Until PR-A deploys, the Android write is refused.

### C13. In-flight Stripe draft

That draft was briefed as a callable named `createParkingPayment` with a single `feePence` price and a webhook. This contract uses request docs, a split price, destination charges, and no webhook. One draft, updated, not a second implementation.

---

## Build plan

PR-0 is this document. Do not merge it and do not deploy from it. Rules are written in the iOS repo, tested, then mirrored here. `demo-` project ids for emulators.

| Order | PR | What | Tests |
|---|---|---|---|
| PR-0 | this draft | contract | none |
| PR-A | rules + indexes, in this repo, based on iOS `b3084e7` | Re-add `appVersion` and `appVersionValid()`. Set `graceEnds()` to 31 Dec 2026. `flags`, `categories` get; `pins`, `pinTiles`, `parkingCells` signed-in read; `isGold()` on `pinGold`, `privateParkingCells`, report creates, payment-request creates; `{paymentId}_confirm` allow-list; `parkingPayments` owner read, no client write; `places`, `pinState`, and `stripeSync` denied; surge pending-replay update that allows a new `createdAt` | A string `appVersion` of 32 characters is allowed. The 15 Oct 2026 grace is closed and the 31 Dec 2026 grace is open. Surge replay: new `createdAt` while `pending` succeeds; changed `pinId` fails; update after `done` is `PERMISSION_DENIED`. iOS copies the file after this PR. `chore/rules-merge-web-admin` is not merged |
| PR-I | seed | `config/categories` with all 14 wire keys. `config/flags` using [section 1](#1-configflags). Omit `minVersion` on every flag and category | Unit test: missing flags → surge and parking on, `pinsV1` off; `ios: false` forces off; `android: true` forces on. The seed document contains no `minVersion` key, so it does not use an empty string or a bare number |
| PR-H | publisher | `pins` with server-written `g5` = `geohash5(p)`, `pinTiles`, additive `liveSurge` and `parking` on `hotspots_test`. Composite index `pins` `g5` ASC, `window_end` ASC in this repo | No top-level `expiresAt`. Each `g5` stays under 500 active pins. Parking `window_end` is now + 24 h and refreshed daily. Legacy hotspot categories unchanged |
| PR-C | BACKEND-2 | `sweepStaleDrivers` | [Section 17](#17-backend-2). Fresh `locationUpdatedAt` on either doc writes nothing. `location` bytes unchanged |
| PR-Loc | `geohash` | `onDriverLocationWritten` sets precision-7 `geohash` from a GeoPoint `location`. `recentDriverHeat` reads `geohash` | A position write fills `geohash`. An `isOnline`-only write leaves `location` and `geohash` unchanged. Heat ignores a missing `geohash` |
| PR-D | live surge | `computeLiveSurge` | Level written ≤ 3.0. Client fixture accepts 3.4 without dropping the layer. `enabled` missing → no writes |
| PR-B | BACKEND-1 | iOS `mobile` | T1–T15 of that note. A `done` deletion doc at 23 months is kept. One at 25 months is deleted |
| PR-E | street parking | `parking-ingest` for Camden and the City of London | `k`/`side`/`who` fixtures. `shards: 1` not required for Android. No production D-TRO calls until the FerroMaps Parking key is handed over |
| PR-G | private + reports | `pp-ingest`, `onParkingReport` | `permit` aud, total-pence `fee`, two uids hide, same uid does not, no location stored. `v` and `expiresAt` required |
| PR-F | surge reports | `onSurgeReport` | Same UUID twice → one apply. `band: 2` → `invalid-band` with both `error` and `errorCode`. Pending replay may change `createdAt` |
| PR-K | traffic | `traffic-enrich` | `src` missing still valid. `generatedAt` + 30 min |
| PR-J | tickets | `tickets-enrich` is not scheduled | Ticketmaster stays off. No outreach. Schema tests only, with `priceBand` int and `status: canceled` |
| PR-L | insights | `insights-enrich` | `demandBand` strings. `conf` 0.4 → Medium. No `model`. No `why` over 120 |
| PR-M | push | forecast data message | Payload matches [section 11](#11-push). No new flag keys |
| Stripe | reshape the in-flight draft | Create writes `parkingPayments` at `status: "created"`. Confirm doc id `{paymentId}_confirm`. Destination charge. `reconcileParkingPayments`. Cursor `stripeSync/cursor` | No `stripeWebhook` and no `STRIPE_WEBHOOK_SECRET`. Status never moves backward. Plate registration runs once. Retrieve is idempotent on `paymentIntentId` |
| WEB-BE-10 | Play receipts, this repo, codebase `default` | `onPlayPurchaseRequest`, `reconcilePlaySubscriptions`, `playPurchaseRequests` rules | Server switch off leaves the request `pending` and keeps the token. A mocked `subscriptionsv2.get` sets `subscriptionExpiresAt` and `subscriptionSource: "play"`. The same token again is one grant. A uid hash mismatch is `account-mismatch`. A later App Store expiry is not shortened. Expiry is not pulled back without a live Play read. A Play error does not downgrade |

---

## Decisions for Nafiu

Nothing in this contract is still waiting on a product decision from Nafiu. WEB-BE-10 stays off until the Play Console setup below is done. That setup does not change Gold while the flag is off.

### Approved by the lead TPM (31 Oct 2026)

- Stale-driver sweep: a driver is stale after 10 minutes without a `locationUpdatedAt`.
- Android and iOS both check `flags.payOrIgnore` before showing the pay card.
- The server clamps `liveSurge.level` to 3.0.
- D-TRO production app FerroMaps Parking, approved 28 Oct 2026. Key handover is still outstanding, which blocks production calls, not the area decision. Pilot area is Camden plus the City of London.
- Stripe uses `parkingPaymentRequests` and `onParkingPaymentRequest`.
- `driverLocations.location` stays the mobile position. `geohash` is a separate derived field. Admin heat reads `geohash`. Nothing rewrites `location`.
- Ticketmaster stays off, with no outreach.
- This repo owns `firestore.rules` and the indexes. iOS ports from here. The rules PR is based on `b3084e7`, re-adds `appVersion`, and moves device-claim grace to 31 Dec 2026. `chore/rules-merge-web-admin` is not merged.
- Pin reads use a cached listener on the driver's 9 geohash-5 cells, field `g5`, index `(g5, window_end)`, 500 per tile. Wider views read `pinTiles` only.
- Parking pins get `window_end` of now + 24 h, refreshed daily. The iOS client still does not hide them when that field passes.
- iOS surge push is an APNs alert after server-side forecast checks. Android stays a data message. Both use `surge_<g5>`.
- Confirm is `parkingPaymentRequests/{paymentId}_confirm`. `parkingPayments` is created with `status: "created"` when the create request completes.

### Approved by the product owner (final)

- No inbound Stripe webhook. `stripeWebhook` and `STRIPE_WEBHOOK_SECRET` are not part of this contract. Status comes from `paymentIntents.retrieve` on a confirm request, and from `reconcileParkingPayments`.
- Destination charges. FerroMaps carries the Stripe fees. The operator's share is `transfer_data`. `connectedAccountId` is not returned to the client.
- Deletion `done` records are kept for 24 months.
- Ticketmaster stays off.

Earlier notes that this ruling did not reopen: surge badge copy, a 1 km surge radius, who owns the Cloud Run jobs, a client cache for `pinGold`, and the surge-report retry table in [section 10.3](#103-what-is-permanent).

### Play Console setup (WEB-BE-10)

This is access, not a product decision. The functions ship with `config/playSubscriptions.enabled` absent, which means off. Nothing calls Play and nothing writes `subscriptionExpiresAt` until that field is set true.

Nafiu turns it on only after:

1. **Android Publisher API** is enabled on the Firebase project (`ferro-maps-staging-v2` for staging).
2. **Play Console → API access** links that Google Cloud project.
3. The caller is granted on the FerroMaps app. It needs permission to view financial data and to manage orders and subscriptions (the acknowledge call fails without the second). Two ways to grant it, in this order:
   - The Cloud Functions runtime service account for codebase `default` in `europe-west2`. No key file. The functions use Application Default Credentials. This repo does not set a custom runtime service account, so that is the default compute service account.
   - Or a dedicated Play service account, with its JSON placed in Secret Manager under the name `PLAY_SERVICE_ACCOUNT_JSON`. The code reads that env var when it is present and otherwise uses Application Default Credentials. This change does not create the secret and does not run `secrets:set`.
4. `config/playSubscriptions.packageName` is the Android application id. `productIds` is `["ferro_gold"]` and `basePlans` is `["monthly", "annual"]` only as placeholders. Prices are not set. Nafiu's yes is required before any of those are created in Play Console. This change creates nothing there. `enabled: true` with `packageName` or `productIds` missing writes `failed-precondition` and does not call Play. The server switch is turned on before `playSubscriptionsEnabled` is true for clients.

**Real-time developer notifications are not required.** Do not create a Pub/Sub topic for this. Renewals, cancellations, refunds, and account holds are read by `reconcilePlaySubscriptions`. RTDN can replace that poll later. It is not part of this contract.

---

## Field index

| Path | Field | Type | Req | Writer |
|---|---|---|---|---|
| `config/flags.{key}` | `enabled` | bool | no | server |
| `config/flags.{key}` | `android`, `ios` | bool or `{enabled, minVersion}` | no | server |
| `config/flags.{key}` | `minVersion` | string or number | no | server |
| `config/categories` entry | `key` | string | yes | server |
| `config/categories` entry | `label`, `icon`, `colour`/`color`, `order`, `enabled`/`on`, `minVersion`, `timeRule` | | no | server |
| `users/{uid}` | `appVersion` | string ≤ 32 | no | client |
| `driverLocations/{uid}` | `location` | GeoPoint | on a position write | client. Never rewritten |
| `driverLocations/{uid}` | `geohash` | string, precision 7 | after the trigger has seen a GeoPoint | server, `onDriverLocationWritten` |
| `users/{uid}` | `subscriptionExpiresAt` | timestamp | no | server. StoreKit and Play write this same field. Create may send null. Clients cannot set a time |
| `users/{uid}` | `subscriptionSource` | `play`, `appstore`, or another short server string | no | server. Create may send null. Missing does not change Gold |
| `users/{uid}` | `playPurchaseTokenHash` | string, SHA-256 hex | no | server. Not the raw token |
| `users/{uid}` | `subscriptionProductId` | string | no | server |
| `playPurchaseRequests/{id}` | `v`, `uid`, `purchaseToken`, `productId`, `packageName`, `platform`, `appVersion`, `status`, `createdAt` | | yes | client creates `pending` |
| `playPurchaseRequests` result | `status`, `error`, `errorCode`, `expiresAt`, `purchaseTokenHash`, `subscriptionState` | | status yes | server. `purchaseToken` is deleted |
| `playPurchases/{tokenHash}` | `uid`, `expiresAt`, `subscriptionState`, `nextCheckAt` | | | server. Doc id is the hash. No raw token |
| `playPurchaseSecrets/{tokenHash}` | `purchaseToken` | string | | server only. Rules deny every client |
| `playSync/cursor` | `lastVoidedQueryMillis` | int | | server. Clients cannot read it |
| `config/playSubscriptions` | `enabled`, `packageName`, `productIds`, `basePlans` | bool, string, string arrays | | server. Default off. Not client-readable. Product placeholders `ferro_gold`, `monthly`, `annual` |
| `config/appVersion` | `playSubscriptionsEnabled` | bool | no | server, `onConfigRequest`. True only when the server switch is true. Android shows the purchase UI only then |
| `configRequests` done | `playSubscriptionsEnabled` | bool | yes on `done` | server. Same boolean as `config/appVersion` |
| `pins/{id}` | `v`, `category`, `title`, `p`, `startAt`, `endAt`, `window_end`, `g5` | | yes | server. `g5` is `geohash5(p)`, length 5 |
| `pins/{id}` | `pinId`, `src`, `parking`, `tickets`, `hasGold` | | no | server |
| `pinTiles/{geohash5}` | `v` | number 1 | yes | server |
| `pinTiles/{geohash5}` | `shards`, `generatedAt`, `pins` | | no | server |
| `pinTiles…pins.{id}.liveSurge` | `active`, `level`, `since`, `expiresAt`, `v` | | all yes inside the map | server |
| `parkingCells/{geohash6}.segs[]` | `geom` | polyline ≥ 2 pts | yes | server |
| `parkingCells…segs[]` | `k` | int 0..6 | no | server |
| `parkingCells…segs[]` | `side` | int 0..2 | no | server |
| `parkingCells…segs[]` | `who` | bits 1, 2, 4, 8, 16 | no | server |
| `parkingCells…segs[]` | `fee` | int pence/hour | no | server |
| `privateParkingCells` place | `p` | lat/lng | yes | server |
| `privateParkingCells` place | `fee` | int total pence | no | server |
| `privateParkingCells` place | `aud` | `c`/`g`/`p`/`permit` and long forms | no | server |
| `privateParkingCells` place | `payMode` | `inapp`/`handoff`/`off` | no | server |
| `privateParkingCells` place | `walkM`, `src`, `capturedAt` | int, string, timestamp | no | server |
| `surgeReports/{uuid}` | `v`, `uid`, `pinId`, `band`, `reportedAt`, `platform`, `appVersion`, `status`, `createdAt` | | yes | client creates |
| `parkingReports/{uuid}` | `reason` | four-value enum | yes | client |
| `pinGold…insights` | `demandBand`, `upliftBand` | low/medium/high | no | server |
| `pinGold…insights` | `conf` | number | no | server |
| `pinGold…insights` | `crowdOut` | `{start, end}` | no | server |
| `pinGold…insights` | `waitAt.walkM` | int 0..1000 | no | server |
| `pinGold…surgeForecast` | `startAt`, `endAt`, `peakBand`, `conf` | | start/end/`v` yes | server |
| `pins…tickets` | `priceBand` | int 1..3 | no | server |
| `pins…tickets` | `status` | includes `canceled` | yes inside map | server |
| `places/{id}` | `parkingPence`, `feePence` | int | for inapp | server |
| `places/{id}` | `connectedAccountId` | string | for a destination charge | server. Not returned to the client |
| `parkingPaymentRequests/{id}` | `placeId`, `visitId`, `operator`, `plate` | string | yes | client |
| `parkingPaymentRequests` done | `parkingPence`, `feePence`, `amount`, `paymentIntentClientSecret`, `paymentId` | | yes | server |
| `parkingPaymentRequests` done | `paymentIntentId` | string | yes | server. Not a connected-account id |
| `parkingPaymentRequests/{paymentId}_confirm` | `action`, `paymentId`, `paymentIntentId`, `originalRequestId` | | yes | client. Id is `{paymentId}_confirm` |
| `parkingPayments/{id}` | `status` | `created` at create time, then only forward | yes | server |
| `stripeSync/cursor` | `lastEventCreated`, `lastEventId` | int, string | yes | server. Clients cannot read it |
| FCM data | `type` | `surge_forecast` | yes | server |
| FCM data | `lat`, `lng`, `startAt`, `endAt`, `pinId`, `v` | strings | yes | server |
| FCM data | `peakBand` | low/medium/high | no | server |
