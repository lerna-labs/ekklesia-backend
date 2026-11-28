---
"ekklesia-backend": patch
---

Allow Cloudflare Web Analytics in the Content-Security-Policy: `script-src` now permits `https://static.cloudflareinsights.com/beacon.min.js`, the script Cloudflare injects into proxied pages. The beacon reports to the site's own `/cdn-cgi/rum`, which `connect-src` already covers through the `default-src 'self'` fallback.
