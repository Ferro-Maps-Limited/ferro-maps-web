# lookupVehicle

A signed-in driver asks for a UK registration by creating a request document. A Firestore trigger looks the registration up on the DVLA Vehicle Enquiry Service and writes the result onto that same document. The phone listens to the document. It never calls a Cloud Function, never receives the raw DVLA payload, and never sends the DVLA key.

The trigger is `onVehicleLookupRequest`, in `europe-west2`. It runs when a document is created at `vehicleLookupRequests/{id}`.

Callables are not used. Organisation Domain Restricted Sharing blocks the `allUsers` Cloud Run invoker, so a phone cannot reach an `onCall` function on this project.

## Request

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

The phone cannot set `status`, `code`, or any vehicle field. It cannot update or delete the document.

## Response

The trigger updates the same document. `uid` and `createdAt` stay as the phone wrote them. The phone should wait until `status` is `done` or `error`.

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

A successful lookup is reused for 24 hours. `fetchedAt` stays the time DVLA was asked, so a cached record can be up to 24 hours old.

### `status: "error"`

The vehicle fields are absent. The phone should branch on `code`.

| `code` | When |
|---|---|
| `invalid` | The request had no usable uid, the registration failed the check above, or DVLA returned 400 |
| `not_found` | DVLA returned 404 |
| `rate_limited` | This driver has used 10 DVLA lookups in the current minute, the shared DVLA pace cannot take another call, or DVLA returned 429 |
| `upstream_error` | DVLA returned a server error, the call took longer than 5 seconds, or the network failed |

```json
{
  "uid": "<signed-in uid>",
  "registration": "ab12 cde",
  "createdAt": "<server timestamp>",
  "status": "error",
  "code": "not_found"
}
```

On an error, `registration` stays as the phone wrote it. Nothing from DVLA's error body is written.

A fresh cached record does not count as one of the 10 lookups and does not call DVLA.

## Who can read it

A signed-in user can create a request only for their own uid, and can read only their own request documents. They cannot list the collection. Another driver, a signed-out caller, and an admin cannot read the document. The cache, the per-driver counter, and the shared DVLA pace stay in server-only collections.
