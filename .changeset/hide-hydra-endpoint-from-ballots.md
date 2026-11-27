---
"ekklesia-backend": patch
---

Ballot responses no longer include the ballot's Hydra endpoint. `hydra.endpoint` is removed from `GET /api/v1/ballots`, `GET /api/v1/ballots/:id` and their `/api/v1/public` equivalents, and `hydraEndpoint` is removed from `GET /api/v0/ballots` and `GET /api/v0/ballots/:ballotId`. The backend still resolves the endpoint server-side for every Hydra call, and the admin prepare response still returns `hydraEndpoint`.
