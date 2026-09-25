---
"ekklesia-backend": patch
---

Update browserslist to 4.28.7, fixing GHSA-73wf-gq98-2v4g (CVE-2026-73088), a crash and prototype write reachable through an untrusted browserslist-stats.json custom stats file; the existing caret ranges on @babel/helper-compilation-targets and core-js-compat already permitted the patched release, so only the lockfile needed to move.

Remove the exact-pinned js-yaml (3.15.1 and, under @changesets/parse, 4.3.1) overrides: consumers' own declared ranges (`^3.13.1`, `^3.6.1`, and `^4.1.1`) already permit newer releases without any forcing, so the pins added nothing the declared ranges did not already allow. Remove the nanoid override for the same reason; @cardano-ogmios/client's own range already lands on the patched 3.3.18. Remove the brace-expansion override: it was a single exact pin forcing every occurrence of the package to 2.1.4 regardless of major line, which meant eslint's and nodemon's minimatch (needing brace-expansion 5.x) and test-exclude's minimatch (needing brace-expansion 1.x) were silently running on a cross-major-incompatible version; each of those subtrees already resolves on its own to a patched release (1.1.18, 2.1.4, and 5.0.9) once nothing forces them onto 2.1.4.

Convert the ip-address override from an exact 10.3.1 pin to a caret floor at ^10.3.1. This one stays: without it, the tree resolves ip-address down to 9.0.5 (via an older @cardano-sdk/core) and 10.1.0 (via express-rate-limit's own declared dependency), both inside GHSA-mwp4-54f8-5fhr's vulnerable range of anything before 10.3.1. The caret lets a future ip-address patch apply on the next install instead of requiring another manual pin bump.
