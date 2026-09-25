---
"ekklesia-backend": patch
---

Validate several user-supplied values against their expected type and shape before they reach a Mongo query filter, instead of relying only on a truthiness check. `helper/compiledBallot/writer.js` now requires `source.moduleId` and `source.externalBallotId` to be non-empty strings before building the ballot upsert filter. `PUT /api/v0/dashboard/:ballotId/checkout` and its `/checkout/multisig` sibling now require the submitted `data` (merkle root) to be a string matching the "0x" + 64 hex char shape the backend itself produces. `POST /api/v1/votes/:ballotId/signature` and `POST /api/v1/votes/:ballotId/submit` now require `packageId` to be a 24-char hex Mongo ObjectId string; `/submit` previously had no check on `packageId` at all. Each affected filter value is also wrapped in `$eq` so the query can only ever match it as a literal.
