# ekklesia-backend

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
