---
"ekklesia-backend": patch
---

Store integrator API keys with a keyed HMAC-SHA256 hash instead of unkeyed SHA-256, so a leaked hash alone can no longer be confirmed against a candidate key without the server secret. Keys issued before this change keep working: a key matched against the previous unkeyed hash is rehashed to the new scheme automatically on its next successful use, so no key needed to be reissued.
