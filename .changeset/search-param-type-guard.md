---
"ekklesia-backend": patch
---

Reject a repeated `search` query parameter with a 400 on the ballot listing (`GET /api/v1/ballots`, `GET /api/v1/public/ballots`) and voter directory (`GET /api/v0/voters`) endpoints, instead of letting the array value reach string handling downstream.
