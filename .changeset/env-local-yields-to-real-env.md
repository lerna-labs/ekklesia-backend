---
"ekklesia-backend": patch
---

Fix environment variable precedence so a real environment variable supplied by the runtime (container `environment:`/`env_file:`, Kubernetes, CI) always wins over a checked-out `.env.local`. Previously `.env.local` was loaded with `override: true` unconditionally, so a `.env.local` left in a mounted checkout could silently replace a value the container was explicitly configured with, including the database host. `.env.local` still fills in any value the runtime does not set, and still takes precedence over the base `.env.${NODE_ENV}` file, so local development workflows are unaffected.
