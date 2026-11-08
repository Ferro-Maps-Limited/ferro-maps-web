# UK restriction sources: what we can say

This is a readiness check, not a parking decision. It does not download orders, call D-TRO, or tell a driver they may park. An empty result is not permission. A successful file fetch is not proof that a nation, a council, or a street is covered.

The checker records, separately:

- which nation, authority, road owner, and on-street or off-street place a source claims
- which restriction types it claims
- what evidence we actually have for coverage, licence, schema, geometry, and the legal order
- whether an import ran, which is not the same thing as coverage

If the licence, schema, geometry, legal currency, or a reviewed freshness rule is missing, the result stays not ready. No age limit is invented here. If nobody has agreed what "stale" means, an old date stays unverified rather than being labelled stale by this code. A source can be marked stale only when a reviewed policy already says so, and even then parking is not allowed.

A future start date is not an active restriction. A proposal or a made order is not treated as in force without evidence. Expired, amended, and revoked states also need evidence. Conflicting sources stay a conflict. One healthy import next to an unverified source does not upgrade the unverified one.

Every result says not ready, and it says why. `policy-unapproved` means nobody has agreed that this check may decide parking or coverage. `runtime-disabled` means this code does not load a feed. A row that has every box filled in still carries those reasons. Silence is not approval.

Coverage counts a nation only when the row names that nation and also names a road owner, an on-street or off-street place, and a restriction type. An unrecognised name does not count. One sample row for each of the four nations is still not an inventory of councils or road owners, so a query also says `authority-coverage-unreviewed`. The result never says UK coverage is complete.

Times must be a real calendar day with an explicit offset, such as `2026-11-26T00:00:00.000Z` or `2026-11-26T00:00:00.000+01:00`. `08/11/2026` is rejected because it does not say which day is meant. 31 February is rejected. A time with no offset is rejected. The checker does not turn an old date into "stale" by counting days.

No source in this repository is switched on. The registry used by the checker is empty. Tests use synthetic rows only.

These public pages are references for later rights review. They are not feeds:

- D-TRO service: https://www.gov.uk/guidance/digital-traffic-regulation-orders-d-tro-service
- England and Wales enabling power, not a feed: https://www.legislation.gov.uk/ukpga/2024/10/section/93
- Bradford catalogue, licence not verified: https://www.data.gov.uk/dataset/bae71281-3be4-4d4c-a7f6-a9535c6b62b7/tros12
- Scotland car-parking compilation, completeness disclaimed: https://www.data.gov.uk/dataset/0f94e690-ac8f-402d-b88f-1bf7341b3d6a/car-parking-scotland
- Rhondda Cynon Taf map, not cleared for reuse: https://rctcbc.traffweb.app/
- Welsh Government road orders, not all council parking: https://www.gov.wales/road-orders
- One Northern Ireland off-street catalogue, not on-street and not NI-wide: https://www.data.gov.uk/dataset/135bafbb-8bea-4853-beb6-e45c02bd9481/ccgbc-off-street-car-parking
- A Northern Ireland consultation is not proof an order is in force: https://www.infrastructure-ni.gov.uk/consultations/parking-and-waiting-restrictions-ballymoney-order-northern-ireland-2026

Scotland's licence wording is not settled. A Northern Ireland order that starts on a later date is not active before that date. None of this is a UK-wide restriction service. The existing private parking sheet sync is a different system and is unchanged.
