---
"ekklesia-backend": patch
---

Remove the JWT `role: "admin"` claim as an admin-grant mechanism. `helper/verifyToken.js` never returned a `role` field from a decoded token, so the branch in `helper/adminAuth.js` that checked for it could never be reached; membership in the `ADMIN_USER_IDS` allowlist is now the only documented and functioning way to gain admin access, matching what already worked in practice. `docs/openapi.yaml` and the dev/ops scripts that minted tokens now describe and use only the allowlist mechanism.
