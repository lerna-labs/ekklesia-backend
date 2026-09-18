---
"ekklesia-backend": patch
---

Update js-yaml to 3.15.2 (under @istanbuljs/load-nyc-config and read-yaml-file) and 4.3.2 (under @changesets/parse) in the lockfile, closing GHSA-2883-xcg3-v3hh. No override is added; the consumers' own declared ranges (`^3.13.1`, `^3.6.1`, `^4.1.1`) already permitted the patched releases, so only the lockfile needed to move.
