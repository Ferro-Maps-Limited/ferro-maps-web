# Vehicle lookup

A signed-in driver asks for a UK registration by creating a Firestore document. The trigger `onVehicleLookupRequest` in `europe-west2` reads that document, asks the DVLA Vehicle Enquiry Service, and writes the result onto the same document. The phone listens to the document.

The lookup is on. There is no feature flag and no enable switch. Creating the document starts the lookup.

The phone creates `vehicleLookupRequests/{id}`, then listens to that same document until `status` is `done` or `error`. It may see `processing` first. That means the server has taken the request. Keep listening. Do not create a second document for the same ask.

If about 25 seconds pass and `status` is still missing or `processing`, stop waiting and show check unavailable.

The phone never calls DVLA and never sends the DVLA key. The trigger sends the key as the `x-api-key` header, from the existing `DVLA_API_KEY` secret. The cache id and the log hash use a second server secret, `VEHICLE_HMAC_SECRET`. This contract does not create or change either secret.

Callables are not used. Organisation Domain Restricted Sharing blocks the `allUsers` Cloud Run invoker, so a phone cannot reach an `onCall` function on this project.

## Request

Path: `vehicleLookupRequests/{id}`

The phone chooses `{id}` and creates the document with exactly these fields:

| Field | Type | Rule |
|---|---|---|
| `uid` | string | The signed-in user's uid. 1 to 128 characters, and it must not contain `/` |
| `registration` | string | 1 to 32 characters. The server uppercases it and removes all whitespace. What remains must match `^[A-Z0-9]{2,8}$` |
| `createdAt` | timestamp | The server timestamp (`serverTimestamp()` / `FieldValue.serverTimestamp()`) |

```json
{
  "uid": "<signed-in uid>",
  "registration": "ab12 cde",
  "createdAt": "<server timestamp>"
}
```

`ab12 cde` and `AB12CDE` are the same vehicle. A string that fails the check above is still a valid create. The trigger writes `code` `invalid` rather than refusing the write, so the phone has a document to read.

The phone cannot set `status`, `code`, `expireAt`, or any vehicle field. It cannot update or delete the document. The server sets `expireAt` to about 30 days after the request is created. Firestore TTL deletes the request document from that field, so the document goes away about 30 days after creation. A create that includes `expireAt` is rejected.

### Who may create it

The Firestore rule on `vehicleLookupRequests/{requestId}` allows `create` when all of these are true:

- the caller is signed in
- the document keys are exactly `uid`, `registration`, and `createdAt`
- `uid` equals the signed-in uid, is a string, is 1 to 128 characters, and contains no `/`
- `registration` is a string of 1 to 32 characters
- `createdAt` equals the request time (the server timestamp)

The same rule allows `get` only when the caller is signed in and `uid` on the document is their uid. `list`, `update`, and `delete` are false. A nested document under the request is closed.

A signed-out caller, another driver, and an admin cannot read the document.

`vehicle_lookups`, `vehicle_lookup_limits`, and `vehicle_lookup_throttle` are server-only. Clients, including an admin, cannot read or write them. Those hold the 24-hour cache, the per-driver minute counter, and the shared DVLA pace.

## Response

The trigger updates the same document. `uid` and `createdAt` stay as the phone wrote them. `status` is absent until the trigger claims the document. It then becomes `processing`, and later `done` or `error`. The phone listens until `status` is `done` or `error`. A client timeout of about 25 seconds, while `status` is still missing or `processing`, shows check unavailable.

### `status: "done"`

`registration` is replaced with the normalised registration. Every vehicle field below is present. A missing DVLA value is `null`. The server does not guess it from another field.

| Field | Type | Meaning |
|---|---|---|
| `status` | string | `done` |
| `registration` | string | The normalised registration |
| `make` | string or null | |
| `colour` | string or null | |
| `fuelType` | string or null | |
| `co2Emissions` | number or null | |
| `taxStatus` | string or null | |
| `taxDueDate` | string or null | |
| `motStatus` | string or null | |
| `motExpiryDate` | string or null | |
| `typeApproval` | string or null | |
| `firstRegistered` | string or null | DVLA `monthOfFirstRegistration`, such as `2017-11` |
| `fetchedAt` | string | ISO-8601 time the record was fetched from DVLA |

```json
{
  "uid": "<signed-in uid>",
  "createdAt": "<server timestamp>",
  "status": "done",
  "registration": "AB12CDE",
  "make": "ROVER",
  "colour": "BLUE",
  "fuelType": "PETROL",
  "co2Emissions": 144,
  "taxStatus": "Taxed",
  "taxDueDate": "2027-03-01",
  "motStatus": "Valid",
  "motExpiryDate": "2026-12-01",
  "typeApproval": "M1",
  "firstRegistered": "2017-11",
  "fetchedAt": "2026-11-11T12:00:00.000Z"
}
```

There is no model. DVLA does not send one. `euroStatus` is not returned. There is no `code` on a done document.

Where a field is null, the phone shows — (an em dash). It does not show a blank, a zero, or a value copied from another field.

### `status: "error"`

The vehicle fields are absent. `registration` stays as the phone wrote it. The phone should branch on `code`.

| `code` | When |
|---|---|
| `invalid` | The request had no usable uid, the registration failed the check above, or DVLA returned 400 |
| `rate_limited` | This driver has already used 10 lookups that called DVLA in the current minute, or the shared pace cannot take another call |
| `vehicle_not_found` | DVLA returned 404. There is no such vehicle |
| `vehicle_check_unavailable` | The call took longer than 5 seconds, DVLA returned 429, 5xx, or another unexpected status, the network failed, the DVLA key or the HMAC secret is missing, or any other upstream failure |

```json
{
  "uid": "<signed-in uid>",
  "registration": "ab12 cde",
  "createdAt": "<server timestamp>",
  "status": "error",
  "code": "vehicle_not_found"
}
```

Nothing from DVLA's error body is written onto the document, stored in the cache, or written to the logs.

## Cache

A successful lookup is stored for 24 hours. `fetchedAt` stays the time DVLA was asked, so a cached record can be up to 24 hours old.

The cache document lives at `vehicle_lookups/{lookupId}`. `{lookupId}` is the hex HMAC-SHA256 of the normalised registration, keyed by `VEHICLE_HMAC_SECRET`. The cache document has no `registration` field. The phone cannot read this collection.

`expireAt` on the cache document is the fetch time plus 24 hours. Firestore TTL on `expireAt` deletes the document. The per-minute counter in `vehicle_lookup_limits` has its own server-set `expireAt`, and the same TTL policy. The phone cannot set `expireAt` on a request.

A fresh cache hit does not call DVLA. It does not use one of the driver's 10 lookups. It does not take a shared pace slot. An error is not cached, so the next request for that registration asks DVLA again.

## Rate limit

Each driver may cause 10 DVLA calls in a minute. The 11th in that minute is `rate_limited`. Another driver's count is separate. The window starts again on the next minute. A cache hit does not count.

Calls to DVLA are also spaced at least 500 milliseconds apart. That pace is shared by every driver. If the next slot would mean waiting more than 2 seconds, the lookup is `rate_limited` and the queue is left where it is. A shared-pace refusal leaves that driver's minute count unchanged. DVLA returning 429 is `vehicle_check_unavailable`.

## Logging

Each lookup logs the uid, the time, the outcome, and `registrationHash`. That hash is the same hex HMAC-SHA256 used as the cache document id. The registration itself is not logged. An invalid registration has no hash, because there is no normalised plate. The DVLA key, the HMAC secret, and the DVLA error body are not logged.
