# lookupVehicle

A signed-in driver sends a UK registration. The server returns a short record from the DVLA Vehicle Enquiry Service. The phone never receives the raw DVLA payload, and it never sends the DVLA key.

The callable is `lookupVehicle`, in `europe-west2`.

## Request

```json
{ "registration": "ab12 cde" }
```

`registration` is a string. The server uppercases it and removes all whitespace. What remains must match `^[A-Z0-9]{2,8}$`. `ab12 cde` and `AB12CDE` are the same vehicle.

The caller must be signed in.

## Response

Every field is always present. A missing DVLA value is `null`. The server does not guess it from another field.

| Field | Type | Meaning |
|---|---|---|
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

There is no model. DVLA does not send one. `euroStatus` is not returned.

Where a field is null, the phone shows — (an em dash). It does not show a blank, a zero, or a value copied from another field.

A successful lookup is reused for 24 hours. `fetchedAt` stays the time DVLA was asked, so a cached record can be up to 24 hours old.

## Errors

The phone should branch on `details.code`. The message is a short English sentence and is not the contract.

| `details.code` | Callable code | When |
|---|---|---|
| `invalid_registration` | `invalid-argument` | The registration failed the check above, or DVLA returned 400 |
| `not_found` | `not-found` | DVLA returned 404 |
| `rate_limited` | `resource-exhausted` | This driver has used 10 DVLA lookups in the current minute, the shared DVLA pace cannot take another call, or DVLA returned 429 |
| `unavailable` | `unavailable` | DVLA returned a server error, the call took longer than 5 seconds, or the network failed |

A signed-out caller gets `unauthenticated` and no `details.code`.

Nothing from DVLA's error body is returned.

A fresh cached record does not count as one of the 10 lookups and does not call DVLA.
