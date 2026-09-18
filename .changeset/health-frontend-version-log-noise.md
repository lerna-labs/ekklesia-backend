---
"ekklesia-backend": patch
---

Stop logging an error on every request to `GET /api/v0/status` when `public/version.json` is absent. A missing file is expected for any deployment that serves the frontend as its own container or from a CDN rather than co-located with this backend; the endpoint now reports the frontend version as `unknown` in that case without logging anything. A `version.json` that is present but unreadable or fails to parse still logs an error, since that points at a real build artifact problem. The file is now read once per process and cached instead of on every request.
