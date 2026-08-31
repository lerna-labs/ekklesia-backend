---
"ekklesia-backend": patch
---

Validate the Hydra endpoint an admin supplies to `POST /:id/prepare` against the operator's configured Hydra instances before making any outbound request to it, closing code-scanning alert #2.
