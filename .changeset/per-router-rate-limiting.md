---
"ekklesia-backend": patch
---

Move rate limiting from a single app-wide mount on `/api` to a limiter applied directly in each route file. Effective limits on existing routes are unchanged: the v0 proposal read endpoints, the dashboard, admin, and public API-key routes all keep the same `publicGetLimiter` budget they shared under the old mount; only where the limiter is mounted changes.

The `/api/v1/public/ballots` and `/api/v1/public/results` API-key lookup now runs behind a limiter ahead of `requireApiKey`, so an unauthenticated database lookup can no longer run unbounded before the per-key limiter takes over.

Two surfaces sit outside `/api` and so were never covered by the old app-wide mount: the root-mounted `/health` status endpoint, and the dynamic OpenGraph card image routes and SPA fallback in `server.js`. Those now share one rate limiter.

Every request, across both `/api` and non-`/api` surfaces, also now passes a 1000-requests-per-minute per-IP baseline limit on top of the router-specific ones above.
