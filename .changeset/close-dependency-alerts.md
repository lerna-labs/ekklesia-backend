---
"ekklesia-backend": patch
---

Bump mongoose to ^9.9.4 and @babel/core to ^7.29.7, and update @babel/preset-env so it pulls a patched @babel/plugin-transform-modules-systemjs. Update qs, form-data, fflate, path-to-regexp, and body-parser to their patched versions in the lockfile. Convert the undici override from an exact pin to a caret floor at ^6.28.0 so future patch releases apply automatically, add picomatch@2 and picomatch@4 overrides covering both resolved major lines, and override hyperid to ^4.0.0 so it stops pulling a vulnerable uuid. Closes the outstanding Dependabot alerts against fflate, qs, undici, mongoose, body-parser, @babel/core, form-data, uuid, @babel/plugin-transform-modules-systemjs, picomatch, and path-to-regexp.
