---
"ekklesia-backend": patch
---

Enable the Content-Security-Policy header on served responses. It had been disabled outright; it now runs on helmet's secure defaults (`default-src`, `base-uri`, `form-action`, and `frame-ancestors` scoped to `'self'`, `object-src 'none'`) with two additions the served frontend build needs: `script-src` allows inline scripts for the SPA's per-build bootstrap loader, and `img-src` allows any HTTPS host because proposal option images are admin-supplied and not limited to this origin.

Stop logging the MongoDB password in clear text when `backup/restore.js` reports the `mongorestore` command it is about to run; the logged command now shows `--password ***` while the real command still carries the credential to the child process.
