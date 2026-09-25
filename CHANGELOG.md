# ekklesia-backend

## 1.1.0

### Minor Changes

- d95b81b: Resolve Hydra endpoints against an explicit allowlist and use the configured value for outbound requests.

  `HYDRA_ALLOWED_ENDPOINTS` is a new comma-separated list of the Hydra instance origins a deployment may call. An endpoint supplied by an admin on `POST /:id/prepare`, or stamped on a ballot, now selects an entry from that list, and it is the configured entry that is used to build the outbound request rather than the supplied value. Previously the supplied value was validated and then used directly, so the string that was checked and the string that was used were assembled separately and could differ.

  Deployments calling more than one Hydra instance must set `HYDRA_ALLOWED_ENDPOINTS` to the origins they already have `HYDRA_API_KEY_<SLUG>` variables for. Where it is unset, `HYDRA_DEFAULT_ENDPOINT` serves as a single-entry allowlist, so a single-instance deployment needs no change. An endpoint that is not on the list fails with `ENDPOINT_NOT_ALLOWED`; one that is on the list but has no key fails with `ENDPOINT_NOT_CONFIGURED`, which replaces the previous use of `ENDPOINT_NOT_ALLOWED` for that case.

### Patch Changes

- 6cc2dd1: Bump mongoose to ^9.9.4 and @babel/core to ^7.29.7, and update @babel/preset-env so it pulls a patched @babel/plugin-transform-modules-systemjs. Update qs, form-data, fflate, path-to-regexp, and body-parser to their patched versions in the lockfile. Convert the undici override from an exact pin to a caret floor at ^6.28.0 so future patch releases apply automatically, add picomatch@2 and picomatch@4 overrides covering both resolved major lines, and override hyperid to ^4.0.0 so it stops pulling a vulnerable uuid. Closes the outstanding Dependabot alerts against fflate, qs, undici, mongoose, body-parser, @babel/core, form-data, uuid, @babel/plugin-transform-modules-systemjs, picomatch, and path-to-regexp.
- 3e3e186: Pin transitive dependencies undici, nanoid, ip-address, and brace-expansion to patched versions via npm overrides, closing the outstanding high-severity Dependabot alerts for each.
- 8f0140c: Fix environment variable precedence so a real environment variable supplied by the runtime (container `environment:`/`env_file:`, Kubernetes, CI) always wins over a checked-out `.env.local`. Previously `.env.local` was loaded with `override: true` unconditionally, so a `.env.local` left in a mounted checkout could silently replace a value the container was explicitly configured with, including the database host. `.env.local` still fills in any value the runtime does not set, and still takes precedence over the base `.env.${NODE_ENV}` file, so local development workflows are unaffected.
- cbab5e6: Stop logging an error on every request to `GET /api/v0/status` when `public/version.json` is absent. A missing file is expected for any deployment that serves the frontend as its own container or from a CDN rather than co-located with this backend; the endpoint now reports the frontend version as `unknown` in that case without logging anything. A `version.json` that is present but unreadable or fails to parse still logs an error, since that points at a real build artifact problem. The file is now read once per process and cached instead of on every request.
- 55b222b: Validate the Hydra endpoint an admin supplies to `POST /:id/prepare` against the operator's configured Hydra instances before making any outbound request to it.
- cc1aa16: Update js-yaml to 3.15.2 (under @istanbuljs/load-nyc-config and read-yaml-file) and 4.3.2 (under @changesets/parse) in the lockfile, closing GHSA-2883-xcg3-v3hh. No override is added; the consumers' own declared ranges (`^3.13.1`, `^3.6.1`, `^4.1.1`) already permitted the patched releases, so only the lockfile needed to move.
- 49de5ca: Fix `PUT /api/v0/dashboard/:ballotId/checkout/multisig` treating a chain data provider failure as a complete multisig. `validateScriptSignatures` returns either a boolean or an `{ error }` object, and the route tested the result with `if (!multisigComplete)`, which is false for any object, including an error one, so a failed signature-completeness check fell through into the branch that finalizes votes. The route now requires the result to be strictly `true` before treating the multisig as complete, and returns a 502 without changing the transaction's status when the check itself fails, instead of the previous 200 `pending` response that recorded a provider outage as a genuine incomplete multisig.
- f53cbfc: Update browserslist to 4.28.7, fixing GHSA-73wf-gq98-2v4g (CVE-2026-73088), a crash and prototype write reachable through an untrusted browserslist-stats.json custom stats file; the existing caret ranges on @babel/helper-compilation-targets and core-js-compat already permitted the patched release, so only the lockfile needed to move.

  Remove the exact-pinned js-yaml (3.15.1 and, under @changesets/parse, 4.3.1) overrides: consumers' own declared ranges (`^3.13.1`, `^3.6.1`, and `^4.1.1`) already permit newer releases without any forcing, so the pins added nothing the declared ranges did not already allow. Remove the nanoid override for the same reason; @cardano-ogmios/client's own range already lands on the patched 3.3.18. Remove the brace-expansion override: it was a single exact pin forcing every occurrence of the package to 2.1.4 regardless of major line, which meant eslint's and nodemon's minimatch (needing brace-expansion 5.x) and test-exclude's minimatch (needing brace-expansion 1.x) were silently running on a cross-major-incompatible version; each of those subtrees already resolves on its own to a patched release (1.1.18, 2.1.4, and 5.0.9) once nothing forces them onto 2.1.4.

  Convert the ip-address override from an exact 10.3.1 pin to a caret floor at ^10.3.1. This one stays: without it, the tree resolves ip-address down to 9.0.5 (via an older @cardano-sdk/core) and 10.1.0 (via express-rate-limit's own declared dependency), both inside GHSA-mwp4-54f8-5fhr's vulnerable range of anything before 10.3.1. The caret lets a future ip-address patch apply on the next install instead of requiring another manual pin bump.

- 2f64a4c: Remove the JWT `role: "admin"` claim as an admin-grant mechanism. `helper/verifyToken.js` never returned a `role` field from a decoded token, so the branch in `helper/adminAuth.js` that checked for it could never be reached; membership in the `ADMIN_USER_IDS` allowlist is now the only documented and functioning way to gain admin access, matching what already worked in practice. `docs/openapi.yaml` and the dev/ops scripts that minted tokens now describe and use only the allowlist mechanism.
- c2068a2: Reject a repeated `search` query parameter with a 400 on the ballot listing (`GET /api/v1/ballots`, `GET /api/v1/public/ballots`) and voter directory (`GET /api/v0/voters`) endpoints, instead of letting the array value reach string handling downstream.

## 1.0.0

### Major Changes

- 1812bdf: First stable release of the Ekklesia Voting API.

  The API is now published as open source under the Apache License 2.0, alongside
  the rest of the Ekklesia platform. This release incorporates the changes made in
  response to the independent security audit of the platform, including verified
  multi-signature co-signer signatures, a whole-package signature check before a
  vote package is submitted, the shared canonical JSON encoding used by every
  component that publishes vote evidence, and a canonicalised signing payload so
  that any implementation derives the same ballot hash for a given voter and set
  of selections.

  Vote evidence and results are published under protocol version ekklesia/2.0.
  Ballots that settled under the previous protocol version keep their original
  version string and remain verifiable exactly as they were, because the earlier
  verification path is retained rather than replaced.

## 0.9.2

### Patch Changes

- 0c82be5: Update dependencies: Mongoose to 9.3.0, Day.js to 1.11.20, and the Mesh SDK core and common packages to 1.9.0-beta.101. Declare a Node 20 floor in package.json.

## 0.9.1

### Patch Changes

- f78d055: Publish a versioned source tarball with each GitHub Release, containing just the files needed to run the server in production. Pushes to staging also publish a rolling preprod build so the testnet can track the release candidate.
- 9d9cde5: Bring Dependabot to the shared standard: weekly npm/github-actions/docker updates, a 3/7/14-day patch/minor/major cooldown, and development as the target branch.
