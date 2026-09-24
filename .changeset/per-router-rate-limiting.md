---
"ekklesia-backend": patch
---

Move rate limiting from a single app-wide mount on `/api` to a limiter applied directly in each route file. Effective limits on existing routes are unchanged, including the v0 proposal read endpoints; only where the limiter is mounted changes.

Several surfaces that were not covered by the old app-wide mount now have one: the `/api/v1/admin/ballots` lifecycle endpoints and the `/api/v1/admin/me` admin-status probe, the `/api/v1/public/ballots` and `/api/v1/public/results` API-key lookup (previously an unauthenticated database lookup ran before any rate limiter), the root-mounted `/health` status endpoint (outside `/api`, so never in reach of the old mount), the dynamic OpenGraph card image routes, and the SPA fallback that serves `index.html`. `/api/v0/comments` writes (create, like, withdraw, edit) get their own budget separate from the router's read traffic.

New env-configurable limiters, each with a sensible default: `DASHBOARD_WINDOW_MS`/`DASHBOARD_MAX` (60/min), `COMMENT_WRITE_WINDOW_MS`/`COMMENT_WRITE_MAX` (20/min), `ADMIN_WINDOW_MS`/`ADMIN_MAX` (60/min), `ADMIN_AUTH_WINDOW_MS`/`ADMIN_AUTH_MAX` (60/min), `API_KEY_AUTH_WINDOW_MS`/`API_KEY_AUTH_MAX` (120/min), `OG_IMAGE_WINDOW_MS`/`OG_IMAGE_MAX` (60/min), `SPA_WINDOW_MS`/`SPA_MAX` (300/min), `HEALTH_WINDOW_MS`/`HEALTH_MAX` (300/min).
