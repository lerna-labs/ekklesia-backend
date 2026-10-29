---
"ekklesia-backend": patch
---

Raise Satori to ^0.33.5, which fixes improper escaping in Satori-generated SVG (GHSA-wx4j-mvgx-mqwp) in the OG image cards. Satori pins fflate 0.7.3, inside GHSA-px8p-9vwx-vf98, so an override resolves fflate to ^0.7.5.
