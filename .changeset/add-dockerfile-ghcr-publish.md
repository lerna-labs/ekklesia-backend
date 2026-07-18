---
"ekklesia-backend": patch
---

Add a multi-stage Dockerfile (production-only runtime deps on node:20-slim) and a GHCR publish workflow, tagging images latest/staging/version/short-sha depending on which ref triggered the build.
